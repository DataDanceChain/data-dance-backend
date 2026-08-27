const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const commerceService = require('../services/commerceService');

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
      let size = 0;
      
      if (nft.dataSource === 'upload' && nft.dataRecords) {
        // 直接上传的数据包：从 dataRecords 计算
        size = nft.dataRecords.recordCount || 0;
      } else {
        // 活动数据：从 snapshots.claims 计算
        const allClaims = nft.snapshots.flatMap(s => s.claims || []);
        // 获取所有不重复的 userId
        const uniqueUserIds = [...new Set(allClaims.map(c => c.userId).filter(Boolean))];
        size = uniqueUserIds.length;
      }
      
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
    let size = 0;
    
    if (dataNFT.dataSource === 'upload' && dataNFT.dataRecords) {
      // 直接上传的数据包：从 dataRecords 计算
      size = dataNFT.dataRecords.recordCount || 0;
    } else {
      // 活动数据：从 snapshots.claims 计算
      const allClaims = dataNFT.snapshots.flatMap(s => s.claims || []);
      const uniqueUserIds = [...new Set(allClaims.map(c => c.userId).filter(Boolean))];
      size = uniqueUserIds.length;
    }
    
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

    const totalAmount = dataNFT.price * quantity;
    const buyer = await prisma.user.findUnique({
      where: { id: buyerId },
      select: {
        id: true,
        email: true,
        isOrganization: true,
        userType: true
      }
    });
    const isOrgBuyer = Boolean(buyer && (buyer.isOrganization || buyer.userType === 'organization'));

    if (isOrgBuyer) {
      const [depositSum, withdrawSum] = await Promise.all([
        prisma.organizationTransaction.aggregate({
          _sum: { amount: true },
          where: { userId: buyerId, type: 'DEPOSIT', status: 'COMPLETED' }
        }),
        prisma.organizationTransaction.aggregate({
          _sum: { amount: true },
          where: { userId: buyerId, type: 'WITHDRAW', status: 'COMPLETED' }
        })
      ]);
      const balance = (depositSum._sum.amount || 0) - (withdrawSum._sum.amount || 0);
      if (balance < totalAmount) {
        return res.status(400).json({ error: 'Insufficient balance to complete this purchase.' });
      }
    }

    const result = await prisma.$transaction(async (tx) => {
      const purchase = await tx.dataNFTPurchase.create({
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

      await tx.organizationTransaction.create({
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

      let buyerTransaction = null;
      if (isOrgBuyer) {
        buyerTransaction = await tx.organizationTransaction.create({
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
      }

      const commerce = await commerceService.createOrderFromPurchase(tx, {
        buyerId,
        sellerId: dataNFT.merchantId,
        dataNFT,
        purchase,
        quantity,
        totalAmount,
        paidFromBalance: isOrgBuyer,
        organizationTransactionId: buyerTransaction?.id,
      });

      return { purchase, commerce };
    });

    console.log('=== Purchase Process Completed ===');
    res.status(201).json({
      ...result.purchase,
      purchaseCount: purchaseCount + 1,
      quantity,
      order: result.commerce.order,
      invoice: result.commerce.invoice,
      payment: result.commerce.payment,
      status: 'success'
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