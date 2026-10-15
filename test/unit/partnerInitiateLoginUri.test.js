/**
 * App hand-off for a first-party partner client stored in the database (SsoDeveloperClient, kind
 * "partner"): its initiateLoginUri column is what the environment's SSO_TGE_INITIATE_LOGIN_URI is
 * for the env client. Over HTTP (supertest + the in-memory Prisma stand-in):
 *   - a partner row with a valid URI mints a ticket, its partner_hosts cover that URI, the exchange
 *     returns it as initiate_login_uri, and the session it gives answers that client's consent;
 *   - every existing refusal stays: no URI, an invalid URI (read as none, logged once), a disabled
 *     row, and any developer row whatever its column holds;
 *   - the env client is unchanged and still wins over a row with its id.
 * Plus scripts/setPartnerInitiateLoginUri.js against the same stand-in.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

// Every warning ssoDeveloperClient logs, captured before the module creates its logger.
const loggerModule = require('../../src/utils/logger');
const warnings = [];
const realCreateLogger = loggerModule.createLogger;
loggerModule.createLogger = (name) => {
  const logger = realCreateLogger(name);
  if (name === 'ssoDeveloperClient') {
    logger.warn = (message, meta) => {
      warnings.push({ message, meta });
    };
  }
  return logger;
};

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const REDIRECT = 'https://tge.example.com/oauth/callback';
const INITIATE = 'https://tge.example.com/login/ddc';
const ISSUER = 'https://api.test.local';
const APP_URL = 'https://app.test.local';
const JWT_SECRET = 'ddc-user-session-secret';
const SSO_SESSION_SECRET = 'ddc-sso-session-secret-different';

const ROW_REDIRECT = 'https://planet.example.org/oauth/callback';
const ROW_INITIATE = 'https://login.planet.example.org/ddc/start';

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_NAME: 'DDC TGE',
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  SSO_TGE_INITIATE_LOGIN_URI: INITIATE,
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: APP_URL,
  JWT_SECRET,
  SSO_SESSION_SECRET,
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.SSO_TICKET_TTL_SEC;
delete process.env.SSO_APP_SESSION_TTL_SEC;

const ssoRoutes = require('../../src/routes/ssoRoutes');
const oauthRoutes = require('../../src/routes/oauthRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { initiateLoginUriProblem } = require('../../src/constants/partnerClient');
const { loadPartnerClient } = require('../../src/services/ssoDeveloperClient');
const script = require('../../scripts/setPartnerInitiateLoginUri');

const app = express();
app.use(express.json());
app.use('/api/sso', ssoRoutes);
app.use('/', oauthRoutes);

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const cUser = {
  id: 'user-1',
  email: 'someone@example.com',
  isOrganization: false,
  userType: 'regular',
  web3authVerifier: 'web3auth',
  disabledAt: null,
  createdAt: new Date('2025-05-03T09:12:44Z'),
};

const userJwt = () => jwt.sign({ id: cUser.id }, JWT_SECRET, { expiresIn: '1h' });
const appTicket = (clientId) => request(server)
  .post('/api/sso/app-ticket').set('Authorization', `Bearer ${userJwt()}`).send({ client_id: clientId });
const exchange = (ticket) => request(server).post('/api/sso/ticket/exchange').send({ ticket });

let rowSeq = 0;
async function clientRow(clientId, { kind = 'partner', initiateLoginUri = null, enabled = true, redirectUris = [ROW_REDIRECT] } = {}) {
  rowSeq += 1;
  return prisma.ssoDeveloperClient.create({
    data: {
      id: `row-${rowSeq}`,
      clientId,
      clientName: kind === 'partner' ? 'Data Planet' : 'Northwind',
      contactEmail: 'ops@example.com',
      secretHash: SECRET_HASH,
      redirectUris,
      enabled,
      kind,
      ownerUserId: null,
      initiateLoginUri,
      createdAt: new Date(),
    },
  });
}

/** What /sso/continue does with the exchange (data-dance-frontend buildInitiateLoginUrl). */
function continueTarget(initiateLoginUri, issuer) {
  const sep = initiateLoginUri.includes('?') ? '&' : '?';
  return `${initiateLoginUri}${sep}iss=${encodeURIComponent(issuer)}`;
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

const INVALID = [
  ['http, not https', 'http://login.planet.example.org/ddc'],
  ['http on localhost (production rule)', 'http://localhost:3000/ddc'],
  ['a fragment', 'https://login.planet.example.org/ddc#start'],
  ['not a URL', 'not a url'],
  ['a relative path', '/ddc/start'],
  ['another scheme', 'ftp://login.planet.example.org/ddc'],
  ['javascript:', 'javascript:alert(1)'],
  ['a user name before the host', 'https://login.planet.example.org@other.example/start'],
  ['a user name and password', 'https://ops:pass@login.planet.example.org/ddc'],
  ['a backslash before the host', 'https://other.example\\@login.planet.example.org/'],
  ['a blank inside', 'https://login.planet.example.org/dd c'],
  ['more than 512 characters', `https://login.planet.example.org/${'a'.repeat(480)}`],
];

beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  warnings.length = 0;
  await prisma.user.create({ data: cUser });
});

