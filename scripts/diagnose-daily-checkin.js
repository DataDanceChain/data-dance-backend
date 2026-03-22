#!/usr/bin/env node
/**
 * Diagnose Daily Check-in streak and expected claim points.
 * Uses the same streak calculation as taskService.claimTask.
 *
 * Usage (from repo root, with backend .env / DATABASE_URL loaded):
 *   node scripts/diagnose-daily-checkin.js <userId>
 *   node scripts/diagnose-daily-checkin.js --email user@example.com
 */

const prisma = require('../src/utils/prisma');
const { getConsecutiveCheckInStreak } = require('../src/services/taskService');
const { awards } = require('../config/awards.json');

function startOfUtcDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseArgs(argv) {
  if (argv.length === 0) return { error: 'missing user' };
  if (argv[0] === '--email' && argv[1]) return { email: argv[1].trim() };
  if (argv[0].startsWith('--')) return { error: `unknown flag: ${argv[0]}` };
  return { userId: argv[0].trim() };
}

async function resolveUserId(parsed) {
  if (parsed.userId) {
    const u = await prisma.user.findUnique({
      where: { id: parsed.userId },
      select: { id: true, email: true },
    });
    return u;
  }
  if (parsed.email) {
    const u = await prisma.user.findUnique({
      where: { email: parsed.email },
      select: { id: true, email: true },
    });
    return u;
  }
  return null;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    console.error('\nUsage: node scripts/diagnose-daily-checkin.js <userId>');
    console.error('   or: node scripts/diagnose-daily-checkin.js --email you@example.com');
    process.exit(1);
  }

  const user = await resolveUserId(parsed);
  if (!user) {
    console.error('User not found.');
    process.exit(1);
  }

  const userId = user.id;
  const now = new Date();
  const today = startOfUtcDay(now);

  const [task, checkIns, checkedInRow, recentClaims] = await Promise.all([
    prisma.task.findUnique({
      where: { id: 'daily-check-in' },
      select: { id: true, points: true, metadata: true, awardId: true },
    }),
    prisma.userDailyEvent.findMany({
      where: { userId, type: 'CHECK_IN' },
      orderBy: { day: 'desc' },
      take: 20,
      select: { day: true, createdAt: true },
    }),
    prisma.userDailyEvent.findUnique({
      where: { userId_type_day: { userId, type: 'CHECK_IN', day: today } },
      select: { day: true, createdAt: true },
    }),
    prisma.point.findMany({
      where: { userId, source: 'TASK_CLAIM', sourceId: 'daily-check-in' },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { amount: true, createdAt: true },
    }),
  ]);

  const configAward = awards.find((a) => a.id === 'daily-tasks');
  const configTask = configAward?.tasks?.find((t) => t.id === 'daily-check-in');

  const meta = task?.metadata && typeof task.metadata === 'object' ? task.metadata : {};
  const dynamicPoints = meta.dynamicPoints;
  const streak = await getConsecutiveCheckInStreak(userId, today);
  const pointsOnNextClaim =
    dynamicPoints === 'CHECKIN_STREAK_1_7'
      ? Math.max(1, Math.min(streak, 7))
      : task?.points ?? null;

  console.log('=== Daily check-in diagnosis ===\n');
  console.log('User:', user.email, `(${userId})`);
  console.log('Server now (UTC):', now.toISOString());
  console.log('Today key (UTC start):', today.toISOString());
  console.log('Checked in today (UTC day):', checkedInRow ? 'yes' : 'no');
  console.log('');

  console.log('--- Task row (DB) daily-check-in ---');
  if (!task) {
    console.log('MISSING: no Task with id daily-check-in');
  } else {
    console.log('points (static fallback):', task.points);
    console.log('metadata:', JSON.stringify(task.metadata ?? {}));
    console.log('dynamicPoints:', dynamicPoints ?? '(absent)');
  }
  console.log('');

  console.log('--- Config (awards.json) daily-check-in ---');
  if (!configTask) {
    console.log('Not found under daily-tasks in awards.json');
  } else {
    console.log('points:', configTask.points);
    console.log('metadata.dynamicPoints:', configTask.metadata?.dynamicPoints ?? '(absent)');
  }
  console.log('');

  console.log('--- Streak (same as claim) ---');
  console.log('consecutive CHECK_IN days (UTC, ending today if checked in):', streak);
  console.log('Expected points on claim (if metadata ok):', pointsOnNextClaim);
  console.log('');

  console.log('--- Recent CHECK_IN events (newest first) ---');
  if (checkIns.length === 0) {
    console.log('(none)');
  } else {
    checkIns.forEach((e, i) => {
      console.log(
        `  ${i + 1}. day=${e.day.toISOString()} createdAt=${e.createdAt.toISOString()}`,
      );
    });
  }
  console.log('');

  console.log('--- Recent Point rows (TASK_CLAIM / daily-check-in) ---');
  if (recentClaims.length === 0) {
    console.log('(none)');
  } else {
    recentClaims.forEach((p, i) => {
      console.log(`  ${i + 1}. amount=${p.amount} at ${p.createdAt.toISOString()}`);
    });
  }
  console.log('');

  console.log('--- Verdict ---');
  if (!task) {
    console.log('Fix: seed tasks (node scripts/createAwards.js).');
  } else if (dynamicPoints !== 'CHECKIN_STREAK_1_7') {
    console.log(
      'LIKELY ISSUE: DB Task.metadata is missing dynamicPoints CHECKIN_STREAK_1_7 — claims use static task.points only.',
    );
    if (configTask?.metadata?.dynamicPoints === 'CHECKIN_STREAK_1_7') {
      console.log('Config file has it; run: node scripts/createAwards.js');
    }
  } else if (streak === 1 && checkIns.length >= 2) {
    const keys = [...new Set(checkIns.map((e) => startOfUtcDay(e.day).toISOString()))];
    console.log('Streak is 1 but multiple CHECK_IN rows exist — check for non-consecutive UTC days:');
    console.log('  distinct day keys:', keys.slice(0, 10).join(', '));
  } else if (streak === 1 && checkIns.length === 1) {
    console.log(
      'Only one CHECK_IN on record — second "day" of testing may be same UTC calendar day, or second check-in never saved.',
    );
  } else {
    console.log('Metadata and streak look consistent; compare Point amounts to expected', pointsOnNextClaim);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
