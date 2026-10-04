/**
 * Re-attest commerce records whose stored attestationTxHash does not prove the attestation.
 *
 * Until this fix attestHashOnChain treated any mined transaction as success, so attestations sent
 * to an address with no contract code (the wrong CommerceAttester address) were stored as
 * "On-chain". This script finds every row that attestHashOnChain writes to (PurchaseOrder and
 * DisbursementItem) whose attestationTxHash receipt lacks a valid Attested(hash, sender) log from
 * the configured attester, signed by the backend wallet, for exactly the row's attestationHash.
 *
 * Usage (run where the API runs, so the RPC, attester and backend wallet env are the server's):
 *   node scripts/reattestCommerceOrders.js                 # --plan: read-only (default)
 *   node scripts/reattestCommerceOrders.js --plan [--signer 0x...]
 *   node scripts/reattestCommerceOrders.js --apply --yes [--audit-log FILE] [--from-block N]
 *
 * --plan prints counts, row ids, reason codes and the old (public) tx hashes. Never personal data.
 *
 * --apply --yes re-attests the planned rows one at a time:
 *   - refuses unless the attester address has contract code and no plan row is blocked;
 *   - refuses while the signer has any transaction in flight (pending nonce != latest nonce),
 *     so at most one transaction is ever in flight;
 *   - before sending, adopts an existing valid Attested log for the same hash and signer (a
 *     previous run that crashed after sending), so re-running never double-attests;
 *   - re-reads the row and updates it only if attestationTxHash and attestationHash are unchanged
 *     since the plan (compare-and-set); only attestationTxHash changes;
 *   - re-verifies the new receipt independently before writing;
 *   - writes an audit line (old and new tx hash) to stdout and to the audit log file;
 *   - stops on the first error.
 * Safe to re-run: rows already proven on chain are not selected.
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const chain = require('../src/utils/commerceAttestChain');

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const CONTENT_HASH = /^(0x)?[0-9a-fA-F]{64}$/;
const MODELS = ['purchaseOrder', 'disbursementItem'];
const ROW_SELECT = { id: true, attestationHash: true, attestationTxHash: true };

function usageError(message) {
  return Object.assign(new Error(message), { usage: true });
}

function parseArgs(argv) {
  const opts = { mode: 'plan', yes: false, signer: null, auditLog: null, fromBlock: null };
  let sawPlan = false;
  let sawApply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || String(value).startsWith('--')) throw usageError(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--plan') sawPlan = true;
    else if (arg === '--apply') sawApply = true;
    else if (arg === '--yes') opts.yes = true;
    else if (arg === '--signer') opts.signer = next();
    else if (arg === '--audit-log') opts.auditLog = next();
    else if (arg === '--from-block') {
      const raw = next();
      if (!/^\d+$/.test(raw)) throw usageError('--from-block must be a block number');
      opts.fromBlock = Number(raw);
    } else throw usageError(`Unknown argument: ${arg}`);
  }
  if (sawPlan && sawApply) throw usageError('Use either --plan or --apply, not both');
  if (sawApply) opts.mode = 'apply';
  if (opts.mode === 'apply' && !opts.yes) throw usageError('--apply sends transactions; add --yes to confirm');
  if (opts.mode === 'plan' && opts.yes) throw usageError('--yes only applies to --apply');
  if (opts.signer && !ethers.isAddress(opts.signer)) throw usageError('--signer must be an address');
  return opts;
}

async function loadAttestedRows(prisma) {
  const rows = [];
  for (const model of MODELS) {
    const found = await prisma[model].findMany({
      where: { attestationTxHash: { not: null } },
      select: ROW_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const row of found) rows.push({ model, ...row });
  }
  return rows;
}

/**
 * valid           receipt proves the attestation; left alone
 * needs_reattest  receipt missing / failed / without the right Attested log; re-attest
 * blocked         cannot be repaired safely by this script (no content hash, tx still pending)
 * RPC errors throw: a row is never classified on a guess.
 */
async function classifyRow(row, { provider, attester, sender }) {
  if (!CONTENT_HASH.test(String(row.attestationHash || ''))) {
    return { status: 'blocked', code: 'missing_attestation_hash' };
  }
  const txHash = String(row.attestationTxHash || '').trim();
  if (!TX_HASH.test(txHash)) {
    return { status: 'needs_reattest', code: 'malformed_tx_hash' };
  }
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    // Raw JSON-RPC on purpose: ethers' getTransaction() rejects DDC transactions ("yParity
    // mismatch"), and only existence matters here.
    const tx = await provider.send('eth_getTransactionByHash', [txHash]);
    if (tx) return { status: 'blocked', code: 'tx_pending' };
    return { status: 'needs_reattest', code: 'tx_not_found' };
  }
  const receiptHash = String(receipt.hash || receipt.transactionHash || '').toLowerCase();
  if (receiptHash && receiptHash !== txHash.toLowerCase()) {
    throw new Error(`RPC returned a receipt for a different transaction (${row.model} ${row.id})`);
  }
  const verdict = chain.verifyAttestedReceipt(receipt, { attester, hash: row.attestationHash, sender });
  if (verdict.ok) return { status: 'valid', code: 'valid' };
  return { status: 'needs_reattest', code: verdict.code || 'invalid_receipt' };
}

