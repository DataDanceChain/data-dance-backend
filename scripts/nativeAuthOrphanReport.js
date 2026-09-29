#!/usr/bin/env node
/**
 * Native-login orphan report (design §9, F15): counts the accounts that native login cannot find
 * after the mainnet cut, so they can be prompted to link a native method before it. Read-only
 * (it never writes the database); --list writes a local CSV of userId,reason (mode 0600).
 *
 * An account is FOUND natively when (mirroring §3.6):
 *   - it has a native AuthIdentity (email / google / apple / x) — rule 1; or
 *   - its CURRENT (web3authVerifier, web3authVerifierId) pair is one the rules link: a legacy
 *     e-mail-passwordless pair, a legacy Google pair on @gmail.com (rule 3b), a legacy X pair
 *     'twitter|<id>' (rule 2). These are counted as `needs_backfill`: they resolve today, but the
 *     mainnet --apply moves the pair, so they keep resolving only through the identity
 *     nativeAuthBackfillIdentities.js creates. Each such account is checked with the backfill's
 *     own rules (planUserIdentity, reads only); one the backfill would skip is an orphan
 *     ('backfill_blocked', with the backfill's reason counted in `backfillBlocked`); or
 *   - it signs in with an external wallet (unchanged path, D16) — counted as `external_wallet`.
 * Everything else with a Web3Auth history is an ORPHAN, by the first reason that applies:
 *   legacy_apple              a legacy Apple pair (verifier name contains "apple")
 *   legacy_google_non_gmail   a legacy Google pair on a non-Gmail address
 *   legacy_x_malformed        a legacy X pair that is not 'twitter|<id>'
 *   x_without_legacy_pair     User.xid set, but no legacy X pair (xid is never trusted, F12)
 *   apple_relay_email         the account's e-mail is an Apple private-relay address
 *   web3auth_unpaired         authType 'web3auth' with no pair at all
 *   backfill_blocked          a linkable current pair the backfill would skip (ambiguous evidence,
 *                             the identity or a strong identity with the e-mail held by another
 *                             account): after --apply nothing finds it natively
 *   backfill_missing          a linkable old pair survives only as a web3auth_legacy identity
 *                             (already migrated) and the native identity was never backfilled
 *   legacy_unknown_verifier   any other Web3Auth verifier (not in DDC_AUTH_LEGACY_*)
 *   native_without_identity   a native connection's pair but no native identity (an anomaly)
 * Accounts that never used Web3Auth (password rows) are counted as `password_only`, not orphans:
 * native e-mail login gives them a separate account (rule 3d) and their password login remains.
 * Organisation and disabled accounts are counted apart (native login refuses them anyway).
 * Two flags are also counted over ALL active accounts, as the design lists them:
 *   flag_x_without_legacy_pair, flag_apple_relay_email.
 *
 * Usage:
 *   node scripts/nativeAuthOrphanReport.js [--json] [--list=<orphans.csv>] [--force] [--batch-size=1000]
 * Reads DDC_AUTH_LEGACY_{EMAIL,GOOGLE,X}_VERIFIERS; with all three empty every legacy pair counts
 * as legacy_unknown_verifier (a warning is printed). Output is counts only.
 */
const fs = require('fs');
const { readNativeAuthConfig } = require('../src/services/nativeAuth/config');
const backfill = require('./nativeAuthBackfillIdentities');

const NATIVE_PROVIDERS = Object.freeze(['email', 'google', 'apple', 'x']);
const LEGACY_PROVIDER = 'web3auth_legacy';
const EXTERNAL_WALLET_VERIFIER = 'external-wallet';
const NATIVE_CONNECTION_NAME = /^(ddc|datadance)-jwt-/i;
const RELAY_DOMAIN = '@privaterelay.appleid.com';
const DEFAULT_BATCH = 1000;
const ORPHAN_REASONS = Object.freeze([
  'legacy_apple',
  'legacy_google_non_gmail',
  'legacy_x_malformed',
  'x_without_legacy_pair',
  'apple_relay_email',
  'web3auth_unpaired',
  'backfill_blocked',
  'backfill_missing',
  'legacy_unknown_verifier',
  'native_without_identity',
]);

function defaultDb() {
  return require('../src/utils/prisma');
}

