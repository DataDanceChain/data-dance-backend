#!/usr/bin/env node
/** Real HTTP/PostgreSQL fixture owner. No production env files, accounts or provider calls.
 * Run from any cwd with --admin-origin/--console-origin http://localhost:<port>,
 * --runtime-file <new private readiness JSON>, and --dependencies <existing node_modules>.
 * SIGTERM/SIGINT closes the API, removes only this container/client overlay and the private file.
 */
'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile, fork } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const BASE = 'd47940285bdf50b1387948d2484c4049111c7175';
const MIGRATIONS = ['20261017100000_ops_roles_audit', '20261019160000_oauth_authorization_prompt', '20261020060000_developer_consent_controls'];
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, i, values) => {
  if (i % 2 === 0) pairs.push([value, values[i + 1]]); return pairs;
}, []));
function origin(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || u.hostname !== 'localhost' || !u.port || u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('Origins must be http://localhost:<port>');
  return u.origin;
}
const adminOrigin = origin(args['--admin-origin']);
const consoleOrigin = origin(args['--console-origin']);
const runtimeFile = path.resolve(args['--runtime-file']);
const dependencies = path.resolve(args['--dependencies'] || process.env.OPS_FIXTURE_DEPENDENCIES || 'node_modules');
if (fs.existsSync(runtimeFile) || fs.existsSync(`${runtimeFile}.tmp`)) throw new Error('Runtime file already exists; refusing to overwrite');
for (const name of ['prisma/build/index.js', '@prisma/client/package.json', 'express/package.json']) {
  if (!fs.existsSync(path.join(dependencies, name))) throw new Error(`Missing fixture dependency: ${name}`);
}
const runId = crypto.randomBytes(6).toString('hex');
const container = `ddc-ops-browser-${runId}`;
const database = `ddc_ops_browser_${runId}_test`;
let work, child, created = false, stopping = false, cleanupPromise;
const commandEnv = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || os.tmpdir(), LANG: 'C', NODE_ENV: 'test' };
async function command(file, argv, options = {}) {
  return runFile(file, argv, { env: commandEnv, timeout: 45000, maxBuffer: 4 * 1024 * 1024, ...options });
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  stopping = true;
  cleanupPromise = (async () => {
    let apiStopped = true, containerRemoved = !created, privateRuntimeRemoved = false, overlayRemoved = !work;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5000))]);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
      apiStopped = child.exitCode !== null || child.signalCode !== null;
    }
    if (created) {
      try {
        const label = await command('docker', ['inspect', '--type', 'container', '--format', '{{ index .Config.Labels "ddc.fixture.run" }}', container], { timeout: 10000 });
        if (label.stdout.trim() === runId) await command('docker', ['rm', '-f', container], { timeout: 15000 });
      } catch { /* Verification below distinguishes absence from failed removal. */ }
      try { await command('docker', ['inspect', '--type', 'container', '--format', '{{.Id}}', container], { timeout: 10000 }); }
      catch (error) { containerRemoved = /no such (?:object|container)/i.test(String(error.stderr || '')); }
    }
    try { await fsp.rm(runtimeFile, { force: true }); await fsp.rm(`${runtimeFile}.tmp`, { force: true }); privateRuntimeRemoved = !fs.existsSync(runtimeFile) && !fs.existsSync(`${runtimeFile}.tmp`); } catch {}
    try { if (work) await fsp.rm(work, { recursive: true, force: true }); overlayRemoved = !work || !fs.existsSync(work); } catch {}
    const ok = apiStopped && containerRemoved && privateRuntimeRemoved && overlayRemoved;
    console.log(JSON.stringify({ stage: ok ? 'cleaned' : 'cleanup_failed', container, apiStopped, containerRemoved, privateRuntimeRemoved, overlayRemoved }));
    return ok;
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cleanup().then((ok) => process.exit(ok ? 0 : 1)));
async function main() {
  work = await fsp.mkdtemp(path.join(os.tmpdir(), 'ddc-ops-browser-'));
  await fsp.chmod(work, 0o700);
  const modules = path.join(work, 'node_modules');
  await fsp.mkdir(path.join(modules, '@prisma'), { recursive: true });
  await fsp.cp(path.join(dependencies, '@prisma/client'), path.join(modules, '@prisma/client'), { recursive: true });
  const currentSchema = await fsp.readFile(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');
  const schema = path.join(work, 'schema.prisma');
  await fsp.writeFile(schema, currentSchema.replace(/provider\s*=\s*"prisma-client-js"/, `provider = "prisma-client-js"\n  output = ${JSON.stringify(path.join(modules, '.prisma/client'))}`));
  const baseSchema = path.join(work, 'base.prisma');
  const baseline = await command('git', ['-C', ROOT, 'show', `${BASE}:prisma/schema.prisma`]);
  await fsp.writeFile(baseSchema, baseline.stdout);
  const password = crypto.randomBytes(24).toString('hex');
  console.log(JSON.stringify({ stage: 'database_starting', container }));
  created = true;
  await command('docker', ['run', '--pull=never', '--rm', '--name', container, '--label', 'ddc.fixture=ops-browser', '--label', `ddc.fixture.run=${runId}`, '-p', '127.0.0.1::5432', '-e', 'POSTGRES_USER=fixture', '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${database}`, '-d', 'postgres:17']);
  created = true;
  for (let i = 0; ; i++) {
    try { await command('docker', ['exec', container, 'pg_isready', '-U', 'fixture', '-d', database], { timeout: 5000 }); break; }
    catch (error) { if (i >= 29) throw new Error('Disposable PostgreSQL did not become ready'); await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  const port = (await command('docker', ['port', container, '5432/tcp'])).stdout.trim();
  if (!/^127\.0\.0\.1:\d+$/.test(port)) throw new Error('Database is not published only on loopback');
  const databaseUrl = `postgresql://fixture:${password}@${port}/${database}?schema=public`;
  const env = { ...commandEnv, DATABASE_URL: databaseUrl, TEST_DATABASE_URL: databaseUrl,
    NODE_PATH: [modules, dependencies].join(path.delimiter), NODE_OPTIONS: `--require=${JSON.stringify(path.join(__dirname, 'opsFixtureNetwork.js'))}`, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', PRISMA_GENERATE_SKIP_AUTOINSTALL: '1', PRISMA_SKIP_POSTINSTALL_GENERATE: 'true',
    JWT_SECRET: crypto.randomBytes(32).toString('hex'), SSO_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    OPS_ADMIN_URL: adminOrigin, FRONTEND_URL: `${adminOrigin},${consoleOrigin}`, APP_PUBLIC_URL: consoleOrigin,
    PUBLIC_BASE_URL: 'http://127.0.0.1', SSO_ENVIRONMENT: 'test', SSO_TGE_AUTO_APPROVE: 'off', SSO_TGE_ENABLED: 'false',
    WEB3AUTH_VERIFY_MODE: 'off', SSO_DEVELOPER_REGISTRATION: 'off', LOG_LEVEL: 'error',
    OPS_ADMIN_USERNAME: 'synthetic-shared', OPS_ADMIN_PASSWORD: crypto.randomBytes(18).toString('hex'),
    OPS_DEMO_USERNAME: 'synthetic-demo', OPS_DEMO_PASSWORD: crypto.randomBytes(18).toString('hex'), OPS_SHARED_LOGIN: 'on',
    OPS_FIXTURE_RUN: runId, OPS_FIXTURE_RUNTIME: runtimeFile, OPS_FIXTURE_WORK: work, OPS_FIXTURE_CONTAINER: container };
  const prisma = path.join(dependencies, 'prisma/build/index.js');
  await command(process.execPath, [prisma, 'generate', '--schema', schema], { env, cwd: work });
  await command(process.execPath, [prisma, 'db', 'push', '--skip-generate', '--schema', baseSchema], { env, cwd: work });
  for (const migration of MIGRATIONS) {
    await command(process.execPath, [prisma, 'db', 'execute', '--file', path.join(ROOT, 'prisma/migrations', migration, 'migration.sql'), '--schema', schema], { env, cwd: work });
  }
  console.log(JSON.stringify({ stage: 'migrations_applied', count: MIGRATIONS.length }));
  child = fork(path.join(__dirname, 'opsBrowserApp.js'), [], { cwd: work, env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', (message) => {
    if (message.type === 'ready') console.log(JSON.stringify({ stage: 'ready', apiOrigin: message.apiOrigin, runtimeFile, container }));
    if (message.type === 'error') console.error(JSON.stringify({ stage: 'fixture_error', name: message.name, code: message.code, module: message.module, location: message.location }));
  });
  child.once('exit', (code) => { if (!stopping) cleanup().then(() => process.exit(code || 0)); });
}
main().catch(async (error) => {
  console.error(JSON.stringify({ stage: 'startup_failed', name: error.name, code: error.code || null, detail: String(error.message).split('\n')[0].replace(/postgresql:\/\/\S+/g, '[synthetic-database]').replace(/POSTGRES_PASSWORD=[^\s,'"]+/g, 'POSTGRES_PASSWORD=[synthetic]') }));
  await cleanup(); process.exit(1);
});