async function planReattest({ prisma, provider, attester, sender }) {
  if (!ethers.isAddress(attester)) throw new Error('Attester address is not configured');
  if (!ethers.isAddress(sender)) throw new Error('Signer address is not known');
  const rows = await loadAttestedRows(prisma);
  const results = [];
  for (const row of rows) {
    const verdict = await classifyRow(row, { provider, attester, sender });
    results.push({ ...row, ...verdict });
  }
  const counts = {};
  for (const model of MODELS) counts[model] = { checked: 0, valid: 0, needs_reattest: 0, blocked: 0 };
  const reasons = {};
  for (const r of results) {
    counts[r.model].checked += 1;
    counts[r.model][r.status] += 1;
    if (r.status !== 'valid') reasons[r.code] = (reasons[r.code] || 0) + 1;
  }
  return {
    counts,
    reasons,
    needs: results.filter((r) => r.status === 'needs_reattest'),
    blocked: results.filter((r) => r.status === 'blocked'),
  };
}

async function hasCode(provider, address) {
  const code = await provider.getCode(address);
  return typeof code === 'string' && code !== '0x' && code.length > 2;
}

async function assertNoTxInFlight(provider, sender) {
  const [latest, pending] = await Promise.all([
    provider.getTransactionCount(sender, 'latest'),
    provider.getTransactionCount(sender, 'pending'),
  ]);
  if (Number(pending) !== Number(latest)) {
    throw new Error(`Signer ${sender} has ${Number(pending) - Number(latest)} transaction(s) in flight (nonce latest ${latest}, pending ${pending}); wait until they are mined`);
  }
}

/** A mined, valid Attested log for this hash from this signer, if one exists already. */
async function findExistingAttestation({ provider, attester, hash, sender, fromBlock }) {
  const logs = await provider.getLogs({
    address: ethers.getAddress(attester),
    topics: [chain.ATTESTED_TOPIC, chain.toBytes32(hash), chain.addressTopic(sender)],
    fromBlock: fromBlock || 0,
    toBlock: 'latest',
  });
  for (const log of logs || []) {
    if (!log || log.removed === true || !TX_HASH.test(String(log.transactionHash || ''))) continue;
    const receipt = await provider.getTransactionReceipt(log.transactionHash);
    if (chain.verifyAttestedReceipt(receipt, { attester, hash, sender }).ok) {
      return log.transactionHash;
    }
  }
  return null;
}

function makeAudit({ auditLog, out }) {
  return (entry) => {
    const line = JSON.stringify({ event: 'commerce_reattest', at: new Date().toISOString(), ...entry });
    out(line);
    if (auditLog) fs.appendFileSync(auditLog, `${line}\n`, { mode: 0o600 });
  };
}

async function applyReattest({
  prisma,
  provider,
  wallet,
  attester,
  fromBlock = 0,
  attest = chain.attestHashOnChain,
  out = console.log,
  auditLog = null,
}) {
  if (!ethers.isAddress(attester)) throw new Error('Attester address is not configured');
  if (!(await hasCode(provider, attester))) {
    throw new Error(`Refusing --apply: attester ${attester} has no contract code`);
  }
  if (!wallet) throw new Error('Refusing --apply: backend wallet unavailable');
  const sender = ethers.getAddress(await wallet.getAddress());

  const plan = await planReattest({ prisma, provider, attester, sender });
  if (plan.blocked.length) {
    const ids = plan.blocked.map((r) => `${r.model}:${r.id}:${r.code}`).join(', ');
    throw new Error(`Refusing --apply: ${plan.blocked.length} blocked row(s) need a human first: ${ids}`);
  }
  const audit = makeAudit({ auditLog, out });
  out(`apply: ${plan.needs.length} row(s) to re-attest, signer ${sender}, attester ${ethers.getAddress(attester)}`);

  let sent = 0;
  let adopted = 0;
  for (const row of plan.needs) {
    const fresh = await prisma[row.model].findUnique({ where: { id: row.id }, select: ROW_SELECT });
    if (!fresh
      || fresh.attestationTxHash !== row.attestationTxHash
      || fresh.attestationHash !== row.attestationHash) {
      throw new Error(`${row.model} ${row.id} changed since the plan; re-run --plan`);
    }

    await assertNoTxInFlight(provider, sender);

    let newTxHash = await findExistingAttestation({
      provider, attester, hash: row.attestationHash, sender, fromBlock,
    });
    const source = newTxHash ? 'existing_log' : 'sent';
    if (!newTxHash) {
      const result = await attest(row.attestationHash, { provider, wallet, attester });
      if (!result || !result.ok || !TX_HASH.test(String(result.txHash || ''))) {
        const sentNote = result && result.sentTxHash ? ` (sent tx ${result.sentTxHash}: check it is mined before re-running)` : '';
        throw new Error(`attest failed for ${row.model} ${row.id}: ${(result && result.reason) || 'unknown'}${sentNote}`);
      }
      newTxHash = result.txHash;
    }

    const receipt = await provider.getTransactionReceipt(newTxHash);
    const check = chain.verifyAttestedReceipt(receipt, { attester, hash: row.attestationHash, sender });
    if (!check.ok) {
      throw new Error(`New tx ${newTxHash} for ${row.model} ${row.id} does not verify: ${check.reason}`);
    }
    audit({
      step: 'attested', model: row.model, id: row.id, reason: row.code, source,
      oldTxHash: row.attestationTxHash, newTxHash,
    });

    const updated = await prisma[row.model].updateMany({
      where: { id: row.id, attestationTxHash: row.attestationTxHash, attestationHash: row.attestationHash },
      data: { attestationTxHash: newTxHash },
    });
    if (!updated || updated.count !== 1) {
      throw new Error(`${row.model} ${row.id} was not updated (changed concurrently?); new tx ${newTxHash} is in the audit log`);
    }
    audit({
      step: 'recorded', model: row.model, id: row.id,
      oldTxHash: row.attestationTxHash, newTxHash,
    });
    if (source === 'sent') sent += 1;
    else adopted += 1;
  }
  const summary = { reattested: sent + adopted, sent, adoptedExisting: adopted };
  out(JSON.stringify(summary));
  return summary;
}

