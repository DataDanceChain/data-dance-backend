/**
 * GET /partner/tge/points/history on the REAL src/app (scope tge:points, the grant that already
 * shows the balance on /status).
 *
 * Gates in order: 401 without a partner token → 404 {"error":"not_available"} where the environment
 * does not list `points_history` in SSO_TGE_STATUS_FIELDS → 403 insufficient_scope without
 * `tge:points` → 403 account_disabled. Plus: the kind allow-list (and a scan that fails when a
 * `point.create` site in src/ writes a source the allow-list does not name), keyset pagination with
 * equal timestamps, cursor tampering, limits, since/until, user isolation, the empty ledger, no-store,
 * one G6 access record, and that an item never carries more than its four fields.
 * The in-memory Prisma stand-in ignores orderBy/take; this file teaches its point.findMany both, so
 * the real where-builder runs here and the real SQL runs on Postgres in test/db/.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');
const { listenLoopback } = require('../helpers/loopbackServer');

const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const SECRET = 'tge-secret-dev';
const REDIRECT = 'https://tge.example.com/oauth/callback';
const SERVED = 'registered_at,wallet_bound,points,points_history';
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
  SSO_TGE_STATUS_FIELDS: SERVED,
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET: 'ddc-user-session-secret',
  SSO_SESSION_SECRET: 'ddc-sso-session-secret-different',
});
delete process.env.SSO_REQUIRE_VERIFIED_SESSION;

const app = require('../../src/app');
const { startAuthorization, decideConsent, issuedTokensByCode } = require('../../src/services/oauthService');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { accessLog } = require('../../src/routes/partnerTgeRoutes');
const { STATUS_FIELD_CATALOG } = require('../../src/constants/partnerClient');
const history = require('../../src/services/partnerPointsHistory');

const { pointKind, SOURCE_KIND, POINT_KINDS, ITEM_FIELDS, buildPointsHistory, PointsHistoryRequestError } = history;

// --- the stand-in's point.findMany learns orderBy [{createdAt: desc}, {id: desc}] and take ---------
const plainFindMany = prisma.point.findMany;
const LAST_WHERE = { value: null };
prisma.point.findMany = async (args = {}) => {
  LAST_WHERE.value = args.where;
  let rows = await plainFindMany(args);
  if (args.orderBy) {
    assert.deepEqual(args.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);
    rows.sort((a, b) => (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  }
  if (args.take !== undefined) rows = rows.slice(0, args.take);
  return rows;
};

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const ME = 'user-pts-1';
const OTHER = 'user-pts-2';
const baseUser = (id, totalPoints) => ({
  id, email: `${id}@example.com`, isOrganization: false, userType: 'regular', disabledAt: null,
  createdAt: new Date('2025-01-01T00:00:00Z'), referralCode: null, totalPoints,
});
const basic = `Basic ${Buffer.from(`tge-test:${SECRET}`).toString('base64')}`;
const T = (minutes) => new Date(Date.parse('2026-09-01T00:00:00.000Z') + minutes * 60_000);

/** My ledger: five rows, two pairs sharing a timestamp; a running total of 175. */
function seedLedger() {
  const mine = [
    { id: 'p-a', amount: 100, source: 'crawler', sourceId: 'data_upload', createdAt: T(1) },
    { id: 'p-b', amount: 50, source: 'REFERRAL_DIRECT', sourceId: OTHER, createdAt: T(2) },
    { id: 'p-c', amount: 25, source: 'OPS_ADJUSTMENT', sourceId: 'ops-manual-1-fix__staffname', createdAt: T(2) },
    { id: 'p-d', amount: 30, source: 'CAMPAIGN_RAFFLE', sourceId: 'win-1', createdAt: T(3) },
    { id: 'p-e', amount: -30, source: 'REWARD_REDEMPTION', sourceId: 'form-apple-order-77', createdAt: T(3) },
  ];
  for (const row of mine) prisma.point.rows.push({ ...row, userId: ME, updatedAt: row.createdAt, metadata: { url: 'https://leak.example/x' } });
  prisma.point.rows.push({ id: 'p-z', userId: OTHER, amount: 40, source: 'TASK_CLAIM', sourceId: 'task-x', createdAt: T(2), updatedAt: T(2) });
}

