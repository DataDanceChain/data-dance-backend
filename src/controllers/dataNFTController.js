const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Create a DataNFT bundle from snapshots
const mergeSnapshots = async (req, res) => {
  try {
    const { snapshotIds, name, description, price, tags } = req.body;
    const merchantId = req.user.id;
    let image = req.body.image;
    if (req.file) {
      // 新上传的图片
      image = '/assets/nfts/' + req.file.filename;
    }

    // Validate snapshots
    const snapshots = await prisma.snapshot.findMany({
      where: {
        id: { in: snapshotIds },
        merchantId
      },
      include: {
        activity: true
      }
    });

    if (snapshots.length !== snapshotIds.length) {
      return res.status(400).json({ error: 'Some snapshots not found or not owned by merchant' });
    }

    // Create DataNFT
    const dataNFT = await prisma.dataNFT.create({
      data: {
        name,
        description,
        price,
        image,
        merchantId,
        snapshots: {
          connect: snapshotIds.map(id => ({ id }))
        },
        tags: {
          connect: tags ? tags.map(id => ({ id })) : []
        }
      },
      include: {
        snapshots: true,
        tags: true
      }
    });

    res.status(201).json(dataNFT);
  } catch (error) {
    console.error('[mergeSnapshots] Error:', error);
    console.error('[mergeSnapshots] Request body:', req.body);
    console.error('[mergeSnapshots] merchantId:', req.user?.id);
    res.status(500).json({ error: 'Failed to create DataNFT', detail: error.message, stack: error.stack });
  }
};

// Get all DataNFTs with pagination and filters
const getDataNFTs = async (req, res) => {
  try {
    const { page = 1, limit = 10, search, minPrice, maxPrice, tags, allMine } = req.query;
    const skip = (page - 1) * limit;

    const where = {};

    if (allMine === 'true') {
      where.merchantId = req.user.id;
    } else {
      where.isPublished = true;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } }
      ];
    }

    console.log('allMine:', allMine, 'req.user.id:', req.user.id);
    console.log('where:', where);

    if (minPrice) {
      where.price = { gte: parseFloat(minPrice) };
    }

    if (maxPrice) {
      where.price = { lte: parseFloat(maxPrice) };
    }

    if (tags) {
      where.tags = {
        some: {
          id: { in: tags.split(',') }
        }
      };
    }

    const [dataNFTs, total] = await Promise.all([
      prisma.dataNFT.findMany({
        where,
        skip: parseInt(limit) * (parseInt(page) - 1),
        take: parseInt(limit),
        include: {
          merchant: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          },
          snapshots: {
            include: {
              activity: true
            }
          },
          tags: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.dataNFT.count({ where })
    ]);

    // 为每个 DataNFT 计算 size 字段
    const dataWithSize = dataNFTs.map(nft => {
      // 获取所有 snapshots 的 claims
      const allClaims = nft.snapshots.flatMap(s => s.claims || []);
      // 获取所有不重复的 userId
      const uniqueUserIds = [...new Set(allClaims.map(c => c.userId).filter(Boolean))];
      const size = uniqueUserIds.length;
      return { ...nft, size };
    });

    res.json({
      data: dataWithSize,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching DataNFTs:', error);
    res.status(500).json({ error: 'Failed to fetch DataNFTs' });
  }
};

// Get a specific DataNFT
const getDataNFTById = async (req, res) => {
  try {
    const { id } = req.params;
    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id },
      include: {
        merchant: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        },
        snapshots: {
          include: {
            activity: true
          }
        },
        tags: true
      }
    });

    if (!dataNFT) {
      return res.status(404).json({ error: 'DataNFT not found' });
    }

    // 计算 size 字段
    const userIds = dataNFT.snapshots.map(s => s.userId).filter(Boolean);
    const size = new Set(userIds).size;
    res.json({ ...dataNFT, size });
  } catch (error) {
    console.error('Error fetching DataNFT:', error);
    res.status(500).json({ error: 'Failed to fetch DataNFT' });
  }
};

