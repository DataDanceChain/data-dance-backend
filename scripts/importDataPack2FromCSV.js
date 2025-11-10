const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

/**
 * 从CSV文件导入数据包（Data Pack 2）
 * 使用方案B：Snapshot.activityId 为可选，数据包可以独立于活动存在
 * 数据结构：每条记录必须包含邮箱字段，其他字段灵活
 * 商家：GlobalHome USA - 另一个亚马逊美国店铺
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

async function importDataPack2FromCSV(csvFilePath, dataPackName, dataPackDescription) {
  try {
    console.log(`Starting to import data pack 2 from CSV: ${csvFilePath}...`);
    
    // 1. 查找或创建 GlobalHome USA 组织用户（另一个亚马逊美国店铺）
    let orgUser = await prisma.user.findFirst({
      where: { 
        email: "support@globalhomeusa.com",
        isOrganization: true
      }
    });
    
    if (!orgUser) {
      console.log("Creating GlobalHome USA organization user...");
      const hashedPassword = await bcrypt.hash("GlobalHomeUS@2024", 10);
      
      // 创建组织用户
      orgUser = await prisma.user.create({
        data: {
          email: "support@globalhomeusa.com",
          name: "GlobalHome USA",
          password: hashedPassword,
          isOrganization: true,
          description: "GlobalHome USA - A trusted e-commerce merchant on Amazon marketplace, specializing in home goods, lifestyle products, and consumer essentials.",
          logo: "/assets/logos/datadance-logo.jpg",
          avatar: "/assets/logos/datadance-logo.jpg",
          referralCode: generateReferralCode()
        }
      });
      
      // 创建用户角色关联
      try {
        // 查找 ORGANIZATION_ADMIN 角色
        const adminRole = await prisma.role.findFirst({
          where: { name: "ORGANIZATION_ADMIN" }
        });
        
        if (adminRole) {
          // 创建用户角色关联
          await prisma.userRole.create({
            data: {
              user: { connect: { id: orgUser.id } },
              role: { connect: { id: adminRole.id } }
            }
          });
          console.log(`Assigned ORGANIZATION_ADMIN role to GlobalHome USA`);
        } else {
          console.log("Warning: ORGANIZATION_ADMIN role not found");
        }
      } catch (roleError) {
        console.error("Error assigning role to user:", roleError);
      }
      
      console.log("Created GlobalHome USA organization user");
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
    const snapshotData = {
      name: dataPackName,
      description: dataPackDescription || `Data pack imported from ${path.basename(csvFilePath)}`,
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
    };
    
    const snapshot = await prisma.snapshot.create({
      data: snapshotData
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
    
    console.log(`🏷️  Added "Data Pack" tag\n`);
    
    return snapshot;
    
  } catch (error) {
    console.error("❌ Error importing data pack 2 from CSV:", error);
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
    console.log('📦 DataDance Data Pack 2 Importer');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Usage:');
    console.log('  node scripts/importDataPack2FromCSV.js <csv-file-path> [name] [description]\n');
    console.log('Examples:');
    console.log('  node scripts/importDataPack2FromCSV.js data-pack-2.csv');
    console.log('  node scripts/importDataPack2FromCSV.js data-pack-2.csv "Order Data Pack 2"');
    console.log('  node scripts/importDataPack2FromCSV.js data-pack-2.csv "Order Data Pack 2" "Customer orders from Q2 2025"\n');
    console.log('Requirements:');
    console.log('  - CSV file must contain an email field (email/邮箱/mail)');
    console.log('  - All other fields are flexible and will be stored');
    console.log('  - Records without email will be skipped');
    console.log('  - Merchant: GlobalHome USA (support@globalhomeusa.com)\n');
    process.exit(1);
  }
  
  const csvFilePath = args[0];
  const dataPackName = args[1] || `Data Pack 2 - ${path.basename(csvFilePath, '.csv')}`;
  const dataPackDescription = args[2] || undefined;
  
  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ Error: File not found: ${csvFilePath}`);
    process.exit(1);
  }
  
  await importDataPack2FromCSV(csvFilePath, dataPackName, dataPackDescription);
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

