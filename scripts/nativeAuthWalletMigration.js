#!/usr/bin/env node
/**
 * Native-login wallet migration (design §9 "Mainnet migration hooks", §6.2 step 3): moves every
 * account's Web3Auth-derived wallet to the native connection `--connection` on `--network`.
 * Dry run by default, idempotent, resumable. Three modes, one per run:
 *
 *   --plan    For each account with a wallet:
 *               legacy Web3Auth pair, no binding → create its NativeWalletBinding (a fresh random
 *                 w3aSubject) with the address the nodes derive for (connection, subject)
 *                 (torus getPublicAddress, through w3aLookup), and a WalletAddressHistory
 *                 {status 'planned', reason 'network_migration', chainStatus 'pending'};
 *               live native binding on ANOTHER connection or network (the §6.2 key-compromise
 *                 case) → the new address for the SAME subject; the binding stays as it is
 *                 until --apply, so the account keeps working meanwhile;
 *               external wallet ('external-wallet' pair) → a history row with the unchanged
 *                 address and chainStatus 'not_needed';
 *               already planned / already on the target → nothing (reruns resume where a run
 *                 stopped; a failed lookup is simply retried by the next run).
 *             Without --write nothing is looked up or written: the run only classifies and
 *             counts (a lookup may assign a key on the nodes, so even that waits for --write).
 *   --export <file.csv|->
 *             userId,oldAddress,newAddress,chainStatus for the chain team, one row per planned or
 *             applied row of this target. Subjects are never exported. Read-only; the file is
 *             created 0600 and never overwritten (unless --force).
 *   --apply   Batches of planned rows, one transaction per account: the account's wallet, the
 *             binding (connection, network, address) and the (web3authVerifier,
 *             web3authVerifierId) pair move to the target; the old legacy pair is kept as an
 *             AuthIdentity('web3auth_legacy', '<verifier>|<verifierId>') so the legacy login path
 *             (web3authIdentity step 1b) still finds the account; the native identity the old
 *             pair qualifies for is backfilled in the same transaction (see
 *             nativeAuthBackfillIdentities.js); the row becomes status 'applied'. A row whose
 *             account changed since the plan (wallet, pair or binding differ) is skipped and
 *             counted as stale; re-plan it. Without --write every row is only checked.
 *
 * Usage:
 *   node scripts/nativeAuthWalletMigration.js --plan  --network sapphire_mainnet --connection ddc-jwt-mainnet [--client-id=<id>] [--write] [--concurrency=4] [--limit=N]
 *   node scripts/nativeAuthWalletMigration.js --export migration.csv --network sapphire_mainnet --connection ddc-jwt-mainnet [--force]
 *   node scripts/nativeAuthWalletMigration.js --apply --network sapphire_mainnet --connection ddc-jwt-mainnet [--write] [--batch-size=100] [--limit=N]
 * --client-id defaults to DDC_AUTH_W3A_CLIENT_ID (the client id of the TARGET native project).
 * Do not run two --plan --write runs for one target at the same time.
 *
 * Between --plan and --apply a planned legacy account already has its target binding while it
 * still holds its old wallet. If native login were live on that same connection in that window,
 * the account's native sign-in would answer WALLET_MISMATCH until --apply; in production native
 * login is off until the cut (D17), so plan and apply both run before it is switched on.
 *
 * Order at the cut: nativeAuthBackfillIdentities.js --write → --plan --write → --export → chain
 * team → --apply --write → switch DDC_AUTH_* to the target (design §9). Organisation accounts and
 * accounts with a wallet but no Web3Auth pair are not migrated (counted; see the orphan report).
 *
 * Secrets: NativeWalletBinding.subject is read here (the one place outside src/services/nativeAuth
 * the design puts the precompute) and passed only to the lookup. It is never printed, logged,
 * exported or copied into another table: WalletAddressHistory.newSubjectRef is the binding row id.
 * Output is counts only.
 */
const crypto = require('crypto');
const fs = require('fs');
const { getAddress } = require('ethers');
const { readNativeAuthConfig, W3A_NETWORKS, NON_PROD_CONNECTION_IDS } = require('../src/services/nativeAuth/config');
const backfill = require('./nativeAuthBackfillIdentities');

