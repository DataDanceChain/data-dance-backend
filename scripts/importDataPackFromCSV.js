const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

/**
 * 从CSV文件导入数据包
 * 使用方案B：Snapshot.activityId 为可选，数据包可以独立于活动存在
 * 数据结构：每条记录必须包含邮箱字段，其他字段灵活
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
        record[header.trim()] = values[index].trim();
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

async function importDataPackFromCSV(csvFilePath, dataPackName, dataPackDescription) {
  try {
    console.log(`Starting to import data pack from CSV: ${csvFilePath}...`);
    
    // 1. 查找或创建 DataDance Official 组织用户
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
      
      console.log("Created DataDance Official organization user");
    }
    
    console.log(`Using merchant: ${orgUser.name} (${orgUser.email})`);
    
    // 2. 读取并解析CSV文件
    const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
    const { headers, data } = parseCSV(csvContent);
    
    console.log(`Parsed CSV: ${data.length} records with headers: ${headers.join(', ')}`);
    
    // 3. 验证数据：确保每条记录都有邮箱字段
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
    const recordsWithoutEmail = data.filter(record => !record[emailField] || !record[emailField].trim());
    if (recordsWithoutEmail.length > 0) {
      console.warn(`⚠️  Warning: ${recordsWithoutEmail.length} records without email will be skipped`);
    }
    
    const validRecords = data.filter(record => record[emailField] && record[emailField].trim());
    console.log(`✅ Valid records with email: ${validRecords.length}`);
    
    // 4. 创建 Snapshot 数据包（不关联活动）
    const snapshot = await prisma.snapshot.create({
      data: {
        name: dataPackName,
        description: dataPackDescription || `Data pack imported from ${path.basename(csvFilePath)}`,
        // activityId: null,  // 不关联活动（可选字段，默认为null）
        merchantId: orgUser.id,
        claims: {
          source: csvFilePath,
          fileName: path.basename(csvFilePath),
          importDate: new Date().toISOString(),
          recordCount: validRecords.length,
          totalRecords: data.length,
          skippedRecords: recordsWithoutEmail.length,
          headers: headers,
          emailField: emailField,
          records: validRecords.map((record, index) => ({
            recordId: index + 1,
            email: record[emailField],
            ...record
          }))
        }
      }
    });
    
    console.log(`\n✅ Created Snapshot successfully!`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📦 Snapshot ID: ${snapshot.id}`);
    console.log(`📝 Name: ${snapshot.name}`);
    console.log(`📄 Description: ${snapshot.description}`);
    console.log(`👤 Merchant: ${orgUser.name}`);
    console.log(`📧 Email Field: ${emailField}`);
    console.log(`📊 Total Records: ${data.length}`);
    console.log(`✓  Valid Records: ${validRecords.length}`);
    console.log(`✗  Skipped Records: ${recordsWithoutEmail.length}`);
    console.log(`🏷️  Fields: ${headers.join(', ')}`);
    console.log(`🔗 Activity: None (standalone data pack)`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    // 5. 为数据包添加标签
    const dataPackTag = await prisma.tag.upsert({
      where: { name: "Data Pack" },
      update: {},
      create: { name: "Data Pack" }
    });
    
    await prisma.snapshot.update({
      where: { id: snapshot.id },
      data: {
        tags: {
          connect: { id: dataPackTag.id }
        }
      }
    });
    
    console.log(`🏷️  Added "Data Pack" tag\n`);
    
    return snapshot;
    
  } catch (error) {
    console.error("❌ Error importing data pack from CSV:", error);
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
    console.log('📦 DataDance Data Pack Importer');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Usage:');
    console.log('  node scripts/importDataPackFromCSV.js <csv-file-path> [name] [description]\n');
    console.log('Examples:');
    console.log('  node scripts/importDataPackFromCSV.js data-pack-1.csv');
    console.log('  node scripts/importDataPackFromCSV.js data-pack-1.csv "Order Data Pack 1"');
    console.log('  node scripts/importDataPackFromCSV.js data-pack-1.csv "Order Data Pack 1" "Customer orders from Q1 2025"\n');
    console.log('Requirements:');
    console.log('  - CSV file must contain an email field (email/邮箱/mail)');
    console.log('  - All other fields are flexible and will be stored');
    console.log('  - Records without email will be skipped\n');
    process.exit(1);
  }
  
  const csvFilePath = args[0];
  const dataPackName = args[1] || `Data Pack - ${path.basename(csvFilePath, '.csv')}`;
  const dataPackDescription = args[2] || undefined;
  
  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ Error: File not found: ${csvFilePath}`);
    process.exit(1);
  }
  
  await importDataPackFromCSV(csvFilePath, dataPackName, dataPackDescription);
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

