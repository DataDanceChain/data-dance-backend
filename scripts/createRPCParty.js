const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

/**
 * 创建 RPC Club Party 活动
 */
async function createRPCParty() {
  try {
    console.log("Starting to create RPC Club Party event...");
    
    // 1. 查找或创建 RPC DAO 组织用户
    let orgUser = await prisma.user.findFirst({
      where: { 
        email: "rpc-dao@organization.com",
        isOrganization: true
      }
    });
    
    if (!orgUser) {
      console.log("Creating RPC DAO organization user...");
      const hashedPassword = await bcrypt.hash("Org@123", 10);
      
      // 创建组织用户
      orgUser = await prisma.user.create({
        data: {
          email: "rpc-dao@organization.com",
          name: "RPC DAO",
          password: hashedPassword,
          isOrganization: true,
          description: "Ready Player Club DAO - A Web3 Community",
          logo: "/assets/logos/rpc-dao.png",
          avatar: "/assets/logos/rpc-dao.png"
        }
      });
      
      // 创建用户角色关联
      try {
        const userRole = await prisma.role.findFirst({
          where: { name: "USER" }
        });
        
        if (userRole) {
          await prisma.userRole.create({
            data: {
              user: { connect: { id: orgUser.id } },
              role: { connect: { id: userRole.id } }
            }
          });
          console.log(`Assigned USER role to RPC DAO`);
        }
      } catch (roleError) {
        console.error("Error assigning role to user:", roleError);
      }
      
      console.log("Created RPC DAO organization user");
    }
    
    // 2. 检查活动是否已存在
    const existingActivity = await prisma.activity.findFirst({
      where: { 
        title: "Ready Player Club - Web3 Future Social Party"
      }
    });
    
    if (existingActivity) {
      console.log("RPC Club Party event already exists, skipping...");
      return;
    }
    
    // 3. 创建活动
    const activity = await prisma.activity.create({
      data: {
        id: "rpc-web3-party",
        title: "Ready Player Club - Web3 Future Social Party",
        description: `Join Ready Player Club's exclusive social gathering in Hong Kong! 

We're bringing together club members and selected Web3 enthusiasts for an evening of meaningful discussions, networking, and shared visions about the future of Web3.

🎯 Event Highlights:
• Web3 Trends Discussion
• Member Experience Sharing
• Social Networking
• Exclusive Club Benefits

🗣️ Format:
• Casual Discussion Panels
• Open Networking Sessions
• Interactive Group Activities

🎫 Participation:
• Priority Access for Club Members
• Limited Spots for Invited Guests
• Semi-private Event

📍 Location: Hong Kong (Exact venue will be shared with confirmed participants)

Join us for an evening of inspiration, connection, and collaborative exploration of Web3's future!`,
        startDate: new Date("2025-04-06T18:00:00+08:00"),
        endDate: new Date("2025-04-06T22:00:00+08:00"),
        image: "/assets/nfts/rpc-party.png",
        creator: {
          connect: { id: orgUser.id }
        },
        type: "MEMBERSHIP",
        remaining: 100,
        total: 100,
        statusNote: "Club members priority, limited guest spots available",
        equityTitle: "EVENT PRIVILEGES",
        equityDetails: [
          "Exclusive networking with Web3 pioneers",
          "Priority access to future club events",
          "Complimentary food and beverages",
          "Special club member benefits"
        ],
        externalLinksTitle: "USEFUL LINKS",
        externalLinks: JSON.stringify([
          {
            name: "Club Membership",
            url: "https://readyplayerclub.com/membership"
          },
          {
            name: "Past Events Gallery",
            url: "https://readyplayerclub.com/events/gallery"
          }
        ]),
        nftName: "RPC Web3 Future Party - Attendance NFT",
        nftDescription: "Exclusive NFT for attendees of the Ready Player Club Web3 Future Social Party",
        nftImage: "/assets/nfts/rpc-party.png",
        nftTotalSupply: 100,
        nftPrice: 0,
        nftValidityStart: new Date("2025-04-06T00:00:00+08:00"),
        nftValidityEnd: new Date("2025-04-07T00:00:00+08:00"),
        nftUsageRules: "This NFT serves as your digital proof of attendance and grants access to exclusive post-event content and future RPC events.",
        contractAddress: null,
        chainId: 1,
        tokenStandard: "ERC721",
        showInExplore: true
      }
    });
    
    console.log("Created RPC Club Party event successfully!");
    
    // 4. 创建活动分类和标签关联
    // 首先查找或创建分类
    const categories = [
      { name: "Social" },
      { name: "Web3" }
    ];
    
    for (const category of categories) {
      let existingCategory = await prisma.activityCategory.findFirst({
        where: { name: category.name }
      });
      
      if (!existingCategory) {
        existingCategory = await prisma.activityCategory.create({
          data: { name: category.name }
        });
        console.log(`Created category: ${category.name}`);
      }
      
      // 关联活动和分类
      await prisma.activity.update({
        where: { id: activity.id },
        data: {
          categories: {
            connect: { id: existingCategory.id }
          }
        }
      });
    }
    
    // 创建和关联标签
    const tags = [
      { name: "Networking" },
      { name: "Discussion" },
      { name: "Club Event" },
      { name: "Hong Kong" }
    ];
    
    for (const tag of tags) {
      let existingTag = await prisma.activityTag.findFirst({
        where: { name: tag.name }
      });
      
      if (!existingTag) {
        existingTag = await prisma.activityTag.create({
          data: { name: tag.name }
        });
        console.log(`Created tag: ${tag.name}`);
      }
      
      // 关联活动和标签
      await prisma.activity.update({
        where: { id: activity.id },
        data: {
          tags: {
            connect: { id: existingTag.id }
          }
        }
      });
    }
    
    console.log("Added categories and tags to the event");
    console.log("RPC Club Party event creation completed!");
    
  } catch (error) {
    console.error("Error creating RPC Club Party event:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
createRPCParty()
  .then(() => console.log("Script completed successfully"))
  .catch(error => console.error("Script failed:", error)); 