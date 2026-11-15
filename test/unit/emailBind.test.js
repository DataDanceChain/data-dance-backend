const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.WEB3AUTH_VERIFY_MODE = 'enforce';
process.env.WEB3AUTH_CLIENT_ID = 'test-web3auth-client-id';
process.env.WEB3AUTH_ALLOWED_VERIFIERS = 'web3auth-google-sapphire';
process.env.WEB3AUTH_JWKS_PIN_MODE = 'off';

const {
  requestEmailBindCode,
  verifyEmailBindCode,
  resetEmailBindState,
  RESEND_INTERVAL_MS,
} = require('../../src/services/emailBind');
const { bindProvenEmail } = require('../../src/services/web3authIdentity');

const NOW = 1_700_000_000_000;

function placeholderUser(overrides = {}) {
  return {
    id: 'user-1',
    email: 'twitter|123',
    name: 'Ada',
    password: 'hashed',
    privateKey: 'secret-key',
    disabledAt: null,
    ...overrides,
  };
}

describe('email bind codes', () => {
  beforeEach(() => resetEmailBindState());

  it('mails a code for a typed address and does not write it yet', async () => {
    const sent = [];
    const result = await requestEmailBindCode({
      user: placeholderUser(),
      email: ' Ada@Example.com ',
      now: NOW,
      sendMail: async (email, code) => sent.push({ email, code }),
      randomCode: () => '123456',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.data.accepted, true);
    assert.deepEqual(sent, [{ email: 'ada@example.com', code: '123456' }]);
  });

  it('refuses a second code inside the resend gap', async () => {
    const send = () => requestEmailBindCode({
      user: placeholderUser(),
      email: 'ada@example.com',
      now: NOW,
      sendMail: async () => {},
      randomCode: () => '123456',
    });
    assert.equal((await send()).status, 200);
    const again = await requestEmailBindCode({
      user: placeholderUser(),
      email: 'ada@example.com',
      now: NOW + RESEND_INTERVAL_MS - 1,
      sendMail: async () => {},
      randomCode: () => '654321',
    });
    assert.equal(again.status, 429);
    assert.equal(again.body.code, 'RATE_LIMITED');
  });

  it('does not mail an account that already has a mailbox', async () => {
    let mailed = false;
    const result = await requestEmailBindCode({
      user: placeholderUser({ email: 'ada@example.com' }),
      email: 'other@example.com',
      now: NOW,
      sendMail: async () => { mailed = true; },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'EMAIL_ALREADY_BOUND');
    assert.equal(mailed, false);
  });

  it('saves the address only after the code matches, and hides secrets', async () => {
    await requestEmailBindCode({
      user: placeholderUser(),
      email: 'ada@example.com',
      now: NOW,
      sendMail: async () => {},
      randomCode: () => '123456',
    });
    const saved = [];
    const result = await verifyEmailBindCode({
      user: placeholderUser(),
      email: 'ada@example.com',
      code: '123456',
      name: '  Ada Lovelace  ',
      now: NOW + 1000,
      findOtherUsers: async () => [],
      saveBinding: async (user, email, name) => {
        saved.push({ id: user.id, email, name });
        return { ...user, email, name, password: 'hashed', privateKey: 'secret-key' };
      },
    });
    assert.equal(result.status, 200);
    assert.deepEqual(saved, [{ id: 'user-1', email: 'ada@example.com', name: 'Ada Lovelace' }]);
    assert.equal(result.body.data.user.email, 'ada@example.com');
    assert.equal(result.body.data.user.privateKey, undefined);
    assert.equal(result.body.data.user.password, undefined);
    assert.equal(result.body.data.token, undefined);
  });

  it('does not save an address another account already holds', async () => {
    await requestEmailBindCode({
      user: placeholderUser(),
      email: 'ada@example.com',
      now: NOW,
      sendMail: async () => {},
      randomCode: () => '123456',
    });
    let saved = false;
    const result = await verifyEmailBindCode({
      user: placeholderUser(),
      email: 'ada@example.com',
      code: '123456',
      now: NOW + 1000,
      findOtherUsers: async () => [{ id: 'user-2', email: 'ada@example.com' }],
      saveBinding: async () => { saved = true; return null; },
    });
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'EMAIL_IN_USE');
    assert.equal(saved, false);
  });

  it('rejects a code issued for a different account', async () => {
    await requestEmailBindCode({
      user: placeholderUser(),
      email: 'ada@example.com',
      now: NOW,
      sendMail: async () => {},
      randomCode: () => '123456',
    });
    const result = await verifyEmailBindCode({
      user: placeholderUser({ id: 'user-9' }),
      email: 'ada@example.com',
      code: '123456',
      now: NOW + 1000,
      findOtherUsers: async () => [],
      saveBinding: async () => { throw new Error('should not save'); },
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'EMAIL_CODE_INVALID');
  });
});

describe('provider-proven email', () => {
  before(() => resetEmailBindState());

  it('replaces a placeholder with the address the provider proved', async () => {
    const rows = new Map([['user-1', { id: 'user-1', email: 'twitter|123' }]]);
    const db = {
      user: {
        findFirst: async () => null,
        updateMany: async ({ where, data }) => {
          const row = rows.get(where.id);
          if (!row || row.email !== where.email) return { count: 0 };
          row.email = data.email;
          return { count: 1 };
        },
        findUnique: async ({ where }) => rows.get(where.id),
      },
    };
    const updated = await bindProvenEmail(db, rows.get('user-1'), { email: 'Ada@Example.com' });
    assert.equal(updated.email, 'ada@example.com');
  });

  it('leaves a placeholder in place when the provider proved nothing', async () => {
    let writes = 0;
    const user = { id: 'user-1', email: 'twitter|123' };
    const db = { user: { findFirst: async () => { writes += 1; return null; } } };
    const updated = await bindProvenEmail(db, user, { email: null, verifierId: 'twitter|123' });
    assert.equal(updated.email, 'twitter|123');
    assert.equal(writes, 0);
  });

  it('does not take a mailbox another account already holds', async () => {
    const user = { id: 'user-1', email: 'twitter|123' };
    const db = {
      user: {
        findFirst: async () => ({ id: 'user-2', email: 'ada@example.com' }),
        updateMany: async () => { throw new Error('should not write'); },
      },
    };
    const updated = await bindProvenEmail(db, user, { email: 'ada@example.com' });
    assert.equal(updated.email, 'twitter|123');
  });
});
