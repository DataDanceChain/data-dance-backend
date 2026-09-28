/**
 * POST /partner/tge/referral/bind/check + /referral/bind on the REAL src/app — decision 30 A (Sloan,
 * 2026-09-28): the TGE partner binds an invite code as the signed-in user's inviter; item 35 (same
 * day): two steps, check then confirm, and the scope may be auto-approved. DB-less
 * (test/helpers/mockPrisma).
 *
 * Covered: every outcome of both steps (valid, bound, already, already_referred, invalid_code,
 * self_referral, referral_cycle, invalid_request); the confirmation (428 without it; 400
 * invalid_confirmation when expired, too early, for another user / client / code, tampered or
 * signed with another key; replay is idempotent; a stale token for another code cannot move the
 * inviter); the scope (advertised, listed on consent as `referral_bind`, never default-granted, 403
 * without it, auto-approvable with SSO_TGE_AUTO_APPROVE once PR #8 is in); the environment switch
 * SSO_TGE_REFERRAL_BIND (default off → 404 not_available, answered before the scope; also
 * invalid_scope at /oauth/authorize and absent from scopes_supported); the referral kill switch;
 * account_disabled; the per-token limit shared by both steps; the audit lines (never a token,
 * never the whole code); that the bind goes through the late-bind lock shared with
 * /api/referrals/use-code; races for the same user; and that every OTHER partner route — /check
 * included — is still behind the read-only guard. Races that need a real lock run on Postgres in
 * test/db/partnerReferralBind.dbtest.js.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');

const { installMockPrisma, matches } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const SECRET = 'tge-secret-dev';
const REDIRECT = 'https://tge.example.com/oauth/callback';
Object.assign(process.env, {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update(SECRET).digest('hex'),
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  SSO_TGE_STATUS_FIELDS: 'registered_at,wallet_bound,referral',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'ddc-user-session-secret',
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;
delete process.env.DISABLE_REFERRAL_REWARDS_FEATURES;

// The code lookup is a raw case-insensitive query on the real client; answer it from the mock rows.
// Patched on the module object BEFORE the app loads, so referralService picks it up.
const referralUtils = require('../../src/utils/referralUtils');
// Like the real lookup: case, spaces and hyphens do not matter, and a legacy code finds its owner.
const lookupKey = (value) => String(value || '').replace(/[\s-]+/g, '').toLowerCase();
referralUtils.findUserByReferralCode = async (code) => {
  const wanted = lookupKey(code);
  const u = wanted
    ? prisma.user.rows.find((row) => lookupKey(row.referralCode) === wanted || lookupKey(row.legacyReferralCode) === wanted)
    : null;
  return u ? { id: u.id, email: u.email, name: u.name, referralCode: u.referralCode } : null;
};
// Rewards stay deferred (nobody has uploaded), so no Point / task rows are needed.
const firstValidUpload = require('../../src/utils/firstValidUpload');
firstValidUpload.hasCompletedFirstValidUpload = async () => false;

// The mock declares no Referral relations and no unique index; give Referral the two things the
// real schema has that this path relies on: `include: { inviter }` and a unique inviteeId (P2002).
prisma.referral.findUnique = async ({ where, include } = {}) => {
  const row = prisma.referral.rows.find((r) => matches(r, where));
  if (!row) return null;
  const out = { ...row };
  if (include && include.inviter) {
    const inviter = prisma.user.rows.find((u) => u.id === row.inviterId);
    out.inviter = inviter ? { id: inviter.id, name: inviter.name } : null;
  }
  return out;
};
const originalReferralCreate = prisma.referral.create;
prisma.referral.create = async (args) => {
  if (prisma.referral.rows.some((r) => r.inviteeId === args.data.inviteeId)) {
    const err = new Error('Unique constraint failed on the fields: (`inviteeId`)');
    err.code = 'P2002';
    throw err;
  }
  return originalReferralCreate(args);
};

const app = require('../../src/app');
const { startAuthorization, decideConsent, getConsentRequest, issuedTokensByCode } = require('../../src/services/oauthService');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const partnerTgeRoutes = require('../../src/routes/partnerTgeRoutes');
const { PARTNER_SCOPES, PARTNER_DEFAULT_SCOPE } = require('../../src/constants/partnerClient');
const confirm = require('../../src/services/referralBindConfirm');

// The confirmation clock is injectable: every test runs on a frozen time it moves by hand.
let NOW = 0;
confirm.clock.now = () => NOW;
const advance = (ms) => { NOW += ms; };

const { bindLog, readOnlyRequest } = partnerTgeRoutes;
const LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext('ddc:referral-late-bind'))";
const lockCount = () => prisma.rawStatements.filter((r) => r.sql === LOCK_SQL).length;

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const ME = 'user-bind-me';
const CODES = { [ME]: 'MEME23', alice: 'ALIC23', bob: 'BOBB23', carol: 'CARO23' };
const basic = `Basic ${Buffer.from(`tge-test:${SECRET}`).toString('base64')}`;
const FULL = 'tge:identity tge:referral_bind';

function addUser(id) {
  prisma.user.rows.push({
    id,
    email: `${id}@example.com`,
    name: id,
    isOrganization: false,
    userType: 'regular',
    disabledAt: null,
    createdAt: new Date('2025-01-01T00:00:00Z'),
    referralCode: CODES[id],
  });
}
function invite(inviter, invitee) {
  prisma.referral.rows.push({ id: `r-${inviter}-${invitee}`, inviterId: inviter, inviteeId: invitee, code: CODES[inviter], campaignSlug: null, createdAt: new Date() });
}
const inviterOf = (id) => prisma.referral.rows.find((r) => r.inviteeId === id)?.inviterId ?? null;
const meUser = () => prisma.user.rows.find((u) => u.id === ME);

async function mintToken(scope) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const consentUrl = await startAuthorization({ get: () => '' }, {
    response_type: 'code', client_id: 'tge-test', redirect_uri: REDIRECT, scope,
    state: crypto.randomBytes(18).toString('base64url'), code_challenge: challenge, code_challenge_method: 'S256',
  });
  const requestId = new URL(consentUrl).searchParams.get('request');
  const summary = await getConsentRequest(requestId);
  const redirectTo = await decideConsent(meUser(), requestId, true, { kind: 'user_jwt', claims: { ver: 2 } });
  const code = new URL(redirectTo).searchParams.get('code');
  const res = await request(server).post('/oauth/token').type('form').set('Authorization', basic)
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(res.status, 200, res.text);
  return { token: res.body.access_token, tokenScope: res.body.scope, scopeItems: summary.scopeItems };
}

const post = (path, token, body) => request(server).post(path).set('Authorization', `Bearer ${token}`).send(body);
const check = (token, body) => post('/partner/tge/referral/bind/check', token, body);
const bindRaw = (token, body) => post('/partner/tge/referral/bind', token, body);

/** A confirmation exactly as /check issues it, issued `ageMs` ago (default: a valid 1.5 s-old one). */
function tokenFor(code, { clientId = 'tge-test', userId = ME, ageMs = 1500 } = {}) {
  NOW -= ageMs;
  try {
    return confirm.issueConfirmToken({ clientId, userId, code }).token;
  } finally {
    NOW += ageMs;
  }
}