describe('initiateLoginUriProblem: the production rule for SSO_TGE_INITIATE_LOGIN_URI', () => {
  it('accepts an absolute https URL, with a query, after trimming', () => {
    assert.equal(initiateLoginUriProblem(ROW_INITIATE), '');
    assert.equal(initiateLoginUriProblem(`  ${ROW_INITIATE}?from=ddc  `), '');
  });

  for (const [label, uri] of INVALID) {
    it(`refuses ${label}`, () => {
      assert.notEqual(initiateLoginUriProblem(uri), '');
    });
  }

  it('refuses empty, null and non-string values without throwing', () => {
    for (const value of ['', '   ', null, undefined, 42, {}]) {
      assert.notEqual(initiateLoginUriProblem(value), '', String(value));
    }
  });
});

describe('database partner client with an initiateLoginUri', () => {
  it('mints a ticket whose partner_hosts cover that URI and the redirect URIs', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const res = await appTicket('planet-live');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.data.client_name, 'Data Planet');
    assert.deepEqual(res.body.data.partner_hosts, ['login.planet.example.org', 'planet.example.org']);
    assert.equal(prisma.store.ssoTicket.length, 1);
    assert.equal(prisma.store.ssoTicket[0].clientId, 'planet-live');
  });

  it('the exchange returns it, and /sso/continue sends the browser to it with ?iss=<issuer>', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const minted = await appTicket('planet-live');
    const redeemed = await exchange(minted.body.data.ticket);
    assert.equal(redeemed.status, 200, redeemed.text);
    assert.deepEqual(redeemed.body.data.client, {
      client_id: 'planet-live',
      name: 'Data Planet',
      initiate_login_uri: ROW_INITIATE,
    });
    const metadata = await request(server).get('/.well-known/oauth-authorization-server');
    assert.equal(metadata.body.issuer, ISSUER);
    const target = new URL(continueTarget(redeemed.body.data.client.initiate_login_uri, metadata.body.issuer));
    assert.equal(`${target.origin}${target.pathname}`, ROW_INITIATE);
    assert.equal(target.searchParams.get('iss'), ISSUER);
  });

  it('its session answers that client\'s consent end to end, and stops when the URI is cleared', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const minted = await appTicket('planet-live');
    const session = (await exchange(minted.body.data.ticket)).body.data.session_token;

    // The partner starts /oauth/authorize in the same browser; the consent page answers it.
    const started = await request(server).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: 'planet-live',
      redirect_uri: ROW_REDIRECT,
      state: 'state-with-enough-entropy-1234',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    assert.equal(started.status, 302, started.text);
    const cookie = ((started.headers['set-cookie'] || [])[0] || '').split(';')[0];
    const requestId = new URL(started.headers.location).searchParams.get('request');

    const summary = await request(server).get(`/api/oauth/requests/${requestId}`).set('Authorization', `Bearer ${session}`);
    assert.equal(summary.status, 200, summary.text);
    const consent = await request(server).post('/api/oauth/consent')
      .set('Authorization', `Bearer ${session}`).set('Cookie', cookie).send({ requestId, allow: true });
    assert.equal(consent.status, 200, consent.text);
    const redirectTo = new URL(consent.body.data.redirectTo);
    assert.equal(`${redirectTo.origin}${redirectTo.pathname}`, ROW_REDIRECT);
    assert.match(redirectTo.searchParams.get('code'), /^ddc_code_/);

    // Same check as the env client's kill switch: no hand-off target, no live session.
    await prisma.ssoDeveloperClient.update({ where: { clientId: 'planet-live' }, data: { initiateLoginUri: null } });
    const after = await request(server).get(`/api/oauth/requests/${requestId}`).set('Authorization', `Bearer ${session}`);
    assert.equal(after.status, 401, after.text);
    assert.equal(after.body.code, 'SSO_SESSION_EXPIRED');
  });

  it('is read with surrounding blanks trimmed', async () => {
    await clientRow('planet-live', { initiateLoginUri: `  ${ROW_INITIATE}\n` });
    assert.equal((await loadPartnerClient('planet-live')).initiateLoginUri, ROW_INITIATE);
  });
});

