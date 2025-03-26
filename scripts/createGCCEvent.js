const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

/**
 * 创建 GCC X Ethpanda X DDC 活动
 */
async function createGCCEvent() {
  try {
    console.log("Starting to create GCC X Ethpanda X DDC event...");
    
    // 1. 查找或创建 DataDance Official 组织用户
    let orgUser = await prisma.user.findFirst({
      where: { 
        email: "official@datadance.co",
        isOrganization: true
      }
    });
    
    if (!orgUser) {
      console.log("Creating DataDance Official organization user...");
      const hashedPassword = await bcrypt.hash("DataDance@2024", 10);
      
      // 创建组织用户
      orgUser = await prisma.user.create({
        data: {
          email: "official@datadance.co",
          name: "DataDance Official",
          password: hashedPassword,
          isOrganization: true,
          description: "Official organization for DataDance platform",
          logo: "/assets/logos/datadance-logo.png",
          avatar: "/assets/logos/datadance-logo.png"
        }
      });
      
      // 创建用户角色关联
      try {
        // 查找 ORGANIZATION_ADMIN 角色
        const adminRole = await prisma.role.findFirst({
          where: { name: "ORGANIZATION_ADMIN" }
        });
        
        if (adminRole) {
          // 创建用户角色关联
          await prisma.userRole.create({
            data: {
              user: { connect: { id: orgUser.id } },
              role: { connect: { id: adminRole.id } }
            }
          });
          console.log(`Assigned ORGANIZATION_ADMIN role to DataDance Official`);
        } else {
          console.log("Warning: ORGANIZATION_ADMIN role not found");
        }
      } catch (roleError) {
        console.error("Error assigning role to user:", roleError);
      }
      
      console.log("Created DataDance Official organization user");
    }
    
    // 2. 检查活动是否已存在
    const existingActivity = await prisma.activity.findFirst({
      where: { 
        title: "GCC X Ethpanda X DDC - Ethereum Maxi Reunion"
      }
    });
    
    if (existingActivity) {
      console.log("GCC X Ethpanda X DDC event already exists, skipping...");
      return;
    }
    
    // 3. 创建活动
    const activity = await prisma.activity.create({
      data: {
        id: "gcc-ethpanda-ddc-2024",
        title: "GCC X Ethpanda X DDC - Ethereum Maxi Reunion",
        description: `Join us for an exclusive Ethereum Maxi Reunion in Hong Kong, featuring Vitalik Buterin and key figures from the Ethereum ecosystem.

Event Details:
Date: April 6, 2024
Venue: BackStage Club, Jardine House (a hardcore stand-up theater in HK)
Theme: Ethereum Maxi Reunion (以太坊挽歌唱诗班 闭门交流会)

Co-organizers:
Wu Shuo / SNZ / Nethermind / Hash Global / Hetu / Mask

Agenda:
7:00-7:15 PM: Vitalik Buterin Opening Speech
7:15-10:00 PM: Discussion Sessions
- Media Session: Discussing foundation narratives with founders from Wu Shuo, DeepWave, Planet Daily, ChainNews, and Ethereum ecosystem KOLs
- Developer Session: Featuring Openbuild, Hackquest founder, Nethermind Core members discussing technical upgrades
- Project Session: With project founders exploring Consumer Apps, ZK alignment, mass adoption, Layer 2 ecosystem, Deep funding, and AI
10:00-10:30 PM: Performance with Meet 48 & Stand-up Comedy (organized by Hash Global/Cat Club)
10:30-10:40 PM: Closing speech by MC/Vitalik

Exclusive Swag:
Milady stickers, Ethereum stickers, Ethpanda stickers, GCC stickers, DDC Swag, Cat Club toys`,
        startDate: new Date("2024-04-06T19:00:00+08:00"),
        endDate: new Date("2024-04-06T22:40:00+08:00"),
        image: "/assets/nfts/gcc-ethpanda-ddc.png",
        creator: {
          connect: { id: orgUser.id }
        },
        type: "MEMBERSHIP",
        remaining: 100,
        total: 100,
        statusNote: "Limited to 100 attendees, by invitation only",
        equityTitle: "BENEFITS",
        equityDetails: [
          "Exclusive access to Vitalik Buterin's speech",
          "Participate in closed-door discussions with Ethereum ecosystem leaders",
          "Networking opportunities with key industry figures",
          "Limited edition event swag and collectibles",
          "Complimentary food and beverages"
        ],
        externalLinksTitle: "EXTERNAL LINKS",
        externalLinks: JSON.stringify([
          {
            name: "GCC Official Website",
            url: "https://gcc.io"
          },
          {
            name: "Ethpanda Official Website",
            url: "https://ethpanda.org"
          }
        ]),
        nftName: "GCC X Ethpanda X DDC - Ethereum Maxi Reunion NFT",
        nftDescription: "Exclusive NFT for attendees of the Ethereum Maxi Reunion in Hong Kong, featuring Vitalik Buterin",
        nftImage: "/assets/nfts/gcc-ethpanda-ddc.jpg",
        nftTotalSupply: 100,
        nftPrice: 0,
        nftValidityStart: new Date("2024-04-06T00:00:00+08:00"),
        nftValidityEnd: new Date("2024-04-07T00:00:00+08:00"),
        nftUsageRules: "This NFT serves as your digital ticket and proof of attendance. It grants access to event recordings and future community events.",
        contractAddress: null,
        chainId: 1,
        tokenStandard: "ERC721",
        showInExplore: true
      }
    });
    
    console.log("Created GCC X Ethpanda X DDC event successfully!");
    
    // 4. 创建活动分类和标签关联
    // 首先查找或创建分类
    const categories = [
      { name: "Conference" },
      { name: "Ethereum" },
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
      { name: "Vitalik" },
      { name: "Hong Kong" },
      { name: "Exclusive" },
      { name: "Limited" }
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
    console.log("GCC X Ethpanda X DDC event creation completed!");
    
  } catch (error) {
    console.error("Error creating GCC X Ethpanda X DDC event:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
createGCCEvent()
  .then(() => console.log("Script completed successfully"))
  .catch(error => console.error("Script failed:", error)); 