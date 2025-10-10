const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');
const prisma = new PrismaClient();

async function createOrganizationUsers() {
  try {
    console.log('Starting to create organization users...');

    // Define organization data
    const organizations = [
      {
        email: 'org1@example.com',
        name: 'Organization One',
        description: 'This is the first test organization',
        logo: '/assets/logos/org1-logo.png',
        password: 'Org1@123'
      },
      {
        email: 'org2@example.com',
        name: 'Organization Two',
        description: 'This is the second test organization',
        logo: '/assets/logos/org2-logo.png',
        password: 'Org2@123'
      },
      {
        email: 'org3@example.com',
        name: 'Organization Three',
        description: 'This is the third test organization',
        logo: '/assets/logos/org3-logo.png',
        password: 'Org3@123'
      }
    ];

    // Check database connection
    try {
      await prisma.$connect();
      console.log('Database connection successful');
    } catch (error) {
      console.error('Database connection failed:', error);
      throw new Error('Cannot connect to database. Please make sure your database is running.');
    }

    // Create organization users
    for (const org of organizations) {
      // Check if organization exists
      const existingOrg = await prisma.user.findFirst({
        where: { 
          email: org.email,
          isOrganization: true
        }
      });

      if (existingOrg) {
        console.log(`Organization ${org.name} already exists, skipping...`);
        continue;
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(org.password, 10);

      // Create organization user
      const orgUser = await prisma.user.create({
        data: {
          email: org.email,
          name: org.name,
          password: hashedPassword,
          isOrganization: true,
          description: org.description,
          logo: org.logo,
          avatar: org.logo,
          userType: 'organization',
          authType: 'traditional',
          referralCode: generateReferralCode(),
          profile: {
            create: {
              language: 'en'
            }
          }
        }
      });

      // Create user role association
      try {
        // Find USER role
        const userRole = await prisma.role.findFirst({
          where: { name: "USER" }
        });

        if (userRole) {
          // Create user role association
          await prisma.userRole.create({
            data: {
              user: { connect: { id: orgUser.id } },
              role: { connect: { id: userRole.id } }
            }
          });
          console.log(`Assigned USER role to ${org.name}`);
        } else {
          console.log("Warning: USER role not found");
        }
      } catch (roleError) {
        console.error("Error assigning role:", roleError);
      }

      console.log(`Successfully created organization user: ${org.name}`);
      console.log('Login Information:');
      console.log(`Email: ${org.email}`);
      console.log(`Password: ${org.password}`);
      console.log('------------------------');
    }

    console.log('Organization users creation completed');

  } catch (error) {
    console.error('Error creating organization users:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Execute script
createOrganizationUsers()
  .then(() => console.log('Script execution completed'))
  .catch(error => console.error('Script execution failed:', error)); 