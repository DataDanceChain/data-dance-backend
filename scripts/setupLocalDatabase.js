/**
 * Setup script to configure and test local database connection
 * 
 * This script helps configure the DATABASE_URL for the local datadance-postgres container
 * and tests the connection.
 * 
 * Usage:
 * node scripts/setupLocalDatabase.js
 */

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

async function testDatabaseConnection() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🔌 Testing Database Connection');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL is not set in .env file');
    console.log('\n📝 Please add the following to your .env file:');
    console.log('DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"');
    process.exit(1);
  }
  
  console.log(`📋 Current DATABASE_URL: ${databaseUrl.replace(/:[^:@]+@/, ':****@')}`);
  console.log('');
  
  const prisma = new PrismaClient();
  
  try {
    // Test connection
    await prisma.$connect();
    console.log('✅ Database connection successful!\n');
    
    // Get database info
    const result = await prisma.$queryRaw`SELECT version()`;
    console.log('📊 Database Info:');
    console.log(`   ${result[0].version}\n`);
    
    // Test a simple query
    const userCount = await prisma.user.count();
    console.log(`📈 Current database state:`);
    console.log(`   Users: ${userCount}`);
    
    const dataNFTCount = await prisma.dataNFT.count();
    console.log(`   DataNFTs: ${dataNFTCount}`);
    
    const merchantCount = await prisma.user.count({
      where: { isOrganization: true }
    });
    console.log(`   Merchants: ${merchantCount}\n`);
    
    console.log('✅ Database is ready to use!\n');
    
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
    console.log('\n💡 Troubleshooting:');
    console.log('   1. Make sure the datadance-postgres container is running in Docker Desktop');
    console.log('   2. Check that the DATABASE_URL in .env matches:');
    console.log('      DATABASE_URL="postgresql://postgres:postgres@localhost:5432/datadance?schema=public"');
    console.log('   3. Verify the database name is "datadance" (not "test_datadance")');
    console.log('   4. Run database migrations: npm run prisma:migrate\n');
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  testDatabaseConnection()
    .then(() => {
      process.exit(0);
    })
    .catch(error => {
      console.error('Error:', error);
      process.exit(1);
    });
}

module.exports = { testDatabaseConnection };


