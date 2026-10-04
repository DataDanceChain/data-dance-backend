/**
 * scripts/reattestCommerceOrders.js: which rows it selects, and how --apply repairs them.
 * In-memory Prisma and a fake chain; no network, no database. The same selection runs against
 * real Postgres in test/db/reattestCommerceOrders.dbtest.js.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createMockPrisma } = require('../helpers/mockPrisma');
const {
  FakeChain, randomHash, randomAddress, contentHash, makeReceipt, attestedLog, dataNotFoundError,
} = require('../helpers/fakeAttestChain');
const script = require('../../scripts/reattestCommerceOrders');
const { attestHashOnChain } = require('../../src/utils/commerceAttestChain');

let prisma;
let chain;
let signer;

function row(model, over = {}) {
  const r = {
    id: `${model}-${Math.random().toString(36).slice(2, 10)}`,
    attestationHash: contentHash(),
    attestationTxHash: null,
    createdAt: new Date(),
    email: 'person@example.test',
    ...over,
  };
  prisma[model].rows.push(r);
  return r;
}

/** One row per classification, with a known expected outcome. */
function seedMatrix() {
  const s = {};
  const h = () => contentHash();
  let hash;

  hash = h();
  s.valid = row('purchaseOrder', { attestationHash: hash, attestationTxHash: chain.mineAttest({ hash, sender: signer }) });
  hash = h();
  s.noCode = row('purchaseOrder', { attestationHash: hash, attestationTxHash: chain.mineAttest({ hash, sender: signer, to: randomAddress() }) });
  s.notAttested = row('purchaseOrder', { attestationTxHash: null });
  s.otherHash = row('purchaseOrder', { attestationTxHash: chain.mineAttest({ hash: h(), sender: signer }) });
  hash = h();
  s.otherSender = row('purchaseOrder', { attestationHash: hash, attestationTxHash: chain.mineAttest({ hash, sender: randomAddress() }) });
  hash = h();
  s.reverted = row('purchaseOrder', { attestationHash: hash, attestationTxHash: chain.mineAttest({ hash, sender: signer, status: 0 }) });
  s.notFound = row('purchaseOrder', { attestationTxHash: randomHash() });
  s.malformed = row('purchaseOrder', { attestationTxHash: 'pasted-by-hand' });
  hash = h();
  s.disbNoCode = row('disbursementItem', { attestationHash: hash, attestationTxHash: chain.mineAttest({ hash, sender: signer, to: randomAddress() }) });
  hash = h();
  s.disbValid = row('disbursementItem', { attestationHash: hash, attestationTxHash: chain.mineAttest({ hash, sender: signer }) });
  return s;
}

function seedBlocked() {
  const s = {};
  const pendingHash = randomHash();
  chain.pendingTxs.set(pendingHash.toLowerCase(), { hash: pendingHash, blockNumber: null });
  s.pending = row('purchaseOrder', { attestationTxHash: pendingHash });
  s.noHash = row('purchaseOrder', { attestationHash: null, attestationTxHash: randomHash() });
  return s;
}

const ids = (rows) => rows.map((r) => r.id).sort();

beforeEach(() => {
  prisma = createMockPrisma();
  chain = new FakeChain();
  signer = randomAddress();
});

describe('parseArgs', () => {
  it('defaults to a read-only plan', () => {
    assert.equal(script.parseArgs([]).mode, 'plan');
    assert.equal(script.parseArgs(['--plan']).mode, 'plan');
  });
  it('needs --yes for --apply and rejects anything ambiguous', () => {
    assert.throws(() => script.parseArgs(['--apply']), /--yes/);
    assert.equal(script.parseArgs(['--apply', '--yes']).mode, 'apply');
    assert.throws(() => script.parseArgs(['--plan', '--apply', '--yes']), /either/);
    assert.throws(() => script.parseArgs(['--yes']), /only applies/);
    assert.throws(() => script.parseArgs(['--aply']), /Unknown argument/);
    assert.throws(() => script.parseArgs(['--signer', 'bob']), /address/);
    assert.throws(() => script.parseArgs(['--from-block', '-1']), /needs a value|block number/);
    assert.equal(script.parseArgs(['--apply', '--yes', '--from-block', '42']).fromBlock, 42);
  });
});