async function mintToken(scope, who = ME) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const consentUrl = await startAuthorization({ get: () => '' }, {
    response_type: 'code', client_id: 'tge-test', redirect_uri: REDIRECT, scope,
    state: crypto.randomBytes(18).toString('base64url'), code_challenge: challenge, code_challenge_method: 'S256',
  });
  const requestId = new URL(consentUrl).searchParams.get('request');
  const consenting = prisma.user.rows.find((u) => u.id === who);
  const redirectTo = await decideConsent(consenting, requestId, true, { kind: 'user_jwt', claims: { ver: 2 } });
  const code = new URL(redirectTo).searchParams.get('code');
  const res = await request(server).post('/oauth/token').type('form').set('Authorization', basic)
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.equal(res.status, 200, res.text);
  return res.body.access_token;
}

const read = (token, query = '', base = '/partner/tge') => request(server).get(`${base}/points/history${query}`).set('Authorization', `Bearer ${token}`);
/** An UNSIGNED cursor body, as a partner (or anyone without the server key) could build one. */
const cursorOf = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
/** The documented signature, computed independently of the service: what only DataDance can mint. */
function signedCursorOf(obj, secret = process.env.SSO_SESSION_SECRET) {
  const payload = cursorOf(obj);
  const key = crypto.createHmac('sha256', secret).update('ddc:partner-points-history-cursor:v1').digest();
  const tag = crypto.createHmac('sha256', key).update(`pph1.${payload}`).digest().subarray(0, 16);
  return `${payload}.${tag.toString('base64url')}`;
}
const decode = (cursor) => JSON.parse(Buffer.from(cursor.split('.')[0], 'base64url').toString('utf8'));

async function pageAll(token, query = '') {
  const pages = [];
  let res = await read(token, query);
  assert.equal(res.status, 200, res.text);
  pages.push(res.body);
  while (res.body.next_cursor) {
    res = await read(token, `${query}${query ? '&' : '?'}cursor=${encodeURIComponent(res.body.next_cursor)}`);
    assert.equal(res.status, 200, res.text);
    pages.push(res.body);
  }
  return pages;
}