function isOrganization(user) {
  return Boolean(user && (user.userType === 'organization' || user.isOrganization));
}

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** '<verifier>|<verifierId>' → { verifier, verifierId } (the verifier id may contain '|'). */
function splitLegacySubject(subject) {
  const text = String(subject || '');
  const at = text.indexOf('|');
  return at > 0 ? { verifier: text.slice(0, at), verifierId: text.slice(at + 1) } : null;
}

/**
 * Kind of one Web3Auth pair: 'linkable_email' | 'linkable_x' | 'external' | 'native' |
 * 'apple' | 'google_non_gmail' | 'x_malformed' | 'unknown'.
 */
function pairKind(verifier, verifierId, lists) {
  if (verifier === EXTERNAL_WALLET_VERIFIER) return 'external';
  if (NATIVE_CONNECTION_NAME.test(verifier)) return 'native';
  const planned = backfill.identityForPair(verifier, verifierId, lists);
  if (planned && planned.identity) return planned.identity.provider === 'x' ? 'linkable_x' : 'linkable_email';
  if (planned && planned.skip === 'google_not_gmail') return 'google_non_gmail';
  if (planned && planned.skip === 'malformed_pair') return lists.xVerifiers.includes(verifier) ? 'x_malformed' : 'unknown';
  if (/apple/i.test(verifier)) return 'apple';
  return 'unknown';
}

/**
 * Classifies one account. `identities` are its AuthIdentity rows. Returns
 * { status, reason?, flags } where status is 'organization' | 'disabled' | 'native' |
 * 'needs_backfill' | 'external_wallet' | 'password_only' | 'orphan'.
 */
function classifyAccount(user, identities, lists) {
  const native = identities.filter((row) => NATIVE_PROVIDERS.includes(row.provider));
  const legacyPairs = identities.filter((row) => row.provider === LEGACY_PROVIDER).map((row) => splitLegacySubject(row.subject)).filter(Boolean);
  const current = user.web3authVerifier && user.web3authVerifierId ? { verifier: user.web3authVerifier, verifierId: user.web3authVerifierId } : null;
  const currentKind = current ? pairKind(current.verifier, current.verifierId, lists) : null;
  const oldKinds = legacyPairs.map((pair) => pairKind(pair.verifier, pair.verifierId, lists));
  const allKinds = [currentKind, ...oldKinds].filter(Boolean);

  const hasXPair = allKinds.includes('linkable_x') || native.some((row) => row.provider === 'x');
  const relay = lower(user.email).endsWith(RELAY_DOMAIN);
  const flags = {
    x_without_legacy_pair: Boolean(user.xid) && !hasXPair,
    apple_relay_email: relay && !native.some((row) => row.emailLinkGrade === 'strong'),
  };

  if (isOrganization(user)) return { status: 'organization', flags };
  if (user.disabledAt) return { status: 'disabled', flags };
  if (native.length) return { status: 'native', flags };
  if (currentKind === 'linkable_email' || currentKind === 'linkable_x') return { status: 'needs_backfill', flags };
  if (currentKind === 'external') return { status: 'external_wallet', flags };

  const everWeb3auth = user.authType === 'web3auth' || allKinds.length > 0;
  if (!everWeb3auth && !user.xid) return { status: 'password_only', flags };

  let reason;
  if (allKinds.includes('apple')) reason = 'legacy_apple';
  else if (allKinds.includes('google_non_gmail')) reason = 'legacy_google_non_gmail';
  else if (allKinds.includes('x_malformed')) reason = 'legacy_x_malformed';
  else if (user.xid && !hasXPair) reason = 'x_without_legacy_pair';
  else if (relay) reason = 'apple_relay_email';
  else if (!allKinds.length) reason = 'web3auth_unpaired';
  else if (oldKinds.includes('linkable_email') || oldKinds.includes('linkable_x')) reason = 'backfill_missing';
  else if (allKinds.every((kind) => kind === 'native')) reason = 'native_without_identity';
  else reason = 'legacy_unknown_verifier';
  return { status: 'orphan', reason, flags };
}

