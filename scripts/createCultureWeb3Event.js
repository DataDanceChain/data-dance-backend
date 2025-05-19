const prisma = require('../src/utils/prisma');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

/**
 * 创建文化娱乐和Web3香港闭门交流会活动
 */
async function createCultureWeb3Event() {
  try {
    console.log("Starting to create Culture & Web3 Hong Kong Forum event...");
    
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
          avatar: "/assets/logos/datadance-logo.png",
          referralCode: generateReferralCode()
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
        title: "Culture & Entertainment x Web3 Hong Kong Forum"
      }
    });
    
    if (existingActivity) {
      console.log("Culture & Web3 event already exists, skipping...");
      return;
    }
    
    // 3. 创建活动
    const activity = await prisma.activity.create({
      data: {
        id: "culture-web3-forum-2025",
        title: "Culture & Entertainment x Web3 Hong Kong Forum",
        description: `Invitation to Culture & Entertainment x Web3 Hong Kong Closed-Door Forum

Event Details:
Date: April 6, 2025
Time: 1:30 PM - 5:30 PM
Venue: Rosewood Hong Kong

Agenda:

I. Building Fan Systems in Web3: From Selling Traffic to Selling Content
- Web3 vs Web2 Fan Systems, Upgrading Onlyfans | KK, Founder of Hash Global
- Building Sports Fan Communities | Xue Dong, CEO of Sports & Entertainment Radar
- Helping Japanese Creators Build Global Fan Systems | Jerry, Founder of Loverose

Web3 Community Operation Management Tools:
- Global Reach with Web3+Web2 | Victor, Founder of SmartTokenLabs
- Information Management and Group Operations | Wei, Founder of Adot
- KOL Community Operations and Monetization | Jason, Founder of BitX
- Merchandise Sales | Zhiqing, Founder of Bitgoods
- On-chain Data Asset Management and Monetization | Geoffrey, Founder of DDC
- Web3 Community Media Freedom Matrix | Yuxin

Panel Discussion: How to Achieve Community Growth with Web2 and Web3 Tools
- Moderator: KK, Hash Global
- Panelists: Jerry (Loverose), Clement (Mobvista), Geoffrey (DDC), Han (Singularity)

II. Co-creation and Sharing of IP in Web3
- Building Indie Bands and Jam Lab with Fans | Ellen, Co-founder of Acemeta
- Web3 for Film and TV Content | Zhang Ming, Co-founder of Just Right
- Music Industry: Space Music (TBC) / Fiction: China Literature Group (TBC)
- Building Copyright Exchanges with Web3 Technology | Geoffrey/Gao Yuan, Unique Art

III. Fan Economy in Web3 - Better Value Distribution
- Idol Asset Issuance and Fan Economy System | Gordon, Co-founder of Meet48
- Cultural and Entertainment Web3 Economic Ecosystem Map | Jensen, Partner at Hash Global`,
        startDate: new Date("2025-04-06T13:30:00+08:00"),
        endDate: new Date("2025-04-06T17:30:00+08:00"),
        image: "/assets/nfts/culture-web3-forum.jpg",
        creator: {
          connect: { id: orgUser.id }
        },
        type: "MEMBERSHIP",
        remaining: 80,
        total: 80,
        statusNote: "Limited to 80 attendees, by invitation only",
        equityTitle: "BENEFITS",
        equityDetails: [
          "Exclusive access to industry leaders in Culture, Entertainment and Web3",
          "Networking opportunities with founders and executives",
          "Insights into the latest Web3 fan economy strategies",
          "Complimentary refreshments and forum materials",
          "Digital certificate of attendance"
        ],
        externalLinksTitle: "EXTERNAL LINKS",
        externalLinks: JSON.stringify([
          {
            name: "Hash Global",
            url: "https://hashglobal.io"
          },
          {
            name: "DataDance Collective",
            url: "https://datadance.co"
          }
        ]),
        nftName: "Culture & Web3 Forum 2025 - Attendance NFT",
        nftDescription: "Exclusive NFT for attendees of the Culture & Entertainment x Web3 Hong Kong Forum, featuring insights on fan economy and Web3 integration",
        nftImage: "/assets/nfts/culture-web3-forum.jpg",
        nftTotalSupply: 80,
        nftPrice: 0,
        nftValidityStart: new Date("2025-04-06T00:00:00+08:00"),
        nftValidityEnd: new Date("2025-04-07T00:00:00+08:00"),
        nftUsageRules: "This NFT serves as your digital proof of attendance and grants access to exclusive post-event content and future related events.",
        contractAddress: null,
        chainId: 1,
        tokenStandard: "ERC721",
        showInExplore: true
      }
    });
    
    console.log("Created Culture & Web3 Forum event successfully!");
    
    // 4. 创建活动分类和标签关联
    // 首先查找或创建分类
    const categories = [
      { name: "Forum" },
      { name: "Entertainment" },
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
      { name: "Fan Economy" },
      { name: "Hong Kong" },
      { name: "IP" },
      { name: "Entertainment" }
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
    console.log("Culture & Web3 Forum event creation completed!");
    
  } catch (error) {
    console.error("Error creating Culture & Web3 Forum event:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行脚本
createCultureWeb3Event()
  .then(() => console.log("Script completed successfully"))
  .catch(error => console.error("Script failed:", error)); 