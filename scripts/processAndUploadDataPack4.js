/**
 * Process and upload data-pack-4.csv to database
 * 
 * This script:
 * 1. Reads and categorizes data-pack-4.csv by product category and region
 * 2. Groups data by category-region combinations
 * 3. Creates DataNFTs for each group with dynamic pricing
 * 4. Uses provided copywriting templates for descriptions
 * 
 * Usage:
 * node scripts/processAndUploadDataPack4.js
 */

require('dotenv').config();
const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');
const { 
  categorizeByRegion, 
  categorizeByProductCategory 
} = require('./cleanAndCategorizeDataPack');

// CSV parsing function (from cleanAndCategorizeDataPack.js)
function parseCSV(content) {
  const lines = content.split('\n').filter(line => line.trim());
  if (lines.length === 0) return { headers: [], data: [] };
  
  const headers = parseCSVLine(lines[0]);
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === headers.length) {
      const record = {};
      headers.forEach((header, index) => {
        record[header.trim()] = values[index]?.trim() || '';
      });
      data.push(record);
    }
  }
  
  return { headers, data };
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

// Copywriting templates by category
const descriptionTemplates = {
  'Health & Wellness': (region, count) => 
    `Unlock high-quality, real-user insights with this authentic health & wellness dataset from the ${region} region.

Built to help teams enhance analytic accuracy, optimize targeting, and strengthen data-driven strategies, the dataset contains ${count.toLocaleString()} rigorously verified records.

Each entry includes detailed dimensions such as validated contact information, transaction history, demographic attributes, and other key user data.`,

  'Home & Kitchen': (region, count) => 
    `Access high-quality Home & Kitchen data from the ${region} region—perfect for marketers and sellers looking to scale with confidence.

This premium data pack includes ${count.toLocaleString()} fully verified records with contact information and transaction details, giving you actionable insights to reach real buyers faster.`,

  'Automotive': (region, count) => 
    `Leverage high-quality Automotive data from the ${region} region—ideal for businesses looking to target real buyers with precision.

This data pack includes ${count.toLocaleString()} fully verified records, complete with contact information and transaction details, giving you reliable insights to drive smarter outreach and conversions.`,

  'Books & Media': (region, count) => 
    `Connect with high-quality Books & Media data from the ${region} region—perfect for marketers and teams looking to engage verified, real users.

This data pack includes ${count.toLocaleString()} fully verified record, complete with contact information and transaction details, providing actionable insights for targeted outreach.`,

  'Beauty & Personal Care': (region, count) => 
    `Tap into high-quality Beauty & Personal Care data from the ${region} region—ideal for brands and marketers looking to connect with real, verified buyers.

This data pack includes ${count.toLocaleString()} fully verified records, complete with contact information and transaction details, providing actionable insights to drive smarter targeting and outreach.`,

  'Baby & Kids': (region, count) => 
    `Gain high-quality Baby & Kids data from the ${region} region—ideal for brands and marketers looking to reach verified, real buyers.

This data pack includes ${count.toLocaleString()} fully verified records, complete with contact information and transaction details, providing actionable insights for smarter targeting and data-driven strategies.`,

  'Other': (region, count) => 
    `Harness high-quality Other data from the ${region} region—perfect for teams seeking large-scale, verified buyer insights.

This data pack includes ${count.toLocaleString()} fully verified records, complete with contact information and transaction details, providing actionable insights for smarter targeting and data-driven strategies.`,

  'Electronics': (region, count) => 
    `Discover high-quality Electronics data from the ${region} region—ideal for teams aiming to reach real buyers with accuracy.

This data pack includes ${count.toLocaleString()} fully verified records, complete with contact information and transaction details, offering reliable insights for smarter targeting and decision-making.`,

  'Fashion & Apparel': (region, count) => 
    `Explore high-quality Fashion & Apparel data from the ${region} region—ideal for brands and teams seeking real, verified buyer insights.

This data pack includes ${count.toLocaleString()} fully verified records, complete with contact information and transaction details, empowering more accurate targeting and smarter decision-making.`,

  'Sports & Outdoors': (region, count) => 
    `Engage with high-quality Sports & Outdoors data from the ${region} region—perfect for marketers and teams looking to reach verified, real users.

This data pack includes ${count.toLocaleString()} fully verified record, complete with contact information and transaction details, providing actionable insights for targeted outreach.`
};

