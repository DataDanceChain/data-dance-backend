/**
 * Native e-mail OTP on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at a
 * throwaway, migrated database whose name contains "test").
 *
 * What only the database can prove (design §3.3, §7.3): the per-address advisory lock really runs
 * inside Prisma's interactive transaction and serialises concurrent /email/start calls, so the
 * cooldown and the caps hold under a burst; the per-domain count query works on Postgres; the
 * attempt claim (`attempts < max → +1`) and the single-use consume are atomic under concurrent
 * verifies.
 *
 * With TEST_MAILPIT_SMTP (host:port) and TEST_MAILPIT_API (http://host:port) set, the mail itself
 * is sent through nodemailer to a Mailpit catcher and read back: subject without the code, the
 * code in the body, no links, and the code from the mailbox verifies.
 *
 * Fixture rows carry a per-run tag in the address and are deleted afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const prisma = require('../../src/utils/prisma');
const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');
const { readNativeAuthConfig } = require('../../src/services/nativeAuth/config');
const emailGuard = require('../../src/services/nativeAuth/emailGuard');
const otp = require('../../src/services/nativeAuth/emailOtp');
const { sendLoginCodeEmail, resetEmailTransport } = require('../../src/utils/email');

const RUN = `otp${crypto.randomBytes(3).toString('hex')}`;
const addr = (name, domain = 'example.org') => `${RUN}-${name}@${domain}`;
const key = makeKeyFile();
const cfgOf = (overrides = {}) => readNativeAuthConfig(localEnv(key, { DDC_AUTH_METHODS: 'email', DDC_AUTH_EMAIL_FROM: 'login@datadance.test', ...overrides }));

const guard = async (raw) => {
  const email = emailGuard.normalizeEmail(raw);
  return { email, domain: emailGuard.domainOf(email) };
};
const sent = [];
const base = {
  guard,
  send: async (to, code) => {
    sent.push({ to, code });
  },
  setTightened: () => {},
  env: {},
  request: { ip: '198.51.100.9' },
};
const codeFor = (to) => [...sent].reverse().find((s) => s.to === to).code;

async function settle(promises) {
  const results = await Promise.allSettled(promises);
  return {
    ok: results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    codes: results.filter((r) => r.status === 'rejected').map((r) => r.reason.code || r.reason.message),
  };
}

describe('native e-mail OTP on Postgres', () => {
  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "AuthEmailChallenge" WHERE email LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
  });

  it('a burst of starts for one address: the advisory lock lets exactly one through the cooldown', async () => {
    const cfg = cfgOf();
    const email = addr('burst');
    const { ok, codes } = await settle(Array.from({ length: 12 }, () => otp.startEmailChallenge({ ...base, email, cfg, db: prisma })));
    assert.equal(ok.length, 1, `codes: ${codes.join(',')}`);
    assert.deepEqual([...new Set(codes)], ['OTP_RESEND_TOO_SOON']);
    assert.equal(await prisma.authEmailChallenge.count({ where: { email } }), 1);
  });

  it('a burst never takes an address past its ceiling', async () => {
    const cfg = cfgOf({ DDC_AUTH_OTP_EMAIL_CEILING_DAY: '3', DDC_AUTH_OTP_PER_EMAIL_HOUR: '100', DDC_AUTH_OTP_PER_EMAIL_DAY: '100', DDC_AUTH_OTP_RESEND_SEC: '1' });
    const email = addr('ceiling');
    const past = new Date(Date.now() - 30 * 60 * 1000);
    await prisma.authEmailChallenge.createMany({
      data: [0, 1].map((i) => ({ email, codeHash: 'x', locale: 'en', expiresAt: past, createdAt: new Date(past.getTime() + i * 1000) })),
    });
    const { ok, codes } = await settle(Array.from({ length: 10 }, () => otp.startEmailChallenge({ ...base, email, cfg, db: prisma })));
    assert.equal(ok.length, 1);
    assert.ok(codes.every((c) => c === 'OTP_RESEND_TOO_SOON' || c === 'OTP_SEND_LIMITED'), codes.join(','));
    assert.equal(await prisma.authEmailChallenge.count({ where: { email } }), 3);
    await assert.rejects(otp.startEmailChallenge({ ...base, email, cfg, db: prisma, now: new Date(Date.now() + 5000) }), { code: 'OTP_SEND_LIMITED' });
  });

  it('the per-recipient-domain cap counts the domain on Postgres', async () => {
    const cfg = cfgOf();
    const domain = `${RUN}.example.net`;
    const now = new Date();
    await prisma.authEmailChallenge.createMany({
      data: Array.from({ length: 200 }, (_, i) => ({ email: `${RUN}-d${i}@${domain}`, codeHash: 'x', locale: 'en', expiresAt: now, createdAt: new Date(now.getTime() - 60 * 1000) })),
    });
    await assert.rejects(otp.startEmailChallenge({ ...base, email: `${RUN}-new@${domain}`, cfg, db: prisma }), { code: 'OTP_SEND_LIMITED' });
    // A look-alike domain that merely ends with the same letters is not counted.
    await otp.startEmailChallenge({ ...base, email: `${RUN}-new@x${domain}`, cfg, db: prisma });
  });

  it('concurrent wrong codes claim at most MAX attempts, then the challenge is locked', async () => {
    const cfg = cfgOf();
    const email = addr('guess');
    const { challengeId } = await otp.startEmailChallenge({ ...base, email, cfg, db: prisma });
    const right = codeFor(email);
    const wrong = right === '999999' ? '999998' : '999999';
    const { ok, codes } = await settle(Array.from({ length: 20 }, () => otp.verifyEmailChallenge({ challengeId, code: wrong, cfg, db: prisma })));
    assert.equal(ok.length, 0);
    assert.ok(codes.every((c) => c === 'OTP_INVALID' || c === 'OTP_LOCKED'), codes.join(','));
    assert.ok(codes.filter((c) => c === 'OTP_INVALID').length <= 4);
    const row = await prisma.authEmailChallenge.findUnique({ where: { id: challengeId } });
    assert.equal(row.attempts, 5);
    assert.ok(row.lockedAt);
    await assert.rejects(otp.verifyEmailChallenge({ challengeId, code: right, cfg, db: prisma }), { code: 'OTP_LOCKED' });
  });

  it('concurrent right codes: exactly one verify consumes the challenge', async () => {
    const cfg = cfgOf();
    const email = addr('race');
    const { challengeId } = await otp.startEmailChallenge({ ...base, email, cfg, db: prisma });
    const code = codeFor(email);
    const { ok, codes } = await settle(Array.from({ length: 5 }, () => otp.verifyEmailChallenge({ challengeId, code, cfg, db: prisma })));
    assert.equal(ok.length, 1);
    assert.deepEqual([...new Set(codes)], ['OTP_EXPIRED']);
    const row = await prisma.authEmailChallenge.findUnique({ where: { id: challengeId } });
    assert.ok(row.consumedAt);
    assert.ok(row.codeHash && !row.codeHash.includes(code));
  });

  describe('Mailpit transport', { skip: !(process.env.TEST_MAILPIT_SMTP && process.env.TEST_MAILPIT_API) && 'TEST_MAILPIT_SMTP / TEST_MAILPIT_API not set' }, () => {
    const [host, port] = String(process.env.TEST_MAILPIT_SMTP || '').split(':');
    const api = process.env.TEST_MAILPIT_API;
    const mailEnv = { SMTP_HOST: host, SMTP_PORT: port, DDC_AUTH_EMAIL_FROM: 'DataDance <login@datadance.test>' };
    const send = (to, code, locale, context) => sendLoginCodeEmail(to, code, locale, context, { env: mailEnv });

    async function mailFor(to) {
      for (let i = 0; i < 20; i += 1) {
        const list = await (await fetch(`${api}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`)).json();
        if (list.messages && list.messages.length) return (await fetch(`${api}/api/v1/message/${list.messages[0].ID}`)).json();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('mail not delivered to Mailpit');
    }

    before(() => resetEmailTransport());
    after(() => resetEmailTransport());

    it('start mails the code (not in the subject, no links); the mailed code verifies', async () => {
      const cfg = cfgOf();
      for (const locale of ['en', 'zh', 'zh-TW', 'ja', 'ko']) {
        const email = addr(`mail-${locale.toLowerCase()}`);
        const { challengeId } = await otp.startEmailChallenge({
          ...base,
          send,
          email,
          locale,
          cfg,
          db: prisma,
          request: { ip: '198.51.100.9', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1', country: 'KR' },
        });
        const message = await mailFor(email);
        const code = /\b(\d{6})\b/.exec(message.Text)[1];
        assert.doesNotMatch(message.Subject, /\d{6}/, `${locale}: code in subject`);
        assert.ok(message.HTML.includes(code));
        assert.doesNotMatch(message.HTML, /<a[\s>]|href=/i, `${locale}: link in HTML`);
        assert.ok(message.Text.includes('app.datadance.ai'));
        assert.equal(message.From.Address, 'login@datadance.test');
        const verified = await otp.verifyEmailChallenge({ challengeId, code, cfg, db: prisma });
        assert.equal(verified.email, email);
      }
    });
  });
});