describe('every existing refusal is unchanged', () => {
  it('a database partner client without a URI: 403 CLIENT_DISABLED, no ticket', async () => {
    await clientRow('planet-none');
    await clientRow('planet-empty', { initiateLoginUri: '   ' });
    for (const id of ['planet-none', 'planet-empty']) {
      const res = await appTicket(id);
      assert.equal(res.status, 403, res.text);
      assert.equal(res.body.code, 'CLIENT_DISABLED');
      assert.equal((await loadPartnerClient(id)).initiateLoginUri, '');
    }
    assert.equal(prisma.store.ssoTicket.length, 0);
    assert.equal(warnings.length, 0, 'an absent value is not a problem to report');
  });

  it('a developer client with a valid URI in the column: 403 CLIENT_DISABLED, never read', async () => {
    await clientRow('sso_dev', { kind: 'developer', initiateLoginUri: ROW_INITIATE });
    const res = await appTicket('sso_dev');
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.code, 'CLIENT_DISABLED');
    assert.equal(prisma.store.ssoTicket.length, 0);
    const client = await loadPartnerClient('sso_dev');
    assert.equal(client.developer, true);
    assert.equal(client.initiateLoginUri, '');
  });

  it('a disabled database partner client with a valid URI: 403 CLIENT_DISABLED', async () => {
    await clientRow('planet-off', { initiateLoginUri: ROW_INITIATE, enabled: false });
    const res = await appTicket('planet-off');
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.code, 'CLIENT_DISABLED');
    assert.equal(prisma.store.ssoTicket.length, 0);
  });

  it('a ticket minted before the client lost its URI is refused at exchange', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const minted = await appTicket('planet-live');
    await prisma.ssoDeveloperClient.update({ where: { clientId: 'planet-live' }, data: { initiateLoginUri: 'http://login.planet.example.org/ddc' } });
    const res = await exchange(minted.body.data.ticket);
    assert.equal(res.status, 403, res.text);
    assert.equal(res.body.code, 'CLIENT_DISABLED');
  });

  for (const [label, uri] of INVALID) {
    it(`an invalid stored URI (${label}) reads as absent: 403 CLIENT_DISABLED, logged once by name`, async () => {
      await clientRow('planet-bad', { initiateLoginUri: uri });
      const first = await appTicket('planet-bad');
      const second = await appTicket('planet-bad');
      for (const res of [first, second]) {
        assert.equal(res.status, 403, res.text);
        assert.equal(res.body.code, 'CLIENT_DISABLED');
      }
      assert.equal((await loadPartnerClient('planet-bad')).initiateLoginUri, '');
      assert.equal(prisma.store.ssoTicket.length, 0);
      const mine = warnings.filter((w) => w.meta && w.meta.clientId === 'planet-bad');
      // Each case stores a value no earlier case reported for this client: exactly one line.
      assert.equal(mine.length, 1, `logged ${mine.length} times`);
      for (const w of mine) {
        assert.equal(w.message, 'sso.partner_initiate_login_uri_invalid');
        assert.equal(w.meta.field, 'SsoDeveloperClient.initiateLoginUri');
        assert.equal(JSON.stringify(w).includes(uri), false, 'the stored value is not logged');
      }
    });
  }

  it('logs a bad value once per client and value, not per request', async () => {
    await clientRow('planet-once', { initiateLoginUri: 'http://once.planet.example.org/ddc' });
    for (let i = 0; i < 3; i += 1) await loadPartnerClient('planet-once');
    assert.equal(warnings.filter((w) => w.meta.clientId === 'planet-once').length, 1);
    await prisma.ssoDeveloperClient.update({ where: { clientId: 'planet-once' }, data: { initiateLoginUri: 'https://once.planet.example.org/#x' } });
    for (let i = 0; i < 3; i += 1) await loadPartnerClient('planet-once');
    assert.equal(warnings.filter((w) => w.meta.clientId === 'planet-once').length, 2, 'a new bad value is reported once more');
  });
});

