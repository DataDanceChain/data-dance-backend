const fs = require('fs');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { OPS_TOKEN_TYPE } = require('../middlewares/opsAuthMiddleware');
const { getUsersWithValidUploads } = require('../utils/firstValidUpload');
const {
  bareDisplayReferralCode,
  formatReferralCodeForDisplay,
  withDisplayReferralCode,
} = require('../utils/referralCodeFormat');

/**
 * `referralCode` search clauses for an ops query. Codes are shown as "DDC-XXXXXX" but stored
 * bare, so a pasted "DDC-ABC123" (or a "DDC-AB" fragment) must also search the bare form.
 */
function referralCodeSearch(q) {
  const terms = new Set([q]);
  const bare = bareDisplayReferralCode(q);
  if (bare) terms.add(bare);
  const fragment = /^DDC[\s-]+(.+)$/i.exec(q);
  if (fragment) terms.add(fragment[1].replace(/[\s-]+/g, ''));
  return [...terms].map((term) => ({ referralCode: { contains: term, mode: 'insensitive' } }));
}

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
  return { username, password, role: 'admin' };
}

function getDemoCredentials() {
  const fromEnv = process.env.OPS_DEMO_USERNAME && process.env.OPS_DEMO_PASSWORD
    ? { username: process.env.OPS_DEMO_USERNAME, password: process.env.OPS_DEMO_PASSWORD }
    : null;
  if (fromEnv) return { ...fromEnv, role: 'demo' };
  const file = process.env.OPS_DEMO_FILE || '/app/config/ops-demo.json';
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.username && parsed.password) {
      return { username: String(parsed.username), password: String(parsed.password), role: 'demo' };
    }
  } catch {
    /* Demo login is optional. */
  }
  return null;
}

function signOpsToken(username, role) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return null;
  const expiresIn = process.env.OPS_ADMIN_TOKEN_EXPIRES || '7d';
  const token = jwt.sign({ type: OPS_TOKEN_TYPE, sub: username, role }, secret, { expiresIn });
  return { token, expiresIn };
}