// Dynamic pricing function based on record count
function calculatePrice(recordCount) {
  // Base pricing tiers:
  // 0-100: $25-50
  // 101-500: $50-100
  // 501-1000: $100-200
  // 1001-5000: $200-400
  // 5001+: $400-800
  
  if (recordCount <= 100) {
    return 25 + Math.floor(Math.random() * 25); // $25-50
  } else if (recordCount <= 500) {
    return 50 + Math.floor(Math.random() * 50); // $50-100
  } else if (recordCount <= 1000) {
    return 100 + Math.floor(Math.random() * 100); // $100-200
  } else if (recordCount <= 5000) {
    return 200 + Math.floor(Math.random() * 200); // $200-400
  } else {
    return 400 + Math.floor(Math.random() * 400); // $400-800
  }
}

// Find or create DataDance Official organization
async function findOrCreateOrgUser() {
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
    
    console.log("✅ Created DataDance Official organization user\n");
  }
  
  return orgUser;
}

// Create DataNFT for a category-region group
async function createDataNFTForGroup(group, orgUser, csvFilePath) {
  const { region, category, records, headers } = group;
  
  // Find email field
  const emailField = headers.find(h => 
    h.toLowerCase().includes('email') || 
    h.toLowerCase().includes('邮箱') ||
    h.toLowerCase().includes('mail')
  );
  
  if (!emailField) {
    throw new Error('CSV must contain an email field');
  }
  
  // Filter valid records with email
  const validRecords = records.filter(record => 
    record[emailField] && record[emailField].trim()
  );
  
  if (validRecords.length === 0) {
    console.warn(`⚠️  Skipping ${category} - ${region}: No valid records with email`);
    return null;
  }
  
  // Generate name
  const name = `${category} Data Pack - ${region}`;
  
  // Generate description using template
  const template = descriptionTemplates[category] || descriptionTemplates['Other'];
  const description = template(region, validRecords.length);
  
  // Calculate dynamic price
  const price = calculatePrice(validRecords.length);
  
  // Build dataRecords JSON
  const dataRecords = {
    source: csvFilePath,
    fileName: path.basename(csvFilePath),
    importDate: new Date().toISOString(),
    recordCount: validRecords.length,
    totalRecords: records.length,
    headers: headers,
    emailField: emailField,
    region: region,
    category: category,
    records: validRecords.map((record, index) => ({
      recordId: index + 1,
      email: record[emailField],
      ...record
    }))
  };
  
  // Create DataNFT
  const dataNFT = await prisma.dataNFT.create({
    data: {
      name: name,
      description: description,
      price: price,
      image: '/assets/nfts/data-pack-default.jpg',
      merchantId: orgUser.id,
      dataSource: 'upload',
      dataRecords: dataRecords,
      isPublished: true,
      maxSales: 999999
    }
  });
  
  // Add "Data Pack" tag
  let dataPackTag = await prisma.tag.findFirst({
    where: { name: "Data Pack" }
  });
  
  if (!dataPackTag) {
    dataPackTag = await prisma.tag.create({
      data: { name: "Data Pack" }
    });
  }
  
  await prisma.dataNFT.update({
    where: { id: dataNFT.id },
    data: {
      tags: {
        connect: { id: dataPackTag.id }
      }
    }
  });
  
  // Add category tag if exists
  let categoryTag = await prisma.tag.findFirst({
    where: { name: category }
  });
  
  if (!categoryTag) {
    categoryTag = await prisma.tag.create({
      data: { name: category }
    });
  }
  
  await prisma.dataNFT.update({
    where: { id: dataNFT.id },
    data: {
      tags: {
        connect: { id: categoryTag.id }
      }
    }
  });
  
  return {
    dataNFT,
    recordCount: validRecords.length,
    price: price
  };
}

