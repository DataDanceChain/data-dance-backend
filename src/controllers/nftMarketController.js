const { Prisma, PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const LIST_PAGE_DEFAULT = 24;
const LIST_PAGE_MAX = 60;

const listSelect = {
  id: true,
  name: true,
  description: true,
  price: true,
  image: true,
  dataSource: true,
  merchant: { select: { id: true, name: true, avatar: true } },
  tags: { select: { id: true, name: true } },
};

function toCard(nft, size) {
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
    tags: (nft.tags || []).map((tag) => ({ id: tag.id, name: tag.name })),
  };
}

function searchScore(nft, query) {
  const s = query.toLowerCase();
  let score = 0;
  if (nft.name?.toLowerCase().includes(s)) score += 3;
  if (nft.merchant?.name?.toLowerCase().includes(s)) score += 2;
  if (nft.description?.toLowerCase().includes(s)) score += 1;
  if (nft.tags?.some((tag) => tag.name?.toLowerCase().includes(s))) score += 0.5;
  return score;
}

async function sizesById(ids) {
  const sizes = new Map();
  if (!ids.length) return sizes;

  const uploadRows = await prisma.$queryRaw`
    SELECT id, COALESCE(("dataRecords"->>'recordCount')::int, 0) AS size
    FROM "DataNFT"
    WHERE id IN (${Prisma.join(ids)})
      AND "dataSource" = 'upload'
  `;
  for (const row of uploadRows) {
    sizes.set(row.id, Number(row.size) || 0);
  }

  for (const id of ids) {
    if (!sizes.has(id)) sizes.set(id, 0);
  }
  return sizes;
}

function publishedWhere(tag, search) {
  const where = { isPublished: true };
  if (tag) where.tags = { some: { name: tag } };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
      { merchant: { name: { contains: search, mode: 'insensitive' } } },
      { tags: { some: { name: { contains: search, mode: 'insensitive' } } } },
    ];
  }
  return where;
}

exports.getMarketTags = async (req, res) => {
  try {
    const tags = await prisma.tag.findMany({
      where: { dataNFTs: { some: { isPublished: true } } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    res.status(200).json({ status: 'success', data: tags });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

// Catalog list: never load dataRecords or snapshots. Those blobs make the old list slow.
exports.getMarketList = async (req, res) => {
  try {
    const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : '';
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(LIST_PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || LIST_PAGE_DEFAULT));
    const where = publishedWhere(tag, search);

    const total = await prisma.dataNFT.count({ where });
    let rows;
    if (search) {
      const matched = await prisma.dataNFT.findMany({
        where,
        select: listSelect,
      });
      matched.sort((a, b) => searchScore(b, search) - searchScore(a, search) || b.price - a.price);
      rows = matched.slice((page - 1) * limit, page * limit);
    } else {
      rows = await prisma.dataNFT.findMany({
        where,
        select: listSelect,
        orderBy: [{ price: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      });
    }

    const sizes = await sizesById(rows.map((row) => row.id));
    const data = rows.map((row) => toCard(row, sizes.get(row.id) || 0));
    res.status(200).json({
      status: 'success',
      data,
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

exports.getMarketDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id },
      select: {
        ...listSelect,
        isPublished: true,
      },
    });
    if (!dataNFT || !dataNFT.isPublished) {
      return res.status(404).json({ status: 'fail', message: 'NFT Data not found or not for sale' });
    }
    const [sales, sizes] = await Promise.all([
      prisma.dataNFTPurchase.aggregate({
        _count: { id: true },
        where: { dataNFTId: id },
      }),
      sizesById([id]),
    ]);
    res.status(200).json({
      status: 'success',
      data: {
        ...toCard(dataNFT, sizes.get(id) || 0),
        sales: sales._count.id || 0,
        revenue: (sales._count.id || 0) * dataNFT.price || 0,
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

exports.purchaseMarketNFT = async (req, res) => {
  try {
    const { id } = req.params;
    const buyerId = req.user.id;
    const dataNFT = await prisma.dataNFT.findUnique({ where: { id } });
    if (!dataNFT || !dataNFT.isPublished) {
      return res.status(404).json({ status: 'fail', message: 'NFT Data not found or not for sale' });
    }
    if (dataNFT.merchantId === buyerId) {
      return res.status(403).json({ status: 'fail', message: 'Cannot purchase your own NFT Data' });
    }
    const existingPurchase = await prisma.dataNFTPurchase.findFirst({
      where: { dataNFTId: id, buyerId },
    });
    if (existingPurchase) {
      return res.status(400).json({ status: 'fail', message: 'Already purchased this NFT Data' });
    }
    const purchase = await prisma.dataNFTPurchase.create({
      data: { dataNFTId: id, buyerId },
    });
    res.status(200).json({
      status: 'success',
      message: 'Purchase successful',
      data: {
        orderId: purchase.id,
        nftId: id,
        price: dataNFT.price,
        purchasedAt: purchase.createdAt,
      },
    });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

exports.getMyPurchases = async (req, res) => {
  try {
    const buyerId = req.user.id;
    const purchases = await prisma.dataNFTPurchase.findMany({
      where: { buyerId },
      include: { dataNFT: { include: { merchant: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const data = purchases.map((p) => ({
      orderId: p.id,
      nftId: p.dataNFTId,
      title: p.dataNFT.name,
      coverImage: p.dataNFT.image,
      price: p.dataNFT.price,
      purchasedAt: p.createdAt,
    }));
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};

exports.getMySales = async (req, res) => {
  try {
    const merchantId = req.user.id;
    const dataNFTs = await prisma.dataNFT.findMany({
      where: { merchantId, isPublished: true },
      include: { purchases: true },
    });
    const data = dataNFTs.map((nft) => ({
      nftId: nft.id,
      title: nft.name,
      coverImage: nft.image,
      sales: nft.purchases.length,
      revenue: nft.purchases.length * nft.price,
    }));
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    res.status(500).json({ status: 'error', message: 'Server error', error: error.message });
  }
};
