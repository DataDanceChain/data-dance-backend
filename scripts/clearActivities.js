const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function clearActivities() {
  try {
    // 删除所有 ActivityClaim
    const deleteClaimsResult = await prisma.activityClaim.deleteMany({});
    console.log(`Deleted ${deleteClaimsResult.count} activity claims`);

    // 删除所有 DataDanceID
    const deleteDataDanceIDsResult = await prisma.dataDanceID.deleteMany({});
    console.log(`Deleted ${deleteDataDanceIDsResult.count} DataDanceIDs`);

    // 删除所有活动
    const deleteActivitiesResult = await prisma.activity.deleteMany({});
    console.log(`Deleted ${deleteActivitiesResult.count} activities`);
  } catch (error) {
    console.error('Error clearing activities:', error);
  } finally {
    await prisma.$disconnect();
  }
}

clearActivities()
  .then(() => console.log('Successfully cleared all activities'))
  .catch(error => console.error('Failed to clear activities:', error)); 