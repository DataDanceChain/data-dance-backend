const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. 查找 RPC DAO 用户
  const user = await prisma.user.findUnique({
    where: { email: 'rpc-dao@organization.com' }
  });
  if (!user) {
    console.error('User not found: rpc-dao@organization.com');
    process.exit(1);
  }

  // 2. 创建充值流水（system mint）
  const tx = await prisma.organizationTransaction.create({
    data: {
      amount: 100000,
      type: 'DEPOSIT',
      status: 'COMPLETED',
      description: 'System mint deposit for RPC DAO',
      userId: user.id,
      metadata: {
        system: true,
        note: 'System minted funds'
      }
    }
  });
  console.log('Deposit successful:', tx);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); }); 