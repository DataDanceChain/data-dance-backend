const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const commerceService = require('../services/commerceService');
const { filterLicensableRecords, assertPackHasLicensableRecords } = require('../services/dataLicenceConsent');
const { BUYER_LICENCE_VERSION, BUYER_LICENCE_TERMS, licenceTerms, hasAcceptedBuyerLicence } = require('../constants/buyerLicence');
const { stampBuyerLicence } = require('../services/buyerLicence');
const { resolveLocale, localizeHeaders, csvNotice } = require('../i18n/merchantLocale');

const SUBJECT_CONSENT_ERROR = 'This pack can only include records from people who granted consent in the Wallet app.';

function withoutRecords(nft) {
  if (!nft) return nft;
  const { dataRecords, ...rest } = nft;
  return rest;
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function packToCsv(dataNFT, locale = 'en') {
  const raw = dataNFT?.dataRecords;
  const records = raw && typeof raw === 'object' ? raw : {};
  const rows = Array.isArray(records.records)
    ? records.records
    : Array.isArray(raw)
      ? raw
      : [];
  if (!rows.length) return null;
  const headers = Array.isArray(records.headers) && records.headers.length
    ? records.headers
    : Object.keys(rows[0] || {});
  if (!headers.length) return null;
  const displayHeaders = localizeHeaders(headers, locale);
  const lines = [
    displayHeaders.map(csvCell).join(','),
    ...rows.map((row) => headers.map((key) => csvCell(row?.[key])).join(',')),
  ];
  return lines.join('\n');
}

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

    const claimRows = snapshots.flatMap((snapshot) => {
      const claims = snapshot.claims;
      if (Array.isArray(claims)) return claims;
      if (claims && Array.isArray(claims.records)) return claims.records;
      return [];
    });
    const licensable = await filterLicensableRecords(claimRows);
    if (!licensable.length) {
      return res.status(403).json({
        status: 'fail',
        code: 'subject_consent_required',
        error: SUBJECT_CONSENT_ERROR,
      });
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

    let listed = dataNFTs;
    if (allMine !== 'true') {
      const retireIds = [];
      for (const nft of dataNFTs) {
        const check = await assertPackHasLicensableRecords(nft);
        if (!check.ok) retireIds.push(nft.id);
      }
      if (retireIds.length) {
        await prisma.dataNFT.updateMany({
          where: { id: { in: retireIds }, isPublished: true },
          data: { isPublished: false },
        });
        listed = dataNFTs.filter((nft) => !retireIds.includes(nft.id));
      }
    }

    // 为每个 DataNFT 计算 size 字段
    const dataWithSize = listed.map(nft => {
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
      
      return { ...withoutRecords(nft), size };
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
    
    res.json({ ...withoutRecords(dataNFT), size });
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

    if (dataNFT.dataSource === 'upload') {
      const licence = await assertPackHasLicensableRecords(dataNFT);
      if (!licence.ok) {
        return res.status(400).json({
          status: 'fail',
          error: 'This pack has no downloadable records yet.',
        });
      }
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

    const licence = await assertPackHasLicensableRecords(dataNFT);
    if (!licence.ok) {
      console.log('Purchase blocked: pack has no licensable records', {
        nftId: id,
        dataSource: dataNFT.dataSource,
      });
      return res.status(403).json({
        status: 'fail',
        code: 'subject_consent_required',
        error: SUBJECT_CONSENT_ERROR,
      });
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
    if (!isOrgBuyer) {
      return res.status(403).json({
        status: 'fail',
        code: 'org_buyer_required',
        error: 'Only a merchant account can buy a dataset licence.',
        message: 'Only a merchant account can buy a dataset licence.',
      });
    }
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

      const buyerTransaction = await tx.organizationTransaction.create({
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

      const commerce = await commerceService.createOrderFromPurchase(tx, {
        buyerId,
        sellerId: dataNFT.merchantId,
        dataNFT,
        purchase,
        quantity,
        totalAmount,
        paidFromBalance: true,
        organizationTransactionId: buyerTransaction.id,
      });

      return { purchase, commerce };
    });

    const commerceAttest = require('../services/commerceAttest');
    const attestation = result.commerce?.order?.id
      ? await commerceAttest.attestPaidOrderSafe(result.commerce.order.id)
      : null;
    const publicView = commerceAttest.publicAttestation(attestation || result.commerce?.order);
    const order = result.commerce.order
      ? { ...commerceAttest.omitAttestationPayload(result.commerce.order), ...publicView }
      : result.commerce.order;

    console.log('=== Purchase Process Completed ===');
    res.status(201).json({
      ...result.purchase,
      purchaseCount: purchaseCount + 1,
      quantity,
      order,
      invoice: result.commerce.invoice,
      payment: result.commerce.payment,
      attestation: publicView,
      status: 'success'
    });
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) {
      return res.status(error.statusCode).json({
        status: 'fail',
        code: error.code,
        error: error.message,
        message: error.message,
      });
    }
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
    const { publicAttestation } = require('../services/commerceAttest');
    const orders = purchases.length
      ? await prisma.purchaseOrder.findMany({
        where: { purchaseId: { in: purchases.map((row) => row.id) } },
        select: {
          id: true,
          purchaseId: true,
          orderNumber: true,
          attestationHash: true,
          attestationTxHash: true,
          attestedAt: true,
        },
      })
      : [];
    const orderByPurchase = new Map(orders.map((row) => [row.purchaseId, row]));

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
      data: purchases.map((purchase) => {
        const order = orderByPurchase.get(purchase.id);
        return {
          ...purchase,
          dataNFT: withoutRecords(purchase.dataNFT),
          licenceAccepted: hasAcceptedBuyerLicence(purchase),
          buyerLicenceVersion: BUYER_LICENCE_VERSION,
          buyerLicenceTerms: BUYER_LICENCE_TERMS,
          orderId: order?.id || null,
          orderNumber: order?.orderNumber || null,
          ...publicAttestation(order),
        };
      }),
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

const exportPurchasedDataNFT = async (req, res) => {
  try {
    const purchase = await prisma.dataNFTPurchase.findFirst({
      where: { id: req.params.purchaseId, buyerId: req.user.id },
      include: { dataNFT: true },
    });
    if (!purchase?.dataNFT) {
      return res.status(404).json({ error: 'Purchase not found' });
    }
    if (!hasAcceptedBuyerLicence(purchase)) {
      return res.status(403).json({
        status: 'fail',
        code: 'buyer_licence_required',
        error: 'Accept the buyer licence before download.',
        licenceVersion: BUYER_LICENCE_VERSION,
        buyerLicenceTerms: BUYER_LICENCE_TERMS,
      });
    }

    const raw = purchase.dataNFT.dataRecords && typeof purchase.dataNFT.dataRecords === 'object'
      ? purchase.dataNFT.dataRecords
      : {};
    const licence = await assertPackHasLicensableRecords(purchase.dataNFT);
    if (!licence.ok) {
      return res.status(403).json({
        status: 'fail',
        code: 'subject_consent_required',
        error: SUBJECT_CONSENT_ERROR,
      });
    }
    const licensable = licence.licensable;
    const csv = packToCsv({
      ...purchase.dataNFT,
      dataRecords: {
        ...raw,
        records: licensable,
        recordCount: licensable.length,
        headers: Array.isArray(raw.headers) && raw.headers.length
          ? raw.headers
          : Object.keys(licensable[0] || {}),
      },
    });
    if (!csv) {
      return res.status(404).json({ error: 'This pack has no downloadable table yet.' });
    }

    const safeName = String(purchase.dataNFT.name || 'data-pack').replace(/[^\w.-]+/g, '_');
    const buyer = req.user?.email || req.user?.id || 'buyer';
    const notice = [
      `# DataDance buyer licence ${BUYER_LICENCE_VERSION}`,
      `# buyer=${buyer}; purchase=${purchase.id}; purpose=analysis-and-research; direct-marketing=no`,
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.csv"`);
    res.setHeader('X-Licence-Purpose', 'analysis-research; no-direct-marketing');
    res.setHeader('X-Licence-Version', BUYER_LICENCE_VERSION);
    return res.send(`\uFEFF${notice}\n${csv}`);
  } catch (error) {
    console.error('Error exporting purchased DataNFT:', error);
    return res.status(500).json({ error: 'Failed to export data pack' });
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

const acceptPurchasedLicence = async (req, res) => {
  try {
    if (req.body?.accepted !== true) {
      return res.status(400).json({
        status: 'fail',
        error: 'Accept the buyer licence to continue.',
      });
    }
    const stamped = await stampBuyerLicence({
      purchaseId: req.params.purchaseId,
      buyerId: req.user.id,
    });
    if (!stamped) {
      return res.status(404).json({ error: 'Purchase not found' });
    }
    return res.json({
      status: 'success',
      data: {
        licenceAccepted: true,
        licenceVersion: BUYER_LICENCE_VERSION,
        licenceAcceptedAt: stamped.licenceAcceptedAt,
        buyerLicenceTerms: BUYER_LICENCE_TERMS,
      },
    });
  } catch (error) {
    console.error('Error accepting buyer licence:', error);
    return res.status(500).json({ error: 'Failed to accept buyer licence' });
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
  exportPurchasedDataNFT,
  acceptPurchasedLicence,
  getDataNFTHolders
}; 