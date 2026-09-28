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
 * Usage:
 *   node scripts/cleanupSso.js [--dry-run] [--older-than-hours=24]
 *
 * Cron: hourly is plenty.
 */
const prisma = require('../src/utils/prisma');

// = ssoRoutes.MAX_SESSION_TTL_SEC (asserted equal in test/unit/ssoHandoff.test.js). Copied so this
// script does not load the Express routes and their middleware.
const SESSION_RETENTION_SEC = 12 * 60 * 60;

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run') || argv.includes('-n');
  const hoursArg = argv.find((arg) => arg.startsWith('--older-than-hours='));
  const hours = hoursArg ? Number.parseInt(hoursArg.split('=')[1], 10) : 24;
  return { dryRun, hours: Number.isFinite(hours) && hours > 0 ? hours : 24 };
}

async function cleanupSso({ dryRun = false, hours = 24, now = new Date() } = {}) {
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
  const { dryRun, hours } = parseArgs(process.argv.slice(2));
  const result = await cleanupSso({ dryRun, hours });
  console.log(
    `${dryRun ? '[dry-run] would delete' : 'deleted'}: ${result.tickets} SsoTicket, ` +
    `${result.authorizations} OAuthAuthorization (unconsumed, created before ${result.cutoff.toISOString()})`,
  );
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

module.exports = { cleanupSso, parseArgs, SESSION_RETENTION_SEC };