const REASON = 'network_migration';
const LEGACY_PROVIDER = 'web3auth_legacy';
const EXTERNAL_WALLET_VERIFIER = 'external-wallet';
const EXTERNAL_NETWORK = 'external';
const NO_SUBJECT_REF = 'none';
const NATIVE_PROVIDERS = Object.freeze(['email', 'google', 'apple', 'x']);
const CONNECTION_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const NON_PROD_CONNECTION_PATTERN = /(devnet|testnet|[-_]test\b|[-_]local\b|[-_]dev\b)/i;
/** Names the native connections use (ddc-jwt-devnet, ddc-jwt-mainnet, …), as BE6's legacy guard does. */
const NATIVE_CONNECTION_NAME = /^(ddc|datadance)-jwt-/i;
const DEFAULT_BATCH = 100;
const DEFAULT_CONCURRENCY = 4;

function defaultDb() {
  return require('../src/utils/prisma');
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function isOrganization(user) {
  return Boolean(user && (user.userType === 'organization' || user.isOrganization));
}

function isP2002(err) {
  return Boolean(err && err.code === 'P2002');
}

/** The legacy network a Web3Auth verifier name points at (…-sapphire-devnet), for the audit row. */
function legacyNetwork(verifier) {
  const name = String(verifier || '');
  if (/sapphire[-_]mainnet/i.test(name)) return 'sapphire_mainnet';
  if (/sapphire[-_]devnet/i.test(name)) return 'sapphire_devnet';
  return 'unknown';
}

function bump(counts, key, by = 1) {
  counts[key] = (counts[key] || 0) + by;
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Throws a usage error unless (network, connection) is a legal migration target. */
function assertTarget({ network, connection }, cfg) {
  if (!W3A_NETWORKS.includes(network)) throw new Error(`--network must be one of ${W3A_NETWORKS.join(', ')}`);
  if (!connection || !CONNECTION_PATTERN.test(connection)) throw new Error('--connection is required ([A-Za-z0-9._-], at most 128)');
  if (connection === EXTERNAL_WALLET_VERIFIER) throw new Error('--connection cannot be external-wallet');
  const legacy = cfg && cfg.legacy ? [...cfg.legacy.emailVerifiers, ...cfg.legacy.googleVerifiers, ...cfg.legacy.xVerifiers] : [];
  if (legacy.includes(connection)) throw new Error('--connection names a legacy verifier (DDC_AUTH_LEGACY_*)');
  if (network === 'sapphire_mainnet' && (NON_PROD_CONNECTION_IDS.includes(connection) || NON_PROD_CONNECTION_PATTERN.test(connection))) {
    throw new Error('a devnet/test connection cannot be a sapphire_mainnet target');
  }
}

/** Where a planned row of this target lives: newNetwork = network, newVerifier ∈ {connection, external-wallet}. */
function targetRowsWhere({ network, connection }) {
  return { reason: REASON, newNetwork: network, newVerifier: { in: [connection, EXTERNAL_WALLET_VERIFIER] } };
}

// ---------------------------------------------------------------------------------------------
// --plan
// ---------------------------------------------------------------------------------------------

/**
 * What --plan does for one account with a wallet (reads nothing but its arguments):
 *   'organization' | 'unpaired'             skipped (not migrated)
 *   'native_without_binding'                a native connection's pair but no binding (skipped)
 *   'already_planned'                       a row for this target exists
 *   'current'                               the live binding is already on the target
 *   'planned_elsewhere'                     a planned-only binding for another target exists (skipped)
 *   'binding_repair'                        a planned-only binding on the target without its row (row re-created)
 *   'legacy' | 'native' | 'external'        to plan
 */
function classify({ user, binding, rows, target }) {
  if (isOrganization(user)) return 'organization';
  if (rows.length) return 'already_planned';
  if (binding) {
    const live = sameAddress(user.walletAddress, binding.address);
    const onTarget = binding.connection === target.connection && binding.network === target.network;
    if (live) return onTarget ? 'current' : 'native';
    return onTarget ? 'binding_repair' : 'planned_elsewhere';
  }
  if (user.web3authVerifier === EXTERNAL_WALLET_VERIFIER) return 'external';
  if (!user.web3authVerifier || !user.web3authVerifierId) return 'unpaired';
  // A native connection's pair without its binding is not a legacy wallet (and the legacy login
  // path refuses these names); leave it to a person.
  if (user.web3authVerifier === target.connection || NATIVE_CONNECTION_NAME.test(user.web3authVerifier)) return 'native_without_binding';
  return 'legacy';
}

async function lookupAddress({ lookup, subject, target, clientId }) {
  const address = await lookup({ connection: target.connection, subject, network: target.network, clientId, loginRef: 'wallet-migration' });
  return getAddress(address);
}

function historyData({ user, oldVerifier, oldVerifierId, oldNetwork, newAddress, newVerifier, newSubjectRef, network, chainStatus }) {
  return {
    userId: user.id,
    oldAddress: user.walletAddress,
    oldVerifier: oldVerifier || null,
    oldVerifierId: oldVerifierId || null,
    oldNetwork,
    newAddress,
    newVerifier,
    newSubjectRef,
    newNetwork: network,
    reason: REASON,
    status: 'planned',
    chainStatus,
  };
}

/** Plans one account (write mode). Returns the outcome key for the summary. */
async function planOne({ kind, user, binding, target, clientId, db, lookup }) {
  if (kind === 'external') {
    await db.walletAddressHistory.create({
      data: historyData({
        user,
        oldVerifier: EXTERNAL_WALLET_VERIFIER,
        oldVerifierId: user.web3authVerifierId,
        oldNetwork: EXTERNAL_NETWORK,
        newAddress: user.walletAddress,
        newVerifier: EXTERNAL_WALLET_VERIFIER,
        newSubjectRef: NO_SUBJECT_REF,
        network: target.network,
        chainStatus: 'not_needed',
      }),
    });
    return 'planned_external';
  }
  if (kind === 'binding_repair') {
    await db.walletAddressHistory.create({
      data: historyData({
        user,
        oldVerifier: user.web3authVerifier,
        oldVerifierId: user.web3authVerifierId,
        oldNetwork: legacyNetwork(user.web3authVerifier),
        newAddress: binding.address,
        newVerifier: target.connection,
        newSubjectRef: binding.id,
        network: target.network,
        chainStatus: 'pending',
      }),
    });
    return 'planned_repaired';
  }
  if (kind === 'native') {
    const newAddress = await lookupAddress({ lookup, subject: binding.subject, target, clientId });
    await db.walletAddressHistory.create({
      data: historyData({
        user,
        oldVerifier: binding.connection,
        oldVerifierId: null,
        oldNetwork: binding.network,
        newAddress,
        newVerifier: target.connection,
        newSubjectRef: binding.id,
        network: target.network,
        chainStatus: sameAddress(newAddress, user.walletAddress) ? 'not_needed' : 'pending',
      }),
    });
    return 'planned_native';
  }
  // legacy: a fresh opaque subject (D2, F11), derived once, then binding + row in one transaction.
  const subject = crypto.randomUUID();
  const newAddress = await lookupAddress({ lookup, subject, target, clientId });
  await db.$transaction(async (tx) => {
    const created = await tx.nativeWalletBinding.create({
      data: { userId: user.id, connection: target.connection, network: target.network, subject, address: newAddress },
    });
    await tx.walletAddressHistory.create({
      data: historyData({
        user,
        oldVerifier: user.web3authVerifier,
        oldVerifierId: user.web3authVerifierId,
        oldNetwork: legacyNetwork(user.web3authVerifier),
        newAddress,
        newVerifier: target.connection,
        newSubjectRef: created.id,
        network: target.network,
        chainStatus: 'pending',
      }),
    });
  });
  return 'planned_legacy';
}

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function planMigration({ target, clientId, write = false, db = defaultDb(), lookup, batchSize = DEFAULT_BATCH, concurrency = DEFAULT_CONCURRENCY, limit = Infinity, log = () => {} }) {
  if (write && !clientId) throw new Error('--plan --write needs the target client id (--client-id or DDC_AUTH_W3A_CLIENT_ID)');
  const doLookup = lookup || require('../src/services/nativeAuth/w3aLookup').lookupWalletAddress;
  const summary = { mode: write ? 'write' : 'dry-run', target: { ...target }, scanned: 0, classes: {}, outcomes: {} };
  let cursor = null;
  let budget = limit;
  while (budget > 0) {
    const page = await db.user.findMany({
      where: { walletAddress: { not: null }, ...(cursor && { id: { gt: cursor } }) },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    const users = page.sort(byId).slice(0, batchSize);
    if (!users.length) break;
    cursor = users[users.length - 1].id;
    const ids = users.map((u) => u.id);
    const bindings = await db.nativeWalletBinding.findMany({ where: { userId: { in: ids } } });
    const rows = await db.walletAddressHistory.findMany({ where: { ...targetRowsWhere(target), userId: { in: ids } } });
    const work = [];
    for (const user of users) {
      summary.scanned += 1;
      const binding = bindings.find((b) => b.userId === user.id) || null;
      const kind = classify({ user, binding, rows: rows.filter((r) => r.userId === user.id), target });
      bump(summary.classes, kind);
      if (['legacy', 'native', 'external', 'binding_repair'].includes(kind) && budget > 0) {
        budget -= 1;
        work.push({ kind, user, binding });
      }
    }
    if (write) {
      await pool(work, concurrency, async ({ kind, user, binding }) => {
        try {
          bump(summary.outcomes, await planOne({ kind, user, binding, target, clientId, db, lookup: doLookup }));
        } catch (err) {
          if (isP2002(err)) bump(summary.outcomes, 'race');
          else if (err && err.code === 'W3A_LOOKUP_UNAVAILABLE') bump(summary.outcomes, 'lookup_failed');
          else throw err;
        }
      });
    }
    log(`… ${summary.scanned} scanned`);
    if (users.length < batchSize) break;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// --export
// ---------------------------------------------------------------------------------------------

function csvCell(value) {
  const text = value == null ? '' : String(value);
  // Every exported value is an id, an address or an enum; quote anyway, and neutralise a leading
  // formula character for spreadsheet imports.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

async function exportRows({ target, db = defaultDb() }) {
  const rows = await db.walletAddressHistory.findMany({ where: targetRowsWhere(target), orderBy: [{ userId: 'asc' }, { createdAt: 'asc' }] });
  rows.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  const lines = ['userId,oldAddress,newAddress,chainStatus'];
  for (const row of rows) lines.push([row.userId, row.oldAddress, row.newAddress, row.chainStatus].map(csvCell).join(','));
  return { csv: `${lines.join('\n')}\n`, count: rows.length };
}

function writeExport(file, csv, { force = false } = {}) {
  if (file === '-') {
    process.stdout.write(csv);
    return;
  }
  fs.writeFileSync(file, csv, { mode: 0o600, flag: force ? 'w' : 'wx' });
  fs.chmodSync(file, 0o600);
}

// ---------------------------------------------------------------------------------------------
// --apply
// ---------------------------------------------------------------------------------------------

class Skip extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/**
 * Checks one planned row against the account as it is now. Returns { kind, user, binding } or
 * throws Skip(reason). `db` may be a transaction client.
 */
async function checkRow({ row, target, db }) {
  const user = await db.user.findUnique({ where: { id: row.userId } });
  if (!user) throw new Skip('user_gone');
  if (!sameAddress(user.walletAddress, row.oldAddress)) {
    // A crash between the commit and the report, or a concurrent apply, leaves the row planned
    // only if the transaction rolled back; an account already on the new address is stale here.
    throw new Skip('stale');
  }
  if (row.newVerifier === EXTERNAL_WALLET_VERIFIER) {
    if (user.web3authVerifier !== EXTERNAL_WALLET_VERIFIER) throw new Skip('stale');
    return { kind: 'external', user, binding: null };
  }
  const binding = await db.nativeWalletBinding.findUnique({ where: { id: row.newSubjectRef } });
  if (!binding || binding.userId !== user.id) throw new Skip('binding_missing');
  const bindingOnTarget = binding.connection === target.connection && binding.network === target.network;
  if (bindingOnTarget && sameAddress(binding.address, row.newAddress)) {
    // A legacy account: its pair must still be the one the plan saw.
    if (user.web3authVerifier !== row.oldVerifier || user.web3authVerifierId !== row.oldVerifierId) throw new Skip('stale');
    return { kind: 'legacy', user, binding };
  }
  if (sameAddress(binding.address, row.oldAddress) && binding.connection === row.oldVerifier && binding.network === row.oldNetwork) {
    return { kind: 'native', user, binding };
  }
  throw new Skip('stale');
}

async function assertWalletFree(db, address, userId) {
  const holder = await db.user.findFirst({ where: { walletAddress: { equals: address, mode: 'insensitive' }, id: { not: userId } } });
  if (holder) throw new Skip('wallet_in_use');
}

/** The web3auth_legacy identity for the old pair: 'create' | 'present', or Skip if another account holds it. */
async function legacyIdentityAction(db, user, subject) {
  const existing = await db.authIdentity.findUnique({ where: { provider_subject: { provider: LEGACY_PROVIDER, subject } } });
  if (!existing) return 'create';
  if (existing.userId !== user.id) throw new Skip('legacy_identity_owned_elsewhere');
  return 'present';
}

/** Applies one planned row in one transaction. Returns the outcome key. */
async function applyOne({ row, target, db, lists, now }) {
  return db.$transaction(async (tx) => {
    const { kind, user, binding } = await checkRow({ row, target, db: tx });
    if (kind !== 'external' && !sameAddress(row.newAddress, user.walletAddress)) await assertWalletFree(tx, row.newAddress, user.id);

    // Claim the row first: of two concurrent applies exactly one proceeds.
    const claimed = await tx.walletAddressHistory.updateMany({
      where: { id: row.id, status: 'planned' },
      data: { status: 'applied', appliedAt: now },
    });
    if (claimed.count !== 1) throw new Skip('already_applied');
    if (kind === 'external') return 'applied_external';

    if (kind === 'legacy') {
      const plan = await backfill.planUserIdentity({ user, lists, db: tx });
      if (plan.status === 'create') await tx.authIdentity.create({ data: backfill.identityData(user.id, plan.identity) });
      const legacySubject = `${user.web3authVerifier}|${user.web3authVerifierId}`;
      if ((await legacyIdentityAction(tx, user, legacySubject)) === 'create') {
        await tx.authIdentity.create({
          data: { userId: user.id, provider: LEGACY_PROVIDER, subject: legacySubject, emailLinkGrade: 'none', isPrivateRelay: false, linkedVia: REASON },
        });
      }
      await tx.user.update({
        where: { id: user.id },
        data: { walletAddress: row.newAddress, web3authVerifier: target.connection, web3authVerifierId: user.id, web3authLinkedAt: now },
      });
      // How the account will be found natively after the cut: a backfilled / already present
      // identity, or none (an orphan: legacy Apple, non-Gmail Google, …; see the orphan report).
      if (plan.status === 'create') return 'applied_legacy_identity_backfilled';
      if (plan.status === 'present') return 'applied_legacy_identity_present';
      const others = await tx.authIdentity.count({ where: { userId: user.id, provider: { in: NATIVE_PROVIDERS } } });
      return others ? 'applied_legacy_identity_present' : 'applied_legacy_no_native_identity';
    }

    // native: the same subject moves to the target connection.
    const oldConnection = binding.connection;
    await tx.nativeWalletBinding.update({
      where: { id: binding.id },
      data: { connection: target.connection, network: target.network, address: row.newAddress },
    });
    await tx.user.update({
      where: { id: user.id },
      data: {
        walletAddress: row.newAddress,
        ...(user.web3authVerifier === oldConnection && { web3authVerifier: target.connection }),
      },
    });
    return 'applied_native';
  });
}

async function applyMigration({ target, write = false, db = defaultDb(), cfg = readNativeAuthConfig(), batchSize = DEFAULT_BATCH, limit = Infinity, now = new Date(), log = () => {} }) {
  const lists = backfill.legacyLists(cfg);
  const summary = { mode: write ? 'write' : 'dry-run', target: { ...target }, scanned: 0, outcomes: {} };
  let cursor = null;
  let budget = limit;
  while (budget > 0) {
    const page = await db.walletAddressHistory.findMany({
      where: { ...targetRowsWhere(target), status: 'planned', ...(cursor && { id: { gt: cursor } }) },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    const rows = page.sort(byId).slice(0, Math.min(batchSize, budget));
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const row of rows) {
      summary.scanned += 1;
      budget -= 1;
      try {
        if (!write) {
          const { kind, user } = await checkRow({ row, target, db });
          if (kind !== 'external' && !sameAddress(row.newAddress, user.walletAddress)) await assertWalletFree(db, row.newAddress, user.id);
          if (kind === 'legacy') await legacyIdentityAction(db, user, `${user.web3authVerifier}|${user.web3authVerifierId}`);
          bump(summary.outcomes, `would_apply_${kind}`);
        } else {
          bump(summary.outcomes, await applyOne({ row, target, db, lists, now }));
        }
      } catch (err) {
        if (err instanceof Skip) bump(summary.outcomes, `skipped_${err.reason}`);
        else if (isP2002(err)) bump(summary.outcomes, 'skipped_unique_conflict');
        else throw err;
      }
    }
    log(`… ${summary.scanned} checked`);
    if (page.length < batchSize) break;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { modes: [], write: false, force: false, json: false, help: false, batchSize: DEFAULT_BATCH, concurrency: DEFAULT_CONCURRENCY, limit: Infinity };
  const takesValue = new Set(['--network', '--connection', '--client-id', '--export', '--batch-size', '--concurrency', '--limit']);
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    if (takesValue.has(name)) {
      const value = eq > 0 ? arg.slice(eq + 1) : argv[(i += 1)];
      if (value === undefined || value === '') throw new Error(`${name} needs a value`);
      values[name] = value;
      if (name === '--export') out.modes.push('export');
    } else if (arg === '--plan') out.modes.push('plan');
    else if (arg === '--apply') out.modes.push('apply');
    else if (arg === '--write') out.write = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg).slice(0, 40)}`);
  }
  const int = (name, min, max) => {
    if (values[name] === undefined) return undefined;
    const n = Number.parseInt(values[name], 10);
    if (!/^\d+$/.test(values[name]) || n < min || n > max) throw new Error(`${name} must be ${min}..${max}`);
    return n;
  };
  out.batchSize = int('--batch-size', 1, 5000) ?? out.batchSize;
  out.concurrency = int('--concurrency', 1, 32) ?? out.concurrency;
  out.limit = int('--limit', 1, Number.MAX_SAFE_INTEGER) ?? out.limit;
  out.network = values['--network'];
  out.connection = values['--connection'];
  out.clientId = values['--client-id'];
  out.exportFile = values['--export'];
  if (!out.help && out.modes.length !== 1) throw new Error('choose exactly one of --plan, --export <file>, --apply');
  if (out.modes[0] === 'export' && out.write) throw new Error('--export is read-only; --write does not apply');
  return out;
}

const USAGE = `usage:
  node scripts/nativeAuthWalletMigration.js --plan  --network <n> --connection <c> [--client-id=<id>] [--write] [--concurrency=4] [--limit=N]
  node scripts/nativeAuthWalletMigration.js --export <file.csv|-> --network <n> --connection <c> [--force]
  node scripts/nativeAuthWalletMigration.js --apply --network <n> --connection <c> [--write] [--batch-size=100] [--limit=N]`;

function printSummary(summary) {
  console.log(`[${summary.mode}] target ${summary.target.connection} on ${summary.target.network}; ${summary.scanned} scanned`);
  const line = (label, obj) => {
    const entries = Object.entries(obj || {});
    if (entries.length) console.log(`${label}: ${entries.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  };
  line('accounts', summary.classes);
  line('outcomes', summary.outcomes);
  if (summary.mode !== 'write') console.log('dry run: nothing looked up or written; add --write');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const cfg = readNativeAuthConfig();
  const target = { network: args.network, connection: args.connection };
  assertTarget(target, cfg);
  const log = args.json ? () => {} : (text) => console.error(text);
  const mode = args.modes[0];
  if (mode === 'export') {
    const { csv, count } = await exportRows({ target });
    writeExport(args.exportFile, csv, { force: args.force });
    if (args.exportFile !== '-') console.error(`exported ${count} row(s) to ${args.exportFile} (mode 0600)`);
    return;
  }
  const summary = mode === 'plan'
    ? await planMigration({ target, clientId: args.clientId || cfg.w3aClientId, write: args.write, batchSize: args.batchSize, concurrency: args.concurrency, limit: args.limit, log })
    : await applyMigration({ target, write: args.write, cfg, batchSize: args.batchSize, limit: args.limit, log });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
  if (mode === 'apply' && args.write) {
    console.error('note: migrated legacy accounts now resolve their old pair through web3auth_legacy identities; ' +
      'web3authIdentity step 1b reads them only while DDC_AUTH_ENABLED=true');
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('nativeAuthWalletMigration failed:', backfill.safeError(error));
      process.exitCode = 1;
    })
    .finally(async () => {
      try {
        const prisma = require('../src/utils/prisma');
        if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
      } catch {
        // nothing to close
      }
    });
}

module.exports = {
  REASON,
  EXTERNAL_WALLET_VERIFIER,
  assertTarget,
  classify,
  planMigration,
  exportRows,
  writeExport,
  applyMigration,
  parseArgs,
  csvCell,
  legacyNetwork,
};
