/**
 * "Bind X account" OAuth flow (decision 46, option B): the CSRF fix.
 *
 * Before: `GET /api/x/oauth2/callback` wrote `User.xid` for whichever DDC user started the flow,
 * in whatever browser X sent back, with a never-expiring in-memory state. An attacker could mail
 * the authorization link from their own flow (victim's X lands on the attacker's account) or the
 * callback URL of their own authorization (an X binding the opener never asked for).
 *
 * After: the callback binds nothing; only `POST /api/x/oauth2/complete` from the initiating user
 * WITH the initiating session's binding secret writes the binding. Every test below drives the
 * real router over HTTP (real `protect` with real JWTs, in-memory Prisma stand-in) with X's token
 * and user endpoints stubbed at the service boundary.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
// `protect` builds its own PrismaClient at load time; point it at the same store so bearer
// tokens are verified for real.
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const JWT_SECRET = 'x-bind-unit-test-secret';
const CALLBACK = 'https://api.test.local/api/x/oauth2/callback';
Object.assign(process.env, {
  JWT_SECRET,
  LOG_LEVEL: 'error',
  X_API_URL: 'https://x.test.local/2',
  X_CLIENT_ID: 'x-client-id',
  X_CLIENT_SECRET: 'x-client-secret',
  X_BEARER_TOKEN: 'x-bearer',
  X_OAUTH_CALLBACK_URL: CALLBACK,
  APP_PUBLIC_URL: 'https://app.test.local',
});
delete process.env.X_BIND_RETURN_URL_WEB;
delete process.env.X_BIND_RETURN_URL_IOS;
delete process.env.X_BIND_RETURN_URL_ANDROID;

// Capture log lines so the suite can prove no state, handle or secret is ever logged.
const logs = [];
const realLogger = require('../../src/utils/logger');
require.cache[require.resolve('../../src/utils/logger')].exports = {
  ...realLogger,
  createLogger: (name) => ({
    info: (message, meta) => logs.push({ level: 'info', name, message, meta }),
    warn: (message, meta) => logs.push({ level: 'warn', name, message, meta }),
    error: (message, meta) => logs.push({ level: 'error', name, message, meta }),
    debug: () => {},
    http: () => {},
  }),
};

const xService = require('../../src/services/xService');
const xBindFlow = require('../../src/services/xBindFlow');
const xRoutes = require('../../src/routes/xRoutes');

const app = express();
app.use(express.json());
app.use('/api/x', xRoutes);

const WEB_RETURN = 'https://app.test.local/user/my';

// X, stubbed at the service boundary. `xAccountForCode` decides which X account authorized a code.
const xAccountForCode = new Map();
const exchanges = [];
xService.exchangeCodeForToken = async (code, codeVerifier) => {
  exchanges.push({ code, codeVerifier });
  if (!xAccountForCode.has(code)) {
    const err = new Error('invalid_grant');
    err.status = 400;
    throw err;
  }
  return { access_token: `at-${code}`, refresh_token: `rt-${code}` };
};
xService.getOAuth2UserInfo = async (accessToken) => {
  const code = accessToken.replace(/^at-/, '');
  return xAccountForCode.get(code);
};

const VICTIM_X = { id: '1001', username: 'victim_on_x', name: 'Victim' };
const ATTACKER_X = { id: '2002', username: 'attacker_on_x', name: 'Attacker' };

function bearer(userId) {
  return `Bearer ${jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '1h' })}`;
}

function userRow(id) {
  return prisma.user.rows.find((row) => row.id === id);
}

async function start(userId, platform) {
  const res = await request(app)
    .get('/api/x/oauth2/authorize-url')
    .query(platform === undefined ? {} : { platform })
    .set('Authorization', bearer(userId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const url = new URL(res.body.data.url);
  return {
    url,
    state: url.searchParams.get('state'),
    challenge: url.searchParams.get('code_challenge'),
    bindingSecret: res.body.data.bindingSecret,
  };
}

/** X sends the browser that authorized `code` back to our callback. */
function callback(query) {
  return request(app).get('/api/x/oauth2/callback').query(query);
}