// Main processing function
async function processAndUploadDataPack4() {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 Data Pack 4 - Process & Upload');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const csvFilePath = path.join(__dirname, '../data-pack-4.csv');
    
    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }
    
    // 1. Find or create organization user
    const orgUser = await findOrCreateOrgUser();
    console.log(`Using merchant: ${orgUser.name} (${orgUser.email})\n`);
    
    // 2. Read and parse CSV
    console.log('📄 Reading CSV file...');
    const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
    const { headers, data } = parseCSV(csvContent);
    
    console.log(`✅ Parsed CSV: ${data.length} total records`);
    console.log(`📋 Headers: ${headers.join(', ')}\n`);
    
    // 3. Categorize data
    console.log('🔍 Categorizing data by region and category...');
    const categorized = [];
    
    for (const record of data) {
      const email = record['buyer-email'] || record['邮箱'] || record['email'] || '';
      if (!email) continue;
      
      const regionInfo = categorizeByRegion(record);
      const category = categorizeByProductCategory(record);
      
      categorized.push({
        record,
        region: regionInfo.region || 'Other',
        category: category || 'Other'
      });
    }
    
    console.log(`✅ Categorized ${categorized.length} records\n`);
    
    // 4. Group by category-region
    console.log('📊 Grouping data by category and region...');
    const groups = {};
    
    for (const item of categorized) {
      const key = `${item.category}-${item.region}`;
      if (!groups[key]) {
        groups[key] = {
          category: item.category,
          region: item.region,
          records: [],
          headers: headers
        };
      }
      groups[key].records.push(item.record);
    }
    
    const groupKeys = Object.keys(groups);
    console.log(`✅ Created ${groupKeys.length} groups:\n`);
    
    // Display statistics
    for (const key of groupKeys) {
      const group = groups[key];
      console.log(`  ${group.category} - ${group.region}: ${group.records.length} records`);
    }
    console.log('');
    
    // 5. Create DataNFTs for each group
    console.log('🎨 Creating DataNFTs...\n');
    const results = [];
    
    for (const key of groupKeys) {
      const group = groups[key];
      try {
        const result = await createDataNFTForGroup(group, orgUser, csvFilePath);
        if (result) {
          results.push(result);
          console.log(`✅ Created: ${result.dataNFT.name}`);
          console.log(`   Records: ${result.recordCount}, Price: $${result.price}\n`);
        }
      } catch (error) {
        console.error(`❌ Error creating DataNFT for ${key}:`, error.message);
      }
    }
    
    // 6. Summary
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ SUCCESS - Data Pack 4 Processed!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log(`📊 Summary:`);
    console.log(`   Total Groups: ${groupKeys.length}`);
    console.log(`   DataNFTs Created: ${results.length}`);
    console.log(`   Total Records: ${results.reduce((sum, r) => sum + r.recordCount, 0)}`);
    console.log(`   Total Value: $${results.reduce((sum, r) => sum + r.price, 0)}`);
    console.log(`   Average Price: $${Math.round(results.reduce((sum, r) => sum + r.price, 0) / results.length)}`);
    
    console.log('\n📦 Created DataNFTs:');
    results.forEach((result, index) => {
      console.log(`   ${index + 1}. ${result.dataNFT.name}`);
      console.log(`      Records: ${result.recordCount}, Price: $${result.price}`);
    });
    
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    return results;
    
  } catch (error) {
    console.error('\n❌ Error processing data pack 4:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  processAndUploadDataPack4()
    .then(() => {
      console.log('✅ Script completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { processAndUploadDataPack4 };
