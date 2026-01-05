const prisma = require('../src/utils/prisma');

// Load award configuration from single JSON file
const { postIds, common, awards } = require('../config/awards.json');

async function main() {
  // Upsert each award definition
  for (const award of awards) {
    await prisma.award.upsert({
      where: { id: award.id },
      update: {
        title: award.title,
        description: award.description,
        icon: award.icon,
        color: award.color,
        status: award.status,
        metadata: award.metadata || {}
      },
      create: {
        id: award.id,
        title: award.title,
        description: award.description,
        icon: award.icon,
        color: award.color,
        status: award.status,
        metadata: award.metadata || {}
      }
    });
  }

  console.log('Award definitions seeded.');

  // Upsert task definitions per award using config tasks
  for (const award of awards) {
    const defs = award.tasks || [];
    for (const t of defs) {
      // build dynamic fields
      const description = t.description;
      const metadata = t.postKey
        ? { type: common.metadataType, targetPostId: postIds[t.postKey] }
        : (t.metadata || null);
      await prisma.task.upsert({
        where: { id: t.id },
        update: {
          title: t.title,
          description: t.description,
          points: t.points,
          status: award.status,
          claimLimit: t.claimLimit,
          requirementCount: t.requirementCount || null,
          prerequisiteTaskId: t.prerequisiteTaskId || null,
          metadata
        },
        create: {
          id: t.id,
          awardId: award.id,
          title: t.title,
          description,
          points: t.points,
          status: award.status,
          claimLimit: t.claimLimit,
          requirementCount: t.requirementCount || null,
          prerequisiteTaskId: t.prerequisiteTaskId || null,
          metadata
        }
      });
    }
  }

  console.log('Task definitions seeded.');

  // Note: user test data seeding is moved to a separate script 'seedTestUserData.js'
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());