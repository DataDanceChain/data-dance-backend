/**
 * Update Data Pack Images Script
 * 
 * This script:
 * 1. Finds all DataNFTs with dataSource='upload' (data packs)
 * 2. Checks if they have default or missing images
 * 3. Matches category from dataRecords to corresponding SVG image
 * 4. Updates the image field with the correct SVG path
 * 
 * Usage:
 * node scripts/updateDataPackImages.js
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

// Default image paths that should be replaced
const defaultImages = [
  '/assets/nfts/data-pack-default.jpg',
  '/assets/nfts/data-pack-default.png',
  null,
  undefined,
  ''
];

// Extract category from DataNFT
function extractCategory(dataNFT) {
  // Try to get category from dataRecords (primary method)
  if (dataNFT.dataSource === 'upload' && dataNFT.dataRecords) {
    const dataRecords = typeof dataNFT.dataRecords === 'string' 
      ? JSON.parse(dataNFT.dataRecords) 
      : dataNFT.dataRecords;
    
    if (dataRecords && dataRecords.category) {
      return dataRecords.category;
    }
  }
  
  // Try to extract from name (fallback method)
  const name = dataNFT.name || '';
  
  // Check for exact category matches in name
  for (const category of Object.keys(categoryImageMap)) {
    // Match patterns like "Category Data Pack" or "Category - Region"
    if (name.includes(category)) {
      return category;
    }
  }
  
  // Try partial matches for common patterns
  const nameLower = name.toLowerCase();
  if (nameLower.includes('automotive') || nameLower.includes('car') || nameLower.includes('vehicle')) {
    return 'Automotive';
  }
  if (nameLower.includes('baby') || nameLower.includes('kids') || nameLower.includes('infant')) {
    return 'Baby & Kids';
  }
  if (nameLower.includes('beauty') || nameLower.includes('cosmetic') || nameLower.includes('makeup')) {
    return 'Beauty & Personal Care';
  }
  if (nameLower.includes('book') || nameLower.includes('media')) {
    return 'Books & Media';
  }
  if (nameLower.includes('electronic') || nameLower.includes('tech')) {
    return 'Electronics';
  }
  if (nameLower.includes('fashion') || nameLower.includes('apparel') || nameLower.includes('clothing')) {
    return 'Fashion & Apparel';
  }
  if (nameLower.includes('health') || nameLower.includes('wellness')) {
    return 'Health & Wellness';
  }
  if (nameLower.includes('home') || nameLower.includes('kitchen')) {
    return 'Home & Kitchen';
  }
  if (nameLower.includes('sport') || nameLower.includes('outdoor')) {
    return 'Sports & Outdoors';
  }
  
  return null;
}

// Check if image needs to be updated
function needsImageUpdate(image) {
  if (!image) return true;
  return defaultImages.includes(image);
}

// Get image path for category
function getImagePathForCategory(category) {
  if (!category) return null;
  return categoryImageMap[category] || categoryImageMap['Other'];
}

// Verify image file exists
function verifyImageFile(imagePath) {
  if (!imagePath) return false;
  
  // Remove leading slash for file system check
  const filePath = imagePath.startsWith('/') 
    ? path.join(process.cwd(), 'public', imagePath.substring(1))
    : path.join(process.cwd(), 'public', imagePath);
  
  return fs.existsSync(filePath);
}

// Main function
async function updateDataPackImages() {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🖼️  Data Pack Image Updater');
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
        dataRecords: true
      }
    });
    
    console.log(`✅ Found ${dataNFTs.length} data pack DataNFTs\n`);
    
    if (dataNFTs.length === 0) {
      console.log('ℹ️  No data packs found. Nothing to update.\n');
      return;
    }
    
    // 2. Process each DataNFT
    console.log('🔍 Processing DataNFTs...\n');
    
    const stats = {
      total: dataNFTs.length,
      needsUpdate: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      byCategory: {}
    };
    
    for (const dataNFT of dataNFTs) {
      try {
        // Check if image needs update
        if (!needsImageUpdate(dataNFT.image)) {
          stats.skipped++;
          continue;
        }
        
        stats.needsUpdate++;
        
        // Extract category
        const category = extractCategory(dataNFT);
        
        if (!category) {
          console.warn(`⚠️  ${dataNFT.name} (${dataNFT.id}): No category found, using 'Other'`);
          stats.byCategory['Other'] = (stats.byCategory['Other'] || 0) + 1;
        } else {
          stats.byCategory[category] = (stats.byCategory[category] || 0) + 1;
        }
        
        // Get image path
        const imagePath = getImagePathForCategory(category || 'Other');
        
        if (!imagePath) {
          console.error(`❌ ${dataNFT.name}: No image path found for category '${category}'`);
          stats.errors++;
          continue;
        }
        
        // Verify file exists
        if (!verifyImageFile(imagePath)) {
          console.warn(`⚠️  ${dataNFT.name}: Image file not found: ${imagePath}`);
          // Continue anyway - the path might be correct for web access
        }
        
        // Update DataNFT
        await prisma.dataNFT.update({
          where: { id: dataNFT.id },
          data: { image: imagePath }
        });
        
        console.log(`✅ Updated: ${dataNFT.name}`);
        console.log(`   Category: ${category || 'Other'}`);
        console.log(`   Image: ${imagePath}\n`);
        
        stats.updated++;
        
      } catch (error) {
        console.error(`❌ Error updating ${dataNFT.name} (${dataNFT.id}):`, error.message);
        stats.errors++;
      }
    }
    
    // 3. Summary
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ Update Complete!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log('📊 Statistics:');
    console.log(`   Total DataNFTs: ${stats.total}`);
    console.log(`   Needed Update: ${stats.needsUpdate}`);
    console.log(`   Successfully Updated: ${stats.updated}`);
    console.log(`   Skipped (already has image): ${stats.skipped}`);
    console.log(`   Errors: ${stats.errors}\n`);
    
    if (Object.keys(stats.byCategory).length > 0) {
      console.log('📦 Updates by Category:');
      Object.entries(stats.byCategory)
        .sort((a, b) => b[1] - a[1])
        .forEach(([category, count]) => {
          console.log(`   ${category}: ${count}`);
        });
      console.log('');
    }
    
    // 4. Verify image files exist
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
      console.log('\n✅ All image files verified!\n');
    }
    
  } catch (error) {
    console.error('\n❌ Error updating data pack images:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// Run if called directly
if (require.main === module) {
  updateDataPackImages()
    .then(() => {
      console.log('✅ Script completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Script failed:', error);
      process.exit(1);
    });
}

module.exports = { updateDataPackImages };

