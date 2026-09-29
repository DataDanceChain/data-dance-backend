#!/usr/bin/env node
/**
 * Housekeeping for the SSO hand-off (plan §2.8). Nothing here is load-bearing for security —
 * a consumed or expired row is already refused by the endpoints — it only stops two short-lived
 * tables from growing forever.
 *
 * Deletes:
 *   - SsoTicket rows never redeemed and past expiry (TTL 60 s, so "past expiry" is immediate)
 *   - SsoTicket rows redeemed longer ago than the longest App SSO session (12 h). A redeemed row
 *     is what keeps its session alive (ssoRoutes.ssoSessionRefusal), so it must outlive it.
 *   - OAuthAuthorization rows never consumed and older than a day (abandoned consent requests;
 *     their own TTL is 10 min, so a day is a wide safety margin)
 *
 * With --native, also the native-login tables (design §3.13; nothing else reads these rows once
 * they are this old):
 *   - AuthFlowState rows (IdP nonces, X state and hand-offs, step-up challenges) expired > 24 h ago
 *   - AuthEmailChallenge rows created > 24 h ago. The per-e-mail rolling 24 h counts, the
 *     30-failure escalation and the daily budgets scan this table, so exactly the last 24 h stay
 *     and the table stays small (it has no createdAt-only index).
 *   - AuthLoginAttempt rows never completed, created > 7 days ago and expired
 *   - AuthLoginAttempt rows completed > 30 days ago
 * The native retention periods are fixed (not --older-than-hours): a shorter window would weaken
 * the e-mail rate limits. Identities, bindings and WalletAddressHistory are never purged.
 * Without --native the script does exactly what it did before native login existed (--native is
 * the explicit opt-in for the new deletions; --dry-run applies to it as well).
 *
 * Usage:
 *   node scripts/cleanupSso.js [--dry-run] [--older-than-hours=24] [--native]
 *
 * Cron: hourly is plenty. Add --native once DDC_AUTH_ENABLED is on anywhere.
 */
const prisma = require('../src/utils/prisma');

// = ssoRoutes.MAX_SESSION_TTL_SEC (asserted equal in test/unit/ssoHandoff.test.js). Copied so this
// script does not load the Express routes and their middleware.
const SESSION_RETENTION_SEC = 12 * 60 * 60;

const HOUR_MS = 60 * 60 * 1000;
/** Native-login retention (design §3.13). Fixed on purpose; see the header. */
const NATIVE_RETENTION = Object.freeze({
  flowStateExpiredHours: 24,
  emailChallengeHours: 24,
  incompleteAttemptDays: 7,
  completedAttemptDays: 30,
});

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const hoursArg = argv.find((arg) => arg.startsWith('--older-than-hours='));
  const hours = hoursArg ? Number.parseInt(hoursArg.split('=')[1], 10) : 24;
  const native = argv.includes('--native');
  return { dryRun, hours: Number.isFinite(hours) && hours > 0 ? hours : 24, native };
}

/** The four native-login purges as { key: [model, where] }. */
function nativeTargets(now) {
  const ago = (ms) => new Date(now.getTime() - ms);
  const r = NATIVE_RETENTION;
  return {
    flowStates: ['authFlowState', { expiresAt: { lt: ago(r.flowStateExpiredHours * HOUR_MS) } }],
    emailChallenges: ['authEmailChallenge', { createdAt: { lt: ago(r.emailChallengeHours * HOUR_MS) } }],
    attemptsIncomplete: [
      'authLoginAttempt',
      { completedAt: null, createdAt: { lt: ago(r.incompleteAttemptDays * 24 * HOUR_MS) }, expiresAt: { lt: now } },
    ],
    attemptsCompleted: ['authLoginAttempt', { completedAt: { not: null, lt: ago(r.completedAttemptDays * 24 * HOUR_MS) } }],
  };
}

/** Counts (dry run) or deletes the native-login rows past retention. Idempotent. */
async function cleanupNative({ dryRun = false, now = new Date(), db = prisma } = {}) {
  const out = {};
  for (const [key, [model, where]] of Object.entries(nativeTargets(now))) {
    out[key] = dryRun ? await db[model].count({ where }) : (await db[model].deleteMany({ where })).count;
  }
  return out;
}

async function cleanupSso({ dryRun = false, hours = 24, now = new Date(), native = false } = {}) {
  const result = await cleanupSsoTables({ dryRun, hours, now });
  if (native) result.native = await cleanupNative({ dryRun, now });
  return result;
}

async function cleanupSsoTables({ dryRun, hours, now }) {
  const cutoff = new Date(now.getTime() - hours * 60 * 60 * 1000);

  const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_SEC * 1000);
  const consumedTickets = { consumedAt: { not: null, lt: sessionCutoff } };
  const expiredTickets = { consumedAt: null, expiresAt: { lt: now } };
  const staleRequests = { consumedAt: null, createdAt: { lt: cutoff } };

  if (dryRun) {
    const [consumed, expired, requests] = await Promise.all([
      prisma.ssoTicket.findMany({ where: consumedTickets }),
      prisma.ssoTicket.findMany({ where: expiredTickets }),
      prisma.oAuthAuthorization.findMany({ where: staleRequests }),
    ]);
    // The two sets are disjoint now (consumed vs not); the union keeps the count honest anyway.
    const ticketIds = new Set([...consumed, ...expired].map((row) => row.id));
    return { dryRun: true, tickets: ticketIds.size, authorizations: requests.length, cutoff };
  }

  const consumed = await prisma.ssoTicket.deleteMany({ where: consumedTickets });
  const expired = await prisma.ssoTicket.deleteMany({ where: expiredTickets });
  const requests = await prisma.oAuthAuthorization.deleteMany({ where: staleRequests });
  return {
    dryRun: false,
    tickets: consumed.count + expired.count,
    authorizations: requests.count,
    cutoff,
  };
}

async function main() {
  const { dryRun, hours, native } = parseArgs(process.argv.slice(2));
  const result = await cleanupSso({ dryRun, hours, native });
  console.log(
    `${dryRun ? '[dry-run] would delete' : 'deleted'}: ${result.tickets} SsoTicket, ` +
    `${result.authorizations} OAuthAuthorization (unconsumed, created before ${result.cutoff.toISOString()})`,
  );
  if (result.native) {
    const n = result.native;
    console.log(
      `${dryRun ? '[dry-run] would delete' : 'deleted'} (native login): ${n.flowStates} AuthFlowState, ` +
      `${n.emailChallenges} AuthEmailChallenge, ${n.attemptsIncomplete} incomplete + ${n.attemptsCompleted} completed AuthLoginAttempt`,
    );
  } else if (String(process.env.DDC_AUTH_ENABLED || '').trim().toLowerCase() === 'true') {
    console.error('note: DDC_AUTH_ENABLED is on but --native was not given; the native-login tables were not purged');
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('cleanupSso failed:', error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (typeof prisma.$disconnect === 'function') await prisma.$disconnect();
    });
}

module.exports = { cleanupSso, cleanupNative, parseArgs, SESSION_RETENTION_SEC, NATIVE_RETENTION };
