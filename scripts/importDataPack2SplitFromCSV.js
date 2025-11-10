const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

/**
 * 从CSV文件导入数据包（Data Pack 2）- 拆分成多个商家
 * 将大数据包拆分成多个部分，每个部分由不同的商家导入
 * 商家列表（8个）：
 * 1. BookWorld USA - 书籍店铺
 * 2. PrimeDeals USA - 美国店铺
 * 3. GlobalTrade USA - 美国店铺
 * 4. SmartHome USA - 智能家居店铺
 * 5. FashionHub USA - 时尚服饰店铺
 * 6. TechZone USA - 科技产品店铺
 * 7. HealthCare USA - 健康护理店铺
 * 8. SportsGear USA - 运动装备店铺
 */

// CSV 解析函数（简单实现，支持引号内的逗号）
function parseCSV(content) {
  const lines = content.split('\n').filter(line => line.trim());
  const headers = parseCSVLine(lines[0]);
  const data = [];
  
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length === headers.length) {
      const record = {};
      headers.forEach((header, index) => {
        const trimmedHeader = header.trim();
        const trimmedValue = values[index].trim();
        // 只添加非空字段
        if (trimmedHeader && trimmedValue) {
          record[trimmedHeader] = trimmedValue;
        }
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

// 商家配置（8个商家）
const merchants = [
  {
    email: "contact@bookworldusa.com",
    name: "BookWorld USA",
    password: "BookWorldUS@2024",
    description: "BookWorld USA - A leading online bookstore on Amazon marketplace, specializing in books, e-books, and educational materials.",
    part: 1
  },
  {
    email: "support@primedealsusa.com",
    name: "PrimeDeals USA",
    password: "PrimeDealsUS@2024",
    description: "PrimeDeals USA - A trusted e-commerce merchant on Amazon marketplace, offering a wide range of consumer products and daily essentials.",
    part: 2
  },
  {
    email: "info@globaltradeusa.com",
    name: "GlobalTrade USA",
    password: "GlobalTradeUS@2024",
    description: "GlobalTrade USA - An established Amazon marketplace seller, specializing in international trade and diverse product categories.",
    part: 3
  },
  {
    email: "sales@smarthomeusa.com",
    name: "SmartHome USA",
    password: "SmartHomeUS@2024",
    description: "SmartHome USA - A premier Amazon seller specializing in smart home devices, IoT products, and home automation solutions.",
    part: 4
  },
  {
    email: "hello@fashionhubusa.com",
    name: "FashionHub USA",
    password: "FashionHubUS@2024",
    description: "FashionHub USA - A trendy fashion retailer on Amazon marketplace, offering clothing, accessories, and style essentials.",
    part: 5
  },
  {
    email: "support@techzoneusa.com",
    name: "TechZone USA",
    password: "TechZoneUS@2024",
    description: "TechZone USA - A technology-focused Amazon seller, providing electronics, gadgets, and cutting-edge tech products.",
    part: 6
  },
  {
    email: "info@healthcareusa.com",
    name: "HealthCare USA",
    password: "HealthCareUS@2024",
    description: "HealthCare USA - A health and wellness Amazon merchant, specializing in health supplements, fitness equipment, and personal care products.",
    part: 7
  },
  {
    email: "contact@sportsgearusa.com",
    name: "SportsGear USA",
    password: "SportsGearUS@2024",
    description: "SportsGear USA - A sports and outdoor equipment seller on Amazon marketplace, offering athletic gear, outdoor supplies, and fitness accessories.",
    part: 8
  }
];

// 查找或创建商家
async function findOrCreateMerchant(merchantConfig) {
  let orgUser = await prisma.user.findFirst({
    where: { 
      email: merchantConfig.email,
      isOrganization: true
    }
  });
  
  if (!orgUser) {
    console.log(`Creating ${merchantConfig.name} organization user...`);
    const hashedPassword = await bcrypt.hash(merchantConfig.password, 10);
    
    // 创建组织用户
    orgUser = await prisma.user.create({
      data: {
        email: merchantConfig.email,
        name: merchantConfig.name,
        password: hashedPassword,
        isOrganization: true,
        description: merchantConfig.description,
        logo: "/assets/logos/datadance-logo.jpg",
        avatar: "/assets/logos/datadance-logo.jpg",
        referralCode: generateReferralCode()
      }
    });
    
    // 创建用户角色关联
    try {
      const adminRole = await prisma.role.findFirst({
        where: { name: "ORGANIZATION_ADMIN" }
      });
      
      if (adminRole) {
        await prisma.userRole.create({
          data: {
            user: { connect: { id: orgUser.id } },
            role: { connect: { id: adminRole.id } }
          }
        });
        console.log(`Assigned ORGANIZATION_ADMIN role to ${merchantConfig.name}`);
      } else {
        console.log("Warning: ORGANIZATION_ADMIN role not found");
      }
    } catch (roleError) {
      console.error("Error assigning role to user:", roleError);
    }
    
    console.log(`Created ${merchantConfig.name} organization user`);
  }
  
  return orgUser;
}

// 导入数据包的一部分
async function importDataPackPart(csvFilePath, headers, dataPart, merchantConfig, partIndex, totalParts) {
  try {
    const orgUser = await findOrCreateMerchant(merchantConfig);
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📦 Processing Part ${partIndex}/${totalParts} - ${merchantConfig.name}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`Using merchant: ${orgUser.name} (${orgUser.email})`);
    console.log(`Records in this part: ${dataPart.length}`);
    
    // 验证数据：确保每条记录都有邮箱字段
    const emailField = headers.find(h => 
      h.toLowerCase().includes('email') || 
      h.toLowerCase().includes('邮箱') ||
      h.toLowerCase().includes('mail')
    );
    
    if (!emailField) {
      throw new Error('CSV must contain an email field (邮箱/email/mail)');
    }
    
    console.log(`Identified email field: "${emailField}"`);
    
    // 检查是否所有记录都有邮箱
    const recordsWithoutEmail = dataPart.filter(record => !record[emailField] || !record[emailField].trim());
    if (recordsWithoutEmail.length > 0) {
      console.warn(`⚠️  Warning: ${recordsWithoutEmail.length} records without email will be skipped`);
    }
    
    const validRecords = dataPart.filter(record => record[emailField] && record[emailField].trim());
    console.log(`✅ Valid records with email: ${validRecords.length}`);
    
    // 创建 Snapshot 数据包（不关联活动）
    const snapshotData = {
      name: `Data Pack 2 - Part ${partIndex} (${merchantConfig.name})`,
      description: `Data pack imported from ${path.basename(csvFilePath)} - Part ${partIndex} of ${totalParts}, processed by ${merchantConfig.name}`,
      merchantId: orgUser.id,
      claims: {
        source: csvFilePath,
        fileName: path.basename(csvFilePath),
        importDate: new Date().toISOString(),
        part: partIndex,
        totalParts: totalParts,
        recordCount: validRecords.length,
        totalRecords: dataPart.length,
        skippedRecords: recordsWithoutEmail.length,
        headers: headers,
        emailField: emailField,
        records: validRecords.map((record, index) => ({
          recordId: index + 1,
          email: record[emailField],
          ...record
        }))
      }
    };
    
    const snapshot = await prisma.snapshot.create({
      data: snapshotData
    });
    
    console.log(`\n✅ Created Snapshot successfully!`);
    console.log(`📦 Snapshot ID: ${snapshot.id}`);
    console.log(`📝 Name: ${snapshot.name}`);
    console.log(`👤 Merchant: ${orgUser.name}`);
    console.log(`📊 Total Records: ${dataPart.length}`);
    console.log(`✓  Valid Records: ${validRecords.length}`);
    console.log(`✗  Skipped Records: ${recordsWithoutEmail.length}`);
    
    // 为数据包添加标签
    let dataPackTag = await prisma.tag.findFirst({
      where: { name: "Data Pack" }
    });
    
    if (!dataPackTag) {
      dataPackTag = await prisma.tag.create({
        data: { name: "Data Pack" }
      });
    }
    
    await prisma.snapshot.update({
      where: { id: snapshot.id },
      data: {
        tags: {
          connect: { id: dataPackTag.id }
        }
      }
    });
    
    console.log(`🏷️  Added "Data Pack" tag`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    return snapshot;
    
  } catch (error) {
    console.error(`❌ Error importing part ${partIndex} for ${merchantConfig.name}:`, error);
    throw error;
  }
}

// 主导入函数
async function importDataPack2SplitFromCSV(csvFilePath, dataPackName) {
  try {
    console.log(`Starting to import data pack 2 (split) from CSV: ${csvFilePath}...`);
    console.log(`This will split the data into ${merchants.length} parts and import each part with a different merchant.\n`);
    
    // 1. 读取并解析CSV文件
    console.log("Reading CSV file...");
    const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
    const { headers, data } = parseCSV(csvContent);
    
    console.log(`Parsed CSV: ${data.length} total records with headers: ${headers.join(', ')}\n`);
    
    // 2. 将数据分成多个部分
    const totalRecords = data.length;
    const recordsPerPart = Math.ceil(totalRecords / merchants.length);
    
    console.log(`Splitting ${totalRecords} records into ${merchants.length} parts:`);
    console.log(`  - Records per part: ~${recordsPerPart}`);
    merchants.forEach((merchant, index) => {
      const start = index * recordsPerPart + 1;
      const end = Math.min((index + 1) * recordsPerPart, totalRecords);
      console.log(`  - Part ${index + 1}: Records ${start}-${end} → ${merchant.name}`);
    });
    console.log('');
    
    const parts = [];
    for (let i = 0; i < merchants.length; i++) {
      const start = i * recordsPerPart;
      const end = Math.min(start + recordsPerPart, totalRecords);
      parts.push(data.slice(start, end));
    }
    
    // 3. 为每个部分导入数据
    const snapshots = [];
    for (let i = 0; i < parts.length; i++) {
      const snapshot = await importDataPackPart(
        csvFilePath,
        headers,
        parts[i],
        merchants[i],
        i + 1,
        merchants.length
      );
      snapshots.push(snapshot);
    }
    
    // 4. 总结
    console.log(`\n🎉 All parts imported successfully!`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📊 Summary:`);
    snapshots.forEach((snapshot, index) => {
      const claims = typeof snapshot.claims === 'string' ? JSON.parse(snapshot.claims) : snapshot.claims;
      console.log(`  Part ${index + 1}: ${snapshot.name} (${claims.recordCount || 0} records)`);
    });
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    return snapshots;
    
  } catch (error) {
    console.error("❌ Error importing data pack 2 (split) from CSV:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// 主函数：处理命令行参数
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 DataDance Data Pack 2 Split Importer');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Usage:');
    console.log('  node scripts/importDataPack2SplitFromCSV.js <csv-file-path> [name]\n');
    console.log('Examples:');
    console.log('  node scripts/importDataPack2SplitFromCSV.js data-pack-2.csv');
    console.log('  node scripts/importDataPack2SplitFromCSV.js data-pack-2.csv "Order Data Pack 2"\n');
    console.log('Description:');
    console.log('  This script will split the CSV data into 8 parts and import each part');
    console.log('  with a different merchant:');
    merchants.forEach((merchant, index) => {
      console.log(`  ${index + 1}. ${merchant.name} (${merchant.email})`);
    });
    console.log('');
    console.log('Requirements:');
    console.log('  - CSV file must contain an email field (email/邮箱/mail)');
    console.log('  - All other fields are flexible and will be stored');
    console.log('  - Records without email will be skipped\n');
    process.exit(1);
  }
  
  const csvFilePath = args[0];
  const dataPackName = args[1] || `Data Pack 2 - Split`;
  
  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ Error: File not found: ${csvFilePath}`);
    process.exit(1);
  }
  
  await importDataPack2SplitFromCSV(csvFilePath, dataPackName);
}

// 运行脚本
main()
  .then(() => {
    console.log("✅ Script completed successfully");
    process.exit(0);
  })
  .catch(error => {
    console.error("❌ Script failed:", error);
    process.exit(1);
  });

