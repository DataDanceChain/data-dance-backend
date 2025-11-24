/**
 * 数据清洗和分类脚本
 * 
 * 功能：
 * 1. 读取 CSV 文件并解析
 * 2. 按照地域、人群、商品种类进行分类
 * 3. 打标签
 * 4. 输出清洗后的数据，按分类分组
 * 
 * 使用方法:
 * node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv
 * node scripts/cleanAndCategorizeDataPack.js data-pack-2.csv
 * node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv data-pack-2.csv
 */

const fs = require('fs');
const path = require('path');

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

// 地域分类
function categorizeByRegion(record) {
  const addressFields = [
    'ship-address', 'ship-city', 'ship-state', 'ship-country',
    '收件地址', '地址', 'address', 'city', 'country', 'state'
  ];
  
  let country = '';
  let region = '';
  let city = '';
  
  // 查找国家信息
  for (const field of addressFields) {
    const value = (record[field] || '').toLowerCase();
    if (!value) continue;
    
    // 国家识别
    const countryPatterns = {
      'United States': ['united states', 'usa', 'us', 'america'],
      'Germany': ['germany', 'deutschland', 'berlin', 'munich', 'hamburg'],
      'Japan': ['japan', 'tokyo', 'osaka', 'kyoto'],
      'United Kingdom': ['united kingdom', 'uk', 'london', 'england', 'britain'],
      'Canada': ['canada', 'vancouver', 'toronto', 'montreal'],
      'Australia': ['australia', 'sydney', 'melbourne'],
      'France': ['france', 'paris'],
      'Singapore': ['singapore'],
      'China': ['china', 'beijing', 'shanghai', 'hong kong'],
      'India': ['india', 'mumbai', 'delhi'],
      'Brazil': ['brazil', 'são paulo', 'rio de janeiro'],
      'Spain': ['spain', 'madrid', 'barcelona'],
      'Italy': ['italy', 'rome', 'milan'],
      'Netherlands': ['netherlands', 'amsterdam'],
      'Switzerland': ['switzerland', 'zurich', 'geneva'],
      'Poland': ['poland', 'warsaw'],
      'Romania': ['romania', 'bucharest'],
      'UAE': ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
      'Ireland': ['ireland', 'dublin'],
      'New Zealand': ['new zealand', 'auckland'],
      'Colombia': ['colombia', 'bogotá'],
      'Hong Kong': ['hong kong', 'kowloon']
    };
    
    for (const [countryName, patterns] of Object.entries(countryPatterns)) {
      if (patterns.some(pattern => value.includes(pattern))) {
        country = countryName;
        break;
      }
    }
    
    if (country) break;
  }
  
  // 如果没有找到国家，尝试从地址字段提取
  if (!country) {
    const address = (record['ship-address'] || record['收件地址'] || record['address'] || '').toLowerCase();
    for (const [countryName, patterns] of Object.entries({
      'United States': ['usa', 'united states', 'america'],
      'Germany': ['germany', 'berlin', 'munich'],
      'Japan': ['japan', 'tokyo'],
      'United Kingdom': ['uk', 'london', 'england'],
      'Canada': ['canada', 'vancouver', 'toronto'],
      'Australia': ['australia', 'sydney'],
      'France': ['france', 'paris'],
      'Singapore': ['singapore'],
      'China': ['china', 'beijing'],
      'India': ['india', 'mumbai']
    })) {
      if (patterns.some(pattern => address.includes(pattern))) {
        country = countryName;
        break;
      }
    }
  }
  
  // 区域分类（大洲/地区）
  const regionMap = {
    'United States': 'North America',
    'Canada': 'North America',
    'United Kingdom': 'Europe',
    'Germany': 'Europe',
    'France': 'Europe',
    'Spain': 'Europe',
    'Italy': 'Europe',
    'Netherlands': 'Europe',
    'Switzerland': 'Europe',
    'Poland': 'Europe',
    'Romania': 'Europe',
    'Ireland': 'Europe',
    'Japan': 'Asia',
    'China': 'Asia',
    'India': 'Asia',
    'Singapore': 'Asia',
    'Hong Kong': 'Asia',
    'UAE': 'Middle East',
    'Australia': 'Oceania',
    'New Zealand': 'Oceania',
    'Brazil': 'South America',
    'Colombia': 'South America'
  };
  
  region = regionMap[country] || 'Other';
  
  // 提取城市
  const cityFields = ['ship-city', 'city'];
  for (const field of cityFields) {
    if (record[field]) {
      city = record[field];
      break;
    }
  }
  
  return { country, region, city };
}

