/**
 * Native e-mail one-time code (design §3.3, §6 F8/F9/F19, decision D15): address guard, Turnstile,
 * sign-in mail (templates and lazy transport), OTP start/verify, and the two routes inside the real
 * application with the identify hand-off (BE6 contract) stubbed.
 *
 * No network: DNS is a fake resolver, Turnstile's siteverify is a fake fetch that answers like
 * Cloudflare's published test secrets, and mail goes to an injected sender (the Mailpit round trip
 * is in test/db/nativeAuthOtp.dbtest.js). Log lines of module nativeAuth are captured, not printed,
 * so the tests can assert what is (and is not) logged.
 */
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const request = require('supertest');

// ---- Log capture (before any logger exists) ------------------------------------------------
process.env.LOG_LEVEL = 'info';
const captured = [];
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '';
  if (text.startsWith('{') && text.includes('"module":')) {
    captured.push(text);
    return true;
  }
  return originalWrite(chunk, ...rest);
};
const logText = () => captured.join('');
/** winston hands lines to the console transport asynchronously. */
const flushLogs = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// ---- Database and identify stub ------------------------------------------------------------
const { installMockPrisma, matches } = require('../helpers/mockPrisma');
const prisma = installMockPrisma();
require.cache[require.resolve('@prisma/client')].exports = {
  PrismaClient: function PrismaClient() {
    return prisma;
  },
};

const identifyCalls = [];
const identifyPath = path.join(__dirname, '../../src/services/nativeAuth/identify.js');
require.cache[identifyPath] = {
  id: identifyPath,
  filename: identifyPath,
  loaded: true,
  children: [],
  exports: {
    async createLoginAttempt(args) {
      identifyCalls.push(args);
      return {
        loginId: '00000000-0000-4000-8000-000000000001',
        loginSecret: 'stub-secret',
        expiresAt: new Date(0).toISOString(),
        account: { status: 'new', hasWallet: false, linkedBy: 'new' },
      };
    },
  },
};

const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');
const { listenLoopback } = require('../helpers/loopbackServer');
const { readNativeAuthConfig, stateHmac } = require('../../src/services/nativeAuth/config');
const emailGuard = require('../../src/services/nativeAuth/emailGuard');
const turnstile = require('../../src/services/nativeAuth/turnstile');
const otp = require('../../src/services/nativeAuth/emailOtp');
const authEmail = require('../../src/i18n/authEmail');
const email = require('../../src/utils/email');
const { NATIVE_ERROR_CODES } = require('../../src/controllers/nativeAuth/respond');
const { createEmailController } = require('../../src/controllers/nativeAuth/emailController');

const key = makeKeyFile();
const TS_PASS = '1x0000000000000000000000000000000AA';
const TS_FAIL = '2x0000000000000000000000000000000AA';
const TS_SPENT = '3x0000000000000000000000000000000AA';
const TS_SITE = '1x00000000000000000000AA';
const TS_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

function makeCfg(overrides = {}) {
  return readNativeAuthConfig(localEnv(key, { DDC_AUTH_METHODS: 'email', DDC_AUTH_EMAIL_FROM: 'DataDance <login@datadance.test>', ...overrides }));
}

/** Siteverify as Cloudflare answers for its published test secrets. */
function fakeSiteverify(calls = []) {
  const fn = async (url, init) => {
    const params = new URLSearchParams(init.body);
    calls.push({ url, ...Object.fromEntries(params) });
    const secret = params.get('secret');
    if (secret === TS_PASS) return { json: async () => ({ success: true, 'error-codes': [], hostname: 'example.com' }) };
    if (secret === TS_SPENT) return { json: async () => ({ success: false, 'error-codes': ['timeout-or-duplicate'] }) };
    return { json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) };
  };
  fn.calls = calls;
  return fn;
}

/** The mock database plus `email: { endsWith }` (the per-domain cap), which the mock lacks. */
function makeDb() {
  const model = prisma.authEmailChallenge;
  const wrapped = {
    ...model,
    count: async ({ where = {} } = {}) => {
      if (where.email && typeof where.email === 'object' && 'endsWith' in where.email) {
        const { email: cond, ...rest } = where;
        return model.rows.filter((r) => r.email.endsWith(cond.endsWith) && matches(r, rest)).length;
      }
      return model.count({ where });
    },
  };
  const db = { ...prisma, authEmailChallenge: wrapped };
  db.$transaction = async (fn) => fn(db);
  return db;
}

const okGuard = async (raw) => {
  const normalized = emailGuard.normalizeEmail(raw);
  if (!normalized) throw new Error('test guard: bad address');
  return { email: normalized, domain: emailGuard.domainOf(normalized) };
};

function harness(cfgOverrides = {}) {
  const cfg = makeCfg(cfgOverrides);
  const db = makeDb();
  const sent = [];
  const tightened = [];
  const fetchImpl = fakeSiteverify();
  const base = {
    db,
    cfg,
    env: { DDC_AUTH_ENV: 'local' },
    guard: okGuard,
    send: async (to, code, locale, context) => {
      sent.push({ to, code, locale, context });
      return { messageId: 'm' };
    },
    setTightened: (v) => tightened.push(v),
    fetchImpl,
  };
  const start = (args = {}) => otp.startEmailChallenge({ email: 'alice@example.org', locale: 'en', request: { ip: '203.0.113.7' }, ...base, ...args });
  const verify = (args = {}) => otp.verifyEmailChallenge({ request: { ip: '203.0.113.7' }, db, cfg, fetchImpl, ...args });
  return { cfg, db, sent, tightened, fetchImpl, start, verify, base };
}

const at = (iso) => new Date(iso);
const T0 = '2026-09-30T09:00:00.000Z';
const plus = (sec, from = T0) => new Date(new Date(from).getTime() + sec * 1000);

