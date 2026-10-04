/**
 * attestHashOnChain returns ok:true only when the mined receipt proves the attestation: status 1
 * AND an Attested(hash, sender) log emitted by the configured attester with exactly the expected
 * hash and the signer as sender. Every other outcome is { ok:false, pending:true, reason }, logged,
 * and never a throw. Fake provider and wallet; no network.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  attestHashOnChain,
  verifyAttestedReceipt,
  attesterHasCode,
  ATTESTED_TOPIC,
  toBytes32,
} = require('../../src/utils/commerceAttestChain');
const {
  FakeChain, attestedLog, makeReceipt, randomHash, randomAddress, contentHash,
} = require('../helpers/fakeAttestChain');

function spyLog() {
  const warnings = [];
  return { warnings, warn: (msg, meta) => warnings.push({ msg, meta }) };
}

async function run(chain, wallet, hash, extra = {}) {
  const log = spyLog();
  const result = await attestHashOnChain(hash, {
    provider: chain.provider, wallet, attester: chain.attester, log, ...extra,
  });
  return { result, log };
}

function assertPending(result, log, reasonPattern) {
  assert.equal(result.ok, false);
  assert.equal(result.pending, true);
  assert.equal(result.txHash, null, 'a failed attestation never hands callers a tx hash to store');
  assert.match(result.reason, reasonPattern);
  assert.equal(log.warnings.length, 1, 'every failure is logged once');
  assert.equal(log.warnings[0].meta.reason, result.reason);
}

describe('attestHashOnChain: success only with a proving receipt', () => {
  it('returns ok:true with the tx hash when the receipt has the exact Attested log', async () => {
    const chain = new FakeChain();
    const wallet = chain.wallet();
    const hash = contentHash();
    const { result, log } = await run(chain, wallet, hash);
    assert.equal(result.ok, true);
    assert.equal(result.pending, false);
    assert.match(result.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(result.attester, chain.attester);
    assert.equal(log.warnings.length, 0);
    assert.deepEqual(chain.sent, [{ to: chain.attester, hash: toBytes32(hash) }]);
  });

  it('accepts the hash with or without 0x and in any case', async () => {
    const chain = new FakeChain();
    const hash = contentHash();
    const { result } = await run(chain, chain.wallet(), `0x${hash.toUpperCase()}`);
    assert.equal(result.ok, true);
  });

  it('fails when the call reached an address without code (the 64 lost attestations)', async () => {
    const chain = new FakeChain();
    const empty = randomAddress();
    const txHash = randomHash();
    const w = chain.wallet(randomAddress(), (tx) => ({
      txHash,
      receipt: makeReceipt({ txHash, from: tx.from, to: empty, status: 1, logs: [] }),
    }));
    const { result, log } = await run(chain, w, contentHash());
    assertPending(result, log, /no logs/);
    assert.equal(result.sentTxHash, txHash, 'the sent tx hash is reported for the log, not stored');
  });

  it('fails on a status-0 receipt even if it carries a matching log', async () => {
    const chain = new FakeChain();
    const hash = contentHash();
    const sender = randomAddress();
    const txHash = randomHash();
    const w = chain.wallet(sender, () => ({
      txHash,
      receipt: makeReceipt({
        txHash, from: sender, to: chain.attester, status: 0,
        logs: [attestedLog({ attester: chain.attester, hash, sender, txHash })],
      }),
    }));
    const { result, log } = await run(chain, w, hash);
    assertPending(result, log, /status is not 1/);
  });

  it('fails on a missing status', async () => {
    const chain = new FakeChain();
    const hash = contentHash();
    const sender = randomAddress();
    const txHash = randomHash();
    const w = chain.wallet(sender, () => ({
      txHash,
      receipt: makeReceipt({
        txHash, from: sender, to: chain.attester, status: null,
        logs: [attestedLog({ attester: chain.attester, hash, sender, txHash })],
      }),
    }));
    const { result, log } = await run(chain, w, hash);
    assertPending(result, log, /status is not 1/);
  });

  const wrongLogCases = [
    ['emitted by another contract', (ctx) => attestedLog({ ...ctx, attester: randomAddress() })],
    ['for a different hash', (ctx) => attestedLog({ ...ctx, hash: contentHash() })],
    ['with a different sender', (ctx) => attestedLog({ ...ctx, sender: randomAddress() })],
    ['with a different event signature', (ctx) => ({ ...attestedLog(ctx), topics: [ethers.id('Other(bytes32,address)'), ...attestedLog(ctx).topics.slice(1)] })],
    ['with a missing sender topic', (ctx) => ({ ...attestedLog(ctx), topics: attestedLog(ctx).topics.slice(0, 2) })],
    ['with an extra fourth topic (another event shape)', (ctx) => ({ ...attestedLog(ctx), topics: [...attestedLog(ctx).topics, randomHash()] })],
    ['with non-empty data', (ctx) => ({ ...attestedLog(ctx), data: '0x01' })],
    ['marked removed (reorg)', (ctx) => ({ ...attestedLog(ctx), removed: true })],
  ];
  for (const [label, makeLog] of wrongLogCases) {
    it(`fails when the only Attested-like log is ${label}`, async () => {
      const chain = new FakeChain();
      const hash = contentHash();
      const sender = randomAddress();
      const txHash = randomHash();
      const w = chain.wallet(sender, () => ({
        txHash,
        receipt: makeReceipt({
          txHash, from: sender, to: chain.attester, status: 1,
          logs: [makeLog({ attester: chain.attester, hash, sender, txHash })],
        }),
      }));
      const { result, log } = await run(chain, w, hash);
      assertPending(result, log, /no Attested log/);
    });
  }

  it('passes when the right log sits among unrelated logs', async () => {
    const chain = new FakeChain();
    const hash = contentHash();
    const sender = randomAddress();
    const txHash = randomHash();
    const w = chain.wallet(sender, () => ({
      txHash,
      receipt: makeReceipt({
        txHash, from: sender, to: chain.attester, status: 1,
        logs: [
          attestedLog({ attester: randomAddress(), hash, sender, txHash, index: 0 }),
          attestedLog({ attester: chain.attester, hash, sender, txHash, index: 1 }),
        ],
      }),
    }));
    const { result } = await run(chain, w, hash);
    assert.equal(result.ok, true);
    assert.equal(result.txHash, txHash);
  });

  it('fails when wait() resolves to no receipt', async () => {
    const chain = new FakeChain();
    const w = chain.wallet(randomAddress(), () => ({ receipt: null }));
    const { result, log } = await run(chain, w, contentHash());
    assertPending(result, log, /no receipt/);
  });

  it('fails when the receipt belongs to another transaction', async () => {
    const chain = new FakeChain();
    const hash = contentHash();
    const sender = randomAddress();
    const other = randomHash();
    const w = chain.wallet(sender, () => ({
      txHash: randomHash(),
      receipt: makeReceipt({
        txHash: other, from: sender, to: chain.attester, status: 1,
        logs: [attestedLog({ attester: chain.attester, hash, sender, txHash: other })],
      }),
    }));
    const { result, log } = await run(chain, w, hash);
    assertPending(result, log, /does not belong/);
  });

  it('fails when wait() rejects (ethers CALL_EXCEPTION on revert) and reports the sent hash', async () => {
    const chain = new FakeChain();
    const txHash = randomHash();
    const w = chain.wallet(randomAddress(), () => ({
      txHash,
      receipt: null,
      waitError: Object.assign(new Error('transaction execution reverted'), { code: 'CALL_EXCEPTION' }),
    }));
    const { result, log } = await run(chain, w, contentHash());
    assertPending(result, log, /reverted/);
    assert.equal(result.sentTxHash, txHash);
  });

  it('does not send when the attester has no code', async () => {
    const chain = new FakeChain({ withCode: false });
    const { result, log } = await run(chain, chain.wallet(), contentHash());
    assertPending(result, log, /has no contract code/);
    assert.equal(chain.sent.length, 0);
  });

  it('does not send when eth_getCode fails', async () => {
    const chain = new FakeChain({ attester: randomAddress() });
    chain.failures.getCode = new Error('getCode boom');
    const { result, log } = await run(chain, chain.wallet(), contentHash());
    assertPending(result, log, /getCode boom/);
    assert.equal(chain.sent.length, 0);
  });

  it('does not send when the RPC is down', async () => {
    const chain = new FakeChain();
    chain.failures.getBlockNumber = new Error('connect ECONNREFUSED');
    const { result, log } = await run(chain, chain.wallet(), contentHash());
    assertPending(result, log, /ECONNREFUSED/);
    assert.equal(chain.sent.length, 0);
  });

  it('does not send for a malformed hash', async () => {
    const chain = new FakeChain();
    const { result, log } = await run(chain, chain.wallet(), 'not-a-hash');
    assertPending(result, log, /32 bytes/);
    assert.equal(chain.calls.includes('sendTransaction'), false);
  });

  it('does not send when the attester address is invalid', async () => {
    const chain = new FakeChain();
    const { result, log } = await run(chain, chain.wallet(), contentHash(), { attester: 'nope' });
    assertPending(result, log, /not configured/);
    assert.equal(chain.calls.length, 0, 'no RPC call at all');
  });

  it('fails without throwing when sendTransaction rejects', async () => {
    const chain = new FakeChain();
    chain.failures.sendTransaction = new Error('insufficient funds for gas');
    const { result, log } = await run(chain, chain.wallet(), contentHash());
    assertPending(result, log, /insufficient funds/);
  });

  it('fails without throwing when the wallet cannot report its address', async () => {
    const chain = new FakeChain();
    const wallet = { getAddress: async () => { throw new Error('signer locked'); } };
    const { result, log } = await run(chain, wallet, contentHash());
    assertPending(result, log, /signer locked/);
  });

  it('never throws even if the logger itself throws', async () => {
    const chain = new FakeChain({ withCode: false });
    const result = await attestHashOnChain(contentHash(), {
      provider: chain.provider,
      wallet: chain.wallet(),
      attester: chain.attester,
      log: { warn: () => { throw new Error('log sink down'); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.pending, true);
  });
});

describe('verifyAttestedReceipt (pure)', () => {
  const attester = randomAddress();
  const sender = randomAddress();
  const hash = contentHash();
  const txHash = randomHash();
  const good = () => makeReceipt({
    txHash, from: sender, to: attester, status: 1, logs: [attestedLog({ attester, hash, sender, txHash })],
  });

  it('accepts a raw JSON-RPC receipt (status "0x1", lowercase addresses)', () => {
    const raw = good();
    raw.status = '0x1';
    raw.logs[0].address = attester.toLowerCase();
    assert.equal(verifyAttestedReceipt(raw, { attester, hash, sender }).ok, true);
  });

  it('returns a stable code for each failure', () => {
    assert.equal(verifyAttestedReceipt(null, { attester, hash, sender }).code, 'no_receipt');
    assert.equal(verifyAttestedReceipt({ ...good(), status: 0 }, { attester, hash, sender }).code, 'status_not_1');
    assert.equal(verifyAttestedReceipt({ ...good(), status: '0x0' }, { attester, hash, sender }).code, 'status_not_1');
    assert.equal(verifyAttestedReceipt({ ...good(), logs: [] }, { attester, hash, sender }).code, 'no_logs');
    assert.equal(verifyAttestedReceipt(good(), { attester, hash: contentHash(), sender }).code, 'no_matching_log');
    assert.equal(verifyAttestedReceipt(good(), { attester: 'x', hash, sender }).code, 'invalid_attester');
    assert.equal(verifyAttestedReceipt(good(), { attester, hash, sender: 'x' }).code, 'invalid_sender');
    assert.equal(verifyAttestedReceipt(good(), { attester, hash: 'zz', sender }).code, 'invalid_hash');
  });

  it('rejects a log with exactly the right first three topics plus a fourth', () => {
    const receipt = good();
    receipt.logs[0].topics = [...receipt.logs[0].topics, randomHash()];
    const verdict = verifyAttestedReceipt(receipt, { attester, hash, sender });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'no_matching_log');
  });

  it('uses the Attested(bytes32,address) topic', () => {
    assert.equal(ATTESTED_TOPIC, ethers.id('Attested(bytes32,address)'));
  });
});

describe('attesterHasCode: only a positive answer is cached', () => {
  it('asks again after a "no code" answer, so a later deploy is seen without a restart', async () => {
    const chain = new FakeChain({ withCode: false });
    assert.equal(await attesterHasCode(chain.provider, chain.attester), false);
    chain.code.set(chain.attester.toLowerCase(), '0x6080604052');
    assert.equal(await attesterHasCode(chain.provider, chain.attester), true);
    assert.equal(chain.calls.filter((c) => c === 'getCode').length, 2);
  });

  it('attestHashOnChain sends once the attester gains code after an earlier "no code" skip', async () => {
    const chain = new FakeChain({ withCode: false });
    const w = chain.wallet();
    const first = await run(chain, w, contentHash());
    assert.equal(first.result.ok, false);
    assert.match(first.result.reason, /has no contract code/);
    chain.code.set(chain.attester.toLowerCase(), '0x6080604052');
    const second = await run(chain, w, contentHash());
    assert.equal(second.result.ok, true);
    assert.equal(chain.sent.length, 1);
  });

  it('caches a positive answer (one eth_getCode per address)', async () => {
    const chain = new FakeChain();
    assert.equal(await attesterHasCode(chain.provider, chain.attester), true);
    assert.equal(await attesterHasCode(chain.provider, chain.attester), true);
    assert.equal(chain.calls.filter((c) => c === 'getCode').length, 1);
  });
});