async function orphanReport({ db = defaultDb(), cfg = readNativeAuthConfig(), batchSize = DEFAULT_BATCH, onOrphan = () => {}, log = () => {} } = {}) {
  const lists = backfill.legacyLists(cfg);
  const report = {
    scanned: 0,
    statuses: {},
    orphans: Object.fromEntries(ORPHAN_REASONS.map((reason) => [reason, 0])),
    orphanTotal: 0,
    flags: { x_without_legacy_pair: 0, apple_relay_email: 0 },
    backfillBlocked: {},
  };
  if (!backfill.allLegacyVerifiers(lists).length) {
    report.warning = 'DDC_AUTH_LEGACY_{EMAIL,GOOGLE,X}_VERIFIERS are all empty: every legacy pair counts as legacy_unknown_verifier';
  }
  let cursor = null;
  for (;;) {
    const page = await db.user.findMany({
      where: cursor ? { id: { gt: cursor } } : {},
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    const users = page.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, batchSize);
    if (!users.length) break;
    cursor = users[users.length - 1].id;
    const identities = await db.authIdentity.findMany({ where: { userId: { in: users.map((u) => u.id) } } });
    for (const user of users) {
      report.scanned += 1;
      const result = classifyAccount(user, identities.filter((row) => row.userId === user.id), lists);
      if (result.status === 'needs_backfill') {
        // Would the backfill actually give it an identity? (reads only)
        const plan = await backfill.planUserIdentity({ user, lists, db });
        if (plan.status === 'skip') {
          result.status = 'orphan';
          result.reason = 'backfill_blocked';
          report.backfillBlocked[plan.reason] = (report.backfillBlocked[plan.reason] || 0) + 1;
        }
      }
      report.statuses[result.status] = (report.statuses[result.status] || 0) + 1;
      if (!['organization', 'disabled'].includes(result.status)) {
        for (const [flag, on] of Object.entries(result.flags)) if (on) report.flags[flag] += 1;
      }
      if (result.status === 'orphan') {
        report.orphans[result.reason] += 1;
        report.orphanTotal += 1;
        onOrphan(user.id, result.reason);
      }
    }
    log(`… ${report.scanned} scanned`);
    if (users.length < batchSize) break;
  }
  return report;
}

function parseArgs(argv) {
  const out = { json: false, force: false, help: false, list: null, batchSize: DEFAULT_BATCH };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--list=')) {
      out.list = arg.slice('--list='.length);
      if (!out.list) throw new Error('--list needs a file');
    } else if (arg.startsWith('--batch-size=')) {
      const raw = arg.slice('--batch-size='.length);
      const n = Number.parseInt(raw, 10);
      if (!/^\d+$/.test(raw) || n < 1 || n > 10000) throw new Error('--batch-size must be 1..10000');
      out.batchSize = n;
    } else throw new Error(`unknown argument ${JSON.stringify(arg).slice(0, 40)}`);
  }
  return out;
}

function printReport(report) {
  console.log(`scanned ${report.scanned} account(s)`);
  if (report.warning) console.log(`warning: ${report.warning}`);
  console.log(`status: ${Object.entries(report.statuses).map(([k, v]) => `${k}=${v}`).join(', ') || '(none)'}`);
  console.log(`orphans after the cut: ${report.orphanTotal}`);
  for (const [reason, count] of Object.entries(report.orphans)) if (count) console.log(`  ${reason}: ${count}`);
  console.log(`flags: ${Object.entries(report.flags).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  const blocked = Object.entries(report.backfillBlocked || {});
  if (blocked.length) console.log(`backfill_blocked by reason: ${blocked.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (report.statuses.needs_backfill) console.log('needs_backfill accounts resolve today; run nativeAuthBackfillIdentities.js --write before the mainnet --apply');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/nativeAuthOrphanReport.js [--json] [--list=<orphans.csv>] [--force] [--batch-size=1000]');
    return;
  }
  let fd = null;
  if (args.list) {
    fd = fs.openSync(args.list, args.force ? 'w' : 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeSync(fd, 'userId,reason\n');
  }
  try {
    const report = await orphanReport({
      batchSize: args.batchSize,
      onOrphan: fd === null ? () => {} : (userId, reason) => fs.writeSync(fd, `${userId},${reason}\n`),
      log: args.json ? () => {} : (line) => console.error(line),
    });
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else printReport(report);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('nativeAuthOrphanReport failed:', backfill.safeError(error));
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
  ORPHAN_REASONS,
  pairKind,
  classifyAccount,
  orphanReport,
  parseArgs,
  splitLegacySubject,
};
