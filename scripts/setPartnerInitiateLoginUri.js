#!/usr/bin/env node
/**
 * Sets or clears the App hand-off target (`initiate_login_uri`) of one first-party partner client
 * stored in the database (SsoDeveloperClient, kind "partner").
 *
 * The App hand-off (POST /api/sso/app-ticket → /sso/continue → `{initiate_login_uri}?iss=…`, see
 * docs/TGE_SSO.md "App hand-off") answers CLIENT_DISABLED for a client without one. The
 * environment's partner client (SSO_TGE_CLIENT_ID) takes its value from SSO_TGE_INITIATE_LOGIN_URI
 * and is refused here, and so is a developer client: the hand-off is first-party only.
 *
 * Dry run by default: prints the client and the value before and after, and writes nothing.
 * --apply writes it. The value must pass the rule the server applies when it reads the column
 * (absolute https URL, no user name or password, no blanks or backslashes, no fragment, at most 512
 * characters: the production rule for SSO_TGE_INITIATE_LOGIN_URI). The server reads the column on
 * every request, so a change takes effect without a restart. The hand-off also needs
 * SSO_TGE_ENABLED on and SSO_SESSION_SECRET set; the "app hand-off" line says when either is missing.
 *
 * Usage (inside the api container, where DATABASE_URL and the SSO_* settings are loaded):
 *   node scripts/setPartnerInitiateLoginUri.js --client-id <id>                        show only
 *   node scripts/setPartnerInitiateLoginUri.js --client-id <id> --uri <https url> [--apply]
 *   node scripts/setPartnerInitiateLoginUri.js --client-id <id> --clear [--apply]
 *
 * Exit codes: 0 shown / dry run / written / already set · 1 refused (unknown client, developer
 * client, the environment's client, invalid URI; nothing written) · 2 usage · 3 unexpected error.
 *
 * Output: client id, name, kind, enabled and the URI. Never the secret hash or the contact e-mail.
 */
const {
  initiateLoginUriProblem,
  readPartnerConfig,
  samePartnerClientId,
  isRetiredPartnerClientId,
} = require('../src/constants/partnerClient');

const EXIT = { OK: 0, REFUSED: 1, USAGE: 2, ERROR: 3 };
const USAGE = 'usage: node scripts/setPartnerInitiateLoginUri.js --client-id <id> [--uri <https url> | --clear] [--apply]';

class UsageError extends Error {}
class Refusal extends Error {}

function parseArgs(argv) {
  const opts = { clientId: '', uri: null, clear: false, apply: false };
  const args = [...argv];
  const valueOf = (name, arg) => {
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    const next = args.shift();
    if (next === undefined || next.startsWith('--')) throw new UsageError(`${name} needs a value`);
    return next;
  };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--client-id' || arg.startsWith('--client-id=')) opts.clientId = valueOf('--client-id', arg).trim();
    else if (arg === '--uri' || arg.startsWith('--uri=')) opts.uri = valueOf('--uri', arg).trim();
    else if (arg === '--clear') opts.clear = true;
    else if (arg === '--apply') opts.apply = true;
    else if (arg === '--help' || arg === '-h') throw new UsageError('');
    else throw new UsageError(`unknown argument "${arg}"`);
  }
  if (!opts.clientId) throw new UsageError('--client-id is required');
  if (opts.uri !== null && opts.clear) throw new UsageError('--uri and --clear cannot be combined');
  if (opts.uri === '') throw new UsageError('--uri needs a value (use --clear to remove the URI)');
  if (opts.apply && opts.uri === null && !opts.clear) throw new UsageError('--apply needs --uri or --clear');
  return opts;
}

function shown(value) {
  if (value === null || value === undefined || value === '') return '(none)';
  const problem = initiateLoginUriProblem(value);
  return problem ? `${value}  [invalid, read as none: ${problem}]` : value;
}

