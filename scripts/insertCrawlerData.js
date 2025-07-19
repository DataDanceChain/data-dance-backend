const prisma = require('../src/utils/prisma');
const { generateContentHash } = require('../src/services/crawlerService');

async function main() {
  const userId = process.argv[2];
  const taskId = process.argv[3];
  const count = parseInt(process.argv[4], 10);

  if (!userId || !taskId || isNaN(count)) {
    console.error('Usage: node insertCrawlerData.js <userId> <taskId> <count>');
    process.exit(1);
  }

  console.log(`Inserting ${count} crawler data records for user ${userId} and task ${taskId}...`);

  const dataToInsert = [];
  for (let i = 1; i <= count; i++) {
    const payload = {
      orderid: `ORDER-${Date.now()}-${i}`,
      title: `Test Item ${i}`,
      price: Math.floor(Math.random() * 100) + 1,
      currency: 'USD',
      sourceUrl: `http://example.com/test-item-${i}`,
      timestamp: new Date().toISOString()
    };

    dataToInsert.push({
      source: 'amazon',
      type: 'order',
      timestamp: new Date(),
      metadata: {},
      payload: payload,
      contentHash: generateContentHash(payload),
      sourceId: payload.orderid,
      taskId: taskId,
      userId: userId
    });
  }

  try {
    await prisma.crawlerData.createMany({
      data: dataToInsert,
      skipDuplicates: true,
    });
    console.log(`Successfully inserted ${count} records.`);
  } catch (error) {
    console.error('Error inserting crawler data:', error);
    process.exit(1);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