/**
 * The bind step on its own: attaches a valid confirmation for the body's code (as if /check had
 * answered it), so the outcome tests below exercise what the bind itself decides — the state may
 * change between the two steps. A body without a string code is sent untouched.
 */
const bind = (token, body) => bindRaw(
  token,
  typeof body.code === 'string' && body.confirm_token === undefined ? { ...body, confirm_token: tokenFor(body.code) } : body,
);

/** The full flow a partner runs: check, the user's own confirmation (> 1 s), bind. */
async function checkThenBind(token, code) {
  const checked = await check(token, { code });
  assert.equal(checked.status, 200, checked.text);
  advance(1000);
  return bindRaw(token, { code: checked.body.code, confirm_token: checked.body.confirm_token });
}

function captureBindLog() {
  const entries = [];
  const original = bindLog.write;
  bindLog.write = (event, entry) => entries.push({ event, ...entry });
  return { entries, restore: () => { bindLog.write = original; } };
}

beforeEach(() => {
  NOW = Date.parse('2026-09-28T10:00:00Z');
  clearRateLimitStore();
  prisma.reset();
  issuedTokensByCode.clear();
  ['user-bind-me', 'alice', 'bob', 'carol'].forEach(addUser);
  process.env.SSO_TGE_REFERRAL_BIND = 'true';
  delete process.env.DISABLE_REFERRAL_REWARDS_FEATURES;
});

describe('scope tge:referral_bind', () => {
  it('is advertised, echoed by /oauth/token and listed on consent as `referral_bind`', async () => {
    assert.ok(PARTNER_SCOPES.includes('tge:referral_bind'));
    const meta = await request(server).get('/.well-known/oauth-authorization-server');
    assert.ok(meta.body.scopes_supported.includes('tge:referral_bind'));
    const { tokenScope, scopeItems } = await mintToken(FULL);
    assert.equal(tokenScope, FULL);
    assert.deepEqual(scopeItems, ['identity', 'referral_bind']);
  });

  it('is never default-granted: an authorization without a scope gets tge:identity only', async () => {
    assert.ok(!PARTNER_DEFAULT_SCOPE.split(/\s+/).includes('tge:referral_bind'));
    const { tokenScope, token } = await mintToken('');
    assert.equal(tokenScope, 'tge:identity');
    const res = await bind(token, { code: CODES.alice });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'insufficient_scope');
    assert.equal(inviterOf(ME), null);
  });

  it('403 insufficient_scope for a token with every read scope but not this one', async () => {
    const { token } = await mintToken('tge:identity tge:status tge:referral');
    const res = await bind(token, { code: CODES.alice });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'insufficient_scope');
    assert.match(res.headers['www-authenticate'], /scope="tge:referral_bind"/);
    assert.equal(inviterOf(ME), null);
  });
});