function location(res) {
  assert.equal(res.status, 302);
  return new URL(res.headers.location);
}

function complete(userId, body) {
  const call = request(app).post('/api/x/oauth2/complete').send(body);
  if (userId) call.set('Authorization', bearer(userId));
  return call;
}

/** Run X's half for `xAccount` against `state`; returns the handle the browser comes back with. */
async function authorizeAtX(state, xAccount) {
  const code = `code-${crypto.randomBytes(6).toString('hex')}`;
  xAccountForCode.set(code, xAccount);
  const res = await callback({ code, state });
  const back = location(res);
  assert.equal(back.searchParams.get('x_status'), 'confirm', back.toString());
  return back.searchParams.get('x_bind');
}

function assertNothingBound() {
  for (const row of prisma.user.rows) {
    assert.equal(row.xid, null, `user ${row.id} got xid ${row.xid}`);
    assert.equal(row.xAccessToken, null);
  }
}

beforeEach(() => {
  prisma.reset();
  xBindFlow._reset();
  xAccountForCode.clear();
  exchanges.length = 0;
  logs.length = 0;
  for (const id of ['victim', 'attacker', 'holder']) {
    prisma.user.rows.push({
      id,
      email: `${id}@example.com`,
      disabledAt: null,
      xid: null,
      xUsername: null,
      xAccessToken: null,
      xRefreshToken: null,
    });
  }
});

describe('normal flow still works', () => {
  it('start -> X -> callback -> complete binds the initiator, with PKCE S256', async () => {
    const flow = await start('victim');
    assert.equal(flow.url.origin + flow.url.pathname, 'https://x.test.local/2/oauth2/authorize');
    assert.equal(flow.url.searchParams.get('redirect_uri'), CALLBACK);
    assert.equal(flow.url.searchParams.get('code_challenge_method'), 'S256');
    assert.match(flow.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(flow.bindingSecret, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!flow.url.toString().includes(flow.bindingSecret), 'secret must never be in a URL');

    const handle = await authorizeAtX(flow.state, VICTIM_X);
    // The callback alone binds nothing.
    assertNothingBound();
    // The verifier X received hashes to the challenge in the authorization URL.
    assert.equal(exchanges.length, 1);
    assert.equal(crypto.createHash('sha256').update(exchanges[0].codeVerifier).digest('base64url'), flow.challenge);

    const res = await complete('victim', { handle, bindingSecret: flow.bindingSecret });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { bound: true, xid: VICTIM_X.id, xUsername: VICTIM_X.username });
    const row = userRow('victim');
    assert.equal(row.xid, VICTIM_X.id);
    assert.equal(row.xUsername, VICTIM_X.username);
    assert.ok(row.xAccessToken.startsWith('at-'));
    assert.ok(row.xRefreshToken.startsWith('rt-'));

    const status = await request(app).get('/api/x/status').set('Authorization', bearer('victim'));
    assert.equal(status.body.data.bound, true);
  });

  it('the callback returns to the configured Wallet page for the platform the flow started on', async () => {
    for (const [platform, expected] of [
      [undefined, WEB_RETURN],
      ['web', WEB_RETURN],
      ['ios', 'datadance://localhost/user/my'],
      ['android', 'ai.datadance.app://localhost/user/my'],
    ]) {
      const flow = await start('victim', platform);
      const code = `code-${platform}`;
      xAccountForCode.set(code, VICTIM_X);
      const back = location(await callback({ code, state: flow.state }));
      assert.equal(back.toString().split('?')[0], expected, String(platform));
    }
  });

  it('a configured return URL wins over the default', async () => {
    process.env.X_BIND_RETURN_URL_WEB = 'https://wallet.test.local/me?tab=x';
    try {
      const flow = await start('victim');
      xAccountForCode.set('c1', VICTIM_X);
      const back = location(await callback({ code: 'c1', state: flow.state }));
      assert.equal(back.origin + back.pathname, 'https://wallet.test.local/me');
      assert.equal(back.searchParams.get('tab'), 'x');
      assert.equal(back.searchParams.get('x_status'), 'confirm');
    } finally {
      delete process.env.X_BIND_RETURN_URL_WEB;
    }
  });

  it('a malformed configured return URL falls back to the default instead of throwing', async () => {
    process.env.X_BIND_RETURN_URL_WEB = 'not a url';
    try {
      const flow = await start('victim');
      xAccountForCode.set('c1', VICTIM_X);
      const back = location(await callback({ code: 'c1', state: flow.state }));
      assert.equal(back.toString().split('?')[0], WEB_RETURN);
    } finally {
      delete process.env.X_BIND_RETURN_URL_WEB;
    }
  });

  it('rebinding the same X account to the same user just refreshes it', async () => {
    for (let i = 0; i < 2; i += 1) {
      const flow = await start('victim');
      const handle = await authorizeAtX(flow.state, VICTIM_X);
      const res = await complete('victim', { handle, bindingSecret: flow.bindingSecret });
      assert.equal(res.status, 200);
    }
    assert.equal(userRow('victim').xid, VICTIM_X.id);
  });
});

