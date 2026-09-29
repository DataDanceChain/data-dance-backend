#!/usr/bin/env node
/**
 * Native-login identity backfill (design §9): gives every legacy Web3Auth account that native login
 * can already link by rule (§3.6 rules 2 and 3b) a native AuthIdentity, so it keeps resolving after
 * the mainnet migration moves its (web3authVerifier, web3authVerifierId) pair to the native
 * connection:
 *
 *   legacy pair                                                   → AuthIdentity
 *   (DDC_AUTH_LEGACY_EMAIL_VERIFIERS, <e-mail>)                   → ('email', e-mail), strong, 'backfill_legacy_email'
 *   (DDC_AUTH_LEGACY_GOOGLE_VERIFIERS, <address>@gmail.com)       → ('email', address), strong, 'backfill_legacy_google'
 *   (DDC_AUTH_LEGACY_X_VERIFIERS, 'twitter|<id>')                 → ('x', id), grade none, 'backfill_legacy_x'
 *
 * The Gmail row is not in the design's one-line description; it is the same evidence rule 3b already
 * accepts (a legacy Google pair on a @gmail.com address is a strong e-mail link target), and without
 * it those accounts would become orphans at the cut (the orphan report does not list them as such).
 * A Google identity cannot be backfilled directly: its subject is Google's `sub`, which the legacy
 * pair does not carry; a strong e-mail identity is what rule 3a links a Gmail sign-in to.
 *
 * Nothing is merged or guessed. A user is skipped (and counted) when:
 *   - it is an organisation (native login refuses those anyway);
 *   - the pair is malformed (not an e-mail address / not 'twitter|<digits>') or a non-Gmail Google
 *     pair (an orphan, see scripts/nativeAuthOrphanReport.js);
 *   - another account holds the same legacy evidence (two legacy pairs for one address or X id;
 *     today's rules answer ACCOUNT_LINK_REQUIRED 'ambiguous' for them);
 *   - the identity, or a strong identity with the same e-mail, already belongs to another account.
 * An identity the user already has is counted as present and left alone, so reruns are no-ops.
 *
 * Dry run by default (reads only). --write creates the identities, one row at a time; a unique
 * violation (a concurrent sign-in created it first) is counted as a race and never retried blindly.
 * Output is counts only: no e-mail address, X id, verifier id or user id is printed.
 *
 * Usage:
 *   node scripts/nativeAuthBackfillIdentities.js [--write] [--batch-size=500] [--json]
 * Reads DDC_AUTH_LEGACY_{EMAIL,GOOGLE,X}_VERIFIERS; nothing to do while all three are empty.
 * Run it before `nativeAuthWalletMigration.js --apply` (which also backfills each user it moves,
 * in the same transaction, as a safety net).
 */
const { readNativeAuthConfig } = require('../src/services/nativeAuth/config');

const LEGACY_PROVIDER = 'web3auth_legacy';
const EMAIL_PATTERN = /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/;
const X_PAIR_PATTERN = /^twitter\|(\d{1,25})$/;
const DEFAULT_BATCH = 500;

function defaultDb() {
  return require('../src/utils/prisma');
}

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isOrganization(user) {
  return Boolean(user && (user.userType === 'organization' || user.isOrganization));
}

/** The legacy verifier lists (DDC_AUTH_LEGACY_*), as used by accounts.js. */
function legacyLists(cfg) {
  const legacy = (cfg && cfg.legacy) || {};
  return {
    emailVerifiers: [...(legacy.emailVerifiers || [])],
    googleVerifiers: [...(legacy.googleVerifiers || [])],
    xVerifiers: [...(legacy.xVerifiers || [])],
  };
}

function allLegacyVerifiers(lists) {
  return [...new Set([...lists.emailVerifiers, ...lists.googleVerifiers, ...lists.xVerifiers])];
}

/**
 * What a legacy pair qualifies for: { identity } or { skip: reason } or null (not a listed legacy
 * verifier). Pure; the list order (e-mail, Google, X) wins when a name is listed twice.
 */