async function rejectsCode(promise, code, check) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code} (${err.message})`);
    if (check) check(err);
    return true;
  });
}

beforeEach(() => {
  prisma.reset();
  captured.length = 0;
  otp.resetBudgetAlarm();
  emailGuard.clearDnsCache();
});

after(() => {
  process.stdout.write = originalWrite;
});

// ================================================================================================
describe('emailGuard', () => {
  const resolver = (records) => ({
    resolveMx: async (d) => (records[d] && records[d].mx ? records[d].mx : Promise.reject(Object.assign(new Error('x'), { code: 'ENODATA' }))),
    resolve4: async (d) => (records[d] && records[d].a ? records[d].a : Promise.reject(Object.assign(new Error('x'), { code: 'ENODATA' }))),
    resolve6: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })),
  });

  it('normalises (trim, lower-case, IDN → ASCII) and validates the syntax', () => {
    assert.equal(emailGuard.normalizeEmail('  Alice.B+tag@Example.ORG '), 'alice.b+tag@example.org');
    assert.equal(emailGuard.normalizeEmail('a@bücher.de'), 'a@xn--bcher-kva.de');
    for (const bad of ['', 'a', 'a@', '@b.com', 'a@b', 'a@@b.com', 'a b@c.com', '.a@b.com', 'a..b@c.com', 'a@-b.com', 'a@b.c', `${'x'.repeat(65)}@b.com`, `a@${'b'.repeat(250)}.com`, null, 42, {}]) {
      assert.equal(emailGuard.normalizeEmail(bad), null, JSON.stringify(bad));
    }
    assert.equal(emailGuard.normalizeEmail(`${'x'.repeat(64)}@${'d'.repeat(63)}.${'e'.repeat(63)}.${'f'.repeat(58)}.com`), null, '> 254 characters');
  });

  it('refuses disposable domains and their subdomains', async () => {
    assert.equal(emailGuard.isDisposableDomain('mailinator.com'), true);
    assert.equal(emailGuard.isDisposableDomain('x.y.mailinator.com'), true);
    assert.equal(emailGuard.isDisposableDomain('gmail.com'), false);
    await rejectsCode(emailGuard.guardEmail('a@mailinator.com', { resolver: resolver({}) }), 'INVALID_EMAIL');
  });

  it('requires an MX (not a null MX) or an A record', async () => {
    const r = resolver({
      'mx.test.org': { mx: [{ exchange: 'mail.mx.test.org', priority: 10 }] },
      'nullmx.test.org': { mx: [{ exchange: '', priority: 0 }] },
      'aonly.test.org': { a: ['192.0.2.1'] },
    });
    assert.deepEqual(await emailGuard.guardEmail('A@MX.test.org', { resolver: r }), { email: 'a@mx.test.org', domain: 'mx.test.org' });
    assert.equal((await emailGuard.guardEmail('a@aonly.test.org', { resolver: r })).domain, 'aonly.test.org');
    await rejectsCode(emailGuard.guardEmail('a@nullmx.test.org', { resolver: r }), 'INVALID_EMAIL');
    await rejectsCode(emailGuard.guardEmail('a@nothing.test.org', { resolver: r }), 'INVALID_EMAIL');
  });

  it('a DNS outage or timeout lets the address through and is not cached; answers are cached 1 h', async () => {
    let calls = 0;
    const down = { resolveMx: async () => { calls += 1; throw Object.assign(new Error('x'), { code: 'ESERVFAIL' }); } };
    assert.equal(await emailGuard.checkDomainDeliverable('flaky.test.org', { resolver: down }), 'unknown');
    assert.equal(await emailGuard.checkDomainDeliverable('flaky.test.org', { resolver: down }), 'unknown');
    assert.equal(calls, 2, 'outages are not cached');
    const slow = { resolveMx: () => new Promise(() => {}) };
    const t = Date.now();
    assert.equal(await emailGuard.checkDomainDeliverable('slow.test.org', { resolver: slow, timeoutMs: 50 }), 'unknown');
    assert.ok(Date.now() - t < 1000);
    assert.equal(emailGuard.DNS_TIMEOUT_MS, 2000);

    let mxCalls = 0;
    const counting = { resolveMx: async () => { mxCalls += 1; return [{ exchange: 'mx.c.test.org', priority: 1 }]; } };
    const now = Date.now();
    await emailGuard.checkDomainDeliverable('c.test.org', { resolver: counting, now });
    await emailGuard.checkDomainDeliverable('c.test.org', { resolver: counting, now: now + 59 * 60 * 1000 });
    assert.equal(mxCalls, 1);
    await emailGuard.checkDomainDeliverable('c.test.org', { resolver: counting, now: now + 61 * 60 * 1000 });
    assert.equal(mxCalls, 2);
  });
});

// ================================================================================================
describe('sign-in mail templates (src/i18n/authEmail.js)', () => {
  it('five locales; the code is never in the subject; body has code, lifetime and the anti-phishing line', () => {
    assert.deepEqual([...authEmail.AUTH_EMAIL_LOCALES], ['en', 'zh', 'zh-TW', 'ja', 'ko']);
    const subjects = new Set();
    for (const locale of authEmail.AUTH_EMAIL_LOCALES) {
      const mail = authEmail.renderLoginCodeEmail({ code: '042917', locale, ttlMinutes: 10, context: {} });
      assert.equal(mail.locale, locale);
      assert.doesNotMatch(mail.subject, /\d{4,}/, `${locale} subject carries digits`);
      assert.ok(!mail.subject.includes('042917'));
      subjects.add(mail.subject);
      for (const part of [mail.text, mail.html]) {
        assert.ok(part.includes('042917'), `${locale}: code missing`);
        assert.ok(part.includes('app.datadance.ai'), `${locale}: anti-phishing line missing`);
        assert.ok(part.includes('10'), `${locale}: lifetime missing`);
      }
      assert.doesNotMatch(mail.html, /<a[\s>]|href=|<img|https?:\/\//i, `${locale}: links or images in html`);
      assert.doesNotMatch(mail.text, /https?:\/\//i);
    }
    assert.equal(subjects.size, 5);
    assert.equal(authEmail.renderLoginCodeEmail({ code: '000001', locale: 'en', ttlMinutes: 10 }).subject, 'Your DataDance sign-in code');
  });

  it('maps client locale tags; unknown → en', () => {
    const cases = { 'zh-CN': 'zh', zh: 'zh', 'zh-Hans': 'zh', 'zh-TW': 'zh-TW', 'zh_HK': 'zh-TW', 'zh-Hant-TW': 'zh-TW', 'ja-JP': 'ja', ko: 'ko', 'en-GB': 'en', fr: 'en', '': 'en', undefined: 'en' };
    for (const [tag, want] of Object.entries(cases)) assert.equal(authEmail.normalizeAuthLocale(tag === 'undefined' ? undefined : tag), want, tag);
  });

  it('request context: fixed browser/OS names and the country, never the raw User-Agent', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1 <script>alert(1)</script> EVIL-TEXT';
    const mail = authEmail.renderLoginCodeEmail({ code: '123456', locale: 'en', ttlMinutes: 10, context: { userAgent: ua, country: 'jp' } });
    assert.ok(mail.text.includes('Safari on iOS'));
    assert.ok(mail.text.includes('Japan'));
    assert.ok(!mail.text.includes('EVIL-TEXT') && !mail.html.includes('EVIL-TEXT') && !mail.html.includes('<script'));
    const zh = authEmail.renderLoginCodeEmail({ code: '123456', locale: 'zh', ttlMinutes: 10, context: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36', country: 'CN' } });
    assert.ok(zh.text.includes('Windows 上的 Chrome'));
    assert.ok(zh.text.includes('中国'));
    assert.ok(zh.text.includes('请求来源：Windows'), 'no space after a full-width colon');
    const none = authEmail.renderLoginCodeEmail({ code: '123456', locale: 'en', ttlMinutes: 10, context: { userAgent: 'curl/8', country: 'XX' } });
    assert.ok(!none.text.includes('Requested from') && !none.text.includes('Location'));
    assert.deepEqual(authEmail.describeUserAgent('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36 EdgA/129'), { browser: 'Edge', os: 'Android' });
    assert.throws(() => authEmail.renderLoginCodeEmail({ code: '12345', locale: 'en' }), /6 digits/);
  });
});

// ================================================================================================
describe('mail transport (src/utils/email.js)', () => {
  it('is created lazily: without SMTP configuration a send throws EMAIL_NOT_CONFIGURED at send time', async () => {
    email.resetEmailTransport();
    const env = {};
    await rejectsCode(email.sendLoginCodeEmail('a@example.org', '123456', 'en', {}, { env }), 'EMAIL_NOT_CONFIGURED');
    await rejectsCode(email.sendLoginCodeEmail('a@example.org', '123456', 'en', {}, { env: { DDC_AUTH_EMAIL_FROM: 'x@y.org' } }), 'EMAIL_NOT_CONFIGURED');
    assert.throws(() => email.getTransporter({ purpose: 'promotion', env: { SMTP_HOST: 'h', SMTP_PORT: '1025' } }), { code: 'EMAIL_NOT_CONFIGURED' });
    assert.ok(email.getTransporter({ purpose: 'login', env: { SMTP_HOST: '127.0.0.1', SMTP_PORT: '1025' } }), 'login mail needs no SMTP auth (Mailpit)');
  });

  it('promotion mail keeps its original transporter options (auth, no new timeouts)', () => {
    email.resetEmailTransport();
    const env = { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '587', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f@example.org' };
    const promo = email.getTransporter({ purpose: 'promotion', env });
    assert.deepEqual({ host: promo.options.host, port: promo.options.port, secure: promo.options.secure, auth: promo.options.auth }, { host: 'smtp.example.org', port: 587, secure: false, auth: { user: 'u', pass: 'p' } });
    assert.equal(promo.options.connectionTimeout, undefined);
    const login = email.getTransporter({ purpose: 'login', env });
    assert.notEqual(login, promo);
    assert.equal(login.options.connectionTimeout, 10000);
    assert.equal(email.getTransporter({ purpose: 'promotion', env }), promo, 'cached per configuration');
    email.resetEmailTransport();
  });

  it('a stalled SMTP server is abandoned after the timeout with EMAIL_SEND_TIMEOUT', async () => {
    email.resetEmailTransport();
    const sockets = [];
    const server = net.createServer((socket) => sockets.push(socket)); // accepts, never greets
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const env = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(server.address().port), DDC_AUTH_EMAIL_FROM: 'login@datadance.test' };
    try {
      await rejectsCode(email.sendLoginCodeEmail('a@example.org', '123456', 'en', {}, { env, timeoutMs: 150 }), 'EMAIL_SEND_TIMEOUT');
    } finally {
      sockets.forEach((s) => s.destroy());
      await new Promise((resolve) => server.close(resolve));
      email.resetEmailTransport();
    }
    assert.equal(email.LOGIN_CODE_SEND_TIMEOUT_MS, 10000);
  });
});

// ================================================================================================
describe('Turnstile (server-side siteverify)', () => {
  it('posts secret, token, client IP and an idempotency key; test secrets pass/fail/spent', async () => {
    const calls = [];
    const fetchImpl = fakeSiteverify(calls);
    const ok = await turnstile.verifyTurnstileToken({ token: TS_TOKEN, remoteip: '203.0.113.7', secret: TS_PASS, fetchImpl });
    assert.deepEqual({ success: ok.success, unavailable: ok.unavailable }, { success: true, unavailable: false });
    assert.equal(calls[0].url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
    assert.equal(calls[0].secret, TS_PASS);
    assert.equal(calls[0].response, TS_TOKEN);
    assert.equal(calls[0].remoteip, '203.0.113.7');
    assert.match(calls[0].idempotency_key, /^[0-9a-f-]{36}$/);
    assert.equal((await turnstile.verifyTurnstileToken({ token: TS_TOKEN, secret: TS_FAIL, fetchImpl })).success, false);
    assert.deepEqual((await turnstile.verifyTurnstileToken({ token: TS_TOKEN, secret: TS_SPENT, fetchImpl })).errorCodes, ['timeout-or-duplicate']);
  });

  it('junk tokens never reach Cloudflare; an outage fails closed', async () => {
    const calls = [];
    const fetchImpl = fakeSiteverify(calls);
    for (const token of ['', null, 42, 'a b', 'x'.repeat(2049)]) {
      assert.equal((await turnstile.verifyTurnstileToken({ token, secret: TS_PASS, fetchImpl })).success, false);
    }
    assert.equal(calls.length, 0);
    const down = await turnstile.verifyTurnstileToken({ token: TS_TOKEN, secret: TS_PASS, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    assert.deepEqual({ success: down.success, unavailable: down.unavailable }, { success: false, unavailable: true });
    const hung = await turnstile.verifyTurnstileToken({ token: TS_TOKEN, secret: TS_PASS, timeoutMs: 30, fetchImpl: (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) });
    assert.deepEqual(hung.errorCodes, ['timeout']);
  });

  it('live: Cloudflare siteverify with the published test secrets (DDC_TEST_TURNSTILE_LIVE=1)', { skip: process.env.DDC_TEST_TURNSTILE_LIVE !== '1' && 'set DDC_TEST_TURNSTILE_LIVE=1 to call Cloudflare' }, async () => {
    const pass = await turnstile.verifyTurnstileToken({ token: TS_TOKEN, remoteip: '203.0.113.7', secret: TS_PASS });
    assert.equal(pass.success, true, JSON.stringify(pass));
    const fail = await turnstile.verifyTurnstileToken({ token: TS_TOKEN, remoteip: '203.0.113.7', secret: TS_FAIL });
    assert.equal(fail.success, false);
    assert.equal(fail.unavailable, false);
    const spent = await turnstile.verifyTurnstileToken({ token: TS_TOKEN, secret: TS_SPENT });
    assert.equal(spent.success, false);
    assert.ok(spent.errorCodes.includes('timeout-or-duplicate'), JSON.stringify(spent));
    // The whole slow path against Cloudflare: past the per-email hour count only a passing token sends.
    const h = harness({ DDC_AUTH_TURNSTILE_MODE: 'log', DDC_AUTH_TURNSTILE_SECRET: TS_PASS, DDC_AUTH_TURNSTILE_SITE_KEY: TS_SITE, DDC_AUTH_OTP_PER_EMAIL_HOUR: '1' });
    await h.start({ now: at(T0), fetchImpl: undefined });
    await rejectsCode(h.start({ now: plus(61), fetchImpl: undefined }), 'TURNSTILE_FAILED');
    await h.start({ now: plus(62), turnstileToken: TS_TOKEN, fetchImpl: undefined });
    assert.equal(h.sent.length, 2);
  });

  it('a request redeems its token at most once; mode off never calls Cloudflare', async () => {
    const calls = [];
    const fetchImpl = fakeSiteverify(calls);
    const cfg = makeCfg({ DDC_AUTH_TURNSTILE_MODE: 'log', DDC_AUTH_TURNSTILE_SECRET: TS_PASS, DDC_AUTH_TURNSTILE_SITE_KEY: TS_SITE });
    const check = turnstile.turnstileCheck({ cfg, token: TS_TOKEN, fetchImpl });
    assert.equal(await check.passed(), true);
    assert.equal(await check.passed(), true);
    assert.equal(calls.length, 1);
    const off = turnstile.turnstileCheck({ cfg: makeCfg(), token: TS_TOKEN, fetchImpl });
    assert.equal(await off.passed(), false);
    assert.equal(calls.length, 1);
    assert.ok(!logText().includes(TS_TOKEN) && !logText().includes(TS_PASS));
  });
});

// ================================================================================================
describe('POST /email/start (service)', () => {
  it('creates a challenge storing only HMAC(stateKey(otp), id:code) and mails the 6-digit code', async () => {
    const h = harness();
    const res = await h.start({ now: at(T0), locale: 'zh-CN', request: { ip: '203.0.113.7', userAgent: 'UA', country: 'SG' } });
    assert.deepEqual(Object.keys(res).sort(), ['challengeId', 'codeLength', 'expiresInSec', 'resendAfterSec']);
    assert.deepEqual({ codeLength: res.codeLength, expiresInSec: res.expiresInSec, resendAfterSec: res.resendAfterSec }, { codeLength: 6, expiresInSec: 600, resendAfterSec: 60 });
    assert.match(res.challengeId, /^[0-9a-f-]{36}$/);
    assert.equal(h.sent.length, 1);
    const { to, code, locale, context } = h.sent[0];
    assert.equal(to, 'alice@example.org');
    assert.match(code, /^\d{6}$/);
    assert.equal(locale, 'zh');
    assert.deepEqual(context, { ttlMinutes: 10, userAgent: 'UA', country: 'SG' });
    const rows = prisma.store.authEmailChallenge;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].codeHash, stateHmac('otp', `${res.challengeId}:${code}`, h.cfg));
    assert.ok(!JSON.stringify(rows).includes(`"${code}"`), 'the code itself is never stored');
    assert.equal(rows[0].expiresAt.getTime(), plus(600).getTime());
    assert.match(rows[0].ipHash, /^[0-9a-f]{32}$/);
    assert.equal(rows[0].locale, 'zh');
  });

  it('codes are uniformly drawn 000000–999999 (zero-padded)', async () => {
    const h = harness({ DDC_AUTH_OTP_RESEND_SEC: '1', DDC_AUTH_OTP_PER_EMAIL_HOUR: '1000', DDC_AUTH_OTP_PER_EMAIL_DAY: '1000', DDC_AUTH_OTP_EMAIL_CEILING_DAY: '1000' });
    for (let i = 0; i < 200; i += 1) await h.start({ now: plus(i * 2), email: `u${i}@example.org` });
    assert.ok(h.sent.every((s) => /^\d{6}$/.test(s.code)));
    assert.ok(new Set(h.sent.map((s) => s.code)).size > 190);
  });

  it('takes the per-address advisory lock inside the transaction', async () => {
    const h = harness();
    await h.start({ now: at(T0) });
    const lock = prisma.rawStatements.find((s) => s.sql.includes('pg_advisory_xact_lock'));
    assert.ok(lock);
    assert.equal(typeof lock.values[0], 'bigint');
    assert.equal(lock.values[0], otp.emailLockKey('alice@example.org'));
    assert.notEqual(otp.emailLockKey('alice@example.org'), otp.emailLockKey('bob@example.org'));
  });

  it('answers identically for known and unknown addresses and never looks at accounts', async () => {
    const h = harness();
    prisma.user.rows.push({ id: 'u1', email: 'known@example.org' });
    const spy = [];
    const db = { ...h.db, user: new Proxy({}, { get: (t, p) => { spy.push(p); return async () => null; } }) };
    db.$transaction = async (fn) => fn(db);
    const a = await h.start({ db, email: 'known@example.org', now: at(T0) });
    const b = await h.start({ db, email: 'nobody@example.org', now: at(T0) });
    assert.deepEqual(Object.keys(a), Object.keys(b));
    assert.deepEqual({ ...a, challengeId: 'x' }, { ...b, challengeId: 'x' });
    assert.deepEqual(spy, []);
  });

  it('resend cooldown → 429 OTP_RESEND_TOO_SOON with retryAfterSec', async () => {
    const h = harness();
    await h.start({ now: at(T0) });
    await rejectsCode(h.start({ now: plus(20) }), 'OTP_RESEND_TOO_SOON', (err) => {
      assert.equal(err.status, 429);
      assert.deepEqual(err.data, { retryAfterSec: 40 });
    });
    await h.start({ now: plus(60) });
    assert.equal(h.sent.length, 2);
  });

  it('no superseding: an older challenge still verifies after a newer one was sent', async () => {
    const h = harness();
    const first = await h.start({ now: at(T0) });
    const second = await h.start({ now: plus(61) });
    const firstCode = h.sent[0].code;
    const verified = await h.verify({ challengeId: first.challengeId, code: firstCode, now: plus(62) });
    assert.equal(verified.email, 'alice@example.org');
    const verified2 = await h.verify({ challengeId: second.challengeId, code: h.sent[1].code, now: plus(63) });
    assert.equal(verified2.challengeId, second.challengeId);
  });

  it('slow path above the per-email hour count: a passing Turnstile token (even in mode log) and a 60 s cooldown — not a lock', async () => {
    const h = harness({ DDC_AUTH_TURNSTILE_MODE: 'log', DDC_AUTH_TURNSTILE_SECRET: TS_PASS, DDC_AUTH_TURNSTILE_SITE_KEY: TS_SITE, DDC_AUTH_OTP_RESEND_SEC: '30' });
    for (let i = 0; i < 5; i += 1) {
      const res = await h.start({ now: plus(i * 30) });
      assert.equal(res.resendAfterSec, i < 4 ? 30 : 60, `send ${i + 1}`);
    }
    await rejectsCode(h.start({ now: plus(4 * 30 + 45) }), 'OTP_RESEND_TOO_SOON', (err) => assert.equal(err.data.retryAfterSec, 15));
    await rejectsCode(h.start({ now: plus(4 * 30 + 61) }), 'TURNSTILE_FAILED', (err) => assert.equal(err.status, 400));
    const failing = makeCfg({ DDC_AUTH_TURNSTILE_MODE: 'log', DDC_AUTH_TURNSTILE_SECRET: TS_FAIL, DDC_AUTH_TURNSTILE_SITE_KEY: TS_SITE, DDC_AUTH_OTP_RESEND_SEC: '30' });
    await rejectsCode(h.start({ cfg: failing, turnstileToken: TS_TOKEN, now: plus(4 * 30 + 62) }), 'TURNSTILE_FAILED');
    const res = await h.start({ turnstileToken: TS_TOKEN, now: plus(4 * 30 + 63) });
    assert.equal(res.resendAfterSec, 60);
    assert.equal(h.sent.length, 6);
  });

  it('slow path above the per-email day count too; with Turnstile off only the cooldown applies', async () => {
    const h = harness({ DDC_AUTH_OTP_PER_EMAIL_HOUR: '100', DDC_AUTH_OTP_PER_EMAIL_DAY: '3', DDC_AUTH_OTP_RESEND_SEC: '10' });
    for (let i = 0; i < 3; i += 1) await h.start({ now: plus(i * 3600) });
    await rejectsCode(h.start({ now: plus(2 * 3600 + 30) }), 'OTP_RESEND_TOO_SOON', (err) => assert.equal(err.data.retryAfterSec, 30));
    const res = await h.start({ now: plus(2 * 3600 + 60) });
    assert.equal(res.resendAfterSec, 60);
  });

  it('mode enforce: every start needs a passing token', async () => {
    const h = harness({ DDC_AUTH_TURNSTILE_MODE: 'enforce', DDC_AUTH_TURNSTILE_SECRET: TS_PASS, DDC_AUTH_TURNSTILE_SITE_KEY: TS_SITE });
    await rejectsCode(h.start({ now: at(T0) }), 'TURNSTILE_FAILED');
    assert.equal(prisma.store.authEmailChallenge.length, 0);
    await h.start({ turnstileToken: TS_TOKEN, now: at(T0) });
    assert.equal(h.fetchImpl.calls.length, 1);
    assert.equal(h.fetchImpl.calls[0].remoteip, '203.0.113.7');
  });

  it('mode log: a failing token is logged, not enforced (below the slow path)', async () => {
    const h = harness({ DDC_AUTH_TURNSTILE_MODE: 'log', DDC_AUTH_TURNSTILE_SECRET: TS_FAIL, DDC_AUTH_TURNSTILE_SITE_KEY: TS_SITE });
    await h.start({ turnstileToken: TS_TOKEN, now: at(T0) });
    assert.equal(h.sent.length, 1);
    await flushLogs();
    assert.ok(logText().includes('native_auth.turnstile_failed'));
  });

  it('per-email hard ceiling (24 h) → 429 OTP_SEND_LIMITED', async () => {
    const h = harness({ DDC_AUTH_OTP_EMAIL_CEILING_DAY: '4', DDC_AUTH_OTP_PER_EMAIL_HOUR: '100', DDC_AUTH_OTP_PER_EMAIL_DAY: '100', DDC_AUTH_OTP_RESEND_SEC: '1' });
    for (let i = 0; i < 4; i += 1) await h.start({ now: plus(i * 600) });
    await rejectsCode(h.start({ now: plus(3 * 600 + 60) }), 'OTP_SEND_LIMITED', (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.data.retryAfterSec, 24 * 3600 - (3 * 600 + 60));
    });
    await h.start({ now: plus(24 * 3600 + 1) });
  });

  it('per-recipient-domain cap (200/h) for custom domains; big consumer providers are exempt', async () => {
    const h = harness();
    const old = plus(-10);
    for (let i = 0; i < 200; i += 1) {
      prisma.authEmailChallenge.rows.push({ id: crypto.randomUUID(), email: `u${i}@corp.example`, codeHash: 'h', attempts: 0, locale: 'en', expiresAt: plus(600), consumedAt: null, lockedAt: null, createdAt: old });
      prisma.authEmailChallenge.rows.push({ id: crypto.randomUUID(), email: `u${i}@gmail.com`, codeHash: 'h', attempts: 0, locale: 'en', expiresAt: plus(600), consumedAt: null, lockedAt: null, createdAt: old });
    }
    await rejectsCode(h.start({ email: 'new@corp.example', now: at(T0) }), 'OTP_SEND_LIMITED');
    await h.start({ email: 'new@gmail.com', now: at(T0) });
    await h.start({ email: 'new@corp.example', now: plus(3600) });
    assert.equal(otp.DOMAIN_CAP_PER_HOUR, 200);
  });

  it('soft budget: halves the per-IP limits and logs an error once per day; hard ceiling → 503', async () => {
    const h = harness({ DDC_AUTH_OTP_SOFT_BUDGET: '2', DDC_AUTH_OTP_HARD_CEILING: '4' });
    await h.start({ email: 'a1@example.org', now: at(T0) });
    assert.deepEqual(h.tightened, [false]);
    await h.start({ email: 'a2@example.org', now: at(T0) });
    await h.start({ email: 'a3@example.org', now: at(T0) });
    assert.deepEqual(h.tightened, [false, true, true]);
    await flushLogs();
    assert.equal((logText().match(/native_auth\.otp_budget_soft/g) || []).length, 1, 'alarm once per day');
    const alarm = captured.map((line) => JSON.parse(line)).find((entry) => entry.message === 'native_auth.otp_budget_soft');
    assert.equal(alarm.level, 'error');
    await h.start({ email: 'a4@example.org', now: at(T0) });
    await rejectsCode(h.start({ email: 'a5@example.org', now: at(T0) }), 'OTP_SEND_UNAVAILABLE', (err) => assert.equal(err.status, 503));
    // Next UTC day: the count starts over, the tightening lifts.
    await h.start({ email: 'a6@example.org', now: at('2026-10-01T00:00:01Z') });
    assert.equal(h.tightened[h.tightened.length - 1], false);
  });

  it('a failed send consumes the challenge and answers 503 OTP_SEND_UNAVAILABLE', async () => {
    const h = harness();
    await rejectsCode(h.start({ now: at(T0), send: async () => { throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }); } }), 'OTP_SEND_UNAVAILABLE', (err) => assert.equal(err.status, 503));
    const [row] = prisma.store.authEmailChallenge;
    assert.ok(row.consumedAt);
    await flushLogs();
    assert.ok(logText().includes('native_auth.otp_send_failed'));
    await rejectsCode(h.verify({ challengeId: row.id, code: '000000', now: plus(5) }), 'OTP_EXPIRED');
  });

  it('dev echo: logs the code instead of mailing only on a loopback listener; otherwise 503', async () => {
    const h = harness({ DDC_AUTH_OTP_DEV_ECHO: 'true' });
    const res = await h.start({ now: at(T0), request: { ip: '127.0.0.1', localAddress: '127.0.0.1' } });
    assert.equal(h.sent.length, 0);
    await flushLogs();
    const echoed = /native_auth\.otp_dev_echo al\*\*\*@example\.org code (\d{6})/.exec(logText());
    assert.ok(echoed, 'code echoed with a masked address');
    assert.ok(await h.verify({ challengeId: res.challengeId, code: echoed[1], now: plus(1) }));
    await rejectsCode(h.start({ email: 'b@example.org', now: at(T0), request: { ip: '10.0.0.2', localAddress: '172.17.0.2' } }), 'OTP_SEND_UNAVAILABLE');
    await rejectsCode(h.start({ email: 'c@example.org', now: at(T0), env: { SMTP_HOST: 'smtp' }, request: { localAddress: '127.0.0.1' } }), 'OTP_SEND_UNAVAILABLE');
    assert.equal(otp.devEchoAllowed(makeCfg({ DDC_AUTH_OTP_DEV_ECHO: 'true', DDC_AUTH_ENV: 'test' }), {}, '127.0.0.1'), false);
  });

  it('logs carry the masked address and ipHash only — never the address, the code or its hash', async () => {
    const h = harness();
    const res = await h.start({ email: 'secret.person@example.org', now: at(T0) });
    const code = h.sent[0].code;
    await rejectsCode(h.verify({ challengeId: res.challengeId, code: code === '111111' ? '222222' : '111111', now: plus(1) }), 'OTP_INVALID');
    await h.verify({ challengeId: res.challengeId, code, now: plus(2) });
    await flushLogs();
    const text = logText();
    for (const event of ['native_auth.otp_sent', 'native_auth.otp_verify_failed']) assert.ok(text.includes(event), event);
    assert.ok(text.includes('se***@example.org'));
    assert.ok(!text.includes('secret.person'));
    assert.ok(!text.includes(code));
    assert.ok(!text.includes(prisma.store.authEmailChallenge[0].codeHash));
    assert.ok(!text.includes('203.0.113.7'));
  });

  it('an invalid address → INVALID_EMAIL before anything is stored', async () => {
    const h = harness();
    await rejectsCode(h.start({ email: 'not-an-email', guard: emailGuard.guardEmail, now: at(T0) }), 'INVALID_EMAIL', (err) => assert.equal(err.status, 400));
    assert.equal(prisma.store.authEmailChallenge.length, 0);
  });
});

// ================================================================================================
describe('POST /email/verify (service)', () => {
  async function started(h, args = {}) {
    const res = await h.start({ now: at(T0), ...args });
    return { challengeId: res.challengeId, code: h.sent[h.sent.length - 1].code };
  }
  const wrong = (code) => (code === '999999' ? '999998' : '999999');

  it('the right code once: returns the address; replay → OTP_EXPIRED', async () => {
    const h = harness();
    const { challengeId, code } = await started(h);
    assert.deepEqual(await h.verify({ challengeId, code, now: plus(30) }), { email: 'alice@example.org', challengeId });
    assert.ok(prisma.store.authEmailChallenge[0].consumedAt);
    await rejectsCode(h.verify({ challengeId, code, now: plus(31) }), 'OTP_EXPIRED');
    assert.deepEqual(otp.emailIdentity('alice@example.org'), { provider: 'email', subject: 'alice@example.org', email: 'alice@example.org', emailVerified: true });
  });

  it('wrong codes count down attemptsLeft; the 5th locks; a locked challenge refuses the right code', async () => {
    const h = harness();
    const { challengeId, code } = await started(h);
    for (let left = 4; left >= 1; left -= 1) {
      await rejectsCode(h.verify({ challengeId, code: wrong(code), now: plus(10) }), 'OTP_INVALID', (err) => {
        assert.equal(err.status, 400);
        assert.deepEqual(err.data, { attemptsLeft: left });
      });
    }
    await rejectsCode(h.verify({ challengeId, code: wrong(code), now: plus(10) }), 'OTP_LOCKED');
    await rejectsCode(h.verify({ challengeId, code, now: plus(11) }), 'OTP_LOCKED');
    assert.ok(prisma.store.authEmailChallenge[0].lockedAt);
    assert.equal(prisma.store.authEmailChallenge[0].attempts, 5);
    await flushLogs();
    assert.ok(logText().includes('native_auth.otp_locked'));
  });

  it('malformed codes are wrong codes (they spend an attempt)', async () => {
    const h = harness();
    const { challengeId } = await started(h);
    for (const bad of ['12345', '1234567', 'abcdef', 123456, null, ' 12345']) {
      await h.verify({ challengeId, code: bad, now: plus(1) }).catch(() => {});
    }
    assert.equal(prisma.store.authEmailChallenge[0].attempts, 5);
  });

  it('attempts are claimed atomically: a burst of wrong codes never exceeds the cap', async () => {
    const h = harness();
    const { challengeId, code } = await started(h);
    const results = await Promise.allSettled(Array.from({ length: 12 }, () => h.verify({ challengeId, code: wrong(code), now: plus(1) })));
    assert.ok(results.every((r) => r.status === 'rejected'));
    assert.equal(prisma.store.authEmailChallenge[0].attempts, 5);
    await rejectsCode(h.verify({ challengeId, code, now: plus(2) }), 'OTP_LOCKED');
  });

  it('two concurrent right codes: exactly one succeeds', async () => {
    const h = harness();
    const { challengeId, code } = await started(h);
    const results = await Promise.allSettled([h.verify({ challengeId, code, now: plus(1) }), h.verify({ challengeId, code, now: plus(1) })]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'OTP_EXPIRED');
  });

  it('expired, unknown or malformed challenge ids → OTP_EXPIRED', async () => {
    const h = harness();
    const { challengeId, code } = await started(h);
    await rejectsCode(h.verify({ challengeId, code, now: plus(600) }), 'OTP_EXPIRED');
    await rejectsCode(h.verify({ challengeId: crypto.randomUUID(), code, now: plus(1) }), 'OTP_EXPIRED');
    for (const id of ['', 'x', null, 5, `${challengeId}x`]) await rejectsCode(h.verify({ challengeId: id, code, now: plus(1) }), 'OTP_EXPIRED');
  });

  it('a code is bound to its challenge (the HMAC covers the challenge id)', async () => {
    const h = harness({ DDC_AUTH_OTP_RESEND_SEC: '1' });
    const a = await started(h, { email: 'a@example.org' });
    const b = await started(h, { email: 'b@example.org' });
    if (a.code !== b.code) await rejectsCode(h.verify({ challengeId: a.challengeId, code: b.code, now: plus(1) }), 'OTP_INVALID');
    assert.notEqual(otp.codeHash(a.challengeId, '123456', h.cfg), otp.codeHash(b.challengeId, '123456', h.cfg));
  });

  it('cross-challenge failure budget: after 30 wrong codes in 24 h a verify needs Turnstile (escalation, not a lock)', async () => {
    const h = harness({ DDC_AUTH_TURNSTILE_MODE: 'log', DDC_AUTH_TURNSTILE_SECRET: TS_PASS, DDC_AUTH_TURNSTILE_SITE_KEY: TS_SITE });
    // 6 earlier challenges with 5 wrong codes each = 30 failures (one consumed after 1 success is not a failure).
    for (let i = 0; i < 6; i += 1) {
      prisma.authEmailChallenge.rows.push({ id: crypto.randomUUID(), email: 'alice@example.org', codeHash: 'h', attempts: 5, locale: 'en', ipHash: null, expiresAt: plus(-100), consumedAt: null, lockedAt: plus(-200), createdAt: plus(-3600) });
    }
    prisma.authEmailChallenge.rows.push({ id: crypto.randomUUID(), email: 'alice@example.org', codeHash: 'h', attempts: 3, locale: 'en', ipHash: null, expiresAt: plus(-100), consumedAt: plus(-150), lockedAt: null, createdAt: plus(-3600) });
    assert.equal(otp.failuresOf(prisma.store.authEmailChallenge), 32);
    const { challengeId, code } = await started(h, { turnstileToken: TS_TOKEN });
    await rejectsCode(h.verify({ challengeId, code, now: plus(1) }), 'TURNSTILE_FAILED', (err) => assert.equal(err.data.reason, 'too_many_failures'));
    assert.equal(prisma.store.authEmailChallenge.find((r) => r.id === challengeId).attempts, 0, 'no attempt spent, no lock');
    assert.ok(await h.verify({ challengeId, code, turnstileToken: TS_TOKEN, now: plus(2) }));
  });

  it('below 30 failures, or with Turnstile off, no escalation', async () => {
    const h = harness();
    for (let i = 0; i < 10; i += 1) {
      prisma.authEmailChallenge.rows.push({ id: crypto.randomUUID(), email: 'alice@example.org', codeHash: 'h', attempts: 5, locale: 'en', ipHash: null, expiresAt: plus(-100), consumedAt: null, lockedAt: plus(-200), createdAt: plus(-3600) });
    }
    const { challengeId, code } = await started(h);
    assert.ok(await h.verify({ challengeId, code, now: plus(1) }));
  });
});

// ================================================================================================
describe('controller: link intent authenticates before the code is spent', () => {
  function fakeRes() {
    const res = { statusCode: 200, body: null, headers: {} };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  }
  const req = (body) => ({ body, ip: '203.0.113.7', get: () => '', socket: { localAddress: '127.0.0.1' }, nativeAuthConfig: makeCfg() });

  it('an unauthenticated link request is answered by the authenticator; verify never runs', async () => {
    let verifyCalls = 0;
    const controller = createEmailController({
      otp: { ...otp, verifyEmailChallenge: async () => { verifyCalls += 1; return { email: 'a@example.org' }; } },
      authenticate: (rq, rs) => rs.status(401).json({ status: 'fail', message: 'Authentication required. Please login first.' }),
      identify: () => ({ createLoginAttempt: async () => ({}) }),
    });
    const res = fakeRes();
    await controller.verify(req({ challengeId: 'x', code: '1', intent: 'link' }), res, (e) => { throw e; });
    assert.equal(res.statusCode, 401);
    assert.equal(verifyCalls, 0);
  });

  it('link passes the bearer user to identify; login never does', async () => {
    const calls = [];
    const controller = createEmailController({
      otp: { ...otp, verifyEmailChallenge: async () => ({ email: 'a@example.org', challengeId: 'c' }) },
      authenticate: (rq, rs, next) => { rq.user = { id: 'user-1' }; next(); },
      identify: () => ({ createLoginAttempt: async (args) => { calls.push(args); return { loginId: 'l' }; } }),
    });
    const res = fakeRes();
    await controller.verify(req({ challengeId: 'c', code: '123456', intent: 'link' }), res, (e) => { throw e; });
    await flushLogs();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { status: 'success', data: { loginId: 'l' } });
    assert.equal(calls[0].intent, 'link');
    assert.deepEqual(calls[0].bearerUser, { id: 'user-1' });
    const res2 = fakeRes();
    await controller.verify(req({ challengeId: 'c', code: '123456', intent: 'bogus' }), res2, (e) => { throw e; });
    assert.equal(calls[1].intent, 'login');
    assert.equal(calls[1].bearerUser, undefined);
  });
});

// ================================================================================================
describe('routes inside the real application', () => {
  Object.assign(process.env, {
    WEB3AUTH_VERIFY_MODE: 'off',
    APNS_KEY_ID: 'TESTKEY001',
    APNS_TEAM_ID: 'TESTTEAM01',
    JWT_SECRET: 'user-session-secret',
    SSO_SESSION_SECRET: 'sso-session-secret',
    PUBLIC_BASE_URL: 'https://api.test.local',
    APP_PUBLIC_URL: 'https://app.test.local',
  });
  for (const name of Object.keys(process.env)) if (name.startsWith('DDC_AUTH_') || name === 'SMTP_HOST') delete process.env[name];

  let app;
  let server;
  const saved = {};
  function setEnv(vars) {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  before(async () => {
    app = require('../../src/app');
    server = await listenLoopback(app);
  });
  after(() => new Promise((resolve) => server.close(resolve)));
  beforeEach(async () => {
    identifyCalls.length = 0;
    require('../../src/middlewares/rateLimitMiddleware').clearRateLimitStore();
    // Seed the DNS cache so the real guard runs without the network.
    await emailGuard.checkDomainDeliverable('gmail.com', { resolver: { resolveMx: async () => [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] } });
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
  });
  const on = (extra = {}) => setEnv(localEnv(key, { DDC_AUTH_METHODS: 'email', DDC_AUTH_EMAIL_FROM: 'login@datadance.test', DDC_AUTH_OTP_DEV_ECHO: 'true', ...extra }));

  it('flags off: both routes answer 404 NATIVE_AUTH_DISABLED and touch nothing', async () => {
    for (const p of ['/api/auth/native/email/start', '/api/auth/native/email/verify']) {
      const res = await request(server).post(p).send({ email: 'a@gmail.com' });
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NATIVE_AUTH_DISABLED');
    }
    assert.equal(prisma.store.authEmailChallenge.length, 0);
  });

  it('email method off: 404 METHOD_DISABLED', async () => {
    on({ DDC_AUTH_METHODS: '' });
    const res = await request(server).post('/api/auth/native/email/start').send({ email: 'a@gmail.com' });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'METHOD_DISABLED');
  });

  it('start → (dev echo) → verify → identify hand-off; identical start bodies for any address', async () => {
    on();
    const s1 = await request(server).post('/api/auth/native/email/start').set('User-Agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15').send({ email: ' Carol@Gmail.com ', locale: 'ja' });
    assert.equal(s1.status, 200, JSON.stringify(s1.body));
    assert.equal(s1.headers['cache-control'], 'no-store');
    assert.equal(s1.headers['x-ratelimit-limit'], '60', 'the per-IP limiters ran (the hourly one sets the header last)');
    assert.deepEqual(Object.keys(s1.body.data).sort(), ['challengeId', 'codeLength', 'expiresInSec', 'resendAfterSec']);
    const s2 = await request(server).post('/api/auth/native/email/start').send({ email: 'dave@gmail.com', locale: 'en' });
    assert.deepEqual({ ...s1.body, data: { ...s1.body.data, challengeId: '' } }, { ...s2.body, data: { ...s2.body.data, challengeId: '' } });

    await flushLogs();
    const code = new RegExp('otp_dev_echo ca\\*\\*\\*@gmail\\.com code (\\d{6})').exec(logText())[1];
    const bad = await request(server).post('/api/auth/native/email/verify').send({ challengeId: s1.body.data.challengeId, code: code === '000000' ? '000001' : '000000' });
    assert.equal(bad.status, 400);
    assert.deepEqual(bad.body, { status: 'fail', code: 'OTP_INVALID', message: 'OTP_INVALID', data: { attemptsLeft: 4 } });
    const ok = await request(server).post('/api/auth/native/email/verify').send({ challengeId: s1.body.data.challengeId, code });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.loginId, '00000000-0000-4000-8000-000000000001');
    assert.equal(identifyCalls.length, 1);
    const call = identifyCalls[0];
    assert.deepEqual(call.identity, { provider: 'email', subject: 'carol@gmail.com', email: 'carol@gmail.com', emailVerified: true });
    assert.equal(call.intent, 'login');
    assert.equal(call.method, 'email');
    assert.ok(call.req && call.req.ip);
    const replay = await request(server).post('/api/auth/native/email/verify').send({ challengeId: s1.body.data.challengeId, code });
    assert.equal(replay.body.code, 'OTP_EXPIRED');
  });

  it('bad input: non-string email → INVALID_EMAIL; disposable → INVALID_EMAIL', async () => {
    on();
    for (const body of [{}, { email: 42 }, { email: 'x@mailinator.com' }, { email: 'nope' }]) {
      const res = await request(server).post('/api/auth/native/email/start').send(body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_EMAIL');
    }
  });

  it('intent link without a session → 401 and the code is not spent', async () => {
    on();
    const s = await request(server).post('/api/auth/native/email/start').send({ email: 'erin@gmail.com' });
    const res = await request(server).post('/api/auth/native/email/verify').send({ challengeId: s.body.data.challengeId, code: '123456', intent: 'link' });
    assert.equal(res.status, 401);
    assert.equal(prisma.store.authEmailChallenge.find((r) => r.id === s.body.data.challengeId).attempts, 0);
    assert.equal(identifyCalls.length, 0);
  });

  it('per-IP burst limiter: the 6th start in a minute → 429 RATE_LIMITED (native envelope)', async () => {
    on();
    for (let i = 0; i < 5; i += 1) {
      const res = await request(server).post('/api/auth/native/email/start').send({ email: `burst${i}@gmail.com` });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    }
    const res = await request(server).post('/api/auth/native/email/start').send({ email: 'burst9@gmail.com' });
    assert.equal(res.status, 429);
    assert.equal(res.body.code, 'RATE_LIMITED');
    assert.ok(res.body.data.retryAfterSec > 0);
  });

  it('past the soft budget the per-IP burst limit is halved', async () => {
    on({ DDC_AUTH_OTP_SOFT_BUDGET: '1' });
    const first = await request(server).post('/api/auth/native/email/start').send({ email: 'soft0@gmail.com' });
    assert.equal(first.status, 200);
    assert.equal(first.headers['x-ratelimit-limit'], '60');
    const second = await request(server).post('/api/auth/native/email/start').send({ email: 'soft1@gmail.com' });
    assert.equal(second.headers['x-ratelimit-limit'], '30', 'hourly per-IP limit halved');
    const third = await request(server).post('/api/auth/native/email/start').send({ email: 'soft2@gmail.com' });
    assert.equal(third.status, 429, 'burst limit halved to 2 per minute');
    require('../../src/middlewares/rateLimitMiddleware').setNativeOtpTightened(false);
  });

  it('every emitted error code is in the §2.2 table', () => {
    for (const c of ['INVALID_EMAIL', 'TURNSTILE_FAILED', 'OTP_RESEND_TOO_SOON', 'OTP_SEND_LIMITED', 'OTP_SEND_UNAVAILABLE', 'OTP_INVALID', 'OTP_EXPIRED', 'OTP_LOCKED']) {
      assert.ok(c in NATIVE_ERROR_CODES, c);
    }
  });
});