function printPlan(plan, out = console.log) {
  out(JSON.stringify({ counts: plan.counts, reasons: plan.reasons }));
  for (const r of plan.needs) out(`needs_reattest ${r.model} ${r.id} ${r.code} ${r.attestationTxHash || '-'}`);
  for (const r of plan.blocked) out(`blocked ${r.model} ${r.id} ${r.code}`);
  out(`total needs_reattest ${plan.needs.length}, blocked ${plan.blocked.length}`);
}

async function deployBlockFor(provider, attester) {
  try {
    const deployed = require('../src/contracts/commerceAttester.deployed.json');
    if (!ethers.isAddress(deployed.address) || ethers.getAddress(deployed.address) !== ethers.getAddress(attester)) return 0;
    if (!TX_HASH.test(String(deployed.deployTxHash || ''))) return 0;
    const receipt = await provider.getTransactionReceipt(deployed.deployTxHash);
    return receipt && Number.isInteger(Number(receipt.blockNumber)) ? Number(receipt.blockNumber) : 0;
  } catch {
    return 0;
  }
}

async function main(argv) {
  const opts = parseArgs(argv);
  const prisma = require('../src/utils/prisma');
  try {
    const provider = chain.getProvider();
    const chainId = Number(await provider.send('eth_chainId', []));
    if (chainId !== chain.getChainId()) {
      throw new Error(`RPC chain id ${chainId} does not match configured ${chain.getChainId()}`);
    }
    const attester = ethers.getAddress(chain.getAttesterAddress());
    const attesterCode = await hasCode(provider, attester);
    let wallet = null;
    try {
      wallet = chain.getBackendWallet(provider);
    } catch {
      wallet = null;
    }
    if (opts.mode === 'apply' && !wallet) throw new Error('Refusing --apply: backend wallet unavailable');
    const walletAddress = wallet ? ethers.getAddress(await wallet.getAddress()) : null;
    if (opts.signer && walletAddress && ethers.getAddress(opts.signer) !== walletAddress) {
      throw new Error(`--signer ${opts.signer} is not the configured backend wallet ${walletAddress}`);
    }
    const sender = walletAddress || (opts.signer ? ethers.getAddress(opts.signer) : null);
    if (!sender) throw new Error('No backend wallet configured; pass --signer <address> for --plan');
    console.log(`mode ${opts.mode}, chain ${chainId}, attester ${attester} (code: ${attesterCode ? 'yes' : 'NO'}), signer ${sender}`);

    if (opts.mode === 'plan') {
      printPlan(await planReattest({ prisma, provider, attester, sender }));
      if (!attesterCode) console.log('WARNING: the attester has no code; --apply will refuse.');
      return;
    }
    const fromBlock = opts.fromBlock ?? await deployBlockFor(provider, attester);
    const auditLog = opts.auditLog
      || path.join(process.cwd(), `reattest-commerce-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    console.log(`audit log ${auditLog}, log search from block ${fromBlock}`);
    await applyReattest({ prisma, provider, wallet, attester, fromBlock, auditLog });
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exit(error && error.usage ? 2 : 1);
  });
}

module.exports = {
  parseArgs,
  loadAttestedRows,
  classifyRow,
  planReattest,
  applyReattest,
  findExistingAttestation,
  assertNoTxInFlight,
  printPlan,
};