describe('callback rejects a bad state and binds nothing', () => {
  it('missing state', async () => {
    xAccountForCode.set('c1', ATTACKER_X);
    const back = location(await callback({ code: 'c1' }));
    assert.equal(back.toString().split('?')[0], WEB_RETURN);
    assert.equal(back.searchParams.get('x_status'), 'error');
    assert.equal(back.searchParams.get('code'), 'STATE_INVALID');
    assert.equal(back.searchParams.get('x_bind'), null);
    assert.equal(exchanges.length, 0, 'no code exchange without a valid state');
    assertNothingBound();
  });

  it('forged state (well-formed but never issued) and malformed state', async () => {
    xAccountForCode.set('c1', ATTACKER_X);
    for (const state of [crypto.randomBytes(32).toString('base64url'), 'abc', crypto.randomBytes(16).toString('hex')]) {
      const back = location(await callback({ code: 'c1', state }));
      assert.equal(back.searchParams.get('code'), 'STATE_INVALID');
    }
    assert.equal(exchanges.length, 0);
    assertNothingBound();
  });

  it('replayed state: the second callback is refused', async () => {
    const flow = await start('victim');
    await authorizeAtX(flow.state, VICTIM_X);
    xAccountForCode.set('again', ATTACKER_X);
    const back = location(await callback({ code: 'again', state: flow.state }));
    assert.equal(back.searchParams.get('code'), 'STATE_INVALID');
    assert.equal(exchanges.length, 1);
    assertNothingBound();
  });

  it('expired state', async () => {
    const flow = await start('victim');
    const realNow = Date.now;
    Date.now = () => realNow() + xBindFlow.FLOW_TTL_MS + 1000;
    try {
      xAccountForCode.set('late', VICTIM_X);
      const back = location(await callback({ code: 'late', state: flow.state }));
      assert.equal(back.searchParams.get('code'), 'STATE_INVALID');
    } finally {
      Date.now = realNow;
    }
    assert.equal(exchanges.length, 0);
    assertNothingBound();
  });

  it('user denied at X: state is consumed, nothing bound', async () => {
    const flow = await start('victim');
    const back = location(await callback({ error: 'access_denied', state: flow.state }));
    assert.equal(back.searchParams.get('code'), 'ACCESS_DENIED');
    xAccountForCode.set('c1', VICTIM_X);
    const replay = location(await callback({ code: 'c1', state: flow.state }));
    assert.equal(replay.searchParams.get('code'), 'STATE_INVALID');
    assertNothingBound();
  });

  it('failed code exchange binds nothing and burns the state', async () => {
    const flow = await start('victim');
    const back = location(await callback({ code: 'unknown-code', state: flow.state }));
    assert.equal(back.searchParams.get('code'), 'TOKEN_EXCHANGE_FAILED');
    assertNothingBound();
  });
});

