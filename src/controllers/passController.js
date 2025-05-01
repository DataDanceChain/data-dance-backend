const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const { PKPass } = require('passkit-generator');
const crypto = require('crypto');
const sharp = require('sharp');
const axios = require('axios');
const os = require('os');

/**
 * 从图片中提取主色调
 * @param {Buffer} imageBuffer 图片Buffer
 * @returns {string} RGB颜色字符串
 */
async function extractDominantColor(imageBuffer) {
  try {
    // 调整图片大小以加快处理速度
    const resized = await sharp(imageBuffer)
      .resize(100, 100, { fit: 'inside' })
      .toBuffer();

    // 获取图片的统计信息
    const stats = await sharp(resized)
      .stats();

    // 获取主色调
    const dominant = stats.channels.reduce((acc, channel, index) => {
      const color = Math.round(channel.mean);
      return acc + (index === 0 ? `rgb(${color},` : index === 1 ? `${color},` : `${color})`);
    }, '');

    // 确保颜色足够深
    const [r, g, b] = dominant.match(/\d+/g).map(Number);
    const darkened = `rgb(${Math.max(0, r - 50)}, ${Math.max(0, g - 50)}, ${Math.max(0, b - 50)})`;
    
    return darkened;
  } catch (error) {
    console.error('提取主色调失败:', error);
    // 返回默认的深青绿色
    return 'rgb(0, 50, 50)';
  }
}

/**
 * 生成 strip 图片
 * @param {Array} nftImages NFT图片URL数组
 * @param {string} outputPath 输出路径
 */