async function authorize(scope) {
  const consentUrl = await startAuthorization({ get: () => '' }, {
    response_type: 'code', client_id: 'tge-test', redirect_uri: REDIRECT, scope,
    state: crypto.randomBytes(18).toString('base64url'),
    code_challenge: crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url'), code_challenge_method: 'S256',
  });
  return new URL(consentUrl).searchParams.get('request');
}
const userJwt = () => require('jsonwebtoken').sign({ id: ME, ver: 2 }, process.env.JWT_SECRET, { expiresIn: '1h' });
const liveRequest = (id) => prisma.oAuthAuthorization.rows.find((r) => r.id === id && !r.consumedAt && !r.codeHash);

describe('the consent for the write opens only with its switch', () => {
  it('switch off: /oauth/authorize answers invalid_scope for tge:referral_bind and no metadata lists it', async () => {
    for (const value of [undefined, 'false']) {
      if (value === undefined) delete process.env.SSO_TGE_REFERRAL_BIND;
      else process.env.SSO_TGE_REFERRAL_BIND = value;
      await assert.rejects(authorize(FULL), (e) => e.error === 'invalid_scope' && /tge:referral_bind/.test(e.description));
      await assert.rejects(authorize('tge:referral_bind'), (e) => e.error === 'invalid_scope');
      const as = await request(server).get('/.well-known/oauth-authorization-server');
      assert.ok(!as.body.scopes_supported.includes('tge:referral_bind'), String(value));
      assert.ok(as.body.scopes_supported.includes('tge:referral_network'));
      const pr = await request(server).get('/.well-known/oauth-protected-resource/partner/tge');
      assert.deepEqual(pr.body.scopes_supported, PARTNER_SCOPES.filter((item) => item !== 'tge:referral_bind'));
    }
    // Every read scope is still served while the write is off.
    const { tokenScope } = await mintToken('tge:identity tge:status tge:referral');
    assert.equal(tokenScope, 'tge:identity tge:status tge:referral');
  });

  it('switch on: advertised on both metadata documents', async () => {
    const pr = await request(server).get('/.well-known/oauth-protected-resource/partner/tge');
    assert.deepEqual(pr.body.scopes_supported, [...PARTNER_SCOPES]);
  });

  it('switch turned off between authorize and Allow: the request ends as invalid_scope, no code is minted', async () => {
    const requestId = await authorize(FULL);
    process.env.SSO_TGE_REFERRAL_BIND = 'false';
    const redirectTo = await decideConsent(meUser(), requestId, true, { kind: 'user_jwt', claims: { ver: 2 } });
    const params = new URL(redirectTo).searchParams;
    assert.equal(params.get('error'), 'invalid_scope');
    assert.equal(params.get('code'), null);
    assert.equal(liveRequest(requestId), undefined);
  });

});