describe('the CSRF attacks fail', () => {
  it('attacker mails the authorization URL of THEIR flow; the victim authorizes: nobody is bound', async () => {
    const attackerFlow = await start('attacker');
    // The victim opens attackerFlow.url, approves with their own X account, and X sends the
    // victim's browser to our callback; the Wallet then confirms in the victim's session.
    const handle = await authorizeAtX(attackerFlow.state, VICTIM_X);
    const victimOwn = await start('victim'); // even with a secret of their own in storage
    const res = await complete('victim', { handle, bindingSecret: victimOwn.bindingSecret });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'X_BIND_NOT_INITIATOR');
    assertNothingBound();

    // The attacker never sees the handle; even if they did, it is already consumed.
    const late = await complete('attacker', { handle, bindingSecret: attackerFlow.bindingSecret });
    assert.equal(late.status, 400);
    assert.equal(late.body.code, 'STATE_INVALID');
    assertNothingBound();
  });

  it('attacker mails the CALLBACK URL of their own authorization; the victim opens it: nobody is bound', async () => {
    const attackerFlow = await start('attacker');
    const code = 'attacker-code';
    xAccountForCode.set(code, ATTACKER_X);
    // The attacker stops before the callback and sends ?code&state to the victim.
    const back = location(await callback({ code, state: attackerFlow.state }));
    const handle = back.searchParams.get('x_bind');
    const res = await complete('victim', { handle });
    assert.equal(res.status, 403);
    assertNothingBound();
    // Replaying the same callback link is refused before any exchange.
    const again = location(await callback({ code, state: attackerFlow.state }));
    assert.equal(again.searchParams.get('code'), 'STATE_INVALID');
    assert.equal(exchanges.length, 1);
  });

  it("a foreign state with the victim's own binding secret is still refused", async () => {
    const victimFlow = await start('victim');
    const attackerFlow = await start('attacker');
    const handle = await authorizeAtX(attackerFlow.state, ATTACKER_X);
    const res = await complete('victim', { handle, bindingSecret: victimFlow.bindingSecret });
    assert.equal(res.status, 403);
    assertNothingBound();
  });

  it('the initiating user without the session secret (another device/tab) is refused', async () => {
    const flow = await start('victim');
    for (const bindingSecret of [undefined, '', 'short', crypto.randomBytes(32).toString('base64url')]) {
      const again = await start('victim');
      const handle = await authorizeAtX(again.state, VICTIM_X);
      const res = await complete('victim', { handle, bindingSecret });
      assert.equal(res.status, 403, String(bindingSecret));
    }
    assert.ok(flow.bindingSecret);
    assertNothingBound();
  });

  it('a replayed handle is refused', async () => {
    const flow = await start('victim');
    const handle = await authorizeAtX(flow.state, VICTIM_X);
    assert.equal((await complete('victim', { handle, bindingSecret: flow.bindingSecret })).status, 200);
    userRow('victim').xid = null;
    userRow('victim').xAccessToken = null;
    const replay = await complete('victim', { handle, bindingSecret: flow.bindingSecret });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.code, 'STATE_INVALID');
    assertNothingBound();
  });

  it('a refused attempt burns the handle, so a later correct one cannot use it', async () => {
    const flow = await start('victim');
    const handle = await authorizeAtX(flow.state, VICTIM_X);
    assert.equal((await complete('attacker', { handle, bindingSecret: flow.bindingSecret })).status, 403);
    const res = await complete('victim', { handle, bindingSecret: flow.bindingSecret });
    assert.equal(res.status, 400);
    assertNothingBound();
  });

  it('an expired handle is refused', async () => {
    const flow = await start('victim');
    const handle = await authorizeAtX(flow.state, VICTIM_X);
    const realNow = Date.now;
    Date.now = () => realNow() + xBindFlow.PENDING_TTL_MS + 1000;
    try {
      const res = await complete('victim', { handle, bindingSecret: flow.bindingSecret });
      assert.equal(res.status, 400);
    } finally {
      Date.now = realNow;
    }
    assertNothingBound();
  });

  it('complete needs a bearer token', async () => {
    const flow = await start('victim');
    const handle = await authorizeAtX(flow.state, VICTIM_X);
    const res = await complete(null, { handle, bindingSecret: flow.bindingSecret });
    assert.equal(res.status, 401);
    assertNothingBound();
  });

  it('an X account held by another user is not moved', async () => {
    userRow('holder').xid = VICTIM_X.id;
    const flow = await start('attacker');
    const handle = await authorizeAtX(flow.state, VICTIM_X);
    const res = await complete('attacker', { handle, bindingSecret: flow.bindingSecret });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'X_ACCOUNT_ALREADY_BOUND');
    assert.equal(userRow('attacker').xid, null);
    assert.equal(userRow('holder').xid, VICTIM_X.id);
  });
});

