/**
 * AuthFlowState (design §2.5, §3.5, §3.8): values are stored only as keyed hashes, consumption is
 * single-use and time-bound, and an IdP nonce is bound to its purpose and to sha256(raw).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.LOG_LEVEL = 'error';

const { installMockPrisma } = require('../helpers/mockPrisma');
const prisma = installMockPrisma();
const { makeKeyFile, localEnv } = require('../helpers/nativeAuthKeys');
const { readNativeAuthConfig } = require('../../src/services/nativeAuth/config');
const flow = require('../../src/services/nativeAuth/flowState');

const cfg = readNativeAuthConfig(localEnv(makeKeyFile()));
const opts = { db: prisma, cfg };

beforeEach(() => prisma.reset());

describe('createFlowState / consumeFlowState', () => {
  it('stores only an HMAC of the value, never the value', async () => {
    const value = flow.randomValue();
    const row = await flow.createFlowState({ kind: 'x_oauth', value, data: { platform: 'web' }, ttlSec: 600, ...opts });
    assert.match(row.valueHash, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(prisma.store.authFlowState).includes(value));
    assert.notEqual(row.valueHash, crypto.createHash('sha256').update(value).digest('hex'), 'keyed, not a bare sha256');
  });

  it('consumes exactly once', async () => {
    const value = flow.randomValue();
    await flow.createFlowState({ kind: 'x_handoff', value, data: { a: 1 }, ttlSec: 60, ...opts });
    const [first, second] = await Promise.all([
      flow.consumeFlowState({ kind: 'x_handoff', value, ...opts }),
      flow.consumeFlowState({ kind: 'x_handoff', value, ...opts }),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.deepEqual((first || second).data, { a: 1 });
    assert.equal(await flow.consumeFlowState({ kind: 'x_handoff', value, ...opts }), null);
  });

  it('refuses an expired state, another kind, and junk values', async () => {
    const value = flow.randomValue();
    const t0 = new Date('2026-09-30T09:00:00Z');
    await flow.createFlowState({ kind: 'x_handoff', value, ttlSec: 60, now: t0, ...opts });
    assert.equal(await flow.consumeFlowState({ kind: 'x_oauth', value, now: t0, ...opts }), null, 'kind is part of the key');
    assert.equal(await flow.consumeFlowState({ kind: 'x_handoff', value, now: new Date(t0.getTime() + 61_000), ...opts }), null, 'expired');
    assert.equal(await flow.consumeFlowState({ kind: 'x_handoff', value: '', ...opts }), null);
    assert.equal(await flow.consumeFlowState({ kind: 'x_handoff', value: 'x'.repeat(600), ...opts }), null);
    await assert.rejects(flow.createFlowState({ kind: 'nope', ttlSec: 1, ...opts }), /unknown flow state kind/);
  });

  it('consumes a value-less state by id once', async () => {
    const row = await flow.createFlowState({ kind: 'step_up', data: { action: 'link' }, ttlSec: 300, ...opts });
    assert.equal(row.valueHash, null);
    assert.ok(await flow.consumeFlowStateById({ kind: 'step_up', id: row.id, ...opts }));
    assert.equal(await flow.consumeFlowStateById({ kind: 'step_up', id: row.id, ...opts }), null);
  });
});

describe('IdP nonce (§2.5)', () => {
  it('issues a 32-byte base64url nonce with its sha256 hex, valid 300 s', async () => {
    const issued = await flow.issueIdpNonce({ purpose: 'google', ...opts });
    assert.match(issued.nonce, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(issued.nonceSha256, crypto.createHash('sha256').update(issued.nonce).digest('hex'));
    assert.equal(issued.expiresInSec, 300);
    assert.ok(!JSON.stringify(prisma.store.authFlowState).includes(issued.nonce));
  });

  it('accepts token.nonce === sha256hex(raw) once, for the purpose it was issued for', async () => {
    const g = await flow.issueIdpNonce({ purpose: 'google', ...opts });
    assert.equal(await flow.consumeIdpNonce({ purpose: 'apple', rawNonce: g.nonce, tokenNonce: g.nonceSha256, ...opts }), false, 'a Google nonce never satisfies Apple');
    assert.equal(await flow.consumeIdpNonce({ purpose: 'google', rawNonce: g.nonce, tokenNonce: g.nonceSha256.toUpperCase(), ...opts }), true);
    assert.equal(await flow.consumeIdpNonce({ purpose: 'google', rawNonce: g.nonce, tokenNonce: g.nonceSha256, ...opts }), false, 'replay');
  });

  it('a wrong raw nonce or token nonce fails and does not burn the nonce', async () => {
    const g = await flow.issueIdpNonce({ purpose: 'google', ...opts });
    assert.equal(await flow.consumeIdpNonce({ purpose: 'google', rawNonce: g.nonce, tokenNonce: 'f'.repeat(64), ...opts }), false);
    assert.equal(await flow.consumeIdpNonce({ purpose: 'google', rawNonce: g.nonce, tokenNonce: g.nonce, ...opts }), false, 'raw nonce in the token');
    assert.equal(await flow.consumeIdpNonce({ purpose: 'google', rawNonce: flow.randomValue(), tokenNonce: g.nonceSha256, ...opts }), false);
    assert.equal(await flow.consumeIdpNonce({ purpose: 'google', rawNonce: g.nonce, tokenNonce: g.nonceSha256, ...opts }), true);
  });

  it('expires after 5 minutes', async () => {
    const t0 = new Date('2026-09-30T09:00:00Z');
    const g = await flow.issueIdpNonce({ purpose: 'apple', now: t0, ...opts });
    assert.equal(await flow.consumeIdpNonce({ purpose: 'apple', rawNonce: g.nonce, tokenNonce: g.nonceSha256, now: new Date(t0.getTime() + 301_000), ...opts }), false);
  });
});