// Update a DataNFT
const updateDataNFT = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, tags } = req.body;
    const merchantId = req.user.id;
    let image = req.body.image;
    if (req.file) {
      image = '/assets/nfts/' + req.file.filename;
    }

    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id }
    });

    if (!dataNFT) {
      return res.status(404).json({ error: 'DataNFT not found' });
    }

    if (dataNFT.merchantId !== merchantId) {
      return res.status(403).json({ error: 'Not authorized to update this DataNFT' });
    }

    if (dataNFT.isPublished) {
      return res.status(400).json({ error: 'Cannot update published DataNFT' });
    }

    const updatedDataNFT = await prisma.dataNFT.update({
      where: { id },
      data: {
        name,
        description,
        price,
        image,
        tags: {
          set: tags.map(id => ({ id }))
        }
      },
      include: {
        snapshots: true,
        tags: true
      }
    });

    res.json(updatedDataNFT);
  } catch (error) {
    console.error('Error updating DataNFT:', error);
    res.status(500).json({ error: 'Failed to update DataNFT' });
  }
};

// Delete a DataNFT
const deleteDataNFT = async (req, res) => {
  try {
    const { id } = req.params;
    const merchantId = req.user.id;

    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id }
    });

    if (!dataNFT) {
      return res.status(404).json({ error: 'DataNFT not found' });
    }

    if (dataNFT.merchantId !== merchantId) {
      return res.status(403).json({ error: 'Not authorized to delete this DataNFT' });
    }

    if (dataNFT.isPublished) {
      return res.status(400).json({ error: 'Cannot delete published DataNFT' });
    }

    await prisma.dataNFT.delete({
      where: { id }
    });

    res.status(204).send();
  } catch (error) {
    console.error('Error deleting DataNFT:', error);
    res.status(500).json({ error: 'Failed to delete DataNFT' });
  }
};

// Publish a DataNFT
const publishDataNFT = async (req, res) => {
  try {
    const { id } = req.params;
    const merchantId = req.user.id;

    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id }
    });

    if (!dataNFT) {
      return res.status(404).json({ error: 'DataNFT not found' });
    }

    if (dataNFT.merchantId !== merchantId) {
      return res.status(403).json({ error: 'Not authorized to publish this DataNFT' });
    }

    const publishedDataNFT = await prisma.dataNFT.update({
      where: { id },
      data: { isPublished: true },
      include: {
        snapshots: true,
        tags: true
      }
    });

    res.json(publishedDataNFT);
  } catch (error) {
    console.error('Error publishing DataNFT:', error);
    res.status(500).json({ error: 'Failed to publish DataNFT' });
  }
};

// Unpublish a DataNFT
const unpublishDataNFT = async (req, res) => {
  try {
    const { id } = req.params;
    const merchantId = req.user.id;

    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id }
    });

    if (!dataNFT) {
      return res.status(404).json({ error: 'DataNFT not found' });
    }

    if (dataNFT.merchantId !== merchantId) {
      return res.status(403).json({ error: 'Not authorized to unpublish this DataNFT' });
    }

    const unpublishedDataNFT = await prisma.dataNFT.update({
      where: { id },
      data: { isPublished: false },
      include: {
        snapshots: true,
        tags: true
      }
    });

    res.json(unpublishedDataNFT);
  } catch (error) {
    console.error('Error unpublishing DataNFT:', error);
    res.status(500).json({ error: 'Failed to unpublish DataNFT' });
  }
};