describe('auto-approved like the read scopes (item 35; SSO_TGE_AUTO_APPROVE, backend PR #8)', () => {
  // Before #8 is merged nothing reads `auto`, so these pass trivially; after it, #8's own gate
  // decides — and nothing here stops the bind scope any more.
  const APP = { kind: 'sso_ticket', clientId: 'tge-test' };
  const WEB = { kind: 'user_jwt', claims: { ver: 2 } };
  beforeEach(() => { process.env.SSO_TGE_AUTO_APPROVE = 'app,web'; });
  after(() => { delete process.env.SSO_TGE_AUTO_APPROVE; });

  it('an automatic Allow of a consent carrying tge:referral_bind mints a code, from the App and from the web', async () => {
    for (const ctx of [APP, WEB]) {
      const requestId = await authorize(FULL);
      const redirectTo = await decideConsent(meUser(), requestId, true, { ...ctx, auto: true });
      assert.ok(new URL(redirectTo).searchParams.get('code'), ctx.kind);
      assert.equal(liveRequest(requestId), undefined);
    }
    assert.equal(inviterOf(ME), null, 'a consent never binds anything by itself');
  });

  it('GET /api/oauth/requests/:id: the Wallet hint is not turned off for the write scope', async () => {
    const requestId = await authorize(FULL);
    const res = await request(server).get(`/api/oauth/requests/${requestId}`).set('Authorization', `Bearer ${userJwt()}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.data.scopeItems, ['identity', 'referral_bind']);
    // Present only once PR #8 is merged.
    if (res.body.data.autoApprove) assert.deepEqual(res.body.data.autoApprove, { app: true, web: true });
  });

  it('switch turned off after authorize: an automatic Allow also ends as invalid_scope, no code', async () => {
    const requestId = await authorize(FULL);
    process.env.SSO_TGE_REFERRAL_BIND = 'false';
    const redirectTo = await decideConsent(meUser(), requestId, true, { ...WEB, auto: true });
    assert.equal(new URL(redirectTo).searchParams.get('error'), 'invalid_scope');
    assert.equal(new URL(redirectTo).searchParams.get('code'), null);
  });

  it('a Deny of a consent carrying the write scope still goes through', async () => {
    const requestId = await authorize(FULL);
    const redirectTo = await decideConsent(meUser(), requestId, false, WEB);
    assert.equal(new URL(redirectTo).searchParams.get('error'), 'access_denied');
  });
});

describe('gates in front of the write', () => {
  it('401 without a token', async () => {
    const res = await request(server).post('/partner/tge/referral/bind').send({ code: CODES.alice });
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'invalid_token');
  });

  it('SSO_TGE_REFERRAL_BIND unset / not "true" → 404 not_available, before the scope, writing nothing', async () => {
    const { token: withScope } = await mintToken(FULL);
    const { token: withoutScope } = await mintToken('tge:identity');
    for (const value of [undefined, 'false', '1', 'yes']) {
      if (value === undefined) delete process.env.SSO_TGE_REFERRAL_BIND;
      else process.env.SSO_TGE_REFERRAL_BIND = value;
      const res = await bind(withScope, { code: CODES.alice });
      assert.equal(res.status, 404, String(value));
      assert.equal(res.body.error, 'not_available');
      assert.equal((await bind(withoutScope, { code: CODES.alice })).status, 404, '"not served here" is answered before "not granted"');
    }
    assert.equal(inviterOf(ME), null);
  });

  it('DISABLE_REFERRAL_REWARDS_FEATURES=true → 403 like /api/referrals, writing nothing', async () => {
    const { token } = await mintToken(FULL);
    process.env.DISABLE_REFERRAL_REWARDS_FEATURES = 'true';
    const res = await bind(token, { code: CODES.alice });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'referral_features_disabled');
    assert.equal(inviterOf(ME), null);
    assert.equal(lockCount(), 0);
  });

  it('403 account_disabled', async () => {
    const { token } = await mintToken(FULL);
    meUser().disabledAt = new Date();
    const res = await bind(token, { code: CODES.alice });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'account_disabled');
    assert.equal(inviterOf(ME), null);
  });

  it('400 invalid_request: no code, a non-string, an over-long code, or a sub/user_id in the query or body', async () => {
    const { token } = await mintToken(FULL);
    for (const body of [{}, { code: '' }, { code: '   ' }, { code: 123 }, { code: ['ALIC23'] }, { code: 'A'.repeat(65) },
      { code: CODES.alice, sub: 'alice' }, { code: CODES.alice, user_id: 'alice' }]) {
      const res = await bind(token, body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error, 'invalid_request');
    }
    const q = await request(server).post('/partner/tge/referral/bind?sub=alice').set('Authorization', `Bearer ${token}`).send({ code: CODES.alice });
    assert.equal(q.status, 400);
    assert.equal(inviterOf(ME), null);
  });

  it('10 attempts a minute per access token, then 429 slow_down; another token has its own budget', async () => {
    const { token } = await mintToken(FULL);
    for (let i = 0; i < 10; i += 1) assert.equal((await bind(token, { code: `NOPE${i}` })).status, 404);
    const limited = await bind(token, { code: CODES.alice });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'slow_down');
    assert.ok(Number(limited.headers['retry-after']) >= 1);
    assert.equal(inviterOf(ME), null, 'the limited attempt did not bind');
    const { token: other } = await mintToken(FULL);
    assert.equal((await bind(other, { code: CODES.alice })).status, 200);
  });
});

describe('outcomes', () => {
  it('200 { bound, inviter_sub }: the Referral row is written through the late-bind lock; one audit line', async () => {
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    let res;
    try {
      res = await bind(token, { code: ` ${CODES.alice.toLowerCase()} ` });
    } finally {
      log.restore();
    }
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { bound: true, inviter_sub: 'alice' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(inviterOf(ME), 'alice');
    const row = prisma.referral.rows.find((r) => r.inviteeId === ME);
    assert.equal(row.campaignSlug, null, 'a standard referral, exactly as /api/referrals/use-code writes it');
    assert.equal(lockCount(), 1, 'the same createLateBindReferral path (cycle check under the global lock)');
    assert.equal(log.entries.length, 1);
    const [entry] = log.entries;
    assert.equal(entry.event, 'partner.referral_bound');
    assert.deepEqual(
      { clientId: entry.clientId, userId: entry.userId, outcome: entry.outcome, inviterSub: entry.inviterSub },
      { clientId: 'tge-test', userId: ME, outcome: 'bound', inviterSub: 'alice' },
    );
    const line = JSON.stringify(entry);
    assert.ok(!line.toLowerCase().includes(CODES.alice.toLowerCase()), 'never the whole code');
    assert.ok(!line.includes(token) && !line.includes('ddc_tge_'), 'never the token');
    assert.equal(entry.codePrefix, 'al…');
  });

  it('200 { bound, inviter_sub, already: true } when the code is the inviter the user already has', async () => {
    invite('alice', ME);
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    let res;
    try {
      res = await bind(token, { code: CODES.alice });
    } finally {
      log.restore();
    }
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { bound: true, inviter_sub: 'alice', already: true });
    assert.equal(prisma.referral.rows.filter((r) => r.inviteeId === ME).length, 1);
    assert.equal(log.entries[0].event, 'partner.referral_bound');
    assert.equal(log.entries[0].outcome, 'already');
  });

  it('409 already_referred when bound to someone else — the inviter is never replaced (29 A) nor named', async () => {
    invite('alice', ME);
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    let res;
    try {
      res = await bind(token, { code: CODES.bob });
    } finally {
      log.restore();
    }
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'already_referred');
    assert.deepEqual(Object.keys(res.body).sort(), ['error', 'error_description']);
    assert.ok(!res.text.includes('alice'), 'the current inviter is not disclosed');
    assert.equal(inviterOf(ME), 'alice');
    assert.equal(log.entries[0].event, 'partner.referral_bind_refused');
    assert.equal(log.entries[0].outcome, 'already_referred');
    assert.equal(log.entries[0].inviterSub, undefined);
  });

  it('409 already_referred also for the user\'s own code or an unknown code once bound', async () => {
    invite('alice', ME);
    const { token } = await mintToken(FULL);
    for (const code of [CODES[ME], 'ZZZZ99']) {
      const res = await bind(token, { code });
      assert.equal(res.status, 409, code);
      assert.equal(res.body.error, 'already_referred');
    }
    assert.equal(inviterOf(ME), 'alice');
  });

  it('404 invalid_code', async () => {
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    let res;
    try {
      res = await bind(token, { code: 'ZZZZ99' });
    } finally {
      log.restore();
    }
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'invalid_code');
    assert.equal(inviterOf(ME), null);
    assert.equal(log.entries[0].event, 'partner.referral_bind_refused');
    assert.equal(log.entries[0].outcome, 'invalid_code');
    assert.equal(log.entries[0].codePrefix, 'ZZ…');
  });

  it('400 self_referral', async () => {
    const { token } = await mintToken(FULL);
    const res = await bind(token, { code: CODES[ME] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'self_referral');
    assert.equal(inviterOf(ME), null);
  });

  it('409 referral_cycle: the code belongs to someone in the user\'s own downline (decision 11 B)', async () => {
    invite(ME, 'alice');
    invite('alice', 'bob'); // me → alice → bob
    const { token } = await mintToken(FULL);
    for (const code of [CODES.alice, CODES.bob]) {
      const res = await bind(token, { code });
      assert.equal(res.status, 409, code);
      assert.equal(res.body.error, 'referral_cycle');
    }
    assert.equal(inviterOf(ME), null);
    assert.equal(lockCount(), 2, 'the walk ran under the late-bind lock');
    // An unrelated inviter is still accepted.
    assert.equal((await bind(token, { code: CODES.carol })).status, 200);
    assert.equal(inviterOf(ME), 'carol');
  });
});

describe('step one: POST /partner/tge/referral/bind/check', () => {
  it('200 { valid, code, confirm_token, expires_in: 120 }: normalised display code, writes nothing, one audit line', async () => {
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    let res;
    try {
      res = await check(token, { code: ` ${CODES.alice.toLowerCase()} ` });
    } finally {
      log.restore();
    }
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), ['code', 'confirm_token', 'expires_in', 'valid']);
    assert.equal(res.body.valid, true);
    assert.equal(res.body.code, CODES.alice);
    assert.equal(res.body.expires_in, 120);
    assert.match(res.body.confirm_token, /^rbc1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!res.text.includes('alice'), 'no inviter identity before the bind');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(inviterOf(ME), null);
    assert.equal(lockCount(), 0, 'no bind transaction');
    assert.equal(log.entries.length, 1);
    const [entry] = log.entries;
    assert.equal(entry.event, 'partner.referral_bind_checked');
    assert.equal(entry.outcome, 'valid');
    const line = JSON.stringify(entry);
    assert.ok(!line.toLowerCase().includes(CODES.alice.toLowerCase()) && !line.includes(res.body.confirm_token));
  });

  it('every token is unique (nonce)', async () => {
    const { token } = await mintToken(FULL);
    const a = await check(token, { code: CODES.alice });
    const b = await check(token, { code: CODES.alice });
    assert.notEqual(a.body.confirm_token, b.body.confirm_token);
  });

  it('the bind\'s error set, writing nothing: invalid_code 404, self_referral 400, referral_cycle 409', async () => {
    invite(ME, 'bob'); // me → bob: binding bob's code would close a ring
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    try {
      for (const [code, status, error] of [['ZZZZ99', 404, 'invalid_code'], [CODES[ME], 400, 'self_referral'], [CODES.bob, 409, 'referral_cycle']]) {
        const res = await check(token, { code });
        assert.equal(res.status, status, code);
        assert.deepEqual(res.body, { error, error_description: res.body.error_description });
        assert.equal(res.body.confirm_token, undefined);
      }
    } finally {
      log.restore();
    }
    assert.deepEqual(log.entries.map((e) => [e.event, e.outcome]), [
      ['partner.referral_bind_check_refused', 'invalid_code'],
      ['partner.referral_bind_check_refused', 'self_referral'],
      ['partner.referral_bind_check_refused', 'referral_cycle'],
    ]);
    assert.equal(inviterOf(ME), null);
    assert.equal(lockCount(), 0);
  });

  it('409 already_referred for another code once bound, without naming the inviter; the current inviter\'s code is valid with already: true', async () => {
    invite('alice', ME);
    const { token } = await mintToken(FULL);
    for (const code of [CODES.bob, CODES[ME], 'ZZZZ99']) {
      const res = await check(token, { code });
      assert.equal(res.status, 409, code);
      assert.deepEqual(Object.keys(res.body).sort(), ['error', 'error_description']);
      assert.equal(res.body.error, 'already_referred');
      assert.ok(!res.text.includes('alice'));
    }
    const same = await check(token, { code: CODES.alice });
    assert.equal(same.status, 200);
    assert.equal(same.body.already, true);
    advance(1000);
    const res = await bindRaw(token, { code: CODES.alice, confirm_token: same.body.confirm_token });
    assert.deepEqual(res.body, { bound: true, inviter_sub: 'alice', already: true });
  });

  it('the same gates as the bind: switch, scope, kill switch, account, sub in the body', async () => {
    const { token } = await mintToken(FULL);
    const { token: readOnly } = await mintToken('tge:identity tge:status');
    assert.equal((await check(readOnly, { code: CODES.alice })).body.error, 'insufficient_scope');
    process.env.DISABLE_REFERRAL_REWARDS_FEATURES = 'true';
    const killed = await check(token, { code: CODES.alice });
    assert.deepEqual([killed.status, killed.body.error], [403, 'referral_features_disabled']);
    delete process.env.DISABLE_REFERRAL_REWARDS_FEATURES;
    for (const body of [{}, { code: 12 }, { code: CODES.alice, sub: 'bob' }]) {
      assert.equal((await check(token, body)).status, 400, JSON.stringify(body));
    }
    meUser().disabledAt = new Date();
    assert.equal((await check(token, { code: CODES.alice })).body.error, 'account_disabled');
    meUser().disabledAt = null;
    process.env.SSO_TGE_REFERRAL_BIND = 'false';
    const off = await check(token, { code: CODES.alice });
    assert.deepEqual([off.status, off.body.error], [404, 'not_available']);
    assert.equal(inviterOf(ME), null);
  });

  it('shares the 10-a-minute budget with the bind: check and bind together, then 429', async () => {
    const { token } = await mintToken(FULL);
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await check(token, { code: `NOPE${i}` })).status, 404);
      assert.equal((await bind(token, { code: `NOPE${i}` })).status, 404);
    }
    const limited = await check(token, { code: CODES.alice });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'slow_down');
  });
});

describe('step two: the bind requires /check\'s confirm_token', () => {
  it('happy path: check → the user confirms (≥ 1 s) → bind', async () => {
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    let res;
    try {
      res = await checkThenBind(token, CODES.alice.toLowerCase());
    } finally {
      log.restore();
    }
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body, { bound: true, inviter_sub: 'alice' });
    assert.equal(inviterOf(ME), 'alice');
    assert.equal(lockCount(), 1);
    assert.deepEqual(log.entries.map((e) => [e.event, e.outcome]), [
      ['partner.referral_bind_checked', 'valid'],
      ['partner.referral_bound', 'bound'],
    ]);
  });

  it('the typed code and the display code /check returned confirm the same bind', async () => {
    const { token } = await mintToken(FULL);
    const checked = await check(token, { code: ` ${CODES.alice.toLowerCase()} ` });
    advance(1500);
    const res = await bindRaw(token, { code: CODES.alice.toLowerCase(), confirm_token: checked.body.confirm_token });
    assert.equal(res.status, 200, res.text);
  });

  it('a legacy code and the display code confirm the same bind, both ways; /check answers the display code', async () => {
    const alice = prisma.user.rows.find((u) => u.id === 'alice');
    alice.legacyReferralCode = 'DD-ALICE234';
    const { token } = await mintToken(FULL);
    const checked = await check(token, { code: 'dd-alice234' });
    assert.equal(checked.status, 200, checked.text);
    assert.equal(checked.body.code, CODES.alice);
    advance(1000);
    const res = await bindRaw(token, { code: 'DD-ALICE234', confirm_token: checked.body.confirm_token });
    assert.deepEqual(res.body, { bound: true, inviter_sub: 'alice' });
    const again = await check(token, { code: CODES.alice });
    advance(1000);
    const replay = await bindRaw(token, { code: 'DDALICE234', confirm_token: again.body.confirm_token });
    assert.deepEqual(replay.body, { bound: true, inviter_sub: 'alice', already: true });
  });

  it('428 confirmation_required without a token (absent, null or empty), writing nothing', async () => {
    const { token } = await mintToken(FULL);
    const log = captureBindLog();
    try {
      for (const extra of [{}, { confirm_token: null }, { confirm_token: '' }]) {
        const res = await bindRaw(token, { code: CODES.alice, ...extra });
        assert.equal(res.status, 428, JSON.stringify(extra));
        assert.equal(res.body.error, 'confirmation_required');
        assert.equal(res.headers['cache-control'], 'no-store');
      }
    } finally {
      log.restore();
    }
    assert.equal(inviterOf(ME), null);
    assert.equal(lockCount(), 0);
    assert.deepEqual(log.entries.map((e) => [e.event, e.outcome]), Array(3).fill(['partner.referral_bind_refused', 'confirmation_required']));
  });

  async function refusedConfirmation(token, body) {
    const res = await bindRaw(token, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.text}`);
    assert.equal(res.body.error, 'invalid_confirmation');
    assert.equal(inviterOf(ME), null);
    assert.equal(lockCount(), 0, 'refused before the bind transaction');
    return res;
  }

  it('400 invalid_confirmation: too early (< 1 s after /check), then fine at 1 s', async () => {
    const { token } = await mintToken(FULL);
    const checked = await check(token, { code: CODES.alice });
    const body = { code: CODES.alice, confirm_token: checked.body.confirm_token };
    await refusedConfirmation(token, body);
    advance(999);
    const res = await refusedConfirmation(token, body);
    assert.match(res.body.error_description, /less than a second/);
    advance(1);
    assert.equal((await bindRaw(token, body)).status, 200);
  });

  it('400 invalid_confirmation: expired (120 s)', async () => {
    const { token } = await mintToken(FULL);
    const checked = await check(token, { code: CODES.alice });
    advance(120 * 1000);
    const res = await refusedConfirmation(token, { code: CODES.alice, confirm_token: checked.body.confirm_token });
    assert.match(res.body.error_description, /expired/);
  });

  it('400 invalid_confirmation: issued for another user, another client or another code', async () => {
    const { token } = await mintToken(FULL);
    await refusedConfirmation(token, { code: CODES.alice, confirm_token: tokenFor(CODES.alice, { userId: 'bob' }) });
    await refusedConfirmation(token, { code: CODES.alice, confirm_token: tokenFor(CODES.alice, { clientId: 'another-client' }) });
    const checked = await check(token, { code: CODES.alice });
    advance(1500);
    const log = captureBindLog();
    try {
      await refusedConfirmation(token, { code: CODES.bob, confirm_token: checked.body.confirm_token });
    } finally {
      log.restore();
    }
    assert.equal(log.entries[0].event, 'partner.referral_bind_refused');
    assert.equal(log.entries[0].outcome, 'invalid_confirmation');
    assert.equal(log.entries[0].reason, 'code');
    assert.ok(!JSON.stringify(log.entries[0]).includes(checked.body.confirm_token));
  });

  it('400 invalid_confirmation: tampered, malformed, or signed with another key', async () => {
    const { token } = await mintToken(FULL);
    const good = tokenFor(CODES.alice);
    const [prefix, body, sig] = good.split('.');
    const forged = JSON.parse(Buffer.from(body, 'base64url').toString());
    forged.s = 'bob';
    const flipped = Buffer.from(sig, 'base64url');
    flipped[0] ^= 1;
    // The last character of a 32-byte signature carries two spare bits: a variant that differs
    // only there decodes to the same bytes, and must still be refused (canonical encoding only).
    const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const spare = b64[b64.indexOf(sig.slice(-1)) ^ 1];
    assert.equal(Buffer.from(`${sig.slice(0, -1)}${spare}`, 'base64url').toString('base64url'), sig, 'same bytes');
    for (const bad of [
      `${prefix}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`,
      `${prefix}.${body}.${flipped.toString('base64url')}`,
      `${prefix}.${body}.${sig.slice(0, -1)}${spare}`,
      `${prefix}.${body}.${sig}=`,
      `${prefix}.${body}`,
      'not-a-token',
      123,
      'x'.repeat(2000),
    ]) {
      await refusedConfirmation(token, { code: CODES.alice, confirm_token: bad });
    }
    const saved = process.env.SSO_SESSION_SECRET;
    process.env.SSO_SESSION_SECRET = 'a-rotated-session-secret';
    try {
      await refusedConfirmation(token, { code: CODES.alice, confirm_token: good });
    } finally {
      process.env.SSO_SESSION_SECRET = saved;
    }
    assert.equal((await bindRaw(token, { code: CODES.alice, confirm_token: good })).status, 200);
  });

  it('replaying a used token for the same code is harmless: 200 already: true, one row', async () => {
    const { token } = await mintToken(FULL);
    const checked = await check(token, { code: CODES.alice });
    advance(1000);
    const body = { code: CODES.alice, confirm_token: checked.body.confirm_token };
    assert.deepEqual((await bindRaw(token, body)).body, { bound: true, inviter_sub: 'alice' });
    advance(5000);
    assert.deepEqual((await bindRaw(token, body)).body, { bound: true, inviter_sub: 'alice', already: true });
    assert.equal(prisma.referral.rows.filter((r) => r.inviteeId === ME).length, 1);
  });

  it('a token checked for another code before a successful bind cannot move the inviter afterwards', async () => {
    const { token } = await mintToken(FULL);
    const forAlice = await check(token, { code: CODES.alice });
    assert.equal((await checkThenBind(token, CODES.bob)).status, 200);
    const res = await bindRaw(token, { code: CODES.alice, confirm_token: forAlice.body.confirm_token });
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'already_referred');
    assert.equal(inviterOf(ME), 'bob');
  });
});