function identityForPair(verifier, verifierId, lists) {
  if (!verifier || typeof verifierId !== 'string') return null;
  if (lists.emailVerifiers.includes(verifier)) {
    const email = lower(verifierId);
    if (!EMAIL_PATTERN.test(email) || email.length > 254) return { skip: 'malformed_pair' };
    return { identity: { provider: 'email', subject: email, email, emailLinkGrade: 'strong', linkedVia: 'backfill_legacy_email' } };
  }
  if (lists.googleVerifiers.includes(verifier)) {
    const email = lower(verifierId);
    if (!EMAIL_PATTERN.test(email) || email.length > 254) return { skip: 'malformed_pair' };
    if (!email.endsWith('@gmail.com')) return { skip: 'google_not_gmail' };
    return { identity: { provider: 'email', subject: email, email, emailLinkGrade: 'strong', linkedVia: 'backfill_legacy_google' } };
  }
  if (lists.xVerifiers.includes(verifier)) {
    const match = X_PAIR_PATTERN.exec(verifierId.trim());
    if (!match) return { skip: 'malformed_pair' };
    return { identity: { provider: 'x', subject: match[1], email: null, emailLinkGrade: 'none', linkedVia: 'backfill_legacy_x' } };
  }
  return null;
}

/** The legacy pairs that carry the same evidence as `identity` (for the ambiguity check). */
function evidencePairs(identity, lists) {
  if (identity.provider === 'x') {
    return lists.xVerifiers.map((verifier) => ({ verifier, verifierId: `twitter|${identity.subject}` }));
  }
  const verifiers = [...lists.emailVerifiers, ...(identity.subject.endsWith('@gmail.com') ? lists.googleVerifiers : [])];
  return verifiers.map((verifier) => ({ verifier, verifierId: identity.subject }));
}

/**
 * Other accounts holding the same legacy evidence: by their current pair, or by an old pair the
 * mainnet migration (or a local lazy rebind) recorded as a 'web3auth_legacy' identity.
 */
async function otherEvidenceHolders(identity, user, lists, db) {
  const holders = new Set();
  for (const { verifier, verifierId } of evidencePairs(identity, lists)) {
    const rows = await db.user.findMany({
      where: { web3authVerifier: verifier, web3authVerifierId: { equals: verifierId, mode: 'insensitive' } },
    });
    rows.filter((row) => row.id !== user.id).forEach((row) => holders.add(row.id));
    const legacyRows = await db.authIdentity.findMany({
      where: { provider: LEGACY_PROVIDER, subject: { equals: `${verifier}|${verifierId}`, mode: 'insensitive' } },
    });
    legacyRows.filter((row) => row.userId !== user.id).forEach((row) => holders.add(row.userId));
  }
  return holders;
}

/**
 * The identity `user` should get from its CURRENT legacy pair. Returns
 *   { status: 'none' }                      the pair is not a listed legacy verifier
 *   { status: 'skip', reason }              see the header
 *   { status: 'present', identity }         the user already has it
 *   { status: 'create', identity }          safe to create
 * Reads only. `db` may be a transaction client.
 */
async function planUserIdentity({ user, lists, db }) {
  const pair = identityForPair(user.web3authVerifier, user.web3authVerifierId, lists);
  if (!pair) return { status: 'none' };
  if (pair.skip) return { status: 'skip', reason: pair.skip };
  if (isOrganization(user)) return { status: 'skip', reason: 'organization' };
  const { identity } = pair;

  const existing = await db.authIdentity.findUnique({
    where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
  });
  if (existing) {
    return existing.userId === user.id
      ? { status: 'present', identity }
      : { status: 'skip', reason: 'identity_owned_elsewhere' };
  }
  if (identity.email) {
    const strong = await db.authIdentity.findMany({ where: { email: identity.email, emailLinkGrade: 'strong' } });
    if (strong.some((row) => row.userId !== user.id)) return { status: 'skip', reason: 'strong_email_owned_elsewhere' };
  }
  const others = await otherEvidenceHolders(identity, user, lists, db);
  if (others.size) return { status: 'skip', reason: 'ambiguous' };
  return { status: 'create', identity };
}

/** AuthIdentity create data for a planned identity. */
function identityData(userId, identity) {
  return {
    userId,
    provider: identity.provider,
    subject: identity.subject,
    email: identity.email,
    emailLinkGrade: identity.emailLinkGrade,
    isPrivateRelay: false,
    linkedVia: identity.linkedVia,
  };
}