// 人群分类（根据邮箱域名和商品类型）
function categorizeByDemographic(record) {
  const email = (record['buyer-email'] || record['邮箱'] || record['email'] || '').toLowerCase();
  const product = (record['title'] || record['商品名称'] || record['product'] || '').toLowerCase();
  
  const demographics = [];
  
  // 根据邮箱域名判断
  if (email.includes('gmail.com') || email.includes('hotmail.com') || email.includes('outlook.com')) {
    demographics.push('General Consumer');
  } else if (email.includes('yahoo.com') || email.includes('icloud.com')) {
    demographics.push('Tech-Savvy');
  } else if (email.includes('protonmail.com') || email.includes('gmx.com')) {
    demographics.push('Privacy-Conscious');
  }
  
  // 根据商品类型判断人群
  if (product.includes('baby') || product.includes('infant') || product.includes('toddler')) {
    demographics.push('Parents');
  }
  if (product.includes('hair') || product.includes('makeup') || product.includes('cosmetic') || 
      product.includes('skincare') || product.includes('beauty')) {
    demographics.push('Beauty Enthusiasts');
  }
  if (product.includes('sport') || product.includes('fitness') || product.includes('running') || 
      product.includes('basketball') || product.includes('yoga')) {
    demographics.push('Fitness Enthusiasts');
  }
  if (product.includes('book') || product.includes('novel')) {
    demographics.push('Book Lovers');
  }
  if (product.includes('tech') || product.includes('electronic') || product.includes('console') || 
      product.includes('monitor') || product.includes('drone')) {
    demographics.push('Tech Enthusiasts');
  }
  if (product.includes('luxury') || product.includes('premium')) {
    demographics.push('Luxury Shoppers');
  }
  
  // 如果没有匹配到，使用默认
  if (demographics.length === 0) {
    demographics.push('General Consumer');
  }
  
  return demographics;
}

// 商品种类分类
function categorizeByProductCategory(record) {
  const product = (record['title'] || record['商品名称'] || record['product'] || '').toLowerCase();
  
  const categories = [];
  
  // 商品分类关键词
  const categoryKeywords = {
    'Baby & Kids': ['baby', 'infant', 'toddler', 'children', 'kids', 'pampers', 'huggies', 'chicco', 'johnson'],
    'Beauty & Personal Care': ['hair', 'makeup', 'cosmetic', 'skincare', 'beauty', 'lotion', 'cream', 'lipstick', 'mascara', 'foundation', 'l\'oréal', 'cantu', 'cerave', 'neutrogena', 'la roche-posay'],
    'Fashion & Apparel': ['shoes', 'hoodie', 'pants', 't-shirt', 'clothing', 'apparel', 'nike', 'adidas', 'levi'],
    'Electronics': ['electronic', 'console', 'monitor', 'printer', 'drone', 'speaker', 'tracker', 'sony', 'samsung', 'dji', 'garmin', 'logitech'],
    'Home & Kitchen': ['vacuum', 'blender', 'grill', 'kitchen', 'home', 'dyson', 'shark', 'vitamix', 'weber', 'nespresso'],
    'Books & Media': ['book', 'novel', 'blu-ray', 'dvd'],
    'Sports & Outdoors': ['sport', 'fitness', 'running', 'basketball', 'yoga', 'outdoor', 'tumbler', 'yeti'],
    'Health & Wellness': ['health', 'wellness', 'organic', 'supplement'],
    'Gaming': ['gaming', 'playstation', 'ps5', 'xbox', 'nintendo'],
    'Automotive': ['car', 'automotive', 'vehicle']
  };
  
  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some(keyword => product.includes(keyword))) {
      categories.push(category);
      break; // 只匹配第一个类别
    }
  }
  
  // 如果没有匹配到，使用默认
  if (categories.length === 0) {
    categories.push('Other');
  }
  
  return categories[0]; // 返回主要类别
}