describe('plan: selection', () => {
  it('selects exactly the rows whose receipt does not prove the attestation', async () => {
    const s = seedMatrix();
    const plan = await script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });

    assert.deepEqual(ids(plan.needs), ids([s.noCode, s.otherHash, s.otherSender, s.reverted, s.notFound, s.malformed, s.disbNoCode]));
    assert.deepEqual(plan.blocked, []);
    const code = Object.fromEntries(plan.needs.map((r) => [r.id, r.code]));
    assert.equal(code[s.noCode.id], 'no_logs');
    assert.equal(code[s.otherHash.id], 'no_matching_log');
    assert.equal(code[s.otherSender.id], 'no_matching_log');
    assert.equal(code[s.reverted.id], 'status_not_1');
    assert.equal(code[s.notFound.id], 'tx_not_found');
    assert.equal(code[s.malformed.id], 'malformed_tx_hash');
    assert.equal(code[s.disbNoCode.id], 'no_logs');
    assert.deepEqual(plan.counts.purchaseOrder, { checked: 7, valid: 1, needs_reattest: 6, blocked: 0 });
    assert.deepEqual(plan.counts.disbursementItem, { checked: 2, valid: 1, needs_reattest: 1, blocked: 0 });
  });

  it('blocks rows it cannot repair safely: tx still pending, no content hash', async () => {
    const s = seedBlocked();
    const plan = await script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });
    const code = Object.fromEntries(plan.blocked.map((r) => [r.id, r.code]));
    assert.equal(code[s.pending.id], 'tx_pending');
    assert.equal(code[s.noHash.id], 'missing_attestation_hash');
    assert.equal(plan.needs.length, 0);
  });

  it('aborts instead of guessing when the RPC fails', async () => {
    seedMatrix();
    chain.failures.getTransactionReceipt = new Error('rpc 502');
    await assert.rejects(
      script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer }),
      /rpc 502/,
    );
  });

  it('prints counts, ids, reason codes and public tx hashes only', async () => {
    seedMatrix();
    seedBlocked();
    const plan = await script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });
    const lines = [];
    script.printPlan(plan, (line) => lines.push(line));
    const text = lines.join('\n');
    assert.doesNotMatch(text, /@|example\.test/);
    assert.match(text, /total needs_reattest 7, blocked 2/);
    for (const r of plan.needs) assert.ok(text.includes(r.id));
  });

  it('is read-only', async () => {
    seedMatrix();
    const before = JSON.stringify(prisma.store);
    await script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });
    assert.equal(JSON.stringify(prisma.store), before);
    assert.equal(chain.calls.includes('sendTransaction'), false);
  });
});