describe('concurrency (same user, one process)', () => {
  it('the same code twice at once: one bound, one already — one row', async () => {
    const { token } = await mintToken(FULL);
    const results = await Promise.all([bind(token, { code: CODES.alice }), bind(token, { code: CODES.alice })]);
    assert.deepEqual(results.map((r) => r.status), [200, 200]);
    assert.deepEqual(results.map((r) => Boolean(r.body.already)).sort(), [false, true]);
    assert.equal(prisma.referral.rows.filter((r) => r.inviteeId === ME).length, 1);
  });

  it('two different codes at once: exactly one inviter wins, the other is 409 already_referred', async () => {
    const { token } = await mintToken(FULL);
    const results = await Promise.all([bind(token, { code: CODES.alice }), bind(token, { code: CODES.bob })]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const winner = results.find((r) => r.status === 200).body.inviter_sub;
    assert.equal(inviterOf(ME), winner);
    assert.equal(results.find((r) => r.status === 409).body.error, 'already_referred');
    assert.equal(prisma.referral.rows.filter((r) => r.inviteeId === ME).length, 1);
  });
});

describe('the rest of /partner/tge is still read-only', () => {
  const routes = () => partnerTgeRoutes.stack.filter((layer) => layer.route).map((layer) => ({
    path: layer.route.path,
    methods: Object.keys(layer.route.methods).sort(),
    guarded: layer.route.stack.some((s) => s.handle === readOnlyRequest),
  }));

  it('exactly one route is outside the guard, and it is POST /referral/bind; /check is guarded', () => {
    const all = routes();
    assert.ok(all.length >= 5, JSON.stringify(all));
    const unguarded = all.filter((r) => !r.guarded);
    assert.deepEqual(unguarded, [{ path: '/referral/bind', methods: ['post'], guarded: false }]);
    assert.deepEqual(all.find((r) => r.path === '/referral/bind/check'), { path: '/referral/bind/check', methods: ['post'], guarded: true });
    for (const r of all.filter((x) => x.guarded && x.path !== '/referral/bind/check')) assert.deepEqual(r.methods, ['get'], `${r.path} is a read`);
  });

  it('a write attempted inside /check is refused (it only reads)', async () => {
    const { token } = await mintToken(FULL);
    const original = prisma.referral.findUnique;
    prisma.referral.findUnique = async (args) => {
      await prisma.referral.create({ data: { inviterId: 'alice', inviteeId: ME, code: CODES.alice } });
      return original(args);
    };
    try {
      const res = await check(token, { code: CODES.alice });
      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'server_error');
    } finally {
      prisma.referral.findUnique = original;
    }
    assert.equal(inviterOf(ME), null);
  });

  it('a write inside GET /status is still refused after a bind in the same process', async () => {
    const { token } = await mintToken('tge:identity tge:status tge:referral tge:referral_bind');
    assert.equal((await bind(token, { code: CODES.alice })).status, 200);
    const originalCount = prisma.referral.count;
    prisma.referral.count = async (args) => {
      await prisma.user.update({ where: { id: ME }, data: { name: 'written-from-a-read' } });
      return originalCount(args);
    };
    try {
      const res = await request(server).get('/partner/tge/status').set('Authorization', `Bearer ${token}`);
      assert.equal(res.status, 500, 'the write is refused, not quietly performed');
      assert.equal(res.body.error, 'server_error');
      assert.equal(meUser().name, ME);
    } finally {
      prisma.referral.count = originalCount;
    }
  });

  it('no other write method exists: POST /status, PUT /referral/bind and GET /referral/bind are unknown', async () => {
    const { token } = await mintToken('tge:identity tge:status tge:referral_bind');
    for (const [method, path] of [['post', '/partner/tge/status'], ['post', '/partner/tge/me'], ['put', '/partner/tge/referral/bind'], ['get', '/partner/tge/referral/bind'], ['get', '/partner/tge/referral/bind/check']]) {
      const res = await request(server)[method](path).set('Authorization', `Bearer ${token}`).send({ code: CODES.alice });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
    assert.equal(inviterOf(ME), null);
  });
});