exports.login = async (req, res) => {
  try {
    const creds = getOpsCredentials();
    const demo = getDemoCredentials();
    if (!creds && !demo) {
      return res.status(503).json({
        status: 'fail',
        message: 'Ops admin is not configured (set OPS_ADMIN_USERNAME and OPS_ADMIN_PASSWORD)',
      });
    }
    const { username, password } = req.body || {};
    const match = [creds, demo].find((row) => row && username === row.username && password === row.password);
    if (!match) {
      return res.status(401).json({ status: 'fail', message: 'Invalid username or password' });
    }
    const signed = signOpsToken(match.username, match.role);
    if (!signed) {
      return res.status(500).json({ status: 'error', message: 'JWT_SECRET is not configured' });
    }
    return res.json({
      status: 'success',
      data: { token: signed.token, expiresIn: signed.expiresIn, username: match.username, role: match.role },
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
          ...referralCodeSearch(q),
          { name: { contains: q, mode: 'insensitive' } },
          { id: q },
        ],
      },
      select: USER_SELECT,
      take: 30,
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ status: 'success', data: { users: users.map(withDisplayReferralCode), count: users.length } });
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
        user: withDisplayReferralCode(user),
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
                code: formatReferralCodeForDisplay(asInvitee.code),
                campaignSlug: asInvitee.campaignSlug,
                createdAt: asInvitee.createdAt,
                inviter: withDisplayReferralCode(asInvitee.inviter),
              }
            : null,
          invitees: invitees.map((r) => ({
            id: r.id,
            inviteeId: r.inviteeId,
            code: formatReferralCodeForDisplay(r.code),
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

function parsePointsQuery(req) {
  const q = String(req.query.q || '').trim();
  const minRaw = req.query.min;
  const maxRaw = req.query.max;
  const min = minRaw === undefined || minRaw === '' ? null : Number(minRaw);
  const max = maxRaw === undefined || maxRaw === '' ? null : Number(maxRaw);
  const zeros = String(req.query.zeros || '1') !== '0';
  const sort = ['totalPoints', 'createdAt', 'email'].includes(String(req.query.sort))
    ? String(req.query.sort)
    : 'totalPoints';
  const order = String(req.query.order) === 'asc' ? 'asc' : 'desc';
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  return { q, min, max, zeros, sort, order, page, limit };
}

function pointsUserWhere({ q, min, max, zeros }) {
  const where = {};
  const points = {};
  if (!zeros) points.gt = 0;
  if (min != null && Number.isFinite(min)) points.gte = min;
  if (max != null && Number.isFinite(max)) points.lte = max;
  if (Object.keys(points).length) where.totalPoints = points;
  if (q.length >= 2) {
    where.OR = [
      { email: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
      { walletAddress: { contains: q, mode: 'insensitive' } },
      ...referralCodeSearch(q),
      { id: q },
    ];
  }
  return where;
}

async function pointsSummary() {
  const [users, ledger, withBalance, issued, deducted] = await Promise.all([
    prisma.user.aggregate({
      _count: { _all: true },
      _sum: { totalPoints: true },
    }),
    prisma.point.aggregate({
      _count: { _all: true },
      _sum: { amount: true },
    }),
    prisma.user.count({ where: { totalPoints: { not: 0 } } }),
    prisma.point.aggregate({ where: { amount: { gt: 0 } }, _sum: { amount: true } }),
    prisma.point.aggregate({ where: { amount: { lt: 0 } }, _sum: { amount: true } }),
  ]);
  return {
    users: users._count._all,
    usersWithBalance: withBalance,
    outstanding: users._sum.totalPoints ?? 0,
    issued: issued._sum.amount ?? 0,
    deducted: Math.abs(deducted._sum.amount ?? 0),
    ledgerNet: ledger._sum.amount ?? 0,
    ledgerRows: ledger._count._all,
  };
}

/** GET /api/ops/points — ledger totals plus a filterable member list */
exports.listPoints = async (req, res) => {
  try {
    const parsed = parsePointsQuery(req);
    const where = pointsUserWhere(parsed);
    const [summary, total, items] = await Promise.all([
      pointsSummary(),
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          walletAddress: true,
          referralCode: true,
          totalPoints: true,
          createdAt: true,
        },
        orderBy: { [parsed.sort]: parsed.order },
        skip: (parsed.page - 1) * parsed.limit,
        take: parsed.limit,
      }),
    ]);
    return res.json({
      status: 'success',
      data: {
        summary,
        items: items.map(withDisplayReferralCode),
        pagination: {
          page: parsed.page,
          limit: parsed.limit,
          total,
          pages: Math.max(1, Math.ceil(total / parsed.limit)),
        },
      },
    });
  } catch (error) {
    console.error('Ops points list error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

function csvCell(value) {
  const text = value == null ? '' : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** GET /api/ops/points/export — same filters, CSV of every matching member */
exports.exportPoints = async (req, res) => {
  try {
    const parsed = parsePointsQuery(req);
    const where = pointsUserWhere(parsed);
    const rows = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        walletAddress: true,
        referralCode: true,
        totalPoints: true,
        createdAt: true,
      },
      orderBy: { [parsed.sort]: parsed.order },
      take: 20000,
    });
    const header = ['email', 'name', 'wallet', 'referral_code', 'points', 'user_id', 'created_at'];
    const lines = [
      header.join(','),
      ...rows.map((row) =>
        [
          csvCell(row.email),
          csvCell(row.name),
          csvCell(row.walletAddress),
          csvCell(formatReferralCodeForDisplay(row.referralCode)),
          csvCell(row.totalPoints),
          csvCell(row.id),
          csvCell(row.createdAt.toISOString()),
        ].join(','),
      ),
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="datadance-points-${stamp}.csv"`);
    return res.send(`\uFEFF${lines.join('\n')}\n`);
  } catch (error) {
    console.error('Ops points export error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
