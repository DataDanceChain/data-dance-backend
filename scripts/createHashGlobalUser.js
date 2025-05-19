const prisma = require('../src/utils/prisma');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

async function main() {
  try {
    // 1. 创建或更新组织用户
    const hashedPassword = await bcrypt.hash("HashGlobal@2024", 10);
    const orgUser = await prisma.user.upsert({
      where: { email: "contact@hashglobal.com" },
      update: {
        name: "Hash Global",
        description: "A leading Web3 investment fund focused on building the future of blockchain technology.",
        logo: "assets/logos/hash-global.png",
        avatar: "assets/logos/hash-global.png",
        referralCode: generateReferralCode()
      },
      create: {
        email: "contact@hashglobal.com",
        name: "Hash Global",
        password: hashedPassword,
        isOrganization: true,
        description: "A leading Web3 investment fund focused on building the future of blockchain technology.",
        logo: "assets/logos/hash-global.png",
        avatar: "assets/logos/hash-global.png",
        referralCode: generateReferralCode()
      }
    });

    console.log('Successfully created/updated Hash Global organization user:', orgUser);

  } catch (error) {
    console.error('Error creating/updating Hash Global organization user:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  }); 