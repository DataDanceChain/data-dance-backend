const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const tags = [
  'Sports & Fitness',
  'Music & Entertainment',
  'Art & Culture',
  'Education & Training',
  'Tech & Innovation',
  'Social & Networking',
  'Food & Beverage',
  'Family & Kids',
  'Travel & Outdoor',
  'Charity & Environment',
  'Health & Wellness',
  'Fashion & Beauty',
  'Finance & Investment',
  'Gaming & E-sports',
  'Pets & Animals',
  'Other'
];

async function main() {
  for (const name of tags) {
    const exists = await prisma.tag.findFirst({ where: { name } });
    if (!exists) {
      await prisma.tag.create({ data: { name } });
      console.log(`Created tag: ${name}`);
    } else {
      console.log(`Tag already exists: ${name}`);
    }
  }
  await prisma.$disconnect();
}

main().then(() => console.log('Tag seeding completed.')).catch(console.error);

