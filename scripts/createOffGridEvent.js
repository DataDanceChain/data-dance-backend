const prisma = require('../src/utils/prisma');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

async function createOffGridEvent() {
  try {
    console.log("Starting to create OFF GRID x RPC DAO event...");
    
    // 1. Find or create OFF GRID organization user
    let orgUser = await prisma.user.findFirst({
      where: { 
        email: "help@theacemeta.com",
        isOrganization: true
      }
    });
    
    if (!orgUser) {
      console.log("Creating OFF GRID organization user...");
      const hashedPassword = await bcrypt.hash("Org@123", 10);
      
      orgUser = await prisma.user.create({
        data: {
          email: "help@theacemeta.com",
          name: "OFF GRID",
          password: hashedPassword,
          isOrganization: true,
          description: "OFF GRID is a community-first entertainment movement, co-creating the future of music and artist IP through real-life experiences and Web3 technology.",
          logo: "/assets/logos/off-grid-logo.jpg",
          avatar: "/assets/logos/off-grid-logo.jpg",
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
          console.log(`Assigned USER role to OFF GRID`);
        }
      } catch (roleError) {
        console.error("Error assigning role to user:", roleError);
      }
      
      console.log("Created OFF GRID organization user");
    }
    
    // 2. Check if activity already exists
    const existingActivity = await prisma.activity.findFirst({
      where: { 
        title: "OFF GRID x RPC DAO: The Fanvestor Launch Gate"
      }
    });
    
    if (existingActivity) {
      console.log("OFF GRID event already exists, skipping...");
      return;
    }
    
    // 3. Create activity
    const activity = await prisma.activity.create({
      data: {
        id: "off-grid-fanvestor-launch",
        title: "OFF GRID x RPC DAO: The Fanvestor Launch Gate",
        description: `Step into the future of fan-powered entertainment. This limited session introduces OFF GRID Infinity and Jam Lab—where you're not just watching from the sidelines, you're helping build the journey.

🎯 What You'll Experience:
• Participate in artist growth decisions
• Brand activations
• Live-stage co-creation
• Earn points and unlock exclusive rewards
• Become a VIP in the ecosystem you help shape

🌟 Key Features:
• Limited to The Founding 100
• Direct involvement in artist development
• Exclusive access to OFF GRID's ecosystem
• Community-driven decision making

Join us in shaping the future of music and entertainment through real fan participation and Web3 innovation!

📍 Digital Event with Real-World Impact
Transform from passive listener to active co-creator in the music industry's next evolution.`,
        startDate: new Date("2025-04-06T00:00:00+08:00"),
        endDate: new Date("2025-04-06T23:59:00+08:00"),
        image: "/assets/nfts/off-grid-nft.jpg",
        creator: {
          connect: { id: orgUser.id }
        },
        type: "MEMBERSHIP",
        remaining: 100,
        total: 100,
        statusNote: "Limited to The Founding 100 members",
        equityTitle: "PARTICIPANT BENEFITS",
        equityDetails: [
          "VIP Priority for May Indie Band Show",
          "Early Voting Access for First Jam Lab Artist",
          "Genesis Co-Creator NFT (FREE)",
          "OFF GRID Merch Box Raffle Entry",
          "Fanvestment Engine Beta Invite",
          "Producer Tier upgrade opportunity"
        ],
        externalLinksTitle: "USEFUL LINKS",
        externalLinks: [
          {
            name: "OFF GRID Website",
            url: "https://offgrid.day"
          }
        ],
        nftName: "OFF GRID x RPC Genesis Co-Creator NFT",
        nftDescription: "A commemorative NFT for early co-creators of Jam Lab. Serves as your proof of participation and unlocks special privileges within the OFF GRID ecosystem.",
        nftImage: "/assets/nfts/off-grid-nft.jpg",
        nftTotalSupply: 100,
        nftPrice: 0,
        nftValidityStart: new Date("2025-04-06T00:00:00+08:00"),
        nftValidityEnd: new Date("2028-04-07T00:00:00+08:00"),
        nftUsageRules: "Grants access to future OFF GRID DAO voting rounds, exclusive merch drops, and VIP co-creation campaigns.",
        contractAddress: null,
        chainId: 1,
        tokenStandard: "ERC721",
        showInExplore: true
      }
    });
    
    console.log("Created OFF GRID event successfully!");
    
    // 4. Create and link categories and tags
    const categories = [
      { name: "Music" },
      { name: "Web3" },
      { name: "Entertainment" }
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
      { name: "Fan Co-creation" },
      { name: "Music Industry" },
      { name: "Artist Development" },
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
    console.log("OFF GRID event creation completed!");
    
  } catch (error) {
    console.error("Error creating OFF GRID event:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the script
createOffGridEvent()
  .then(() => console.log("Script completed successfully"))
  .catch(error => console.error("Script failed:", error)); 