const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const { PKPass } = require('passkit-generator');
const crypto = require('crypto');
const sharp = require('sharp');
const axios = require('axios');

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
      brandId,
      brandName,
      brandLogo,
      userId,
      userName,
      userWalletAddress
    } = req.body;

    console.log('请求参数:', { brandId, brandName, brandLogo, userId, userName, userWalletAddress });

    // 验证必要参数
    if (!brandId || !brandName || !userId || !userName || !userWalletAddress) {
      return res.status(400).json({
        status: 'fail',
        message: '缺少必要参数'
      });
    }

    // 获取用户已领取的该商家的活动
    console.log('获取用户已领取的商家活动...');
    console.log('查询条件:', {
      userId,
      brandName,
      status: 'CLAIMED'
    });

    // 查询用户的所有已领取活动
    const userClaims = await prisma.activityClaim.findMany({
      where: {
        userId: userId,
        status: 'CLAIMED',
      },
      include: {
        activity: {
          include: {
            creator: true,
            categories: true,
            tags: true
          }
        }
      },
      orderBy: {
        claimedAt: 'desc'
      }
    });

    console.log('用户所有已领取的活动数据:', JSON.stringify({
      totalClaims: userClaims.length,
      claims: userClaims.map(claim => ({
        id: claim.id,
        activityId: claim.activityId,
        status: claim.status,
        claimedAt: claim.claimedAt,
        activity: {
          id: claim.activity.id,
          title: claim.activity.title,
          creator: claim.activity.creator,
          categories: claim.activity.categories,
          tags: claim.activity.tags
        }
      }))
    }, null, 2));

    // 过滤当前商家的活动 - 使用商家名称匹配
    const brandClaims = userClaims.filter(claim => 
      claim.activity.creator.name === brandName
    );

    console.log('当前商家的活动数据:', JSON.stringify({
      brandName,
      totalBrandClaims: brandClaims.length,
      claims: brandClaims.map(claim => ({
        id: claim.id,
        activityId: claim.activityId,
        status: claim.status,
        claimedAt: claim.claimedAt,
        activity: {
          id: claim.activity.id,
          title: claim.activity.title,
          creator: claim.activity.creator,
          categories: claim.activity.categories,
          tags: claim.activity.tags
        }
      }))
    }, null, 2));

    // 处理NFT数据，添加图片路径
    const nftsWithImages = brandClaims.map(claim => {
      const imageUrl = claim.activity.nftImage || claim.activity.image;
      console.log('处理NFT图片:', {
        activityId: claim.activity.id,
        nftImage: claim.activity.nftImage,
        image: claim.activity.image,
        imageUrl
      });
      
      // 检查图片是否存在
      const imagePath = path.join(__dirname, '../../public', imageUrl);
      console.log('完整图片路径:', imagePath);
      
      return {
        id: claim.activity.id,
        name: claim.activity.nftName || claim.activity.title,
        description: claim.activity.nftDescription || claim.activity.description,
        imageUrl: imagePath,
        contractAddress: claim.activity.contractAddress,
        chainId: claim.activity.chainId,
        mintDate: claim.claimedAt,
        categories: claim.activity.categories,
        tags: claim.activity.tags,
        openseaUrl: claim.activity.contractAddress ? 
          `https://opensea.io/assets/ethereum/${claim.activity.contractAddress}/${claim.activity.id}` :
          null
      };
    });

    console.log('处理后的NFT数据:', JSON.stringify(nftsWithImages, null, 2));

    // 生成唯一的 pass ID
    const passId = uuidv4();
    console.log('生成 Pass ID:', passId);
    
    // 设置过期时间（默认一年后）
    const expiresAt = new Date();
    expiresAt.setFullYear(expiresAt.getFullYear() + 1);

    // 创建 pass 目录
    const modelPath = path.join(__dirname, '../../keys/passes/models/membership.pass');
    await fs.mkdir(modelPath, { recursive: true });

    // 如果有NFT数据，生成strip图片
    if (nftsWithImages.length > 0) {
      console.log('开始处理NFT图片生成strip...');
      const stripPath = path.join(modelPath, 'strip.png');
      
      // 验证所有图片路径是否存在
      for (const nft of nftsWithImages) {
        try {
          await fs.access(nft.imageUrl);
          const stats = await fs.stat(nft.imageUrl);
          console.log(`图片文件存在: ${nft.imageUrl}, 大小: ${stats.size} 字节`);
        } catch (error) {
          console.error(`图片文件不存在或无法访问: ${nft.imageUrl}`);
          console.error(error);
          // 如果图片不存在，跳过生成strip
          console.log('由于图片不存在，跳过生成strip');
          continue;
        }
      }

      try {
        await generateStripImage(
          nftsWithImages.map(nft => nft.imageUrl),
          stripPath
        );
        console.log('Strip 图片生成完成');

        // 验证生成的strip图片
        const stats = await fs.stat(stripPath);
        console.log(`Strip 图片已生成: ${stripPath}, 大小: ${stats.size} 字节`);
      } catch (error) {
        console.error('生成strip图片失败，继续生成Pass:', error);
        // 即使strip生成失败，也继续生成Pass
      }
    }

    // Pass 配置
    const passData = {
      formatVersion: 1,
      passTypeIdentifier: "pass.ai.datadance.app",
      serialNumber: passId,
      teamIdentifier: "R2DAZ94F4S",
      organizationName: brandName,
      description: `${brandName} Membership Pass`,
      logoText: brandName,
      foregroundColor: "rgb(255, 255, 255)",
      backgroundColor: "rgb(10, 32, 77)",
      labelColor: "rgb(200, 200, 200)",
      stripColor: "rgb(10, 32, 77)",
      strip: {
        backgroundColor: "rgb(10, 32, 77)"
      },
      suppressStripShine: true,  // 禁用strip的光泽效果
      barcodes: [
        {
          message: userWalletAddress,
          format: "PKBarcodeFormatQR",
          messageEncoding: "iso-8859-1",
          altText: `Wallet: ${userWalletAddress.slice(0, 6)}...${userWalletAddress.slice(-4)}`
        }
      ],
      storeCard: {
        secondaryFields: [
          {
            key: "name",
            label: "MEMBER",
            value: userName
          },
          {
            key: "wallet",
            label: "WALLET ID",
            value: `${userWalletAddress.slice(0, 6)}...${userWalletAddress.slice(-4)}`
          }
        ],
        auxiliaryFields: [
          {
            key: "nftCount",
            label: "TOTAL NFTs",
            value: String(nftsWithImages.length)
          },
          {
            key: "lastMint",
            label: "LAST MINT",
            value: nftsWithImages.length > 0 ? 
              new Date(nftsWithImages[0].mintDate).toLocaleDateString() : 
              new Date().toLocaleDateString()
          }
        ],
        backFields: [
          {
            key: "brandName",
            label: "Brand",
            value: brandName
          },
          {
            key: "walletAddress",
            label: "Full Wallet Address",
            value: userWalletAddress
          },
          {
            key: "nftList",
            label: "Your NFTs",
            value: nftsWithImages.length > 0 ? 
              nftsWithImages.map((nft, index) => 
                `${index + 1}. ${nft.name}\n` +
                `Type: ${nft.categories.map(c => c.name).join(', ')}\n` +
                `Tags: ${nft.tags.map(t => t.name).join(', ')}\n` +
                `Mint Date: ${new Date(nft.mintDate).toLocaleDateString()}\n` +
                (nft.openseaUrl ? `View: ${nft.openseaUrl}\n` : '') +
                `\n`
              ).join('') :
              "No NFTs found"
          },
          {
            key: "expiry",
            label: "Valid Until",
            value: expiresAt.toLocaleDateString()
          }
        ]
      }
    };

    console.log('Pass 配置:', JSON.stringify(passData, null, 2));

    // 创建临时的 pass.json 文件
    const passJsonPath = path.join(modelPath, 'pass.json');
    console.log('写入配置文件:', passJsonPath);
    
    await fs.writeFile(passJsonPath, JSON.stringify(passData, null, 2));

    // 检查证书文件
    const certFiles = {
      wwdr: path.join(__dirname, '../../keys_fixed/wwdr.pem'),
      signerCert: path.join(__dirname, '../../keys_fixed/signerCert.pem'),
      signerKey: path.join(__dirname, '../../keys_fixed/signerKey.pem')
    };

    // 验证证书
    for (const [key, filePath] of Object.entries(certFiles)) {
      try {
        const certContent = await fs.readFile(filePath, 'utf-8');
        
        // 尝试使用 Node.js 的加密模块验证证书
        if (key === 'signerKey') {
          // 验证私钥
          try {
            crypto.createPrivateKey(certContent);
            console.log(`${key} 私钥验证成功`);
          } catch (e) {
            throw new Error(`${key} 私钥格式无效: ${e.message}`);
          }
        } else {
          // 验证证书
          try {
            crypto.createPublicKey(certContent);
            console.log(`${key} 证书验证成功`);
          } catch (e) {
            throw new Error(`${key} 证书格式无效: ${e.message}`);
          }
        }
      } catch (error) {
        console.error(`${key} 证书验证失败:`, error.message);
        throw error;
      }
    }

    // 检查资源文件
    const resourceFiles = [
      'icon.png',
      'icon@2x.png',
      'icon@3x.png',
      'logo.png',
      'logo@2x.png',
      'logo@3x.png'
    ];

    for (const file of resourceFiles) {
      const filePath = path.join(modelPath, file);
      try {
        await fs.access(filePath);
        console.log(`资源文件存在:`, file);
      } catch (error) {
        console.warn(`资源文件不存在:`, file);
      }
    }

    console.log('开始创建 Pass...');
    
    // 读取证书内容
    const certificates = {
      wwdr: await fs.readFile(certFiles.wwdr, 'utf-8'),
      signerCert: await fs.readFile(certFiles.signerCert, 'utf-8'),
      signerKey: await fs.readFile(certFiles.signerKey, 'utf-8')
    };

    // 创建 pass
    const pass = await PKPass.from({
      model: modelPath,
      certificates
    });

    console.log('生成 Pass Buffer...');
    // 生成 pass buffer
    const passBuffer = await pass.getAsBuffer();

    // 确保目录存在
    const passDir = path.join(__dirname, '../../public/assets/passes');
    await fs.mkdir(passDir, { recursive: true });

    // 保存 .pkpass 文件
    const passPath = path.join(passDir, `${passId}.pkpass`);
    console.log('保存 Pass 文件:', passPath);
    await fs.writeFile(passPath, passBuffer);

    // 生成 pass URL（不再使用 API 前缀）
    const passUrl = `/assets/passes/${passId}.pkpass`;

    // 创建 pass 记录
    const passRecord = await prisma.pass.create({
      data: {
        id: passId,
        brandId,
        brandName,
        brandLogo,
        userId,
        userName,
        userWalletAddress,
        passUrl,
        expiresAt
      }
    });

    console.log('Pass 生成完成');
    
    // 获取 API 基础 URL，如果环境变量未设置则使用默认值
    const apiBaseUrl = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
    
    res.status(200).json({
      status: 'success',
      data: {
        passUrl: `${apiBaseUrl}${passUrl}`,
        expiresAt: passRecord.expiresAt
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