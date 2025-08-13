const prisma = require('../src/utils/prisma');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

async function createDataAssetsForumEvent() {
  try {
    console.log("Starting to create Data Assets Forum 2025 event...");
    
    // 1. Find or create DataDance Official organization user
    let orgUser = await prisma.user.findFirst({
      where: { 
        email: "official@datadance.io",
        isOrganization: true
      }
    });
    
    if (!orgUser) {
      console.log("Creating DataDance Official organization user...");
      const hashedPassword = await bcrypt.hash("Org@123", 10);
      
      orgUser = await prisma.user.create({
        data: {
          email: "official@datadance.io",
          name: "DataDance Official",
          password: hashedPassword,
          isOrganization: true,
          description: "DataDance is a leading platform for data assetization and Web3 marketing, empowering businesses and individuals to unlock the value of their data through blockchain technology.",
          logo: "/assets/logos/datadance-logo.jpg",
          avatar: "/assets/logos/datadance-logo.jpg",
          referralCode: generateReferralCode()
        }
      });
      
      // Create user role association
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
          console.log(`Assigned USER role to DataDance Official`);
        }
      } catch (roleError) {
        console.error("Error assigning role to user:", roleError);
      }
      
      console.log("Created DataDance Official organization user");
    }
    
    // 2. Check if activity already exists
    const existingActivity = await prisma.activity.findFirst({
      where: { 
        title: "Data Assets Forum 2025: The Future of Data Marketing & Assetization"
      }
    });
    
    if (existingActivity) {
      console.log("Data Assets Forum 2025 event already exists, skipping...");
      return;
    }
    
    // 3. Create activity
    const activity = await prisma.activity.create({
      data: {
        id: "data-assets-forum-2025",
        title: "Data Assets Forum 2025: The Future of Data Marketing & Assetization",
        description: `Join us for the premier event exploring the intersection of data marketing, Web3 technology, and assetization in the digital economy.

🎯 Event Highlights:
• Expert panel discussions on Web2 & Web3 data marketing
• Deep dive into centralized vs decentralized AI data assets
• Exclusive dialogue with industry leaders
• Critical analysis of RWA and stablecoin trends
• Interactive Q&A sessions with community perspectives

📅 Agenda:
• 13:00-13:30: Guest Registration & Welcome Tea Break & Warm-up Lucky Draw
• 13:30-13:50: Opening Remarks
• 13:50-14:30: Panel Discussion 1: Web2 & Web3 Data Marketing: From Compliance to Assetization
• 14:30-15:10: Panel Discussion 2: Centralized AI vs Decentralized AI Data Assets: Data as Capital vs Model as Moat?
• 15:10-16:00: Dialogue with Gao Xiaosong: Data Giants in the Entertainment Industry
• 16:00-16:40: Panel Discussion 3: On-Chain ≠ On-Value: Critical Reflections Amid the RWA and Stablecoin Boom
• 16:40-17:00: Open Mic: Free Q&A and Community Perspectives
• 17:00-17:30: Pilot Program Launch & Group Photo & Event Lucky Draw

🌟 Key Topics:
• Data compliance and assetization strategies
• AI data asset management and monetization
• Entertainment industry data giants
• RWA and stablecoin market analysis
• Community-driven data economy

📍 Location: JZ Club, No. 8 Hengshan Road, Shanghai, China
📅 Date: August 16, 2025 (Afternoon)
🎫 Limited to 500 exclusive participants
🎁 Free NFT available for claim until August 17, 2025

Transform your understanding of data assets and join the future of Web3 marketing!`,
        startDate: new Date("2025-08-16T13:00:00+08:00"),
        endDate: new Date("2025-08-16T17:30:00+08:00"),
        image: "/assets/banners/data-assets-forum-2025.png",
        creator: {
          connect: { id: orgUser.id }
        },
        type: "FORUM",
        remaining: 500,
        total: 500,
        statusNote: "Limited to 500 exclusive participants",
        equityTitle: "PARTICIPANT BENEFITS",
        equityDetails: [
          "Exclusive Data Assets Forum 2025 NFT (FREE)",
          "Priority access to future DataDance events",
          "Networking opportunities with industry leaders",
          "Exclusive content and research materials",
          "Community membership benefits",
          "Early access to DataDance platform features"
        ],
        externalLinksTitle: "USEFUL LINKS",
        externalLinks: [
          {
            name: "DataDance Platform",
            url: "https://datadance.io"
          },
          {
            name: "Event Registration",
            url: "https://datadance.io/events/data-assets-forum-2025"
          }
        ],
        nftName: "Data Assets Forum 2025 Participant NFT",
        nftDescription: "A commemorative NFT for the Data Assets Forum 2025. This NFT can be claimed before the event (until August 17, 2025) and serves as proof of participation, granting access to exclusive DataDance community benefits and future events.",
        nftImage: "/assets/nfts/data-assets-forum-2025.jpg",
        nftTotalSupply: 500,
        nftPrice: 0,
        nftValidityStart: new Date("2025-01-01T00:00:00+08:00"),
        nftValidityEnd: new Date("2025-08-17T23:59:00+08:00"),
        nftUsageRules: "Grants access to DataDance community benefits, exclusive content, and priority registration for future events. NFT holders receive special privileges within the DataDance ecosystem.",
        contractAddress: null,
        chainId: 1,
        tokenStandard: "ERC721",
        showInExplore: true
      }
    });
    
    console.log("Created Data Assets Forum 2025 event successfully!");
    
    // 4. Create and link categories and tags
    const categories = [
      { name: "Web3" },
      { name: "Data" },
      { name: "Marketing" },
      { name: "Forum" }
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
      
      await prisma.activity.update({
        where: { id: activity.id },
        data: {
          categories: {
            connect: { id: existingCategory.id }
          }
        }
      });
    }
    
    const tags = [
      { name: "Data Assets" },
      { name: "Web3 Marketing" },
      { name: "AI" },
      { name: "RWA" },
      { name: "Stablecoins" },
      { name: "Entertainment" },
      { name: "Community" }
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
    console.log("Data Assets Forum 2025 event creation completed!");
    
  } catch (error) {
    console.error("Error creating Data Assets Forum 2025 event:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
createDataAssetsForumEvent()
  .then(() => console.log("Script completed successfully"))
  .catch(error => console.error("Script failed:", error)); 