const prisma = require('../src/utils/prisma');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { generateReferralCode } = require('../src/utils/referralUtils');

/**
 * 从CSV文件直接创建DataNFT（方案C）
 * 不使用Snapshot中间层，直接将CSV数据打包成可交易的DataNFT
 * 
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

async function importDataPackAsDataNFT(csvFilePath, options = {}) {
  try {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📦 DataDance Data Pack → DataNFT Importer`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(`Starting to import CSV: ${csvFilePath}...\n`);
    
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
      
      console.log("✅ Created DataDance Official organization user\n");
    }
    
    console.log(`Using merchant: ${orgUser.name} (${orgUser.email})\n`);
    
    // 2. 读取并解析CSV文件
    const csvContent = fs.readFileSync(csvFilePath, 'utf-8');
    const { headers, data } = parseCSV(csvContent);
    
    console.log(`📄 Parsed CSV:`);
    console.log(`   Total records: ${data.length}`);
    console.log(`   Headers: ${headers.join(', ')}\n`);
    
    // 3. 验证数据：确保每条记录都有邮箱字段
    const emailField = headers.find(h => 
      h.toLowerCase().includes('email') || 
      h.toLowerCase().includes('邮箱') ||
      h.toLowerCase().includes('mail')
    );
    
    if (!emailField) {
      throw new Error('❌ CSV must contain an email field (邮箱/email/mail)');
    }
    
    console.log(`📧 Identified email field: "${emailField}"\n`);
    
    // 检查是否所有记录都有邮箱
    const recordsWithoutEmail = data.filter(record => !record[emailField] || !record[emailField].trim());
    if (recordsWithoutEmail.length > 0) {
      console.warn(`⚠️  Warning: ${recordsWithoutEmail.length} records without email will be skipped\n`);
    }
    
    const validRecords = data.filter(record => record[emailField] && record[emailField].trim());
    console.log(`✅ Valid records with email: ${validRecords.length}\n`);
    
    // 4. 准备 DataNFT 数据
    const defaultName = options.name || `Data Pack - ${path.basename(csvFilePath, '.csv')}`;
    const defaultDescription = options.description || `Data pack imported from ${path.basename(csvFilePath)} containing ${validRecords.length} records with contact information and transaction details.`;
    const defaultPrice = options.price || 0;
    const defaultImage = options.image || '/assets/nfts/data-pack-default.jpg';
    
    // 构建 dataRecords JSON 结构
    const dataRecords = {
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
    };
    
    // 5. 直接创建 DataNFT（不经过Snapshot）
    console.log(`🎨 Creating DataNFT...`);
    
    const dataNFT = await prisma.dataNFT.create({
      data: {
        name: defaultName,
        description: defaultDescription,
        price: defaultPrice,
        image: defaultImage,
        merchantId: orgUser.id,
        dataSource: 'upload',  // 标识为上传数据
        dataRecords: dataRecords,  // 存储CSV数据
        isPublished: options.autoPublish || false,
        maxSales: options.maxSales || 999999
      }
    });
    
    console.log(`✅ DataNFT created successfully!\n`);
    
    // 6. 添加标签
    const dataPackTag = await prisma.tag.upsert({
      where: { name: "Data Pack" },
      update: {},
      create: { name: "Data Pack" }
    });
    
    await prisma.dataNFT.update({
      where: { id: dataNFT.id },
      data: {
        tags: {
          connect: { id: dataPackTag.id }
        }
      }
    });
    
    // 7. 输出结果
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`✨ SUCCESS - DataNFT Created!`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    console.log(`📦 DataNFT Details:`);
    console.log(`   ID: ${dataNFT.id}`);
    console.log(`   Name: ${dataNFT.name}`);
    console.log(`   Description: ${dataNFT.description}`);
    console.log(`   Price: $${dataNFT.price}`);
    console.log(`   Published: ${dataNFT.isPublished ? 'Yes ✅' : 'No (Draft) 📝'}`);
    console.log(`   Max Sales: ${dataNFT.maxSales}\n`);
    
    console.log(`👤 Merchant:`);
    console.log(`   ${orgUser.name} (${orgUser.email})\n`);
    
    console.log(`📊 Data Statistics:`);
    console.log(`   Source: ${csvFilePath}`);
    console.log(`   Email Field: ${emailField}`);
    console.log(`   Total Records: ${data.length}`);
    console.log(`   Valid Records: ${validRecords.length}`);
    console.log(`   Skipped Records: ${recordsWithoutEmail.length}`);
    console.log(`   Fields: ${headers.join(', ')}\n`);
    
    console.log(`🏷️  Tags: Data Pack\n`);
    
    console.log(`🔄 Data Source: upload (standalone data pack)\n`);
    
    console.log(`💡 Next Steps:`);
    if (!dataNFT.isPublished) {
      console.log(`   1. Set a price (if not already set)`);
      console.log(`   2. Publish the DataNFT to make it available in the market`);
    } else {
      console.log(`   ✅ DataNFT is published and ready for trading!`);
    }
    console.log(`   3. Share with potential buyers\n`);
    
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    
    return dataNFT;
    
  } catch (error) {
    console.error("\n❌ Error importing data pack as DataNFT:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// 主函数：处理命令行参数
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📦 DataDance Data Pack → DataNFT Importer (方案C)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('Usage:');
    console.log('  node scripts/importDataPackAsDataNFT.js <csv-file> [options]\n');
    console.log('Options:');
    console.log('  --name <string>        DataNFT name');
    console.log('  --description <string> DataNFT description');
    console.log('  --price <number>       Price (default: 0)');
    console.log('  --image <string>       Image path');
    console.log('  --publish              Auto-publish after creation');
    console.log('  --max-sales <number>   Maximum sales limit (default: 999999)\n');
    console.log('Examples:');
    console.log('  # Basic import');
    console.log('  node scripts/importDataPackAsDataNFT.js data-pack-1.csv\n');
    console.log('  # With custom name and price');
    console.log('  node scripts/importDataPackAsDataNFT.js data-pack-1.csv --name "Q1 Orders" --price 99.99\n');
    console.log('  # Auto-publish with all options');
    console.log('  node scripts/importDataPackAsDataNFT.js data-pack-1.csv \\');
    console.log('    --name "Premium Customer Data" \\');
    console.log('    --description "High-value customer orders Q1 2025" \\');
    console.log('    --price 299.99 \\');
    console.log('    --max-sales 10 \\');
    console.log('    --publish\n');
    console.log('Requirements:');
    console.log('  - CSV file must contain an email field (email/邮箱/mail)');
    console.log('  - All other fields are flexible and will be stored');
    console.log('  - Records without email will be skipped\n');
    console.log('Features:');
    console.log('  ✅ Direct DataNFT creation (no Snapshot layer)');
    console.log('  ✅ Ready for market trading');
    console.log('  ✅ Flexible pricing and sales limits');
    console.log('  ✅ Automatic data validation\n');
    process.exit(1);
  }
  
  const csvFilePath = args[0];
  
  // 解析命令行参数
  const options = {
    name: null,
    description: null,
    price: 0,
    image: null,
    autoPublish: false,
    maxSales: 999999
  };
  
  for (let i = 1; i < args.length; i++) {
    switch(args[i]) {
      case '--name':
        options.name = args[++i];
        break;
      case '--description':
        options.description = args[++i];
        break;
      case '--price':
        options.price = parseFloat(args[++i]);
        break;
      case '--image':
        options.image = args[++i];
        break;
      case '--publish':
        options.autoPublish = true;
        break;
      case '--max-sales':
        options.maxSales = parseInt(args[++i]);
        break;
    }
  }
  
  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ Error: File not found: ${csvFilePath}`);
    process.exit(1);
  }
  
  await importDataPackAsDataNFT(csvFilePath, options);
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