describe('the environment\'s partner client is unchanged', () => {
  it('still hands off to SSO_TGE_INITIATE_LOGIN_URI', async () => {
    const minted = await appTicket('tge-test');
    assert.equal(minted.status, 200, minted.text);
    assert.deepEqual(minted.body.data.partner_hosts, ['tge.example.com']);
    const redeemed = await exchange(minted.body.data.ticket);
    assert.equal(redeemed.body.data.client.initiate_login_uri, INITIATE);
  });

  it('wins over a database row with its id and another URI', async () => {
    await clientRow('tge-test', { initiateLoginUri: ROW_INITIATE });
    const minted = await appTicket('tge-test');
    assert.deepEqual(minted.body.data.partner_hosts, ['tge.example.com']);
    const redeemed = await exchange(minted.body.data.ticket);
    assert.equal(redeemed.body.data.client.initiate_login_uri, INITIATE);
  });

  it('with SSO_TGE_INITIATE_LOGIN_URI empty it is still refused, even with a row carrying a URI', async () => {
    await clientRow('tge-test', { initiateLoginUri: ROW_INITIATE });
    const saved = process.env.SSO_TGE_INITIATE_LOGIN_URI;
    process.env.SSO_TGE_INITIATE_LOGIN_URI = '';
    try {
      const res = await appTicket('tge-test');
      assert.equal(res.status, 403, res.text);
      assert.equal(res.body.code, 'CLIENT_DISABLED');
    } finally {
      process.env.SSO_TGE_INITIATE_LOGIN_URI = saved;
    }
  });
});