/** What /api/sso/app-ticket will answer for this row with `uri` stored, under the settings `env`. */
function handoffState(row, uri, env) {
  if (!row.enabled) return 'refused (CLIENT_DISABLED): the client is disabled';
  if (!readPartnerConfig(env).enabled) return 'refused (CLIENT_DISABLED): SSO_TGE_ENABLED is off';
  if (!String(env.SSO_SESSION_SECRET || '').trim()) return 'refused (CLIENT_DISABLED): SSO_SESSION_SECRET is not set';
  if (uri === null || uri === undefined || String(uri).trim() === '') return 'refused (CLIENT_DISABLED): no initiate_login_uri';
  if (initiateLoginUriProblem(uri)) return 'refused (CLIENT_DISABLED): the stored initiate_login_uri is invalid';
  return 'available';
}

/**
 * Runs one invocation. `prisma` is the client to use; `env` the settings to compare the client id
 * with; `out` receives each output line. Resolves to an exit code and never throws.
 */
async function run(argv, { prisma, env = process.env, out = (line) => console.log(line) } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    if (error.message) out(`error: ${error.message}`);
    out(USAGE);
    return EXIT.USAGE;
  }
  try {
    const cfg = readPartnerConfig(env);
    if (cfg.clientId && !isRetiredPartnerClientId(cfg.clientId) && samePartnerClientId(cfg.clientId, opts.clientId)) {
      throw new Refusal('this is the environment\'s partner client (SSO_TGE_CLIENT_ID): set SSO_TGE_INITIATE_LOGIN_URI instead');
    }
    let next = null;
    if (opts.uri !== null) {
      const problem = initiateLoginUriProblem(opts.uri);
      if (problem) throw new Refusal(`invalid --uri: ${problem}`);
      next = opts.uri;
    }

    const row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: opts.clientId } });
    if (!row) throw new Refusal(`no database client with client_id "${opts.clientId}"`);
    if (row.kind !== 'partner') {
      throw new Refusal(`client "${row.clientId}" is kind "${row.kind}": the App hand-off is for first-party partner clients only`);
    }
    const before = row.initiateLoginUri ?? null;

    out(`client_id:   ${row.clientId}`);
    out(`client_name: ${row.clientName}`);
    out(`kind:        ${row.kind}`);
    out(`enabled:     ${Boolean(row.enabled)}`);
    out(`before:      ${shown(before)}`);
    if (opts.uri === null && !opts.clear) {
      out(`app hand-off: ${handoffState(row, before, env)}`);
      return EXIT.OK;
    }
    out(`after:       ${shown(next)}`);
    out(`app hand-off: ${handoffState(row, before, env)} -> ${handoffState(row, next, env)}`);
    if (before === next) {
      out('unchanged: nothing to write');
      return EXIT.OK;
    }
    if (!opts.apply) {
      out('dry run: nothing written. Re-run with --apply to write.');
      return EXIT.OK;
    }
    // Kind is part of the write as well as the read, so a row changed in between is not touched.
    const { count } = await prisma.ssoDeveloperClient.updateMany({
      where: { clientId: row.clientId, kind: 'partner' },
      data: { initiateLoginUri: next },
    });
    if (count !== 1) throw new Refusal('the client changed while this ran; nothing written');
    const stored = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: row.clientId } });
    out(`written:     ${shown(stored ? stored.initiateLoginUri ?? null : null)}`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof Refusal) {
      out(`refused: ${error.message}`);
      return EXIT.REFUSED;
    }
    out(`error: ${error && error.message ? error.message : String(error)}`);
    return EXIT.ERROR;
  }
}

if (require.main === module) {
  const prisma = require('../src/utils/prisma');
  run(process.argv.slice(2), { prisma })
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`error: ${error && error.message ? error.message : String(error)}`);
      process.exitCode = EXIT.ERROR;
    })
    .finally(() => prisma.$disconnect());
}

module.exports = { run, parseArgs, EXIT };
