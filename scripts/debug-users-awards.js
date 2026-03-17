/**
 * Debug script: call getUserAwards for a real user to reproduce the 500 error.
 * Run from backend root: node scripts/debug-users-awards.js
 */
require('dotenv').config();
const { getUserAwards } = require('../src/services/awardService');
const prisma = require('../src/utils/prisma');

async function main() {
  const user = await prisma.user.findFirst({ select: { id: true, email: true } });
  if (!user) {
    console.error('No user in database. Seed a user first.');
    process.exit(1);
  }
  console.log('Calling getUserAwards for user:', user.id, user.email);
  try {
    const data = await getUserAwards(user.id);
    console.log('Success. Awards count:', data.awards?.length ?? 0);
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
  } catch (err) {
    console.error('Error message:', err.message);
    console.error('Stack:', err.stack);
    if (err.cause) console.error('Cause:', err.cause);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