describe('points kind mapping (explicit allow-list)', () => {
  it('every listed source maps to one of the documented kinds, and the catalog names them', () => {
    for (const [source, kind] of Object.entries(SOURCE_KIND)) {
      assert.ok(POINT_KINDS.includes(kind), `${source} → ${kind}`);
      assert.equal(pointKind(source), kind);
    }
    for (const kind of POINT_KINDS) assert.ok(STATUS_FIELD_CATALOG.points_history.meaning.includes(kind), kind);
  });

  it('maps the product sources to the expected kinds', () => {
    const expected = {
      crawler: 'upload',
      TASK_CLAIM: 'task',
      REFERRAL_DIRECT: 'referral',
      REFERRAL_LEVEL_2: 'referral',
      REFERRAL_LEVEL_12: 'referral',
      REFERRAL_CLAIM: 'referral',
      upline_reward: 'referral',
      REFERRAL_CAMPAIGN_SUMMER_TRAVEL_INVITEE: 'referral',
      BADGE_CLAIM: 'campaign',
      CHRISTMAS_WELCOME_BONUS: 'campaign',
      CAMPAIGN_CONNECT_BOOST: 'campaign',
      OPS_ADJUSTMENT: 'adjustment',
      MANUAL_ADJUSTMENT: 'adjustment',
      REWARD_REDEMPTION: 'redemption',
    };
    for (const [source, kind] of Object.entries(expected)) assert.equal(pointKind(source), kind, source);
  });

  it('anything not on the list reads as `other` — never a guess, never the raw name', () => {
    for (const source of ['REGISTRATION', 'TEST_SEED', 'revenue_book_data', 'CRAWLER', 'crawler ', 'referral_direct',
      'REFERRAL_LEVEL_0', 'REFERRAL_LEVEL_x', 'REFERRAL_LEVEL_1000', '', null, undefined, 42, {},
      '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal(pointKind(source), 'other', String(source));
    }
  });

  it('the campaign and referral source constants map to their intended kinds', () => {
    const rules = require('../../src/utils/campaignRules');
    const campaigns = require('../../src/constants/referralCampaigns');
    assert.equal(pointKind(rules.POINT_SOURCE_CONNECT_BOOST), 'campaign');
    assert.equal(pointKind(rules.POINT_SOURCE_REFERRAL_BOOST), 'campaign');
    assert.equal(pointKind(rules.POINT_SOURCE_FIRST_ACTION), 'campaign');
    assert.equal(pointKind(rules.POINT_SOURCE_RAFFLE), 'campaign');
    assert.equal(pointKind(campaigns.POINT_SOURCE_SUMMER_TRAVEL_BONUS), 'campaign');
    assert.equal(pointKind(campaigns.POINT_SOURCE_SUMMER_TRAVEL_INVITER), 'referral');
    assert.equal(pointKind(campaigns.POINT_SOURCE_SUMMER_TRAVEL_INVITEE), 'referral');
  });

  /**
   * Drift guard: a new ledger source added in src/ without a decision here would reach partners as
   * `other`. Every `point.create` / `point.createMany` call is read, its `source` resolved (string
   * literal, POINT_SOURCE_* constant, or a same-file assignment), and checked against the list.
   * Sources that are deliberately `other`, or written through a parameter, are acknowledged below.
   */
  it('every source a point.create site in src/ writes is on the allow-list', () => {
    const SRC = path.join(__dirname, '../../src');
    const constants = { ...require('../../src/utils/campaignRules'), ...require('../../src/constants/referralCampaigns') };
    // Deliberately `other`: the standalone dev seed script.
    const ACKNOWLEDGED_OTHER = new Set(['src/utils/seedData.js:REGISTRATION']);
    // Written through a variable whose values are asserted above or in this list.
    const ACKNOWLEDGED_DYNAMIC = new Map([
      // claimReferralRewards: 'REFERRAL_DIRECT' or `REFERRAL_LEVEL_${level}` (both referral).
      ['src/services/referralService.js:source', () => ['REFERRAL_DIRECT', 'REFERRAL_LEVEL_2', 'REFERRAL_LEVEL_7']],
      // grantPoints(tx, userId, amount, source, sourceId): callers pass POINT_SOURCE_* constants.
      ['src/services/campaignEffects.js:source', () => [constants.POINT_SOURCE_REFERRAL_BOOST, constants.POINT_SOURCE_FIRST_ACTION]],
    ]);
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) files.push(full);
      }
    };
    walk(SRC);
    let sites = 0;
    const problems = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(path.join(SRC, '..'), file).split(path.sep).join('/');
      const sitePattern = /\.point\.(create|createMany)\s*\(/g;
      let site;
      while ((site = sitePattern.exec(text))) {
        sites += 1;
        const snippet = text.slice(site.index, site.index + 700).split(/\n\s*\}\s*\)\s*;/)[0];
        const match = /\bsource\s*(?::\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_$][\w$]*))|(?=[,}\s]))/.exec(snippet);
        if (!match) { problems.push(`${rel}: no source at a point.${site[1]} site`); continue; }
        let values;
        const literal = match[1] ?? match[2];
        const ident = match[3] || 'source';
        if (literal !== undefined) values = [literal];
        else if (ACKNOWLEDGED_DYNAMIC.has(`${rel}:${ident}`)) values = ACKNOWLEDGED_DYNAMIC.get(`${rel}:${ident}`)();
        else if (/^POINT_SOURCE_[A-Z_]+$/.test(ident) && typeof constants[ident] === 'string') values = [constants[ident]];
        else {
          const assigned = [...text.matchAll(new RegExp(`\\b${ident}\\s*=\\s*(?:'([^']*)'|([A-Z][A-Z0-9_]+))\\s*;`, 'g'))]
            .map((m) => (m[1] !== undefined ? m[1] : constants[m[2]]));
          if (!assigned.length || assigned.some((v) => typeof v !== 'string')) {
            problems.push(`${rel}: cannot resolve source "${ident}" — map it or acknowledge it in this test`);
            continue;
          }
          values = assigned;
        }
        for (const value of values) {
          if (pointKind(value) === 'other' && !ACKNOWLEDGED_OTHER.has(`${rel}:${value}`)) {
            problems.push(`${rel}: source "${value}" is not on the partner kind allow-list`);
          }
        }
      }
    }
    assert.ok(sites >= 15, `found only ${sites} point.create sites — the scan is broken`);
    assert.deepEqual(problems, []);
  });
});

