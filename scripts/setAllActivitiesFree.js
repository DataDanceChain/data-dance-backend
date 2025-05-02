const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function setAllActivitiesFree() {
  try {
    // Update all activities to have nftPrice = 0
    const result = await prisma.activity.updateMany({
      where: {
        nftPrice: {
          not: 0
        }
      },
      data: {
        nftPrice: 0
      }
    });

    console.log(`Successfully updated ${result.count} activities to be free`);
  } catch (error) {
    console.error('Error updating activities:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
setAllActivitiesFree(); 