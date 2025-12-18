/**
 * Check Data Pack Images Script
 * 
 * This script checks if all data pack DataNFTs have corresponding images
 * 
 * Usage:
 * node scripts/checkDataPackImages.js
 */

require('dotenv').config();
const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');

// Category to image file mapping
const categoryImageMap = {
  'Automotive': '/data-pack/Automotive Data Pack.svg',
  'Baby & Kids': '/data-pack/Baby & Kids Data Pack.svg',
  'Beauty & Personal Care': '/data-pack/Beauty & Personal Care Data Pack.svg',
  'Books & Media': '/data-pack/Books & Media Data Pack.svg',
  'Electronics': '/data-pack/Electronics Data Pack.svg',
  'Fashion & Apparel': '/data-pack/Fashion & Apparel Data Pack.svg',
  'Health & Wellness': '/data-pack/Health & Wellness Data Pack.svg',
  'Home & Kitchen': '/data-pack/Home & Kitchen Data Pack.svg',
  'Other': '/data-pack/Other Data Pack.svg',
  'Sports & Outdoors': '/data-pack/Sports & Outdoors Data Pack.svg'
};

// Extract category from DataNFT
function extractCategory(dataNFT) {
  if (dataNFT.dataSource === 'upload' && dataNFT.dataRecords) {
    const dataRecords = typeof dataNFT.dataRecords === 'string' 
      ? JSON.parse(dataNFT.dataRecords) 
      : dataNFT.dataRecords;
    
    if (dataRecords && dataRecords.category) {
      return dataRecords.category;
    }
  }
  
  const name = dataNFT.name || '';
  for (const category of Object.keys(categoryImageMap)) {
    if (name.includes(category)) {
      return category;
    }
  }
  
  return null;
}

// Verify image file exists
function verifyImageFile(imagePath) {
  if (!imagePath) return false;
  
  const filePath = imagePath.startsWith('/') 
    ? path.join(process.cwd(), 'public', imagePath.substring(1))
    : path.join(process.cwd(), 'public', imagePath);
  
  return fs.existsSync(filePath);
}

// Main function
async function checkDataPackImages() {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔍 Data Pack Images Check');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // 1. Get all data pack DataNFTs
    console.log('📦 Fetching all data pack DataNFTs...');
    const dataNFTs = await prisma.dataNFT.findMany({
      where: {
        dataSource: 'upload'
      },
      select: {
        id: true,
        name: true,
        image: true,
        dataSource: true,
        dataRecords: true,
        isPublished: true
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    
    console.log(`✅ Found ${dataNFTs.length} data pack DataNFTs\n`);
    
    if (dataNFTs.length === 0) {
      console.log('ℹ️  No data packs found.\n');
      return;
    }
    
    // 2. Check each DataNFT
    console.log('🔍 Checking images...\n');
    
    const stats = {
      total: dataNFTs.length,
      hasImage: 0,
      missingImage: 0,
      invalidImage: 0,
      validImage: 0,
      byCategory: {},
      missing: [],
      invalid: []
    };
    
    for (const dataNFT of dataNFTs) {
      const category = extractCategory(dataNFT);
      const expectedImage = category ? categoryImageMap[category] || categoryImageMap['Other'] : categoryImageMap['Other'];
      
      if (!dataNFT.image) {
        stats.missingImage++;
        stats.missing.push({
          id: dataNFT.id,
          name: dataNFT.name,
          category: category || 'Unknown',
          expectedImage: expectedImage
        });
        console.log(`❌ Missing Image: ${dataNFT.name}`);
        console.log(`   Category: ${category || 'Unknown'}`);
        console.log(`   Expected: ${expectedImage}\n`);
      } else {
        stats.hasImage++;
        
        // Check if image file exists
        const fileExists = verifyImageFile(dataNFT.image);
        
        if (!fileExists) {
          stats.invalidImage++;
          stats.invalid.push({
            id: dataNFT.id,
            name: dataNFT.name,
            image: dataNFT.image,
            category: category || 'Unknown',
            expectedImage: expectedImage
          });
          console.log(`⚠️  Invalid Image Path: ${dataNFT.name}`);
          console.log(`   Current: ${dataNFT.image}`);
          console.log(`   Category: ${category || 'Unknown'}`);
          console.log(`   Expected: ${expectedImage}\n`);
        } else {
          stats.validImage++;
          
          // Check if image matches category
          if (dataNFT.image !== expectedImage) {
            console.log(`ℹ️  Image Mismatch: ${dataNFT.name}`);
            console.log(`   Current: ${dataNFT.image}`);
            console.log(`   Expected: ${expectedImage}`);
            console.log(`   Category: ${category || 'Unknown'}\n`);
          }
        }
        
        // Count by category
        if (category) {
          stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
        }
      }
    }
    
    // 3. Summary
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 Summary');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log(`Total DataNFTs: ${stats.total}`);
    console.log(`✅ Has Image: ${stats.hasImage}`);
    console.log(`   └─ Valid Image: ${stats.validImage}`);
    console.log(`   └─ Invalid Image Path: ${stats.invalidImage}`);
    console.log(`❌ Missing Image: ${stats.missingImage}\n`);
    
    if (Object.keys(stats.byCategory).length > 0) {
      console.log('📦 By Category:');
      Object.entries(stats.byCategory)
        .sort((a, b) => b[1] - a[1])
        .forEach(([category, count]) => {
          console.log(`   ${category}: ${count}`);
        });
      console.log('');
    }
    
    // 4. Missing images list
    if (stats.missing.length > 0) {
      console.log('❌ Missing Images:');
      stats.missing.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.name}`);
        console.log(`      Category: ${item.category}`);
        console.log(`      Expected: ${item.expectedImage}`);
      });
      console.log('');
    }
    
    // 5. Invalid images list
    if (stats.invalid.length > 0) {
      console.log('⚠️  Invalid Image Paths:');
      stats.invalid.forEach((item, index) => {
        console.log(`   ${index + 1}. ${item.name}`);
        console.log(`      Current: ${item.image}`);
        console.log(`      Expected: ${item.expectedImage}`);
      });
      console.log('');
    }
    
    // 6. Recommendation
    if (stats.missingImage > 0 || stats.invalidImage > 0) {
      console.log('💡 Recommendation:');
      console.log('   Run the update script to fix missing/invalid images:');
      console.log('   node scripts/updateDataPackImages.js\n');
    } else {
      console.log('✅ All data packs have valid images!\n');
    }
    
    // 7. Verify all image files exist
    console.log('🔍 Verifying image files...\n');
    const imageFiles = Object.values(categoryImageMap);
    let allFilesExist = true;
    
    for (const imagePath of imageFiles) {
      const exists = verifyImageFile(imagePath);
      if (exists) {
        console.log(`✅ ${imagePath}`);
      } else {
        console.error(`❌ ${imagePath} - File not found!`);
        allFilesExist = false;
      }
    }
    
    if (!allFilesExist) {
      console.log('\n⚠️  Warning: Some image files are missing!');
      console.log('   Make sure all SVG files are in: public/data-pack/\n');
    } else {
      console.log('\n✅ All image files exist!\n');
    }
    
  } catch (error) {
    console.error('\n❌ Error checking data pack images:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  checkDataPackImages()
    .then(() => {
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { checkDataPackImages };


