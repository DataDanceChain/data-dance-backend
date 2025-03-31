const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function ensureOrganizationExists() {
  const organizerName = "RPC DAO";
  const orgEmail = "rpc-dao@organization.com";
  
  let orgUser = await prisma.user.findFirst({
    where: { 
      email: orgEmail,
      isOrganization: true
    }
  });
  
  if (!orgUser) {
    console.log(`Creating organization user: ${organizerName}`);
    const hashedPassword = await bcrypt.hash("Org@123", 10);
    
    // 创建组织用户
    orgUser = await prisma.user.create({
      data: {
        email: orgEmail,
        name: organizerName,
        password: hashedPassword,
        isOrganization: true,
        description: "Ready Player Club DAO - A Web3 Community",
        logo: "/assets/logos/rpc-dao.png",
        avatar: "/assets/logos/rpc-dao.png"
      }
    });
    
    // 分配 USER 角色
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
        console.log(`Assigned USER role to organization: ${orgUser.email}`);
      }
    } catch (roleError) {
      console.error("Error assigning role to organization:", roleError);
    }
    
    console.log(`Created organization user: ${organizerName}`);
  }
  
  return orgUser;
}

async function createRPCParty() {
  try {
    console.log('开始创建 RPC Club Party 活动...');

    // 确保组织存在
    const orgUser = await ensureOrganizationExists();

    const event = await prisma.activity.create({
      data: {
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
        
        image: "/assets/nfts/rpc-party.png",
        startDate: new Date("2025-04-06T18:00:00+08:00"),
        endDate: new Date("2025-04-06T22:00:00+08:00"),
        type: "SOCIAL",
        location: "Hong Kong",
        totalSpots: 100,
        remainingSpots: 100,
        price: 0,
        status: "UPCOMING",
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

        categories: {
          connect: [
            { name: "Social" },
            { name: "Web3" }
          ]
        },

        tags: {
          connect: [
            { name: "Networking" },
            { name: "Discussion" },
            { name: "Club Event" }
          ]
        },

        creator: {
          connect: {
            id: orgUser.id
          }
        },

        requirements: [
          "Club membership or invitation",
          "Web3 enthusiasm and knowledge",
          "Positive contribution to community"
        ],

        additionalInfo: {
          create: {
            dress_code: "Smart Casual",
            language: "English",
            food_and_beverage: "Provided",
            special_notes: "Members can bring one guest with prior approval"
          }
        }
      }
    });

    console.log('活动创建成功:', event);

  } catch (error) {
    console.error('创建活动失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createRPCParty(); 