function emptySummary(write) {
  return {
    mode: write ? 'write' : 'dry-run',
    scanned: 0,
    create: { email: 0, x: 0 },
    created: { email: 0, x: 0 },
    present: 0,
    races: 0,
    skipped: {},
  };
}

/**
 * Scan every user whose pair names a listed legacy verifier and create (with `write`) the missing
 * identities. Returns the summary (counts only).
 */
async function backfillIdentities({ db = defaultDb(), cfg = readNativeAuthConfig(), write = false, batchSize = DEFAULT_BATCH, log = () => {} } = {}) {
  const lists = legacyLists(cfg);
  const verifiers = allLegacyVerifiers(lists);
  const summary = emptySummary(write);
  if (!verifiers.length) {
    summary.note = 'DDC_AUTH_LEGACY_{EMAIL,GOOGLE,X}_VERIFIERS are all empty: nothing to backfill';
    return summary;
  }
  let cursor = null;
  for (;;) {
    const page = await db.user.findMany({
      where: { web3authVerifier: { in: verifiers }, ...(cursor && { id: { gt: cursor } }) },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    // Sorted and cut here too, so the cursor is right whatever the client returns.
    const rows = page.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, batchSize);
    if (!rows.length) break;
    for (const user of rows) {
      summary.scanned += 1;
      const plan = await planUserIdentity({ user, lists, db });
      if (plan.status === 'skip') summary.skipped[plan.reason] = (summary.skipped[plan.reason] || 0) + 1;
      if (plan.status === 'present') summary.present += 1;
      if (plan.status !== 'create') continue;
      summary.create[plan.identity.provider] += 1;
      if (!write) continue;
      try {
        await db.authIdentity.create({ data: identityData(user.id, plan.identity) });
        summary.created[plan.identity.provider] += 1;
      } catch (err) {
        if (err && err.code === 'P2002') summary.races += 1;
        else throw err;
      }
    }
    cursor = rows[rows.length - 1].id;
    log(`… ${summary.scanned} scanned`);
    if (rows.length < batchSize) break;
  }
  return summary;
}

/**
 * An error for the console without row data: Prisma messages quote the query arguments (e-mail
 * addresses, ids), so for those only the class and code are printed.
 */
function safeError(error) {
  if (!error) return 'unknown error';
  const name = String(error.name || 'Error');
  if (/^Prisma/.test(name) || error.code) return `${name}${error.code ? ` ${error.code}` : ''}`;
  return String(error.message || name).slice(0, 300);
}

function parseArgs(argv) {
  const out = { write: false, json: false, batchSize: DEFAULT_BATCH, help: false };
  for (const arg of argv) {
    if (arg === '--write') out.write = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg.startsWith('--batch-size=')) {
      const n = Number.parseInt(arg.slice('--batch-size='.length), 10);
      if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error('--batch-size must be 1..5000');
      out.batchSize = n;
    } else throw new Error(`unknown argument ${JSON.stringify(arg).slice(0, 40)}`);
  }
  return out;
}

function printSummary(summary) {
  const verb = summary.mode === 'write' ? 'created' : 'would create';
  const made = summary.mode === 'write' ? summary.created : summary.create;
  console.log(`[${summary.mode}] scanned ${summary.scanned} legacy account(s)`);
  if (summary.note) console.log(`note: ${summary.note}`);
  console.log(`${verb}: ${made.email} e-mail identit(ies), ${made.x} X identit(ies); already present: ${summary.present}`);
  if (summary.races) console.log(`races (created concurrently, left as found): ${summary.races}`);
  const skips = Object.entries(summary.skipped);
  if (skips.length) console.log(`skipped: ${skips.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (summary.mode !== 'write' && (summary.create.email || summary.create.x)) console.log('dry run: nothing written; add --write to create them');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('usage: node scripts/nativeAuthBackfillIdentities.js [--write] [--batch-size=500] [--json]');
    return;
  }
  const summary = await backfillIdentities({ write: args.write, batchSize: args.batchSize, log: args.json ? () => {} : (line) => console.error(line) });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else printSummary(summary);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('nativeAuthBackfillIdentities failed:', safeError(error));
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
  LEGACY_PROVIDER,
  legacyLists,
  allLegacyVerifiers,
  identityForPair,
  planUserIdentity,
  identityData,
  backfillIdentities,
  parseArgs,
  safeError,
};
