const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Get the rpc-dao organization
  const org = await prisma.user.findUnique({
    where: { email: 'rpc-dao@organization.com' }
  });
  if (!org) {
    throw new Error('Cannot find user: rpc-dao@organization.com');
  }

  // Assume DataDance System is also an organization user
  const system = await prisma.user.findFirst({
    where: { isOrganization: true, email: 'system@datadance.com' }
  });

  // Other organizations
  const otherOrgs = await prisma.user.findMany({
    where: {
      isOrganization: true,
      email: { notIn: ['rpc-dao@organization.com', 'system@datadance.com'] }
    },
    take: 2
  });

  // Generate some deposit, withdrawal, system reward, and cooperation income transactions
  const transactions = [
    // Deposit
    {
      amount: 1000,
      type: 'DEPOSIT',
      status: 'COMPLETED',
      description: 'Initial deposit',
      userId: org.id,
      metadata: { source: 'bank' }
    },
    // Withdrawal
    {
      amount: 200,
      type: 'WITHDRAW',
      status: 'COMPLETED',
      description: 'Withdrawal to bank account',
      userId: org.id,
      metadata: { target: 'bank' }
    },
    // System reward
    system && {
      amount: 500,
      type: 'DEPOSIT',
      status: 'COMPLETED',
      description: 'DataDance System activity reward',
      userId: org.id,
      metadata: { from: system.id }
    },
    // Cooperation income with other organizations
    ...otherOrgs.map(o => ({
      amount: 300,
      type: 'DEPOSIT',
      status: 'COMPLETED',
      description: `Cooperation income from organization ${o.email}`,
      userId: org.id,
      metadata: { from: o.id }
    }))
  ].filter(Boolean);

  for (const tx of transactions) {
    await prisma.organizationTransaction.create({ data: tx });
    console.log('Created transaction:', tx.description);
  }

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
}); 