describe('scripts/setPartnerInitiateLoginUri.js', () => {
  async function runScript(argv, env = process.env) {
    const lines = [];
    const code = await script.run(argv, { prisma, env, out: (line) => lines.push(line) });
    return { code, text: lines.join('\n') };
  }
  const stored = async (clientId) => (await prisma.ssoDeveloperClient.findUnique({ where: { clientId } })).initiateLoginUri;

  it('shows the current value without writing', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const { code, text } = await runScript(['--client-id', 'planet-live']);
    assert.equal(code, 0, text);
    assert.match(text, /client_name: Data Planet/);
    assert.match(text, new RegExp(`before: +${ROW_INITIATE.replace(/[.]/g, '\\.')}`));
    assert.match(text, /app hand-off: available/);
    assert.equal(text.includes(SECRET_HASH), false, 'never the secret hash');
    assert.equal(text.includes('ops@example.com'), false, 'never the contact e-mail');
  });

  it('dry run by default: prints before and after, writes nothing', async () => {
    await clientRow('planet-none');
    const { code, text } = await runScript(['--client-id', 'planet-none', '--uri', ROW_INITIATE]);
    assert.equal(code, 0, text);
    assert.match(text, /before: +\(none\)/);
    assert.match(text, new RegExp(`after: +${ROW_INITIATE.replace(/[.]/g, '\\.')}`));
    assert.match(text, /refused \(CLIENT_DISABLED\): no initiate_login_uri -> available/);
    assert.match(text, /dry run: nothing written/);
    assert.equal(await stored('planet-none'), null);
  });

  it('--apply writes the trimmed URI and the hand-off starts working', async () => {
    await clientRow('planet-none');
    const { code, text } = await runScript([`--client-id=planet-none`, `--uri=  ${ROW_INITIATE}  `, '--apply']);
    assert.equal(code, 0, text);
    assert.match(text, /written: +https:\/\/login\.planet\.example\.org\/ddc\/start$/m);
    assert.equal(await stored('planet-none'), ROW_INITIATE);
    assert.equal((await appTicket('planet-none')).status, 200);
  });

  it('--clear --apply removes it and the hand-off is refused again', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const dry = await runScript(['--client-id', 'planet-live', '--clear']);
    assert.equal(dry.code, 0, dry.text);
    assert.equal(await stored('planet-live'), ROW_INITIATE, 'the dry run wrote nothing');
    const { code, text } = await runScript(['--client-id', 'planet-live', '--clear', '--apply']);
    assert.equal(code, 0, text);
    assert.match(text, /after: +\(none\)/);
    assert.equal(await stored('planet-live'), null);
    assert.equal((await appTicket('planet-live')).body.code, 'CLIENT_DISABLED');
  });

  it('setting the value already stored writes nothing', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const { code, text } = await runScript(['--client-id', 'planet-live', '--uri', ROW_INITIATE, '--apply']);
    assert.equal(code, 0, text);
    assert.match(text, /unchanged: nothing to write/);
  });

  it('shows a stored invalid value as invalid', async () => {
    await clientRow('planet-bad', { initiateLoginUri: 'http://login.planet.example.org/ddc' });
    const { code, text } = await runScript(['--client-id', 'planet-bad']);
    assert.equal(code, 0, text);
    assert.match(text, /\[invalid, read as none: .*must be https/);
    assert.match(text, /the stored initiate_login_uri is invalid/);
  });

  for (const [label, uri] of INVALID) {
    it(`refuses ${label} with exit 1 and writes nothing, even with --apply`, async () => {
      await clientRow('planet-none');
      const { code, text } = await runScript(['--client-id', 'planet-none', '--uri', uri, '--apply']);
      assert.equal(code, 1, text);
      assert.match(text, /refused: invalid --uri/);
      assert.equal(await stored('planet-none'), null);
    });
  }

  it('refuses a developer client, an unknown client and the environment\'s client', async () => {
    await clientRow('sso_dev', { kind: 'developer' });
    await clientRow('tge-test');
    const developer = await runScript(['--client-id', 'sso_dev', '--uri', ROW_INITIATE, '--apply']);
    assert.equal(developer.code, 1, developer.text);
    assert.match(developer.text, /first-party partner clients only/);
    assert.equal(await stored('sso_dev'), null);

    const unknown = await runScript(['--client-id', 'nope', '--uri', ROW_INITIATE, '--apply']);
    assert.equal(unknown.code, 1, unknown.text);
    assert.match(unknown.text, /no database client/);

    const envClient = await runScript(['--client-id', 'tge-test', '--uri', ROW_INITIATE, '--apply']);
    assert.equal(envClient.code, 1, envClient.text);
    assert.match(envClient.text, /SSO_TGE_INITIATE_LOGIN_URI instead/);
    assert.equal(await stored('tge-test'), null);
  });

  it('answers usage errors with exit 2', async () => {
    for (const argv of [
      [],
      ['--uri', ROW_INITIATE],
      ['--client-id', 'planet-live', '--uri', ROW_INITIATE, '--clear'],
      ['--client-id', 'planet-live', '--apply'],
      ['--client-id', 'planet-live', '--uri'],
      ['--client-id', 'planet-live', '--uri='],
      ['--client-id', 'planet-live', '--bogus'],
      ['--help'],
    ]) {
      const { code, text } = await runScript(argv);
      assert.equal(code, 2, `${argv.join(' ')}: ${text}`);
      assert.match(text, /^usage: /m);
    }
  });
});

