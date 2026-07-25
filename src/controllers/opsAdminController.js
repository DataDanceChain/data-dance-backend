const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { OPS_TOKEN_TYPE } = require('../middlewares/opsAuthMiddleware');
const { getUsersWithValidUploads } = require('../utils/firstValidUpload');

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  walletAddress: true,
  referralCode: true,
  totalPoints: true,
  authType: true,
  userType: true,
  createdAt: true,
  xid: true,
  xUsername: true,
};

function getOpsCredentials() {
  const username = process.env.OPS_ADMIN_USERNAME;
  const password = process.env.OPS_ADMIN_PASSWORD;
  if (!username || !password) return null;
  return { username, password };
}

exports.login = async (req, res) => {
  try {
    const creds = getOpsCredentials();
    if (!creds) {
      return res.status(503).json({
        status: 'fail',
        message: 'Ops admin is not configured (set OPS_ADMIN_USERNAME and OPS_ADMIN_PASSWORD)',
      });
    }
    const { username, password } = req.body || {};
    if (username !== creds.username || password !== creds.password) {
      return res.status(401).json({ status: 'fail', message: 'Invalid username or password' });
    }
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ status: 'error', message: 'JWT_SECRET is not configured' });
    }
    const expiresIn = process.env.OPS_ADMIN_TOKEN_EXPIRES || '8h';
    const token = jwt.sign({ type: OPS_TOKEN_TYPE, sub: username }, secret, { expiresIn });
    return res.json({
      status: 'success',
      data: { token, expiresIn, username },
    });
  } catch (error) {
    console.error('Ops login error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.searchUsers = async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 2) {
      return res.status(400).json({ status: 'fail', message: 'Query must be at least 2 characters' });
    }
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { email: { contains: q, mode: 'insensitive' } },
          { walletAddress: { contains: q, mode: 'insensitive' } },
          { referralCode: { contains: q, mode: 'insensitive' } },
          { name: { contains: q, mode: 'insensitive' } },
          { id: q },
        ],
      },
      select: USER_SELECT,
      take: 30,
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ status: 'success', data: { users, count: users.length } });
  } catch (error) {
    console.error('Ops search error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.getUserDetail = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: USER_SELECT,
    });
    if (!user) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }

    const [
      pointsSum,
      pointsBySource,
      recentPoints,
      uploadCount,
      asInvitee,
      invitees,
      campaignInvitees,
    ] = await Promise.all([
      prisma.point.aggregate({ where: { userId }, _sum: { amount: true } }),
      prisma.point.groupBy({
        by: ['source'],
        where: { userId },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.point.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, amount: true, source: true, sourceId: true, createdAt: true },
      }),
      prisma.crawlerData.count({ where: { userId } }),
      prisma.referral.findUnique({
        where: { inviteeId: userId },
        include: {
          inviter: { select: { id: true, email: true, name: true, referralCode: true, walletAddress: true } },
        },
      }),
      prisma.referral.findMany({
        where: { inviterId: userId, campaignSlug: null },
        include: {
          invitee: { select: { id: true, email: true, name: true, walletAddress: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.referral.findMany({
        where: { inviterId: userId, campaignSlug: { not: null } },
        include: {
          invitee: { select: { id: true, email: true, name: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);

    const inviteeIds = invitees.map((r) => r.inviteeId);
    const withUploads = inviteeIds.length
      ? await getUsersWithValidUploads(inviteeIds)
      : new Set();

    const ledgerTotal = pointsSum._sum.amount ?? 0;

    return res.json({
      status: 'success',
      data: {
        user,
        points: {
          totalPointsField: user.totalPoints,
          ledgerTotal,
          inSync: Math.abs(user.totalPoints - ledgerTotal) < 0.01,
          bySource: pointsBySource.map((row) => ({
            source: row.source,
            total: row._sum.amount ?? 0,
            count: row._count._all,
          })),
          recent: recentPoints,
        },
        uploads: { count: uploadCount },
        referral: {
          invitedBy: asInvitee
            ? {
                inviterId: asInvitee.inviterId,
                code: asInvitee.code,
                campaignSlug: asInvitee.campaignSlug,
                createdAt: asInvitee.createdAt,
                inviter: asInvitee.inviter,
              }
            : null,
          invitees: invitees.map((r) => ({
            id: r.id,
            inviteeId: r.inviteeId,
            code: r.code,
            createdAt: r.createdAt,
            invitee: r.invitee,
            hasValidUpload: withUploads.has(r.inviteeId),
          })),
          campaignInvitees: campaignInvitees.map((r) => ({
            id: r.id,
            campaignSlug: r.campaignSlug,
            createdAt: r.createdAt,
            invitee: r.invitee,
          })),
          inviteeCount: invitees.length,
        },
      },
    });
  } catch (error) {
    console.error('Ops user detail error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.adjustPoints = async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, note } = req.body || {};
    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({
        status: 'fail',
        message: 'amount must be a non-zero number (positive to add, negative to deduct)',
      });
    }
    const reason = String(note || '').trim().slice(0, 200);
    if (!reason) {
      return res.status(400).json({ status: 'fail', message: 'note is required' });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, totalPoints: true },
    });
    if (!user) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }

    if (delta < 0 && user.totalPoints + delta < 0) {
      return res.status(400).json({
        status: 'fail',
        message: `Insufficient balance: ${user.totalPoints}, cannot deduct ${Math.abs(delta)}`,
      });
    }

    const slug = reason.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 40).toLowerCase() || 'adjustment';
    const admin = req.opsAdmin?.username || 'ops';
    const sourceId = `ops-manual-${Date.now()}-${slug}__${admin}`;

    const result = await prisma.$transaction(async (tx) => {
      const point = await tx.point.create({
        data: {
          userId,
          amount: delta,
          source: 'OPS_ADJUSTMENT',
          sourceId,
        },
      });
      const updated = await tx.user.update({
        where: { id: userId },
        data: { totalPoints: { increment: delta } },
        select: { totalPoints: true, email: true },
      });
      return { point, user: updated };
    });

    return res.json({
      status: 'success',
      data: {
        pointId: result.point.id,
        amount: delta,
        source: 'OPS_ADJUSTMENT',
        sourceId,
        note: reason,
        balanceBefore: user.totalPoints,
        balanceAfter: result.user.totalPoints,
        email: result.user.email,
        adjustedBy: req.opsAdmin?.username,
      },
    });
  } catch (error) {
    console.error('Ops adjust points error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

const OPS_LEDGER_SOURCES = ['OPS_ADJUSTMENT', 'REWARD_REDEMPTION'];

/** GET /api/ops/operations — global ops-relevant point ledger */
exports.listOperations = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const userId = req.query.userId ? String(req.query.userId) : undefined;
    const direction = String(req.query.direction || 'all'); // all | credit | debit

    const where = {
      source: { in: OPS_LEDGER_SOURCES },
    };
    if (userId) where.userId = userId;
    if (direction === 'credit') where.amount = { gt: 0 };
    if (direction === 'debit') where.amount = { lt: 0 };

    const [total, rows] = await Promise.all([
      prisma.point.count({ where }),
      prisma.point.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          user: { select: { id: true, email: true, walletAddress: true } },
        },
      }),
    ]);

    return res.json({
      status: 'success',
      data: {
        total,
        limit,
        offset,
        records: rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          amount: r.amount,
          source: r.source,
          sourceId: r.sourceId,
          userId: r.userId,
          email: r.user.email,
          wallet: r.user.walletAddress,
        })),
      },
    });
  } catch (error) {
    console.error('Ops list operations error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

/** GET /api/ops/users/:userId/points/history — full paginated ledger for one user */
exports.getUserPointHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const source = req.query.source ? String(req.query.source) : undefined;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user) {
      return res.status(404).json({ status: 'fail', message: 'User not found' });
    }

    const where = { userId };
    if (source) where.source = source;

    const [total, rows] = await Promise.all([
      prisma.point.count({ where }),
      prisma.point.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        select: { id: true, amount: true, source: true, sourceId: true, createdAt: true },
      }),
    ]);

    return res.json({
      status: 'success',
      data: { userId, email: user.email, total, limit, offset, records: rows },
    });
  } catch (error) {
    console.error('Ops user point history error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