// Purchase a DataNFT
const purchaseDataNFT = async (req, res) => {
  try {
    console.log('=== Starting DataNFT Purchase Process ===');
    const { id } = req.params;
    const buyerId = req.user.id;
    const quantity = Math.max(1, Number(req.body.quantity) || 1);
    
    console.log('Initial request data:', {
      nftId: id,
      buyerId: buyerId,
      user: req.user,
      quantity
    });

    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id },
      include: {
        merchant: true
      }
    });

    console.log('Found DataNFT:', {
      id: dataNFT?.id,
      name: dataNFT?.name,
      merchantId: dataNFT?.merchantId,
      isPublished: dataNFT?.isPublished,
      price: dataNFT?.price
    });

    if (!dataNFT) {
      console.log('Error: DataNFT not found');
      return res.status(404).json({ error: 'DataNFT not found' });
    }

    if (!dataNFT.isPublished) {
      console.log('Error: DataNFT is not published');
      return res.status(400).json({ error: 'DataNFT is not published' });
    }

    if (dataNFT.merchantId === buyerId) {
      console.log('Error: Attempting to purchase own DataNFT', {
        merchantId: dataNFT.merchantId,
        buyerId: buyerId
      });
      return res.status(403).json({ error: 'Cannot purchase your own DataNFT' });
    }

    // 获取用户已购买次数（仅用于记录）
    const purchaseCount = await prisma.dataNFTPurchase.count({
      where: {
        dataNFTId: id,
        buyerId: buyerId
      }
    });

    console.log('Current purchase count:', purchaseCount);

    // Create purchase record (with quantity)
    console.log('Creating purchase record...');
    const purchase = await prisma.dataNFTPurchase.create({
      data: {
        dataNFTId: id,
        buyerId,
        quantity
      },
      include: {
        dataNFT: {
          include: {
            snapshots: true,
            tags: true
          }
        }
      }
    });
    console.log('Purchase record created:', { purchaseId: purchase.id, quantity });

    // --- 新增：自动生成交易流水 ---
    console.log('=== Starting Transaction Generation ===');
    const totalAmount = dataNFT.price * quantity;
    // 1. 生成商家收入流水
    console.log('Creating merchant transaction...');
    try {
      const merchantTransaction = await prisma.organizationTransaction.create({
        data: {
          amount: totalAmount,
          type: 'DEPOSIT',
          status: 'COMPLETED',
          description: `DataNFT sale: ${dataNFT.name} (Purchase #${purchaseCount + 1}, quantity: ${quantity})`,
          userId: dataNFT.merchantId,
          metadata: { 
            dataNFTId: dataNFT.id, 
            buyerId,
            purchaseCount: purchaseCount + 1,
            quantity
          }
        }
      });
      console.log('Merchant transaction created:', {
        id: merchantTransaction.id,
        amount: merchantTransaction.amount,
        type: merchantTransaction.type
      });
    } catch (merchantTxError) {
      console.error('Error creating merchant transaction:', {
        error: merchantTxError.message,
        code: merchantTxError.code,
        stack: merchantTxError.stack
      });
    }

    // 2. 检查买家信息并生成买家支出流水
    console.log('Checking buyer info...');
    try {
      const buyer = await prisma.user.findUnique({ 
        where: { id: buyerId },
        select: {
          id: true,
          email: true,
          isOrganization: true,
          userType: true
        }
      });
      
      console.log('Buyer details:', {
        id: buyer?.id,
        email: buyer?.email,
        isOrganization: buyer?.isOrganization,
        userType: buyer?.userType
      });

      if (buyer && (buyer.isOrganization || buyer.userType === 'organization')) {
        console.log('Creating buyer transaction...');
        const buyerTransaction = await prisma.organizationTransaction.create({
          data: {
            amount: totalAmount,
            type: 'WITHDRAW',
            status: 'COMPLETED',
            description: `Purchase DataNFT: ${dataNFT.name} (Purchase #${purchaseCount + 1}, quantity: ${quantity})`,
            userId: buyerId,
            metadata: { 
              dataNFTId: dataNFT.id, 
              merchantId: dataNFT.merchantId,
              purchaseCount: purchaseCount + 1,
              quantity
            }
          }
        });
        console.log('Buyer transaction created:', {
          id: buyerTransaction.id,
          amount: buyerTransaction.amount,
          type: buyerTransaction.type
        });
      } else {
        console.log('Skipping buyer transaction - not an organization user');
      }
    } catch (buyerTxError) {
      console.error('Error processing buyer transaction:', {
        error: buyerTxError.message,
        code: buyerTxError.code,
        stack: buyerTxError.stack
      });
    }
    // --- end ---

    console.log('=== Purchase Process Completed ===');
    res.status(201).json({
      ...purchase,
      purchaseCount: purchaseCount + 1,
      quantity
    });
  } catch (error) {
    console.error('Error in purchaseDataNFT:', {
      message: error.message,
      code: error.code,
      stack: error.stack
    });
    res.status(500).json({ error: 'Failed to purchase DataNFT' });
  }
};