describe('classifyRow: what the DDC RPC really returns', () => {
  const ctx = () => ({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });

  it('the fake chain answers an unknown hash like DDC: an error, not null', async () => {
    await assert.rejects(
      chain.provider.send('eth_getTransactionByHash', [randomHash()]),
      (error) => error.error.code === -32000 && error.error.message === 'data not found',
    );
  });

  it('classifies a row with an unknown tx hash as needs_reattest:tx_not_found without throwing', async () => {
    const unknown = row('purchaseOrder', { attestationTxHash: `0x${'ab'.repeat(32)}` });
    const verdict = await script.classifyRow({ model: 'purchaseOrder', ...unknown }, ctx());
    assert.deepEqual(verdict, { status: 'needs_reattest', code: 'tx_not_found' });
  });

  it('one unknown hash does not abort the plan for the other rows', async () => {
    const s = seedMatrix();
    const plan = await script.planReattest(ctx());
    const code = Object.fromEntries(plan.needs.map((r) => [r.id, r.code]));
    assert.equal(code[s.notFound.id], 'tx_not_found');
    assert.equal(plan.counts.purchaseOrder.checked, 7);
  });

  it('still blocks a hash the chain knows but has not mined', async () => {
    const pendingHash = randomHash();
    chain.pendingTxs.set(pendingHash.toLowerCase(), { hash: pendingHash, blockNumber: null });
    const r = row('purchaseOrder', { attestationTxHash: pendingHash });
    assert.deepEqual(await script.classifyRow({ model: 'purchaseOrder', ...r }, ctx()), { status: 'blocked', code: 'tx_pending' });
  });

  const otherErrors = [
    ['another -32000 message', () => Object.assign(new Error('could not coalesce error'), { error: { code: -32000, message: 'header not found' } })],
    ['"data not found" with another code', () => Object.assign(new Error('could not coalesce error'), { error: { code: -32603, message: 'data not found' } })],
    ['a network error', () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['a timeout', () => Object.assign(new Error('request timeout'), { code: 'TIMEOUT' })],
  ];
  for (const [label, make] of otherErrors) {
    it(`rethrows ${label} from eth_getTransactionByHash`, async () => {
      const r = row('purchaseOrder', { attestationTxHash: randomHash() });
      const error = make();
      chain.failures.send = error;
      await assert.rejects(script.classifyRow({ model: 'purchaseOrder', ...r }, ctx()), (e) => e === error);
      await assert.rejects(script.planReattest(ctx()), (e) => e === error);
    });
  }

  it('isTxNotFoundError matches only code -32000 with message "data not found"', () => {
    assert.equal(script.isTxNotFoundError(dataNotFoundError('eth_getTransactionByHash', [])), true);
    assert.equal(script.isTxNotFoundError({ info: { error: { code: -32000, message: 'data not found' } } }), true);
    assert.equal(script.isTxNotFoundError({ error: { code: -32000, message: 'data not found for block' } }), false);
    assert.equal(script.isTxNotFoundError({ error: { code: -32001, message: 'data not found' } }), false);
    assert.equal(script.isTxNotFoundError(new Error('data not found')), false);
    assert.equal(script.isTxNotFoundError(null), false);
  });

  it('throws when the RPC returns a receipt for a different transaction', async () => {
    // Stored under the row's hash, but the receipt (otherwise a perfect proof) names another tx.
    const hash = contentHash();
    const asked = randomHash();
    const other = randomHash();
    chain.receipts.set(asked.toLowerCase(), makeReceipt({
      txHash: other, from: signer, to: chain.attester, status: 1,
      logs: [attestedLog({ attester: chain.attester, hash, sender: signer, txHash: other })],
    }));
    const r = row('purchaseOrder', { attestationHash: hash, attestationTxHash: asked });
    await assert.rejects(
      script.classifyRow({ model: 'purchaseOrder', ...r }, ctx()),
      new RegExp(`receipt for a different transaction \\(purchaseOrder ${r.id}\\)`),
    );
  });

  it('accepts a receipt whose hash differs from the stored one only in case', async () => {
    const hash = contentHash();
    const txHash = chain.mineAttest({ hash, sender: signer });
    const r = row('purchaseOrder', { attestationHash: hash, attestationTxHash: `0x${txHash.slice(2).toUpperCase()}` });
    assert.deepEqual(await script.classifyRow({ model: 'purchaseOrder', ...r }, ctx()), { status: 'valid', code: 'valid' });
  });
});

function applyArgs(over = {}) {
  const lines = [];
  return {
    lines,
    args: {
      prisma,
      provider: chain.provider,
      wallet: chain.wallet(signer),
      attester: chain.attester,
      out: (line) => lines.push(line),
      ...over,
    },
  };
}

const audits = (lines) => lines.filter((l) => l.startsWith('{"event"')).map((l) => JSON.parse(l));

describe('apply', () => {
  it('re-attests every selected row, changes only attestationTxHash, audits old and new', async () => {
    const s = seedMatrix();
    const snapshot = JSON.parse(JSON.stringify(prisma.store));
    const { args, lines } = applyArgs();
    const summary = await script.applyReattest(args);
    assert.deepEqual(summary, { reattested: 7, sent: 7, adoptedExisting: 0 });

    const plan = await script.planReattest({ prisma, provider: chain.provider, attester: chain.attester, sender: signer });
    assert.equal(plan.needs.length, 0, 'every repaired row now verifies');

    const recorded = audits(lines).filter((a) => a.step === 'recorded');
    assert.equal(recorded.length, 7);
    for (const model of ['purchaseOrder', 'disbursementItem']) {
      for (const before of snapshot[model]) {
        const after = prisma[model].rows.find((r) => r.id === before.id);
        const audit = recorded.find((a) => a.id === before.id);
        if (audit) {
          assert.equal(audit.oldTxHash, before.attestationTxHash);
          assert.equal(audit.newTxHash, after.attestationTxHash);
          assert.notEqual(after.attestationTxHash, before.attestationTxHash);
          assert.deepEqual({ ...after, attestationTxHash: null }, { ...before, attestationTxHash: null, createdAt: after.createdAt });
        } else {
          assert.equal(after.attestationTxHash, before.attestationTxHash, `${before.id} untouched`);
        }
      }
    }
    assert.equal(prisma.purchaseOrder.rows.find((r) => r.id === s.valid.id).attestationTxHash, s.valid.attestationTxHash);
  });

  it('is idempotent: a second run sends nothing', async () => {
    seedMatrix();
    await script.applyReattest(applyArgs().args);
    const sentBefore = chain.sent.length;
    const summary = await script.applyReattest(applyArgs().args);
    assert.deepEqual(summary, { reattested: 0, sent: 0, adoptedExisting: 0 });
    assert.equal(chain.sent.length, sentBefore);
  });

  it('adopts an existing valid attestation (crash after send) instead of sending again', async () => {
    const hash = contentHash();
    const r = row('purchaseOrder', { attestationHash: hash, attestationTxHash: chain.mineAttest({ hash, sender: signer, to: randomAddress() }) });
    const earlier = chain.mineAttest({ hash, sender: signer });
    const summary = await script.applyReattest(applyArgs().args);
    assert.deepEqual(summary, { reattested: 1, sent: 0, adoptedExisting: 1 });
    assert.equal(chain.sent.length, 0);
    assert.equal(prisma.purchaseOrder.rows.find((x) => x.id === r.id).attestationTxHash, earlier);
  });

  it('refuses when the attester has no code, without sending or writing', async () => {
    chain = new FakeChain({ withCode: false });
    seedMatrix();
    const before = JSON.stringify(prisma.store);
    await assert.rejects(script.applyReattest(applyArgs().args), /^Error: Refusing --apply: attester .* has no contract code$/);
    assert.equal(chain.calls.includes('getTransactionReceipt'), false, 'refused before planning');
    assert.equal(chain.sent.length, 0);
    assert.equal(JSON.stringify(prisma.store), before);
  });

  it('refuses when any row is blocked', async () => {
    seedMatrix();
    const s = seedBlocked();
    await assert.rejects(script.applyReattest(applyArgs().args), (error) => {
      assert.match(error.message, /2 blocked row/);
      assert.ok(error.message.includes(s.pending.id));
      return true;
    });
    assert.equal(chain.sent.length, 0);
  });

  it('refuses to send while the signer has a transaction in flight', async () => {
    seedMatrix();
    chain.nonces.set(signer.toLowerCase(), { latest: 497, pending: 498 });
    await assert.rejects(script.applyReattest(applyArgs().args), /in flight/);
    assert.equal(chain.sent.length, 0);
  });

  it('keeps at most one attestation in flight', async () => {
    seedMatrix();
    let inFlight = 0;
    let maxInFlight = 0;
    const attest = async (hash, deps) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      const result = await attestHashOnChain(hash, { ...deps, log: { warn() {} } });
      inFlight -= 1;
      return result;
    };
    await script.applyReattest(applyArgs({ attest }).args);
    assert.equal(maxInFlight, 1);
  });

  it('stops on the first failed attestation and leaves later rows untouched', async () => {
    const r1 = row('purchaseOrder', { attestationTxHash: randomHash() });
    const r2 = row('purchaseOrder', { attestationTxHash: randomHash() });
    const r3 = row('purchaseOrder', { attestationTxHash: randomHash() });
    const [old1, old2, old3] = [r1, r2, r3].map((r) => r.attestationTxHash);
    let calls = 0;
    const attest = async (hash, deps) => {
      calls += 1;
      if (calls === 2) return { ok: false, pending: true, reason: 'receipt timed out', sentTxHash: randomHash() };
      return attestHashOnChain(hash, { ...deps, log: { warn() {} } });
    };
    await assert.rejects(script.applyReattest(applyArgs({ attest }).args), /receipt timed out.*sent tx/);
    assert.equal(calls, 2);
    assert.notEqual(prisma.purchaseOrder.rows.find((x) => x.id === r1.id).attestationTxHash, old1);
    assert.equal(prisma.purchaseOrder.rows.find((x) => x.id === r2.id).attestationTxHash, old2);
    assert.equal(prisma.purchaseOrder.rows.find((x) => x.id === r3.id).attestationTxHash, old3);
  });

  it('does not write a new tx hash that fails independent re-verification', async () => {
    const r = row('purchaseOrder', { attestationTxHash: randomHash() });
    const old = r.attestationTxHash;
    const attest = async () => {
      const txHash = chain.mine(makeReceipt({ txHash: randomHash(), from: signer, to: chain.attester, status: 1, logs: [] }));
      return { ok: true, pending: false, txHash };
    };
    await assert.rejects(script.applyReattest(applyArgs({ attest }).args), /does not verify/);
    assert.equal(prisma.purchaseOrder.rows.find((x) => x.id === r.id).attestationTxHash, old);
  });

  it('stops when a row changed between plan and apply (compare-and-set)', async () => {
    const r = row('purchaseOrder', { attestationTxHash: randomHash() });
    const attest = async (hash, deps) => {
      // Someone else repairs the row while our transaction is being mined.
      prisma.purchaseOrder.rows.find((x) => x.id === r.id).attestationTxHash = randomHash();
      return attestHashOnChain(hash, { ...deps, log: { warn() {} } });
    };
    const { args, lines } = applyArgs({ attest });
    await assert.rejects(script.applyReattest(args), /was not updated/);
    const attested = audits(lines).filter((a) => a.step === 'attested');
    assert.equal(attested.length, 1, 'the new tx hash is in the audit log even though the row was not written');
  });

  it('stops when the row changed before its turn', async () => {
    const r = row('purchaseOrder', { attestationTxHash: randomHash() });
    const findUnique = prisma.purchaseOrder.findUnique;
    prisma.purchaseOrder.findUnique = async (q) => ({ ...(await findUnique(q)), attestationTxHash: randomHash() });
    await assert.rejects(script.applyReattest(applyArgs().args), new RegExp(`${r.id} changed since the plan`));
    assert.equal(chain.sent.length, 0);
  });

  it('appends the audit trail to a 0600 file', async () => {
    seedMatrix();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reattest-'));
    const auditLog = path.join(dir, 'audit.jsonl');
    try {
      await script.applyReattest(applyArgs({ auditLog }).args);
      const entries = fs.readFileSync(auditLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(entries.filter((e) => e.step === 'recorded').length, 7);
      assert.ok(entries.every((e) => e.oldTxHash && /^0x[0-9a-f]{64}$/.test(e.newTxHash)));
      assert.equal(fs.statSync(auditLog).mode & 0o777, 0o600);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores an existing log by another sender when looking for a prior attestation', async () => {
    const hash = contentHash();
    row('purchaseOrder', { attestationHash: hash, attestationTxHash: randomHash() });
    chain.mineAttest({ hash, sender: randomAddress() });
    const summary = await script.applyReattest(applyArgs().args);
    assert.deepEqual(summary, { reattested: 1, sent: 1, adoptedExisting: 0 });
  });
});
