/**
 * 分析 data-pack-4.csv 的统计信息
 * 
 * 功能：
 * 1. 统计总数据条数
 * 2. 按分类统计数据量
 * 3. 按地区统计数据量
 * 4. 统计分类-地区组合数量
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { 
  categorizeByRegion, 
  categorizeByProductCategory 
} = require('./cleanAndCategorizeDataPack');

// CSV 解析函数
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

async function analyzeDataPack4() {
  try {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 Data Pack 4 - Statistical Analysis');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const csvFilePath = path.join(__dirname, '../data-pack-4.csv');
    
    if (!fs.existsSync(csvFilePath)) {
      throw new Error(`CSV file not found: ${csvFilePath}`);
    }
    
    // 1. 读取 CSV
    console.log('📄 Reading CSV file...');
    const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
    const { headers, data } = parseCSV(csvContent);
    
    console.log(`✅ Total lines in file: ${data.length + 1} (including header)`);
    console.log(`✅ Total data records: ${data.length}`);
    console.log(`📋 Headers: ${headers.join(', ')}\n`);
    
    // 2. 查找邮箱字段
    const emailField = headers.find(h => 
      h.toLowerCase().includes('email') || 
      h.toLowerCase().includes('邮箱') ||
      h.toLowerCase().includes('mail')
    );
    
    if (!emailField) {
      throw new Error('CSV must contain an email field');
    }
    
    console.log(`📧 Email field: ${emailField}\n`);
    
    // 3. 过滤有效记录（有邮箱的记录）
    const validRecords = data.filter(record => 
      record[emailField] && record[emailField].trim()
    );
    
    console.log(`✅ Valid records (with email): ${validRecords.length}`);
    console.log(`⚠️  Skipped records (no email): ${data.length - validRecords.length}\n`);
    
    // 4. 分类统计
    console.log('🔍 Categorizing data...');
    const categoryStats = {};
    const regionStats = {};
    const categoryRegionStats = {};
    
    for (const record of validRecords) {
      const regionInfo = categorizeByRegion(record);
      const category = categorizeByProductCategory(record) || 'Other';
      const region = regionInfo.region || 'Other';
      
      // 分类统计
      categoryStats[category] = (categoryStats[category] || 0) + 1;
      
      // 地区统计
      regionStats[region] = (regionStats[region] || 0) + 1;
      
      // 分类-地区组合统计
      const key = `${category}-${region}`;
      categoryRegionStats[key] = (categoryRegionStats[key] || 0) + 1;
    }
    
    // 5. 输出统计结果
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 STATISTICS SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log(`📦 Total Data Records: ${data.length.toLocaleString()}`);
    console.log(`✅ Valid Records (with email): ${validRecords.length.toLocaleString()}`);
    console.log(`📊 Total Categories: ${Object.keys(categoryStats).length}`);
    console.log(`🌍 Total Regions: ${Object.keys(regionStats).length}`);
    console.log(`📦 Total Data Packs (Category-Region combinations): ${Object.keys(categoryRegionStats).length}\n`);
    
    // 按分类统计
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📂 BY CATEGORY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const sortedCategories = Object.entries(categoryStats)
      .sort((a, b) => b[1] - a[1]);
    
    sortedCategories.forEach(([category, count], index) => {
      const percentage = ((count / validRecords.length) * 100).toFixed(2);
      console.log(`${(index + 1).toString().padStart(2)}. ${category.padEnd(30)} ${count.toString().padStart(8)} (${percentage}%)`);
    });
    
    // 按地区统计
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🌍 BY REGION');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const sortedRegions = Object.entries(regionStats)
      .sort((a, b) => b[1] - a[1]);
    
    sortedRegions.forEach(([region, count], index) => {
      const percentage = ((count / validRecords.length) * 100).toFixed(2);
      console.log(`${(index + 1).toString().padStart(2)}. ${region.padEnd(30)} ${count.toString().padStart(8)} (${percentage}%)`);
    });
    
    // 分类-地区组合统计
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 DATA PACKS (Category-Region Combinations)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    const sortedCombinations = Object.entries(categoryRegionStats)
      .sort((a, b) => b[1] - a[1]);
    
    sortedCombinations.forEach(([key, count], index) => {
      const [category, region] = key.split('-');
      const percentage = ((count / validRecords.length) * 100).toFixed(2);
      console.log(`${(index + 1).toString().padStart(2)}. ${category.padEnd(25)} - ${region.padEnd(20)} ${count.toString().padStart(6)} (${percentage}%)`);
    });
    
    // 汇总
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✨ SUMMARY');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    console.log(`📊 Total Records: ${data.length.toLocaleString()}`);
    console.log(`✅ Valid Records: ${validRecords.length.toLocaleString()}`);
    console.log(`📂 Categories: ${Object.keys(categoryStats).length}`);
    console.log(`🌍 Regions: ${Object.keys(regionStats).length}`);
    console.log(`📦 Data Packs: ${Object.keys(categoryRegionStats).length}`);
    console.log(`\n💡 Expected DataNFTs: ~${Object.keys(categoryRegionStats).length} (one per category-region combination)\n`);
    
    return {
      totalRecords: data.length,
      validRecords: validRecords.length,
      categories: Object.keys(categoryStats).length,
      regions: Object.keys(regionStats).length,
      dataPacks: Object.keys(categoryRegionStats).length,
      categoryStats,
      regionStats,
      categoryRegionStats
    };
    
  } catch (error) {
    console.error('\n❌ Error analyzing data pack 4:', error);
    throw error;
  }
}

// Run if called directly
if (require.main === module) {
  analyzeDataPack4()
    .then(() => {
      console.log('✅ Analysis completed successfully');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Analysis failed:', error);
      process.exit(1);
    });
}

module.exports = { analyzeDataPack4 };