// 生成标签
function generateTags(record, region, demographics, category) {
  const tags = [];
  
  // 地域标签
  if (region.country) {
    tags.push(`Region:${region.region}`);
    tags.push(`Country:${region.country}`);
  }
  if (region.city) {
    tags.push(`City:${region.city}`);
  }
  
  // 人群标签
  demographics.forEach(demo => {
    tags.push(`Demographic:${demo}`);
  });
  
  // 商品类别标签
  if (category) {
    tags.push(`Category:${category}`);
  }
  
  // 数据质量标签
  const email = record['buyer-email'] || record['邮箱'] || record['email'] || '';
  if (email) {
    tags.push('HasEmail');
  }
  
  const address = record['ship-address'] || record['收件地址'] || '';
  if (address) {
    tags.push('HasAddress');
  }
  
  return tags;
}

// 清洗和分类数据
function cleanAndCategorize(csvFilePath) {
  console.log(`\n📂 Processing: ${csvFilePath}`);
  console.log('='.repeat(60));
  
  // 读取 CSV
  const content = fs.readFileSync(csvFilePath, 'utf-8');
  const { headers, data } = parseCSV(content);
  
  console.log(`📊 Total records: ${data.length}`);
  console.log(`📋 Headers: ${headers.join(', ')}\n`);
  
  // 清洗和分类
  const cleanedData = [];
  const statistics = {
    byRegion: {},
    byCategory: {},
    byDemographic: {},
    byCountry: {}
  };
  
  for (const record of data) {
    // 跳过空记录
    const email = record['buyer-email'] || record['邮箱'] || record['email'] || '';
    if (!email) continue;
    
    // 分类
    const region = categorizeByRegion(record);
    const demographics = categorizeByDemographic(record);
    const category = categorizeByProductCategory(record);
    const tags = generateTags(record, region, demographics, category);
    
    // 添加分类信息到记录
    const cleanedRecord = {
      ...record,
      _metadata: {
        region: region.region,
        country: region.country,
        city: region.city,
        demographics: demographics,
        category: category,
        tags: tags
      }
    };
    
    cleanedData.push(cleanedRecord);
    
    // 统计
    statistics.byRegion[region.region] = (statistics.byRegion[region.region] || 0) + 1;
    statistics.byCategory[category] = (statistics.byCategory[category] || 0) + 1;
    statistics.byCountry[region.country] = (statistics.byCountry[region.country] || 0) + 1;
    demographics.forEach(demo => {
      statistics.byDemographic[demo] = (statistics.byDemographic[demo] || 0) + 1;
    });
  }
  
  console.log(`✅ Cleaned records: ${cleanedData.length}\n`);
  
  // 输出统计信息
  console.log('📈 Statistics:');
  console.log('\nBy Region:');
  Object.entries(statistics.byRegion)
    .sort((a, b) => b[1] - a[1])
    .forEach(([region, count]) => {
      console.log(`  ${region}: ${count}`);
    });
  
  console.log('\nBy Category:');
  Object.entries(statistics.byCategory)
    .sort((a, b) => b[1] - a[1])
    .forEach(([category, count]) => {
      console.log(`  ${category}: ${count}`);
    });
  
  console.log('\nBy Country (Top 10):');
  Object.entries(statistics.byCountry)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([country, count]) => {
      console.log(`  ${country}: ${count}`);
    });
  
  console.log('\nBy Demographic:');
  Object.entries(statistics.byDemographic)
    .sort((a, b) => b[1] - a[1])
    .forEach(([demo, count]) => {
      console.log(`  ${demo}: ${count}`);
    });
  
  return {
    headers,
    data: cleanedData,
    statistics
  };
}