describe('GET /partner/tge/points/history', () => {
  beforeEach(() => {
    clearRateLimitStore();
    prisma.reset();
    issuedTokensByCode.clear();
    prisma.user.rows.push(baseUser(ME, 175), baseUser(OTHER, 40));
    seedLedger();
    process.env.SSO_TGE_STATUS_FIELDS = SERVED;
    LAST_WHERE.value = null;
  });

  it('catalogs points_history as an endpoint under sso:points, never cacheable', () => {
    const entry = STATUS_FIELD_CATALOG.points_history;
    assert.equal(entry.endpoint, 'points/history');
    assert.equal(entry.scope, 'sso:points');
    assert.equal(entry.presence, 'endpoint');
    assert.equal(entry.cacheTtlSec, 0);
  });

  it('200: newest first, four fields per item, balance as on /status, no-store, one G6 record', async () => {
    const token = await mintToken('tge:identity tge:status tge:points');
    const entries = [];
    const original = accessLog.write;
    accessLog.write = (e) => entries.push(e);
    let res;
    let status;
    try {
      res = await read(token);
      status = await request(server).get('/partner/tge/status').set('Authorization', `Bearer ${token}`);
    } finally {
      accessLog.write = original;
    }
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(Object.keys(res.body).sort(), ['as_of', 'balance', 'cache_max_age', 'items', 'next_cursor', 'sub']);
    assert.equal(res.body.sub, ME);
    assert.equal(res.body.balance, 175);
    assert.equal(res.body.balance, status.body.points.balance, 'the same balance /status reports');
    assert.equal(res.body.cache_max_age, 0);
    assert.ok(!Number.isNaN(Date.parse(res.body.as_of)));
    assert.equal(res.body.next_cursor, null);
    // (createdAt, id) DESC: p-e and p-d share T(3), p-c and p-b share T(2).
    assert.deepEqual(res.body.items, [
      { id: 'p-e', amount: -30, kind: 'redemption', created_at: T(3).toISOString() },
      { id: 'p-d', amount: 30, kind: 'campaign', created_at: T(3).toISOString() },
      { id: 'p-c', amount: 25, kind: 'adjustment', created_at: T(2).toISOString() },
      { id: 'p-b', amount: 50, kind: 'referral', created_at: T(2).toISOString() },
      { id: 'p-a', amount: 100, kind: 'upload', created_at: T(1).toISOString() },
    ]);
    for (const item of res.body.items) assert.deepEqual(Object.keys(item).sort(), [...ITEM_FIELDS]);
    assert.equal(res.body.items.reduce((sum, i) => sum + i.amount, 0), res.body.balance);
    for (const leak of ['sourceId', 'source"', 'staffname', 'data_upload', 'form-apple', 'leak.example', 'metadata', OTHER, 'p-z']) {
      assert.ok(!res.text.includes(leak), `body must not carry ${leak}`);
    }
    const access = entries.filter((e) => e.endpoint === 'points-history');
    assert.equal(access.length, 1);
    assert.equal(access[0].userId, ME);
    assert.equal(access[0].itemCount, 5);
    assert.equal(access[0].more, false);
  });

  it('the /partner/sso alias and the sso:points scope name serve the same thing', async () => {
    const token = await mintToken('sso:points');
    const res = await read(token, '', '/partner/sso');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.items.length, 5);
  });

  it('401 without a token; 404 not_available where not listed (before the scope check); 403 without tge:points', async () => {
    assert.equal((await request(server).get('/partner/tge/points/history')).status, 401);
    const withScope = await mintToken('tge:identity tge:points');
    const withoutScope = await mintToken('tge:identity tge:status');
    const denied = await read(withoutScope);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, 'insufficient_scope');
    assert.match(denied.headers['www-authenticate'], /scope="sso:points"/);
    process.env.SSO_TGE_STATUS_FIELDS = 'registered_at,wallet_bound,points';
    const notServed = await read(withScope);
    assert.equal(notServed.status, 404);
    assert.equal(notServed.body.error, 'not_available');
    assert.equal(notServed.headers['cache-control'], 'no-store');
    assert.equal((await read(withoutScope)).status, 404, '"not served here" is answered before "not granted"');
    delete process.env.SSO_TGE_STATUS_FIELDS;
    assert.equal((await read(withScope)).status, 404, 'off by default');
  });

  it('403 account_disabled; ?sub= / ?user_id= / ?access_token= refused', async () => {
    const token = await mintToken('tge:points');
    for (const q of [`?sub=${OTHER}`, `?user_id=${OTHER}`, `?access_token=${token}`]) {
      const r = await read(token, q);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, 'invalid_request', q);
    }
    prisma.user.rows.find((u) => u.id === ME).disabledAt = new Date();
    const disabled = await read(token);
    assert.equal(disabled.status, 403);
    assert.equal(disabled.body.error, 'account_disabled');
  });

  it('another user\'s token reads only that user\'s ledger and balance', async () => {
    const mine = await mintToken('tge:points', ME);
    const theirs = await mintToken('tge:points', OTHER);
    const res = await read(theirs);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.sub, OTHER);
    assert.equal(res.body.balance, 40);
    assert.deepEqual(res.body.items, [{ id: 'p-z', amount: 40, kind: 'task', created_at: T(2).toISOString() }]);
    assert.equal(LAST_WHERE.value.userId, OTHER);
    // My cursor in their hands is refused, and theirs in mine.
    const myPage = await read(mine, '?limit=2');
    const stolen = await read(theirs, `?cursor=${myPage.body.next_cursor}`);
    assert.equal(stolen.status, 400);
    assert.equal(stolen.body.error, 'invalid_request');
    assert.match(stolen.body.error_description, /another user/);
  });

  it('an empty ledger: 200, no items, balance 0, next_cursor null', async () => {
    prisma.user.rows.push(baseUser('user-pts-new', 0));
    const token = await mintToken('tge:points', 'user-pts-new');
    const res = await read(token);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.items, []);
    assert.equal(res.body.balance, 0);
    assert.equal(res.body.next_cursor, null);
  });

  it('pages with every limit 1..6: the union is the whole ledger once, in order, ties included', async () => {
    const token = await mintToken('tge:points');
    const full = (await read(token)).body.items.map((i) => i.id);
    for (let limit = 1; limit <= 6; limit++) {
      const pages = await pageAll(token, `?limit=${limit}`);
      const ids = pages.flatMap((p) => p.items.map((i) => i.id));
      assert.deepEqual(ids, full, `limit=${limit}`);
      assert.equal(pages.length, Math.max(1, Math.ceil(full.length / limit)), `limit=${limit}`);
      for (const p of pages) assert.equal(p.balance, 175);
    }
  });

  it('limit: default 50, max 100; out of range or malformed is 400', async () => {
    const token = await mintToken('tge:points');
    for (let i = 0; i < 120; i++) {
      prisma.point.rows.push({ id: `bulk-${String(i).padStart(3, '0')}`, userId: ME, amount: 1, source: 'TASK_CLAIM', createdAt: T(10 + i) });
    }
    const first = await read(token);
    assert.equal(first.body.items.length, 50);
    assert.ok(first.body.next_cursor);
    const max = await read(token, '?limit=100');
    assert.equal(max.body.items.length, 100);
    for (const q of ['?limit=0', '?limit=101', '?limit=-1', '?limit=1.5', '?limit=abc', '?limit=', '?limit=1&limit=2', '?limit=1e2']) {
      const r = await read(token, q);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, 'invalid_request', q);
    }
  });

  it('since (inclusive) / until (exclusive) narrow the window and stay pinned in the cursor', async () => {
    const token = await mintToken('tge:points');
    const range = `?since=${encodeURIComponent(T(2).toISOString())}&until=${encodeURIComponent(T(3).toISOString())}`;
    const res = await read(token, range);
    assert.deepEqual(res.body.items.map((i) => i.id), ['p-c', 'p-b']);
    assert.equal(res.body.balance, 175, 'balance is the account balance, not the window sum');
    const pages = await pageAll(token, `${range}&limit=1`);
    assert.deepEqual(pages.flatMap((p) => p.items.map((i) => i.id)), ['p-c', 'p-b']);
    // The cursor carries the window: a later page without since/until keeps it…
    const page1 = await read(token, `${range}&limit=1`);
    const page2 = await read(token, `?limit=1&cursor=${page1.body.next_cursor}`);
    assert.deepEqual(page2.body.items.map((i) => i.id), ['p-b']);
    // …and a different window on a later page is refused.
    const changed = await read(token, `?limit=1&since=${encodeURIComponent(T(1).toISOString())}&cursor=${page1.body.next_cursor}`);
    assert.equal(changed.status, 400);
    assert.equal(changed.body.error, 'invalid_request');
    // A date alone is UTC midnight.
    assert.deepEqual((await read(token, '?until=2026-09-01')).body.items, []);
    for (const q of ['?since=nope', '?since=2026-09-01T00:00:00', '?until=1693526400', `?since=${encodeURIComponent(T(3).toISOString())}&until=${encodeURIComponent(T(2).toISOString())}`,
      `?since=${encodeURIComponent(T(2).toISOString())}&until=${encodeURIComponent(T(2).toISOString())}`, '?since=a&since=b']) {
      const r = await read(token, q);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.error, 'invalid_request', q);
    }
  });

  it('cursor tampering: any edit, an unsigned or foreign-key cursor, or a malformed one is 400', async () => {
    const token = await mintToken('tge:points');
    const page1 = await read(token, '?limit=2');
    const issued = page1.body.next_cursor;
    assert.match(issued, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    const good = decode(issued);
    assert.deepEqual(Object.keys(good).sort(), ['e', 'i', 's', 't', 'u', 'v']);
    assert.equal(signedCursorOf(good), issued, 'the documented signature reproduces the issued cursor');
    const [payload, tag] = issued.split('.');
    const flip = (str, at) => str.slice(0, at) + (str[at] === 'A' ? 'B' : 'A') + str.slice(at + 1);
    const otherPage = (await read(token, '?limit=3')).body.next_cursor;
    const bad = [
      // Not a cursor at all.
      'garbage!', '%%%', 'x'.repeat(2000), '', '.', `${payload}.`, `.${tag}`, `${payload}.${tag}.${tag}`, payload,
      // The issued cursor, edited.
      `${flip(payload, 5)}.${tag}`, `${payload}.${flip(tag, 3)}`, `${payload.slice(0, -2)}.${tag}`, `${payload}.${tag.slice(0, -1)}`,
      `${payload}.${otherPage.split('.')[1]}`, `${payload}A.${tag}`,
      // Any position, even a well-formed one, without the server's signature or under another key.
      cursorOf(good), `${cursorOf({ ...good, t: '2999-01-01T00:00:00.000Z' })}.${tag}`,
      signedCursorOf({ ...good, t: '2999-01-01T00:00:00.000Z' }, 'some-other-secret'),
      // Signed, so the tag passes, but the body is still checked.
      signedCursorOf([]), signedCursorOf(null), signedCursorOf('x'),
      signedCursorOf({ ...good, v: 2 }), signedCursorOf({ ...good, u: 123 }), signedCursorOf({ ...good, t: 'yesterday' }),
      signedCursorOf({ ...good, t: null }), signedCursorOf({ ...good, i: '' }), signedCursorOf({ ...good, i: 7 }),
      signedCursorOf({ ...good, i: 'x'.repeat(200) }), signedCursorOf({ ...good, s: 'nope' }), signedCursorOf({ ...good, e: 5 }),
      signedCursorOf({ ...good, u: OTHER }),
    ];
    // A non-canonical spelling of the tag (the last character carries spare bits) is refused too.
    const last = tag[tag.length - 1];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = alphabet[(alphabet.indexOf(last) & ~3) + ((alphabet.indexOf(last) + 1) & 3)];
    assert.deepEqual(Buffer.from(`${tag.slice(0, -1)}${twin}`, 'base64url'), Buffer.from(tag, 'base64url'));
    bad.push(`${payload}.${tag.slice(0, -1)}${twin}`);
    let calls = 0;
    const original = history.source.loadPage;
    history.source.loadPage = async (...args) => { calls += 1; return original(...args); };
    try {
      for (const cursor of bad) {
        const r = await read(token, `?cursor=${encodeURIComponent(cursor)}`);
        assert.equal(r.status, 400, cursor.slice(0, 60));
        assert.equal(r.body.error, 'invalid_request');
      }
    } finally {
      history.source.loadPage = original;
    }
    assert.equal(calls, 0, 'a refused cursor never reaches the database');
    // Another user's genuine cursor says so.
    const theirs = await read(token, `?cursor=${encodeURIComponent(signedCursorOf({ ...good, u: OTHER }))}`);
    assert.match(theirs.body.error_description, /another user/);
    // Even a position DataDance itself signed only ever reads the caller's own ledger.
    const moved = await read(token, `?cursor=${signedCursorOf({ ...good, t: '2999-01-01T00:00:00.000Z', i: 'zzzz' })}`);
    assert.equal(moved.status, 200, moved.text);
    assert.deepEqual(moved.body.items.map((i) => i.id), ['p-e', 'p-d', 'p-c', 'p-b', 'p-a']);
    assert.equal(LAST_WHERE.value.userId, ME);
    // The genuine cursor still works, and an array of cursors is refused, not concatenated.
    assert.equal((await read(token, `?cursor=${issued}`)).status, 200);
    assert.equal((await read(token, `?cursor=${issued}&cursor=${issued}`)).status, 400);
  });

  it('rows written while paging are not mixed into later pages', async () => {
    const token = await mintToken('tge:points');
    const page1 = await read(token, '?limit=2');
    prisma.point.rows.push({ id: 'p-new', userId: ME, amount: 5, source: 'TASK_CLAIM', createdAt: T(500) });
    const rest = [];
    let cursor = page1.body.next_cursor;
    while (cursor) {
      const r = await read(token, `?limit=2&cursor=${cursor}`);
      rest.push(...r.body.items.map((i) => i.id));
      cursor = r.body.next_cursor;
    }
    assert.deepEqual([...page1.body.items.map((i) => i.id), ...rest], ['p-e', 'p-d', 'p-c', 'p-b', 'p-a']);
    assert.equal((await read(token, '?limit=1')).body.items[0].id, 'p-new', 'it is on the next first page');
  });

  it('rate limit: the shared 120/min per token with /status; the 121st read is 429 slow_down', async () => {
    const token = await mintToken('tge:status tge:points');
    for (let i = 0; i < 60; i++) {
      assert.equal((await read(token, '?limit=1')).status, 200, `history ${i}`);
      assert.equal((await request(server).get('/partner/tge/status').set('Authorization', `Bearer ${token}`)).status, 200, `status ${i}`);
    }
    const blocked = await read(token, '?limit=1');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, 'slow_down');
    assert.ok(blocked.headers['retry-after']);
    // Another token (another session) has its own budget.
    const fresh = await mintToken('tge:points');
    assert.equal((await read(fresh, '?limit=1')).status, 200);
  });

  it('an item carries exactly four fields even if the query ever selects more', async () => {
    const original = history.source.loadPage;
    history.source.loadPage = async () => [{ id: 'q1', amount: '12.5', source: 'BADGE_CLAIM', sourceId: 'secret', createdAt: T(9), userId: OTHER, email: 'leak@example.com' }];
    try {
      const body = await buildPointsHistory({ id: ME, totalPoints: 12.5 }, {});
      assert.deepEqual(body.items, [{ id: 'q1', amount: 12.5, kind: 'campaign', created_at: T(9).toISOString() }]);
    } finally {
      history.source.loadPage = original;
    }
  });

  it('a bad request is a PointsHistoryRequestError (400), never a database call', async () => {
    let called = false;
    const original = history.source.loadPage;
    history.source.loadPage = async () => { called = true; return []; };
    try {
      await assert.rejects(buildPointsHistory({ id: ME, totalPoints: 0 }, { limit: '500' }), PointsHistoryRequestError);
      await assert.rejects(buildPointsHistory({ id: ME, totalPoints: 0 }, { cursor: 'nope!' }), PointsHistoryRequestError);
    } finally {
      history.source.loadPage = original;
    }
    assert.equal(called, false);
  });
});