describe('the URI rule: user name, blanks, backslashes and length', () => {
  it('accepts exactly 512 characters', () => {
    const uri = `https://login.planet.example.org/${'a'.repeat(479)}`;
    assert.equal(uri.length, 512);
    assert.equal(initiateLoginUriProblem(uri), '');
  });

  it('never repeats a password in its message', () => {
    const problem = initiateLoginUriProblem('https://ops:pw-in-uri@login.planet.example.org/ddc');
    assert.match(problem, /user name or password/);
    assert.match(problem, /login\.planet\.example\.org/);
    assert.equal(problem.includes('pw-in-uri'), false, problem);
  });

  it('leaves the user name and password out when the value does not parse', () => {
    for (const uri of [
      'https://ops:pw-in-uri@login.planet.example.org:99999/ddc',
      'https://ops:pw-in-uri@login.planet exa.org/ddc',
    ]) {
      const problem = initiateLoginUriProblem(uri);
      assert.match(problem, /is not an absolute URL/);
      assert.equal(problem.includes('pw-in-uri'), false, problem);
      assert.equal(problem.includes('ops'), false, problem);
    }
  });

  it('the console refuses blanks and backslashes in a redirect URI, as the partner rule does', async () => {
    const { createDeveloperClient, DeveloperClientError } = require('../../src/services/ssoDeveloperClient');
    for (const uri of ['https://other.example\\@planet.example.org/cb', 'https://planet.example.org/c b']) {
      await assert.rejects(
        () => createDeveloperClient({ client_name: 'Northwind', contact_email: 'dev@example.com', redirect_uris: [uri] }),
        (error) => error instanceof DeveloperClientError && error.code === 'invalid_redirect_uri',
        uri,
      );
    }
  });

  it('the boot check applies the same rule to SSO_TGE_REDIRECT_URIS and SSO_TGE_INITIATE_LOGIN_URI', () => {
    const { assertPartnerConfig } = require('../../src/constants/partnerClient');
    assert.doesNotThrow(() => assertPartnerConfig({ ...process.env }));
    for (const [name, value] of [
      ['SSO_TGE_REDIRECT_URIS', 'https://tge.example.com@other.example/oauth/callback'],
      ['SSO_TGE_REDIRECT_URIS', 'https://other.example\\@tge.example.com/oauth/callback'],
      ['SSO_TGE_INITIATE_LOGIN_URI', 'https://ops:pw-in-uri@tge.example.com/login/ddc'],
      ['SSO_TGE_INITIATE_LOGIN_URI', 'https://ops:pw-in-uri@tge.example.com:99999/login/ddc'],
    ]) {
      assert.throws(() => assertPartnerConfig({ ...process.env, [name]: value }), (error) => {
        assert.match(error.message, new RegExp(`${name}: .*(user name or password|blanks or backslashes|not an absolute URL)`));
        assert.equal(error.message.includes('pw-in-uri'), false, error.message);
        return true;
      }, `${name}=${value}`);
    }
  });
});

describe('the kill switch and the session key cover a database partner client', () => {
  async function openSession(clientId) {
    const minted = await appTicket(clientId);
    assert.equal(minted.status, 200, minted.text);
    const session = (await exchange(minted.body.data.ticket)).body.data.session_token;
    const started = await request(server).get('/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: ROW_REDIRECT,
      state: 'state-with-enough-entropy-1234',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
    });
    assert.equal(started.status, 302, started.text);
    return {
      session,
      cookie: ((started.headers['set-cookie'] || [])[0] || '').split(';')[0],
      requestId: new URL(started.headers.location).searchParams.get('request'),
    };
  }

  it('SSO_TGE_ENABLED=false: no URI, 403 CLIENT_DISABLED, no ticket, and an open session is refused', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const { session, requestId } = await openSession('planet-live');
    const ticketsBefore = prisma.store.ssoTicket.length;
    const saved = process.env.SSO_TGE_ENABLED;
    process.env.SSO_TGE_ENABLED = 'false';
    try {
      assert.equal((await loadPartnerClient('planet-live')).initiateLoginUri, '');
      const res = await appTicket('planet-live');
      assert.equal(res.status, 403, res.text);
      assert.equal(res.body.code, 'CLIENT_DISABLED');
      assert.equal(prisma.store.ssoTicket.length, ticketsBefore, 'no ticket minted');
      const summary = await request(server).get(`/api/oauth/requests/${requestId}`).set('Authorization', `Bearer ${session}`);
      assert.equal(summary.status, 401, summary.text);
      assert.equal(summary.body.code, 'SSO_SESSION_EXPIRED');
    } finally {
      process.env.SSO_TGE_ENABLED = saved;
    }
    assert.equal((await appTicket('planet-live')).status, 200, 'switching back on restores the hand-off');
  });

  it('the script says the hand-off is refused while SSO_TGE_ENABLED is off or SSO_SESSION_SECRET is unset', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const lines = [];
    const out = (line) => lines.push(line);
    assert.equal(await script.run(['--client-id', 'planet-live'], { prisma, env: { ...process.env, SSO_TGE_ENABLED: 'false' }, out }), 0);
    assert.match(lines.join('\n'), /app hand-off: refused \(CLIENT_DISABLED\): SSO_TGE_ENABLED is off/);
    lines.length = 0;
    const noKey = { ...process.env };
    delete noKey.SSO_SESSION_SECRET;
    assert.equal(await script.run(['--client-id', 'planet-live'], { prisma, env: noKey, out }), 0);
    assert.match(lines.join('\n'), /app hand-off: refused \(CLIENT_DISABLED\): SSO_SESSION_SECRET is not set/);
  });

  it('without SSO_SESSION_SECRET: 403 CLIENT_DISABLED before any ticket is minted, for both kinds of partner client', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    const saved = process.env.SSO_SESSION_SECRET;
    delete process.env.SSO_SESSION_SECRET;
    try {
      for (const clientId of ['planet-live', 'tge-test']) {
        const res = await appTicket(clientId);
        assert.equal(res.status, 403, `${clientId}: ${res.text}`);
        assert.equal(res.body.code, 'CLIENT_DISABLED');
      }
      assert.equal(prisma.store.ssoTicket.length, 0);
    } finally {
      process.env.SSO_SESSION_SECRET = saved;
    }
  });
});