// 按分类分组数据
function groupByCategory(cleanedData) {
  const groups = {};
  
  for (const record of cleanedData) {
    const { region, country, category, demographics } = record._metadata;
    
    // 创建分组键：Region-Category
    const groupKey = `${region || 'Unknown'}-${category || 'Other'}`;
    
    if (!groups[groupKey]) {
      groups[groupKey] = {
        key: groupKey,
        region: region,
        category: category,
        records: []
      };
    }
    
    groups[groupKey].records.push(record);
  }
  
  return groups;
}

// 保存清洗后的数据
function saveCleanedData(outputDir, fileName, cleanedData, groups) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  // 保存完整清洗后的数据
  const fullOutputPath = path.join(outputDir, `${fileName}_cleaned.json`);
  fs.writeFileSync(fullOutputPath, JSON.stringify(cleanedData, null, 2), 'utf-8');
  console.log(`\n💾 Saved cleaned data: ${fullOutputPath}`);
  
  // 保存分组数据
  const groupsOutputPath = path.join(outputDir, `${fileName}_groups.json`);
  fs.writeFileSync(groupsOutputPath, JSON.stringify(groups, null, 2), 'utf-8');
  console.log(`💾 Saved grouped data: ${groupsOutputPath}`);
  
  // 为每个分组保存单独的 CSV
  const groupsDir = path.join(outputDir, `${fileName}_groups`);
  if (!fs.existsSync(groupsDir)) {
    fs.mkdirSync(groupsDir, { recursive: true });
  }
  
  for (const [groupKey, group] of Object.entries(groups)) {
    if (group.records.length === 0) continue;
    
    // 获取所有字段
    const allHeaders = new Set();
    group.records.forEach(record => {
      Object.keys(record).forEach(key => {
        if (key !== '_metadata') {
          allHeaders.add(key);
        }
      });
    });
    
    const headers = Array.from(allHeaders);
    
    // 生成 CSV
    let csv = headers.join(',') + '\n';
    group.records.forEach(record => {
      const row = headers.map(header => {
        const value = record[header] || '';
        // 如果包含逗号或引号，用引号包裹
        if (value.includes(',') || value.includes('"')) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      });
      csv += row.join(',') + '\n';
    });
    
    const safeGroupKey = groupKey.replace(/[^a-zA-Z0-9-_]/g, '_');
    const groupCsvPath = path.join(groupsDir, `${safeGroupKey}.csv`);
    fs.writeFileSync(groupCsvPath, csv, 'utf-8');
  }
  
  console.log(`💾 Saved ${Object.keys(groups).length} group CSV files to: ${groupsDir}`);
}

// 主函数
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: node scripts/cleanAndCategorizeDataPack.js <csv-file1> [csv-file2] ...');
    console.log('Example: node scripts/cleanAndCategorizeDataPack.js data-pack-1.csv data-pack-2.csv');
    process.exit(1);
  }
  
  const outputDir = path.join(__dirname, '../cleaned-data');
  
  for (const csvFile of args) {
    if (!fs.existsSync(csvFile)) {
      console.error(`❌ File not found: ${csvFile}`);
      continue;
    }
    
    const fileName = path.basename(csvFile, '.csv');
    const { data: cleanedData, statistics } = cleanAndCategorize(csvFile);
    const groups = groupByCategory(cleanedData);
    
    saveCleanedData(outputDir, fileName, cleanedData, groups);
    
    console.log(`\n✅ Completed: ${csvFile}\n`);
  }
  
  console.log('='.repeat(60));
  console.log('🎉 Data cleaning completed!');
  console.log(`📁 Output directory: ${outputDir}`);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  cleanAndCategorize,
  categorizeByRegion,
  categorizeByDemographic,
  categorizeByProductCategory,
  generateTags,
  groupByCategory
};

