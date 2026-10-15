/**
 * App hand-off for a database partner client, on REAL Postgres (`npm run test:db`; needs
 * TEST_DATABASE_URL pointing at a throwaway, migrated database whose name contains "test").
 *
 * The migration adds SsoDeveloperClient.initiateLoginUri as a nullable text column and is safe to
 * run again. Through the real routes (src/routes/ssoRoutes.js, with authMiddleware.protect reading
 * the account from Postgres): a partner row with a valid URI mints a ticket and the exchange returns
 * that URI; a partner row without one, with an invalid one, and a developer row with one are all
 * refused as before; the environment's client is unchanged. scripts/setPartnerInitiateLoginUri.js
 * shows, dry-runs, writes and clears the column. Fixture rows carry a per-run prefix and are
 * deleted afterwards.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');

const RUN = `iu${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const JWT_SECRET = `initiate-uri-db-${crypto.randomBytes(8).toString('hex')}`;
const SECRET_HASH = crypto.createHash('sha256').update('not-used').digest('hex');
const ISSUER = 'https://api.test.local';
const ENV_REDIRECT = 'https://tge.example.com/oauth/callback';
const ENV_INITIATE = 'https://tge.example.com/login/ddc';
const ROW_REDIRECT = 'https://planet.example.org/oauth/callback';
const ROW_INITIATE = 'https://login.planet.example.org/ddc/start';
const MIGRATION = path.join(__dirname, '../../prisma/migrations/20261015180000_sso_partner_initiate_login_uri/migration.sql');

Object.assign(process.env, {
  DATABASE_URL: url,
  LOG_LEVEL: 'error',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: id('env'),
  SSO_TGE_CLIENT_NAME: 'DDC TGE',
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: ENV_REDIRECT,
  SSO_TGE_INITIATE_LOGIN_URI: ENV_INITIATE,
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET,
  SSO_SESSION_SECRET: `${JWT_SECRET}-sso`,
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;

const prisma = require('../../src/utils/prisma');
const ssoRoutes = require('../../src/routes/ssoRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { listenLoopback } = require('../helpers/loopbackServer');
const script = require('../../scripts/setPartnerInitiateLoginUri');

const app = express();
app.use(express.json());
app.use('/api/sso', ssoRoutes);

let server;
const userJwt = () => jwt.sign({ id: id('user') }, JWT_SECRET, { expiresIn: '5m' });
const appTicket = (clientId) => request(server)
  .post('/api/sso/app-ticket').set('Authorization', `Bearer ${userJwt()}`).send({ client_id: clientId });
const exchange = (ticket) => request(server).post('/api/sso/ticket/exchange').send({ ticket });
const stored = async (clientId) => (await prisma.ssoDeveloperClient.findUnique({ where: { clientId } })).initiateLoginUri;

async function clientRow(name, { kind = 'partner', initiateLoginUri = null } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "SsoDeveloperClient"(id, "clientId", "clientName", "contactEmail", "secretHash", "redirectUris", enabled, kind, "initiateLoginUri")
     VALUES ($1, $1, $2, $3, $4, ARRAY[$5]::text[], true, $6, $7)`,
    id(name), kind === 'partner' ? 'Data Planet' : 'Northwind', `${RUN}@example.test`, SECRET_HASH, ROW_REDIRECT, kind, initiateLoginUri,
  );
}

async function runScript(argv) {
  const lines = [];
  const code = await script.run(argv, { prisma, out: (line) => lines.push(line) });
  return { code, text: lines.join('\n') };
}

describe('database partner client initiate_login_uri, on Postgres', () => {
  before(async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "User"(id, email, "referralCode", "authType", "updatedAt") VALUES ($1, $2, $3, 'web3auth', now())`,
      id('user'), `${RUN}-user@example.test`, id('user').toUpperCase(),
    );
    await clientRow('planet', { initiateLoginUri: ROW_INITIATE });
    await clientRow('planet-none');
    await clientRow('planet-bad', { initiateLoginUri: 'http://login.planet.example.org/ddc' });
    await clientRow('dev', { kind: 'developer', initiateLoginUri: ROW_INITIATE });
    server = await listenLoopback(app);
  });

  beforeEach(() => clearRateLimitStore());

  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "SsoTicket" WHERE "userId" LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "SsoDeveloperClient" WHERE "clientId" LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  it('the column is nullable text with no default, and the migration can run again', async () => {
    const [column] = await prisma.$queryRawUnsafe(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'SsoDeveloperClient' AND column_name = 'initiateLoginUri'`,
    );
    assert.deepEqual(column, { data_type: 'text', is_nullable: 'YES', column_default: null });
    await prisma.$executeRawUnsafe(fs.readFileSync(MIGRATION, 'utf8'));
    assert.equal(await stored(id('planet')), ROW_INITIATE, 'a second run keeps the rows');
    assert.equal(await stored(id('planet-none')), null);
  });

  it('a partner row with a valid URI mints a ticket and the exchange returns that URI', async () => {
    const minted = await appTicket(id('planet'));
    assert.equal(minted.status, 200, minted.text);
    assert.deepEqual(minted.body.data.partner_hosts, ['login.planet.example.org', 'planet.example.org']);
    const redeemed = await exchange(minted.body.data.ticket);
    assert.equal(redeemed.status, 200, redeemed.text);
    assert.deepEqual(redeemed.body.data.client, { client_id: id('planet'), name: 'Data Planet', initiate_login_uri: ROW_INITIATE });
    // What /sso/continue opens next.
    const target = new URL(`${redeemed.body.data.client.initiate_login_uri}?iss=${encodeURIComponent(ISSUER)}`);
    assert.equal(`${target.origin}${target.pathname}`, ROW_INITIATE);
    assert.equal(target.searchParams.get('iss'), ISSUER);
  });

  it('no URI, an invalid URI and a developer row with a URI are all 403 CLIENT_DISABLED, with no ticket', async () => {
    for (const name of ['planet-none', 'planet-bad', 'dev']) {
      const res = await appTicket(id(name));
      assert.equal(res.status, 403, `${name}: ${res.text}`);
      assert.equal(res.body.code, 'CLIENT_DISABLED', name);
      assert.equal(await prisma.ssoTicket.count({ where: { clientId: id(name) } }), 0, name);
    }
  });

  it('the environment\'s client still hands off to SSO_TGE_INITIATE_LOGIN_URI', async () => {
    const minted = await appTicket(id('env'));
    assert.equal(minted.status, 200, minted.text);
    assert.deepEqual(minted.body.data.partner_hosts, ['tge.example.com']);
    const redeemed = await exchange(minted.body.data.ticket);
    assert.equal(redeemed.body.data.client.initiate_login_uri, ENV_INITIATE);
  });

  it('the operator script shows, dry-runs, applies and clears', async () => {
    const shown = await runScript(['--client-id', id('planet-none')]);
    assert.equal(shown.code, 0, shown.text);
    assert.match(shown.text, /before: +\(none\)/);

    const dry = await runScript(['--client-id', id('planet-none'), '--uri', ROW_INITIATE]);
    assert.equal(dry.code, 0, dry.text);
    assert.match(dry.text, /dry run: nothing written/);
    assert.equal(await stored(id('planet-none')), null);

    const applied = await runScript(['--client-id', id('planet-none'), '--uri', ROW_INITIATE, '--apply']);
    assert.equal(applied.code, 0, applied.text);
    assert.equal(await stored(id('planet-none')), ROW_INITIATE);
    assert.equal((await appTicket(id('planet-none'))).status, 200, 'the next request sees it');

    const cleared = await runScript(['--client-id', id('planet-none'), '--clear', '--apply']);
    assert.equal(cleared.code, 0, cleared.text);
    assert.equal(await stored(id('planet-none')), null);
    assert.equal((await appTicket(id('planet-none'))).body.code, 'CLIENT_DISABLED');
  });

  it('the operator script refuses a developer row, an invalid URI and the environment\'s client', async () => {
    const developer = await runScript(['--client-id', id('dev'), '--clear', '--apply']);
    assert.equal(developer.code, 1, developer.text);
    assert.equal(await stored(id('dev')), ROW_INITIATE, 'a developer row is never written');

    const invalid = await runScript(['--client-id', id('planet'), '--uri', 'https://login.planet.example.org/#x', '--apply']);
    assert.equal(invalid.code, 1, invalid.text);
    assert.equal(await stored(id('planet')), ROW_INITIATE);

    const envClient = await runScript(['--client-id', id('env'), '--uri', ROW_INITIATE, '--apply']);
    assert.equal(envClient.code, 1, envClient.text);
    assert.match(envClient.text, /SSO_TGE_INITIATE_LOGIN_URI instead/);
  });
});
