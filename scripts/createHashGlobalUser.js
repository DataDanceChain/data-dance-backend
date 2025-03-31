const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  try {
    // 1. 创建组织用户
    const orgUser = await prisma.user.create({
      data: {
        email: "contact@hashglobal.com",
        name: "Hash Global",
        password: "hashedPassword", // 你可能需要添加正确的密码哈希
        isOrganization: true,
        description: "A leading Web3 investment fund focused on building the future of blockchain technology.",
        logo: "assets/logos/hash-global.png",
        avatar: "assets/logos/hash-global.png"
      }
    });

    console.log('Successfully created Hash Global organization user:', orgUser);

  } catch (error) {
    console.error('Error creating Hash Global organization user:', error);
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