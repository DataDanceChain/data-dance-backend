/**
 * 批量创建商家账户和 DataNFT 脚本
 * 
 * 功能：
 * 1. 读取清洗后的分组数据
 * 2. 为每个分组创建商家账户
 * 3. 为每个商家创建 DataNFT
 * 4. 自动发布到市场
 * 
 * 使用方法:
 * node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json
 * node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-2_groups.json
 * node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json --price 100 --publish
 */

// 确保使用正确的数据库连接
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

// 解析命令行参数
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    groupsFile: null,
    price: 0,
    publish: false,
    maxSales: 10,
    image: '/assets/nfts/data-pack-default.jpg'
  };
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--price' && i + 1 < args.length) {
      options.price = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--publish') {
      options.publish = true;
    } else if (args[i] === '--max-sales' && i + 1 < args.length) {
      options.maxSales = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--image' && i + 1 < args.length) {
      options.image = args[i + 1];
      i++;
    } else if (!args[i].startsWith('--')) {
      options.groupsFile = args[i];
    }
  }
  
  return options;
}

/**
 * 创建或查找商家账户
 */
async function findOrCreateMerchant(groupKey, region, category) {
  // 生成商家名称和邮箱
  const merchantName = `${region} ${category} Merchant`;
  const emailSuffix = groupKey
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const email = `merchant-${emailSuffix}@datadance.io`;
  
  // 查找是否已存在
  let merchant = await prisma.user.findFirst({
    where: {
      email: email,
      isOrganization: true
    }
  });
  
  if (merchant) {
    console.log(`  ✓ Merchant exists: ${merchantName}`);
    return merchant;
  }
  
  // 创建新商家
  console.log(`  📝 Creating merchant: ${merchantName}`);
  const hashedPassword = await bcrypt.hash('Merchant@123', 10);
  
  merchant = await prisma.user.create({
    data: {
      email: email,
      name: merchantName,
      password: hashedPassword,
      isOrganization: true,
      userType: 'organization',
      authType: 'traditional',
      description: `Data merchant specializing in ${category} data from ${region} region.`,
      logo: '/assets/logos/merchant-default.jpg',
      avatar: '/assets/logos/merchant-default.jpg',
      referralCode: generateReferralCode()
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
          user: { connect: { id: merchant.id } },
          role: { connect: { id: userRole.id } }
        }
      });
    }
  } catch (roleError) {
    console.warn(`  ⚠️  Could not assign role: ${roleError.message}`);
  }
  
  console.log(`  ✅ Created merchant: ${merchantName} (${email})`);
  return merchant;
}

/**
 * 从分组 CSV 文件读取数据
 */
function readGroupCSV(csvFilePath) {
  const content = fs.readFileSync(csvFilePath, 'utf-8');
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
  return result.map(item => item.replace(/^"|"$/g, ''));
}

/**
 * 创建 DataNFT
 */
async function createDataNFT(merchant, group, csvFilePath, options) {
  const { headers, data } = readGroupCSV(csvFilePath);
  
  // 查找邮箱字段
  const emailField = headers.find(h => 
    h.toLowerCase().includes('email') || 
    h.toLowerCase().includes('邮箱') ||
    h.toLowerCase().includes('mail') ||
    h.toLowerCase().includes('buyer-email')
  );
  
  if (!emailField) {
    throw new Error(`No email field found in ${csvFilePath}`);
  }
  
  // 过滤有效记录
  const validRecords = data.filter(record => 
    record[emailField] && record[emailField].trim()
  );
  
  if (validRecords.length === 0) {
    throw new Error(`No valid records with email in ${csvFilePath}`);
  }
  
  // 生成 DataNFT 名称和描述
  const name = `${group.region} ${group.category} Data Pack`;
  const description = `High-quality ${group.category.toLowerCase()} data from ${group.region} region. Contains ${validRecords.length} verified records with contact information and transaction details.`;
  
  // 构建 dataRecords JSON
  const dataRecords = {
    source: csvFilePath,
    fileName: path.basename(csvFilePath),
    importDate: new Date().toISOString(),
    recordCount: validRecords.length,
    totalRecords: data.length,
    headers: headers,
    emailField: emailField,
    region: group.region,
    category: group.category,
    records: validRecords.map((record, index) => ({
      recordId: index + 1,
      email: record[emailField],
      ...record
    }))
  };
  
  // 创建 DataNFT
  const dataNFT = await prisma.dataNFT.create({
    data: {
      name: name,
      description: description,
      price: options.price,
      image: options.image,
      merchantId: merchant.id,
      dataSource: 'upload',
      dataRecords: dataRecords,
      isPublished: options.publish,
      maxSales: options.maxSales
    }
  });
  
  return { dataNFT, recordCount: validRecords.length };
}

/**
 * 主函数
 */