describe('SSO_TGE_AUTO_APPROVE and a database partner client', () => {
  function withAutoApprove(value, fn) {
    const saved = process.env.SSO_TGE_AUTO_APPROVE;
    process.env.SSO_TGE_AUTO_APPROVE = value;
    return Promise.resolve().then(fn).finally(() => {
      if (saved === undefined) delete process.env.SSO_TGE_AUTO_APPROVE;
      else process.env.SSO_TGE_AUTO_APPROVE = saved;
    });
  }

  it('applies to a first-party row as to the environment\'s client, never to a developer row', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    await clientRow('sso_dev', { kind: 'developer', initiateLoginUri: ROW_INITIATE });
    await withAutoApprove('app', async () => {
      assert.deepEqual((await loadPartnerClient('planet-live')).autoApprove, { app: true, web: false });
      assert.deepEqual((await loadPartnerClient('sso_dev')).autoApprove, { app: false, web: false });
    });
    await withAutoApprove('off', async () => {
      assert.deepEqual((await loadPartnerClient('planet-live')).autoApprove, { app: false, web: false });
    });
  });

  it('with app: an App-entry Allow posted with auto:true is accepted for that row; with off it is not', async () => {
    await clientRow('planet-live', { initiateLoginUri: ROW_INITIATE });
    await withAutoApprove('app', async () => {
      const minted = await appTicket('planet-live');
      const session = (await exchange(minted.body.data.ticket)).body.data.session_token;
      const started = await request(server).get('/oauth/authorize').query({
        response_type: 'code',
        client_id: 'planet-live',
        redirect_uri: ROW_REDIRECT,
        state: 'state-with-enough-entropy-1234',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      });
      const cookie = ((started.headers['set-cookie'] || [])[0] || '').split(';')[0];
      const requestId = new URL(started.headers.location).searchParams.get('request');
      const consent = await request(server).post('/api/oauth/consent')
        .set('Authorization', `Bearer ${session}`).set('Cookie', cookie).send({ requestId, allow: true, auto: true });
      assert.equal(consent.status, 200, consent.text);
      assert.match(new URL(consent.body.data.redirectTo).searchParams.get('code'), /^ddc_code_/);
    });
    await withAutoApprove('off', async () => {
      const minted = await appTicket('planet-live');
      const session = (await exchange(minted.body.data.ticket)).body.data.session_token;
      const started = await request(server).get('/oauth/authorize').query({
        response_type: 'code',
        client_id: 'planet-live',
        redirect_uri: ROW_REDIRECT,
        state: 'state-with-enough-entropy-5678',
        code_challenge: pkce().challenge,
        code_challenge_method: 'S256',
      });
      const cookie = ((started.headers['set-cookie'] || [])[0] || '').split(';')[0];
      const requestId = new URL(started.headers.location).searchParams.get('request');
      const consent = await request(server).post('/api/oauth/consent')
        .set('Authorization', `Bearer ${session}`).set('Cookie', cookie).send({ requestId, allow: true, auto: true });
      assert.notEqual(consent.status, 200, consent.text);
    });
  });
});