describe('no open redirect, no leaks', () => {
  it('callback ignores any return target in the request', async () => {
    const flow = await start('victim');
    xAccountForCode.set('c1', VICTIM_X);
    const res = await callback({
      code: 'c1',
      state: flow.state,
      redirect_uri: 'https://evil.example',
      return_to: 'https://evil.example',
      redirect: '//evil.example',
    });
    const back = location(res);
    assert.equal(back.toString().split('?')[0], WEB_RETURN);
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    const bad = location(await callback({ state: 'x', return_to: 'https://evil.example' }));
    assert.equal(bad.toString().split('?')[0], WEB_RETURN);
  });

  it('an unknown platform is refused at start', async () => {
    for (const platform of ['https://evil.example', 'desktop']) {
      const res = await request(app)
        .get('/api/x/oauth2/authorize-url')
        .query({ platform })
        .set('Authorization', bearer('victim'));
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'INVALID_PLATFORM');
    }
    assert.equal(xBindFlow._sizes().flows, 0);
  });

  it('the old bearer-only redirect endpoint is gone', async () => {
    const res = await request(app).get('/api/x/oauth2/authorize').set('Authorization', bearer('victim'));
    assert.equal(res.status, 404);
  });

  it('start requires a bearer token', async () => {
    const res = await request(app).get('/api/x/oauth2/authorize-url');
    assert.equal(res.status, 401);
  });

  it('state, handle, binding secret and X tokens never reach a log line', async () => {
    const flow = await start('victim');
    const handle = await authorizeAtX(flow.state, VICTIM_X);
    await complete('attacker', { handle, bindingSecret: flow.bindingSecret });
    const text = JSON.stringify(logs);
    for (const secret of [flow.state, flow.bindingSecret, handle, 'at-code-', 'rt-code-']) {
      assert.ok(!text.includes(secret), `${secret} leaked into logs`);
    }
  });
});

describe('xBindFlow store', () => {
  it('caps open flows per user and drops the oldest', async () => {
    const flows = [];
    for (let i = 0; i < xBindFlow.MAX_OPEN_PER_USER + 2; i += 1) flows.push(await start('victim'));
    assert.equal(xBindFlow._sizes().flows, xBindFlow.MAX_OPEN_PER_USER);
    assert.equal(xBindFlow.consumeFlow(flows[0].state), null);
    assert.ok(xBindFlow.consumeFlow(flows[flows.length - 1].state));
  });

  it('sweeps expired flows on the next write', () => {
    const now = Date.now();
    xBindFlow.createFlow({ userId: 'a', now });
    xBindFlow.createFlow({ userId: 'b', now: now + xBindFlow.FLOW_TTL_MS + 1 });
    assert.equal(xBindFlow._sizes().flows, 1);
  });
});
