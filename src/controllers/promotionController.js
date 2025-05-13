const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { sendPromotionEmail } = require('../utils/email');

// Get DataNFTs by tags
const getDataNFTsByTags = async (req, res) => {
  try {
    const { tags, page = 1, limit = 10 } = req.query;
    const userId = req.user.id;
    const skip = (page - 1) * limit;

    // Parse tags from comma-separated string to array
    const tagIds = tags ? tags.split(',') : [];

    // Find DataNFTs that have any of the selected tags
    const where = {
      isPublished: true,
      tags: {
        some: {
          id: {
            in: tagIds
          }
        }
      }
    };

    const [dataNFTs, total] = await Promise.all([
      prisma.dataNFT.findMany({
        where,
        skip: parseInt(skip),
        take: parseInt(limit),
        include: {
          merchant: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          },
          tags: true
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.dataNFT.count({ where })
    ]);

    // Check which DataNFTs are owned by the user
    const ownedDataNFTs = await prisma.dataNFTPurchase.findMany({
      where: {
        buyerId: userId,
        dataNFTId: {
          in: dataNFTs.map(nft => nft.id)
        }
      },
      select: {
        dataNFTId: true
      }
    });

    const ownedDataNFTIds = new Set(ownedDataNFTs.map(p => p.dataNFTId));

    // Separate owned and available DataNFTs
    const owned = dataNFTs.filter(nft => ownedDataNFTIds.has(nft.id));
    const available = dataNFTs.filter(nft => !ownedDataNFTIds.has(nft.id));

    res.json({
      status: 'success',
      data: {
        owned,
        available,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching DataNFTs by tags:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to fetch DataNFTs',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create a new promotion
const createPromotion = async (req, res) => {
  try {
    const {
      title,
      description,
      startDate,
      endDate,
      type,
      total,
      remaining,
      price,
      selectedDataNfts,
      nft
    } = req.body;

    const merchantId = req.user.id;

    // Create the promotion activity
    const promotion = await prisma.activity.create({
      data: {
        title,
        description,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        type,
        total,
        remaining,
        price,
        creatorId: merchantId,
        nft: {
          create: {
            name: nft.name,
            description: nft.description,
            totalSupply: nft.totalSupply,
            price: nft.price,
            validityStart: new Date(nft.validityStart),
            validityEnd: new Date(nft.validityEnd),
            usageRules: nft.usageRules
          }
        },
        selectedDataNfts: {
          create: selectedDataNfts.map(dataNft => ({
            dataNFTId: dataNft.id,
            isOwned: dataNft.isOwned,
            quantity: dataNft.quantity || 1
          }))
        }
      },
      include: {
        nft: true,
        selectedDataNfts: {
          include: {
            dataNFT: true
          }
        }
      }
    });

    // Send emails to users who own the selected DataNFTs
    const ownedDataNFTs = selectedDataNfts.filter(dn => dn.isOwned);
    for (const dataNft of ownedDataNFTs) {
      const owners = await prisma.dataNFTPurchase.findMany({
        where: {
          dataNFTId: dataNft.id
        },
        include: {
          buyer: true
        }
      });

      for (const owner of owners) {
        await sendPromotionEmail(owner.buyer.email, {
          promotionTitle: title,
          promotionDescription: description,
          startDate,
          endDate
        });
      }
    }

    res.status(201).json({
      status: 'success',
      data: promotion
    });
  } catch (error) {
    console.error('Error creating promotion:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to create promotion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all promotions
const getPromotions = async (req, res) => {
  try {
    const { page = 1, limit = 10, status } = req.query;
    const skip = (page - 1) * limit;

    const where = {};
    if (status && status !== 'all') {
      const now = new Date();
      if (status === 'active') {
        where.startDate = { lte: now };
        where.endDate = { gt: now };
      } else if (status === 'ended') {
        where.endDate = { lte: now };
      }
    }

    const [promotions, total] = await Promise.all([
      prisma.activity.findMany({
        where: {
          ...where,
          type: 'PROMOTION'
        },
        skip: parseInt(skip),
        take: parseInt(limit),
        include: {
          nft: true,
          selectedDataNfts: {
            include: {
              dataNFT: true
            }
          },
          creator: {
            select: {
              id: true,
              name: true,
              avatar: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }),
      prisma.activity.count({
        where: {
          ...where,
          type: 'PROMOTION'
        }
      })
    ]);

    res.json({
      status: 'success',
      data: {
        promotions,
        pagination: {
          total,
          page: parseInt(page),
          limit: parseInt(limit),
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    console.error('Error fetching promotions:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to fetch promotions',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get promotion by ID
const getPromotionById = async (req, res) => {
  try {
    const { id } = req.params;

    const promotion = await prisma.activity.findFirst({
      where: {
        id,
        type: 'PROMOTION'
      },
      include: {
        nft: true,
        selectedDataNfts: {
          include: {
            dataNFT: true
          }
        },
        creator: {
          select: {
            id: true,
            name: true,
            avatar: true
          }
        }
      }
    });

    if (!promotion) {
      return res.status(404).json({
        status: 'fail',
        message: 'Promotion not found'
      });
    }

    res.json({
      status: 'success',
      data: promotion
    });
  } catch (error) {
    console.error('Error fetching promotion:', error);
    res.status(500).json({ 
      status: 'error',
      message: 'Failed to fetch promotion',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

module.exports = {
  getDataNFTsByTags,
  createPromotion,
  getPromotions,
  getPromotionById
}; 