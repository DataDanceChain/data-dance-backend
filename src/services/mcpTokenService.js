const crypto = require('crypto');
const prisma = require('../utils/prisma');

const TOKEN_PREFIX = 'ddc_mcp_';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createMcpTokenSecret() {
  return `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function toSummary(row) {
  return {
    id: row.id,
    label: row.label,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

async function listMcpTokens(userId) {
  const rows = await prisma.mcpToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toSummary);
}

async function issueMcpToken(userId, label, extras = {}) {
  const token = createMcpTokenSecret();
  const row = await prisma.mcpToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      label: String(label || '').trim() || 'Claude / ChatGPT',
      source: extras.source || 'manual',
      clientId: extras.clientId || '',
      resource: extras.resource || '',
      scope: extras.scope || '',
      expiresAt: extras.expiresAt || null,
    },
  });
  return { token, ...toSummary(row) };
}

async function revokeMcpToken(userId, tokenId) {
  const result = await prisma.mcpToken.deleteMany({
    where: { id: tokenId, userId },
  });
  return result.count > 0;
}

async function findUserByMcpToken(token) {
  const trimmed = String(token || '').trim();
  if (!trimmed.startsWith(TOKEN_PREFIX)) return null;
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: hashToken(trimmed) },
    include: { user: { select: { id: true, email: true, disabledAt: true } } },
  });
  if (!row?.user) return null;
  if (row.user.disabledAt) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  await prisma.mcpToken.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
  });
  return { id: row.user.id, email: row.user.email, tokenId: row.id };
}

module.exports = {
  listMcpTokens,
  issueMcpToken,
  revokeMcpToken,
  findUserByMcpToken,
  hashToken,
  createMcpTokenSecret,
};
