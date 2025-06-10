const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// 获取市场 NFT 数据资产列表
exports.getMarketList = async (req, res) => {
  try {
    const { tag, search } = req.query;
    const where = {
      isPublished: true
    };
    if (tag) {
      where.tags = { some: { name: tag } };
    }
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { merchant: { name: { contains: search, mode: 'insensitive' } } },
        { tags: { some: { name: { contains: search, mode: 'insensitive' } } } }
      ];
    }
    const dataNFTs = await prisma.dataNFT.findMany({
      where,
      include: {
        merchant: true,
        tags: true,
        snapshots: {
          include: {
            activity: true
          }
        }
      },
      orderBy: search ? undefined : { createdAt: 'desc' }
    });
    let data = dataNFTs.map(nft => {
      const userIds = nft.snapshots.map(s => s.userId).filter(Boolean);
      const size = new Set(userIds).size;
      // 计算关联度分数
      let score = 0;
      if (search) {
        const s = search.toLowerCase();
        if (nft.name?.toLowerCase().includes(s)) score += 3;
        if (nft.merchant?.name?.toLowerCase().includes(s)) score += 2;
        if (nft.description?.toLowerCase().includes(s)) score += 1;
        if (nft.tags?.some(t => t.name?.toLowerCase().includes(s))) score += 0.5;
      }
      return {
        id: nft.id,
        title: nft.name,
        coverImage: nft.image,
        owner: nft.merchant?.name,
        ownerId: nft.merchant?.id,
        ownerAvatar: nft.merchant?.avatar,
        size,
        price: nft.price,
        description: nft.description,
        tags: nft.tags.map(t => t.name),
        _score: score
      };
    });
    if (search) {
      data = data.sort((a, b) => b._score - a._score);
    }
    // 移除 _score 字段
    data = data.map(({ _score, ...rest }) => rest);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

// 获取市场 NFT 数据资产详情
exports.getMarketDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id },
      include: { 
        merchant: true, 
        tags: true,
        snapshots: {
          include: {
            activity: true
          }
        }
      }
    });
    if (!dataNFT || !dataNFT.isPublished) {
      return res.status(404).json({ status: 'fail', message: 'NFT Data not found or not for sale' });
    }
    // 统计销量和收入
    const sales = await prisma.dataNFTPurchase.aggregate({
      _count: { id: true },
      where: { dataNFTId: id }
    });
    // 计算实际数据量
    const userIds = dataNFT.snapshots.map(s => s.userId).filter(Boolean);
    const size = new Set(userIds).size;
    res.status(200).json({
      status: 'success',
      data: {
        id: dataNFT.id,
        title: dataNFT.name,
        coverImage: dataNFT.image,
        owner: dataNFT.merchant?.name,
        ownerId: dataNFT.merchant?.id,
        ownerAvatar: dataNFT.merchant?.avatar,
        size,
        price: dataNFT.price,
        description: dataNFT.description,
        tags: dataNFT.tags.map(t => t.name),
        sales: sales._count.id || 0,
        revenue: sales._count.id * dataNFT.price || 0
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

// 购买市场 NFT 数据资产
exports.purchaseMarketNFT = async (req, res) => {
  try {
    const { id } = req.params;
    const buyerId = req.user.id;
    const dataNFT = await prisma.dataNFT.findUnique({ where: { id } });
    if (!dataNFT || !dataNFT.isPublished) {
      return res.status(404).json({ status: 'fail', message: 'NFT Data not found or not for sale' });
    }
    // 不能购买自己发售的
    if (dataNFT.merchantId === buyerId) {
      return res.status(403).json({ status: 'fail', message: 'Cannot purchase your own NFT Data' });
    }
    // 检查是否已购买
    const existingPurchase = await prisma.dataNFTPurchase.findFirst({
      where: {
        dataNFTId: id,
        buyerId
      }
    });
    if (existingPurchase) {
      return res.status(400).json({ status: 'fail', message: 'Already purchased this NFT Data' });
    }
    // 创建购买记录
    const purchase = await prisma.dataNFTPurchase.create({
      data: {
        dataNFTId: id,
        buyerId
      }
    });
    res.status(200).json({
      status: 'success',
      message: 'Purchase successful',
      data: {
        orderId: purchase.id,
        nftId: id,
        price: dataNFT.price,
        purchasedAt: purchase.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

// 获取我购买的 NFT 数据资产
exports.getMyPurchases = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const purchases = await prisma.dataNFTPurchase.findMany({
      where: { buyerId },
      include: { 
        dataNFT: { 
          include: { 
            merchant: true 
          } 
        } 
      },
      orderBy: { createdAt: 'desc' }
    });
    const data = purchases.map(p => ({
      orderId: p.id,
      nftId: p.dataNFTId,
      title: p.dataNFT.name,
      coverImage: p.dataNFT.image,
      price: p.dataNFT.price,
      purchasedAt: p.createdAt
    }));
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

// 获取我发售的 NFT 数据资产及销售情况
exports.getMySales = async (req, res) => {
  try {
    const merchantId = req.user.id;
    const dataNFTs = await prisma.dataNFT.findMany({
      where: { merchantId, isPublished: true },
      include: { purchases: true }
    });
    const data = dataNFTs.map(nft => ({
      nftId: nft.id,
      title: nft.name,
      coverImage: nft.image,
      sales: nft.purchases.length,
      revenue: nft.purchases.length * nft.price
    }));
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
}; 