async function generateStripImage(nftImages, outputPath) {
  try {
    // 确保输出目录存在
    const outputDir = path.dirname(outputPath);
    await fs.mkdir(outputDir, { recursive: true });

    console.log('开始生成 strip 图片，NFT图片数量:', nftImages.length);
    console.log('NFT图片URLs:', nftImages);

    // 验证所有图片文件是否存在
    const validImages = [];
    for (const url of nftImages) {
      try {
        const stats = await fs.stat(url);
        console.log(`图片文件 ${url} 存在，大小: ${stats.size} 字节`);
        validImages.push(url);
      } catch (error) {
        console.error(`图片文件 ${url} 不存在或无法访问:`, error.message);
        // 继续处理其他图片
      }
    }

    if (validImages.length === 0) {
      console.log('没有有效的图片可处理');
      return false;
    }

    // 只处理最新的3个NFT图片
    const imagesToProcess = validImages.slice(0, Math.min(3, validImages.length));
    
    // 读取和处理所有NFT图片
    const processedImages = [];
    for (let i = 0; i < imagesToProcess.length; i++) {
      const url = imagesToProcess[i];
      try {
        console.log(`开始处理第 ${i + 1} 个图片:`, url);
        const imageBuffer = await fs.readFile(url);
        
        // 根据图片数量决定尺寸
        let width, height;
        if (imagesToProcess.length === 1) {
          // 单张图片铺满
          width = 624;
          height = 250;
        } else if (imagesToProcess.length === 2) {
          // 两张图片平分
          width = 312;
          height = 250;
        } else {
          // 三张图片平分
          width = 208;
          height = 250;
        }

        const resizedImage = await sharp(imageBuffer)
          .resize(width, height, { 
            fit: 'cover',
            position: 'center'
          })
          .toBuffer();
        console.log(`第 ${i + 1} 个图片处理完成`);
        processedImages.push(resizedImage);
      } catch (error) {
        console.error(`处理图片 ${url} 时出错:`, error);
        // 继续处理其他图片
      }
    }

    if (processedImages.length === 0) {
      console.log('没有成功处理的图片');
      return false;
    }

    // 创建背景画布
    const width = 624;
    const height = 250;
    const canvas = sharp({
      create: {
        width,
        height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    });

    // 计算图片布局
    const compositeOperations = processedImages.map((buffer, index) => {
      let left = 0;
      if (processedImages.length === 2) {
        // 两张图片平分
        left = index * 312;
      } else if (processedImages.length === 3) {
        // 三张图片平分
        left = index * 208;
      }

      return {
        input: buffer,
        top: 0,
        left: left,
        blend: 'over'  // 使用over模式确保透明度正确
      };
    });

    // 执行合成
    console.log('开始合成最终图片');
    await canvas
      .composite(compositeOperations)
      .toFile(outputPath);
    console.log('strip 图片生成完成:', outputPath);

    // 生成2x和3x版本
    console.log('生成2x和3x版本...');
    try {
      await Promise.all([
        sharp(outputPath)
          .resize(width * 2, height * 2, { 
            kernel: sharp.kernel.lanczos3,
            fit: 'fill'
          })
          .toFile(outputPath.replace('.png', '@2x.png')),
        sharp(outputPath)
          .resize(width * 3, height * 3, {
            kernel: sharp.kernel.lanczos3,
            fit: 'fill'
          })
          .toFile(outputPath.replace('.png', '@3x.png'))
      ]);
      console.log('2x和3x版本生成完成');
    } catch (error) {
      console.error('生成2x和3x版本时出错:', error);
      // 继续执行，因为基础版本已经生成
    }

    // 验证文件
    try {
      const stats = await fs.stat(outputPath);
      console.log(`验证基础文件成功: ${outputPath}, 大小: ${stats.size} 字节`);
      return true;
    } catch (error) {
      console.error('验证基础文件失败:', error);
      return false;
    }
  } catch (error) {
    console.error('生成 strip 图片时出错:', error);
    return false;
  }
}

/**
 * 生成 Apple Wallet Pass
 * @route POST /assets/passes/generate
 * @access Private
 */
exports.generatePass = async (req, res) => {
  try {
    console.log('开始生成 Pass...');
    const {
      creatorId,
      creatorName,
      creatorLogo,
      userId,
      userName,
      userWalletAddress
    } = req.body;

    console.log('请求参数:', { creatorId, creatorName, creatorLogo, userId, userName, userWalletAddress });

    // 验证必要参数
    if (!creatorId || !creatorName || !userId || !userName || !userWalletAddress) {
      console.log('缺少必要参数:', { creatorId, creatorName, userId, userName, userWalletAddress });
      return res.status(400).json({
        status: 'fail',
        message: '缺少必要参数'
      });
    }

    // 获取用户的所有已认领活动
    console.log('开始获取用户认领活动...');
    const userClaims = await prisma.activityClaim.findMany({
      where: {
        userId: userId,
        activity: {
          creator: {
            id: creatorId === 'default' ? undefined : creatorId,
            OR: creatorId === 'default' ? [{ name: creatorName }] : undefined
          }
        }
      },
      include: {
        activity: {
          include: {
            creator: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    console.log('用户认领活动数量:', userClaims.length);

    if (userClaims.length === 0) {
      console.log('未找到认领记录，尝试直接查询创建者...');
      // 尝试直接查找创建者
      const creator = await prisma.creator.findFirst({
        where: {
          OR: [
            { id: creatorId },
            { name: creatorName }
          ]
        }
      });

      if (!creator) {
        return res.status(400).json({
          status: 'fail',
          message: '未找到该创建者'
        });
      }

      return res.status(400).json({
        status: 'fail',
        message: '未找到该创建者的认领记录'
      });
    }

    // 使用第一个 claim 获取创建者信息
    const creatorClaim = userClaims[0];
    const actualCreatorId = creatorClaim.activity.creatorId;
    const actualCreatorName = creatorClaim.activity.creator.name;
    const actualCreatorLogo = creatorClaim.activity.creator.logo;
    console.log('使用创建者信息:', {
      id: actualCreatorId,
      name: actualCreatorName,
      logo: actualCreatorLogo
    });

    // 获取该创建者的所有NFT图片
    const nftsWithImages = userClaims.map(claim => ({
      name: claim.activity.name,
      image: claim.activity.nftImage,
      mintDate: claim.createdAt
    }));
    console.log('NFT 图片数量:', nftsWithImages.length);

    // 生成通行证
    const passId = uuidv4();
    const serialNumber = uuidv4();
    console.log('生成的 Pass ID:', passId);
    console.log('生成的序列号:', serialNumber);

    // 设置过期时间为一年后
    const expirationDate = new Date();
    expirationDate.setFullYear(expirationDate.getFullYear() + 1);
    console.log('Pass 过期时间:', expirationDate);

    // 创建 Pass 记录
    console.log('开始创建 Pass 数据库记录...');
    const passRecord = await prisma.pass.create({
      data: {
        id: passId,
        creatorId: actualCreatorId,
        creatorName: actualCreatorName,
        creatorLogo: actualCreatorLogo,
        userId,
        userName,
        userWalletAddress,
        serialNumber,
        expiresAt: expirationDate
      }
    });
    console.log('Pass 数据库记录创建成功:', passRecord);

    // 处理创建者logo
    let creatorLogoPath = path.join(__dirname, '../../public', actualCreatorLogo);
    const defaultLogoPath = path.join(__dirname, '../../public/assets/logos/default-logo.png');
    console.log('创建者 logo 路径:', creatorLogoPath);
    console.log('默认 logo 路径:', defaultLogoPath);

    try {
      await fs.access(creatorLogoPath);
      console.log('创建者 logo 文件存在:', creatorLogoPath);
    } catch (error) {
      console.log('创建者 logo 文件不存在，使用默认 logo');
      creatorLogoPath = defaultLogoPath;
    }

    // 读取logo文件并提取主色调
    const logoBuffer = await fs.readFile(creatorLogoPath);
    const backgroundColor = await extractDominantColor(logoBuffer);
    console.log('使用背景色:', backgroundColor);

    // 检查证书文件
    console.log('开始检查证书文件...');
    const certFiles = {
      wwdr: path.join(__dirname, '../../keys_fixed/wwdr.pem'),
      signerCert: path.join(__dirname, '../../keys_fixed/signerCert.pem'),
      signerKey: path.join(__dirname, '../../keys_fixed/signerKey.pem')
    };
    console.log('证书文件路径:', certFiles);

    // 读取证书内容
    console.log('读取证书内容...');
    const certificates = {
      wwdr: await fs.readFile(certFiles.wwdr, 'utf-8'),
      signerCert: await fs.readFile(certFiles.signerCert, 'utf-8'),
      signerKey: await fs.readFile(certFiles.signerKey, 'utf-8')
    };
    console.log('证书内容读取完成');

    // 创建临时目录用于生成 pass
    const tempDir = path.join(os.tmpdir(), `pass-${passId}.pass`);
    await fs.mkdir(tempDir, { recursive: true });
    console.log('创建临时目录:', tempDir);

    // 创建基础 pass.json
    const passJson = {
      formatVersion: 1,
      passTypeIdentifier: "pass.ai.datadance.app",
      teamIdentifier: "R2DAZ94F4S",
      serialNumber,
      description: `${actualCreatorName} Membership Pass`,
      organizationName: actualCreatorName,
      logoText: actualCreatorName,
      foregroundColor: 'rgb(255, 255, 255)',
      backgroundColor: backgroundColor,
      labelColor: 'rgb(255, 255, 255)',
      relevantDate: new Date().toISOString(),
      expirationDate: expirationDate.toISOString(),
      suppressStripShine: true,
      barcodes: [{
        message: userWalletAddress,
        format: "PKBarcodeFormatQR",
        messageEncoding: "iso-8859-1",
        altText: `Wallet: ${userWalletAddress.slice(0, 6)}...${userWalletAddress.slice(-4)}`
      }],
      storeCard: {
        headerFields: [],
        primaryFields: [],
        secondaryFields: [
          {
            key: "nftCount",
            label: "NFTs",
            value: nftsWithImages.length.toString()
          },
          {
            key: "wallet",
            label: "Wallet",
            value: `${userWalletAddress.slice(0, 6)}...${userWalletAddress.slice(-4)}`
          },
          {
            key: "name",
            label: "Name",
            value: userName
          },
          {
            key: "status",
            label: "Status",
            value: "MEMBER"
          }
        ],
        auxiliaryFields: [],
        backFields: [
          {
            key: "wallet-full",
            label: "Wallet Address",
            value: userWalletAddress
          },
          {
            key: "nft-list",
            label: "NFT Collection",
            value: nftsWithImages.map(nft => 
              `${nft.name}\nMint Date: ${new Date(nft.mintDate).toLocaleDateString()}`
            ).join("\n\n")
          },
          {
            key: "expiry",
            label: "Valid Until",
            value: expirationDate.toLocaleDateString()
          }
        ]
      }
    };

    // 写入临时的 pass.json
    await fs.writeFile(path.join(tempDir, 'pass.json'), JSON.stringify(passJson, null, 2));

    // 创建 PKPass 实例
    console.log('创建 PKPass 实例...');
    
    // 处理创建者头像
    const creatorAvatarPath = path.join(__dirname, '../../public', actualCreatorLogo);
    console.log('使用创建者头像路径:', creatorAvatarPath);
    const avatarBuffer = await fs.readFile(creatorAvatarPath);

    // 生成圆形裁剪的 icon
    const iconSizes = {
      'icon.png': 29,
      'icon@2x.png': 58,
      'icon@3x.png': 87
    };

    // 先生成所有图片文件
    for (const [filename, size] of Object.entries(iconSizes)) {
      console.log(`处理 ${filename}, 尺寸: ${size}x${size}`);
      
      // 创建圆形蒙版
      const svgCircle = `
        <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
          <circle cx="${size/2}" cy="${size/2}" r="${size/2}" fill="white"/>
        </svg>
      `;
      
      // 先调整图片大小并转为 PNG
      const resized = await sharp(avatarBuffer)
        .resize(size, size, {
          fit: 'cover',
          position: 'center'
        })
        .png()
        .toBuffer();

      // 应用圆形蒙版
      const iconBuffer = await sharp(resized)
        .composite([{
          input: Buffer.from(svgCircle),
          blend: 'dest-in'
        }])
        .png()
        .toBuffer();

      await fs.writeFile(path.join(tempDir, filename), iconBuffer);
      console.log(`${filename} 圆形裁剪完成`);
    }

    // 生成 logo（不需要圆形裁剪）
    const logoSizes = {
      'logo.png': 29,
      'logo@2x.png': 58,
      'logo@3x.png': 87
    };

    for (const [filename, size] of Object.entries(logoSizes)) {
      console.log(`处理 ${filename}, 尺寸: ${size}x${size}`);
      const logoBuffer = await sharp(avatarBuffer)
        .resize(size, size, {
          fit: 'cover',
          position: 'center'
        })
        .png()
        .toBuffer();
      
      await fs.writeFile(path.join(tempDir, filename), logoBuffer);
    }

    // 生成 strip 图片（拼接 NFT 图片）
    const stripSizes = {
      'strip.png': { width: 624, height: 250 },
      'strip@2x.png': { width: 1248, height: 500 },
      'strip@3x.png': { width: 1872, height: 750 }
    };

    // 获取 NFT 图片路径
    const nftImages = nftsWithImages.map(nft => path.join(__dirname, '../../public', nft.image));
    console.log('NFT 图片路径:', nftImages);

    for (const [filename, dimensions] of Object.entries(stripSizes)) {
      console.log(`处理 ${filename}, 尺寸: ${dimensions.width}x${dimensions.height}`);
      
      // 验证和处理 NFT 图片
      const validImages = [];
      for (const imagePath of nftImages) {
        try {
          const imageBuffer = await fs.readFile(imagePath);
          validImages.push(imageBuffer);
        } catch (error) {
          console.error(`无法读取 NFT 图片: ${imagePath}`, error);
        }
      }

      // 限制最多处理3张图片
      const imagesToProcess = validImages.slice(0, Math.min(3, validImages.length));
      
      if (imagesToProcess.length === 0) {
        console.log('没有有效的 NFT 图片，创建空的 strip');
        // 创建空的透明背景
        const emptyStrip = await sharp({
          create: {
            width: dimensions.width,
            height: dimensions.height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 }
          }
        })
        .png()
        .toBuffer();
        
        await fs.writeFile(path.join(tempDir, filename), emptyStrip);
        continue;
      }

      // 处理每张 NFT 图片
      const processedImages = [];
      for (let i = 0; i < imagesToProcess.length; i++) {
        const imageBuffer = imagesToProcess[i];
        let width = dimensions.width;
        
        // 根据图片数量调整宽度
        if (imagesToProcess.length === 2) {
          width = dimensions.width / 2;
        } else if (imagesToProcess.length === 3) {
          width = dimensions.width / 3;
        }

        const resizedImage = await sharp(imageBuffer)
          .resize(width, dimensions.height, {
            fit: 'cover',
            position: 'center'
          })
          .toBuffer();
        
        processedImages.push({
          input: resizedImage,
          left: i * width,
          top: 0
        });
      }

      // 创建最终的 strip 图片
      const stripBuffer = await sharp({
        create: {
          width: dimensions.width,
          height: dimensions.height,
          channels: 4,
          background: { r: 0, g: 0, b: 0, alpha: 0 }
        }
      })
      .composite(processedImages)
      .png()
      .toBuffer();

      await fs.writeFile(path.join(tempDir, filename), stripBuffer);
    }

    // 创建 PKPass 实例
    const pkPass = await PKPass.from({
      model: tempDir,
      certificates
    });
    console.log('PKPass 实例创建成功');

    // 生成 pass buffer
    console.log('生成 Pass Buffer...');
    const passBuffer = await pkPass.getAsBuffer();
    console.log('Pass Buffer 生成完成，大小:', passBuffer.length);

    // 清理临时目录
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
      console.log('临时目录已清理:', tempDir);
    } catch (error) {
      console.error('清理临时目录失败:', error);
    }

    // 确保公共目录存在
    const passDir = path.join(__dirname, '../../public/assets/passes');
    await fs.mkdir(passDir, { recursive: true });
    console.log('Pass 目录已创建:', passDir);

    // 保存 .pkpass 文件
    const passPath = path.join(passDir, `${passId}.pkpass`);
    console.log('保存 Pass 文件:', passPath);
    await fs.writeFile(passPath, passBuffer);
    console.log('Pass 文件保存成功');

    // 设置定时器在一段时间后删除文件（例如 5 分钟）
    setTimeout(async () => {
      try {
        await fs.unlink(passPath);
        console.log('Pass 文件已自动删除:', passPath);
      } catch (error) {
        console.error('删除 Pass 文件失败:', error);
      }
    }, 5 * 60 * 1000); // 5 分钟后删除

    // 生成 pass URL (使用非 API 路径以避免认证检查)
    const passUrl = `/assets/passes/${passId}.pkpass`;
    console.log('Pass URL:', passUrl);

    // 更新 pass 记录
    console.log('更新 Pass 数据库记录...');
    const updatedPassRecord = await prisma.pass.update({
      where: { id: passId },
      data: {
        passUrl
      }
    });
    console.log('Pass 数据库记录更新成功:', updatedPassRecord);

    console.log('Pass 生成完成');
    
    // 获取 API 基础 URL，移除 /api 后缀
    const baseUrl = process.env.API_BASE_URL 
      ? process.env.API_BASE_URL.replace(/\/api$/, '')
      : `http://localhost:${process.env.PORT || 3000}`;
    console.log('使用基础 URL:', baseUrl);
    
    res.status(200).json({
      status: 'success',
      data: {
        passUrl: `${baseUrl}${passUrl}`,  // 使用非 API 路径
        expiresAt: updatedPassRecord.expiresAt
      }
    });
  } catch (error) {
    console.error('生成 Pass 时出错:', error);
    res.status(500).json({
      status: 'error',
      message: '生成 Pass 失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 获取用户的所有 Pass
 * @route GET /assets/passes
 * @access Private
 */
exports.getUserPasses = async (req, res) => {
  try {
    const userId = req.user.id;

    const passes = await prisma.pass.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    res.status(200).json({
      status: 'success',
      data: {
        passes: passes.map(pass => ({
          ...pass,
          passUrl: `${process.env.API_BASE_URL}${pass.passUrl}`
        }))
      }
    });
  } catch (error) {
    console.error('获取用户 Pass 列表时出错:', error);
    res.status(500).json({
      status: 'error',
      message: '获取 Pass 列表失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 获取单个 Pass 详情
 * @route GET /assets/passes/:passId
 * @access Private
 */
exports.getPassDetail = async (req, res) => {
  try {
    const { passId } = req.params;
    const userId = req.user.id;

    const pass = await prisma.pass.findFirst({
      where: {
        id: passId,
        userId
      }
    });

    if (!pass) {
      return res.status(404).json({
        status: 'fail',
        message: 'Pass 不存在'
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        ...pass,
        passUrl: `${process.env.API_BASE_URL}${pass.passUrl}`
      }
    });
  } catch (error) {
    console.error('获取 Pass 详情时出错:', error);
    res.status(500).json({
      status: 'error',
      message: '获取 Pass 详情失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

/**
 * 更新 Pass 状态
 * @route PATCH /assets/passes/:passId/status
 * @access Private
 */
exports.updatePassStatus = async (req, res) => {
  try {
    const { passId } = req.params;
    const { status } = req.body;
    const userId = req.user.id;

    // 验证状态值
    if (!['active', 'revoked', 'expired'].includes(status)) {
      return res.status(400).json({
        status: 'fail',
        message: '无效的状态值'
      });
    }

    const pass = await prisma.pass.findFirst({
      where: {
        id: passId,
        userId
      }
    });

    if (!pass) {
      return res.status(404).json({
        status: 'fail',
        message: 'Pass 不存在'
      });
    }

    const updatedPass = await prisma.pass.update({
      where: { id: passId },
      data: { status }
    });

    res.status(200).json({
      status: 'success',
      data: {
        id: updatedPass.id,
        status: updatedPass.status
      }
    });
  } catch (error) {
    console.error('更新 Pass 状态时出错:', error);
    res.status(500).json({
      status: 'error',
      message: '更新 Pass 状态失败',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}; 