// Get DataNFTs by merchant
const getDataNFTsByMerchant = async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const [dataNFTs, total] = await Promise.all([
      prisma.dataNFT.findMany({
        where: {
          merchantId,
          isPublished: true
        },
        skip,
        take: parseInt(limit),
        include: {
          snapshots: {
            include: {
              activity: true
            }
          },
          tags: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.dataNFT.count({
        where: {
          merchantId,
          isPublished: true
        }
      })
    ]);

    res.json({
      data: dataNFTs,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching merchant DataNFTs:', error);
    res.status(500).json({ error: 'Failed to fetch merchant DataNFTs' });
  }
};

// Get purchased DataNFTs
const getPurchasedDataNFTs = async (req, res) => {
  try {
    console.log('getPurchasedDataNFTs called');
    const buyerId = req.user.id;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    const [purchases, total] = await Promise.all([
      prisma.dataNFTPurchase.findMany({
        where: { buyerId },
        skip,
        take: parseInt(limit),
        include: {
          dataNFT: {
            include: {
              snapshots: {
                include: {
                  activity: true
                }
              },
              tags: true,
              merchant: {
                select: {
                  id: true,
                  name: true,
                  avatar: true
                }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.dataNFTPurchase.count({
        where: { buyerId }
      })
    ]);

    // 调试信息
    console.log('buyerId:', buyerId);
    console.log('purchases.length:', purchases.length);
    purchases.forEach((p, idx) => {
      console.log(`purchase[${idx}]: id=${p.id}, dataNFTId=${p.dataNFTId}, dataNFT=`, p.dataNFT);
    });

    // 检查是否有 dataNFT 为空的情况
    const missingNFTs = purchases.filter(p => !p.dataNFT);
    if (missingNFTs.length > 0) {
      console.warn('Some purchases have missing dataNFT:', missingNFTs.map(p => p.dataNFTId));
    }

    res.json({
      data: purchases,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Error fetching purchased DataNFTs:', error);
    res.status(500).json({ error: 'Failed to fetch purchased DataNFTs' });
  }
};

// Get DataNFT holders
const getDataNFTHolders = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 10 } = req.query;
    const skip = (page - 1) * limit;

    // 验证 DataNFT 是否存在
    const dataNFT = await prisma.dataNFT.findUnique({
      where: { id }
    });

    if (!dataNFT) {
      return res.status(404).json({
        status: 'fail',
        message: 'DataNFT not found'
      });
    }

    // 获取持有者信息
    const [holders, total] = await Promise.all([
      prisma.dataNFTPurchase.findMany({
        where: { dataNFTId: id },
        include: {
          buyer: {
            select: {
              id: true,
              email: true,
              name: true,
              avatar: true
            }
          }
        },
        skip,
        take: Number(limit),
        orderBy: { createdAt: 'desc' }
      }),
      prisma.dataNFTPurchase.count({
        where: { dataNFTId: id }
      })
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        holders: holders.map(h => ({
          id: h.buyer.id,
          email: h.buyer.email,
          name: h.buyer.name,
          avatar: h.buyer.avatar,
          purchasedAt: h.createdAt
        })),
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching DataNFT holders:', error);
    res.status(500).json({
      status: 'error',
      message: 'Server error',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  mergeSnapshots,
  getDataNFTs,
  getDataNFTById,
  updateDataNFT,
  deleteDataNFT,
  publishDataNFT,
  unpublishDataNFT,
  purchaseDataNFT,
  getDataNFTsByMerchant,
  getPurchasedDataNFTs,
  getDataNFTHolders
}; 