async function main() {
  const options = parseArgs();
  
  if (!options.groupsFile || !fs.existsSync(options.groupsFile)) {
    console.error('❌ Groups file not found:', options.groupsFile);
    console.log('\nUsage:');
    console.log('  node scripts/createMerchantsAndDataNFTs.js <groups-file> [options]');
    console.log('\nOptions:');
    console.log('  --price <number>      Price for DataNFT (default: 0)');
    console.log('  --publish             Publish to market immediately');
    console.log('  --max-sales <number>  Maximum sales allowed (default: 10)');
    console.log('  --image <path>        Image path (default: /assets/nfts/data-pack-default.jpg)');
    console.log('\nExample:');
    console.log('  node scripts/createMerchantsAndDataNFTs.js cleaned-data/data-pack-1_groups.json --price 100 --publish');
    process.exit(1);
  }
  
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🏪 Create Merchants & DataNFTs');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  // 读取分组数据
  const groupsData = JSON.parse(fs.readFileSync(options.groupsFile, 'utf-8'));
  const groups = Object.values(groupsData);
  
  console.log(`📊 Found ${groups.length} groups to process\n`);
  console.log(`⚙️  Options:`);
  console.log(`   Price: ${options.price}`);
  console.log(`   Publish: ${options.publish ? 'Yes' : 'No'}`);
  console.log(`   Max Sales: ${options.maxSales}`);
  console.log(`   Image: ${options.image}\n`);
  
  const results = {
    merchantsCreated: 0,
    merchantsExisting: 0,
    dataNFTsCreated: 0,
    errors: []
  };
  
  // 处理每个分组
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const groupKey = group.key;
    
    console.log(`\n[${i + 1}/${groups.length}] Processing: ${groupKey}`);
    console.log(`   Records: ${group.records.length}`);
    
    if (group.records.length === 0) {
      console.log(`   ⚠️  Skipping empty group`);
      continue;
    }
    
    try {
      // 1. 创建或查找商家
      const merchant = await findOrCreateMerchant(
        groupKey,
        group.region,
        group.category
      );
      
      if (merchant.id) {
        // 检查是否是新创建的
        const isNew = await prisma.user.findUnique({
          where: { id: merchant.id },
          select: { createdAt: true }
        });
        const isNewMerchant = isNew && 
          new Date(isNew.createdAt).getTime() > Date.now() - 5000;
        
        if (isNewMerchant) {
          results.merchantsCreated++;
        } else {
          results.merchantsExisting++;
        }
      }
      
      // 2. 查找对应的 CSV 文件
      const groupsDir = path.dirname(options.groupsFile);
      const fileName = path.basename(options.groupsFile, '_groups.json');
      const safeGroupKey = groupKey.replace(/[^a-zA-Z0-9-_]/g, '_');
      const csvFilePath = path.join(groupsDir, `${fileName}_groups`, `${safeGroupKey}.csv`);
      
      if (!fs.existsSync(csvFilePath)) {
        throw new Error(`CSV file not found: ${csvFilePath}`);
      }
      
      // 3. 检查是否已存在相同的 DataNFT
      const existingNFT = await prisma.dataNFT.findFirst({
        where: {
          merchantId: merchant.id,
          name: `${group.region} ${group.category} Data Pack`
        }
      });
      
      if (existingNFT) {
        console.log(`   ⚠️  DataNFT already exists, skipping`);
        continue;
      }
      
      // 4. 创建 DataNFT
      console.log(`   📦 Creating DataNFT...`);
      const { dataNFT, recordCount } = await createDataNFT(
        merchant,
        group,
        csvFilePath,
        options
      );
      
      results.dataNFTsCreated++;
      console.log(`   ✅ Created DataNFT: ${dataNFT.name}`);
      console.log(`      ID: ${dataNFT.id}`);
      console.log(`      Records: ${recordCount}`);
      console.log(`      Price: ${dataNFT.price}`);
      console.log(`      Published: ${dataNFT.isPublished ? 'Yes' : 'No'}`);
      
    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      results.errors.push({
        group: groupKey,
        error: error.message
      });
    }
  }
  
  // 输出总结
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📊 Summary');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`✅ Merchants created: ${results.merchantsCreated}`);
  console.log(`✓  Merchants existing: ${results.merchantsExisting}`);
  console.log(`📦 DataNFTs created: ${results.dataNFTsCreated}`);
  console.log(`❌ Errors: ${results.errors.length}`);
  
  if (results.errors.length > 0) {
    console.log('\n⚠️  Errors:');
    results.errors.forEach(({ group, error }) => {
      console.log(`   ${group}: ${error}`);
    });
  }
  
  console.log('\n🎉 Process completed!\n');
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('\n❌ Fatal error:', error);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

module.exports = {
  findOrCreateMerchant,
  createDataNFT,
  readGroupCSV
};

