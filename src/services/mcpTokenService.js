const crypto = require('crypto');
const prisma = require('../utils/prisma');
const { PARTNER_TOKEN_PREFIX, PARTNER_ACCESS_TTL_SEC } = require('../constants/partnerClient');

const TOKEN_PREFIX = 'ddc_mcp_';
const PARTNER_SOURCE = 'partner';
const LAST_USED_WRITE_INTERVAL_MS = 30 * 1000;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createMcpTokenSecret(prefix = TOKEN_PREFIX) {
  return `${prefix}${crypto.randomBytes(32).toString('base64url')}`;
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

/** Personal / MCP tokens only — partner (TGE) tokens never appear in the Portrait UI. */
async function listMcpTokens(userId) {
  const rows = await prisma.mcpToken.findMany({
    where: { userId, source: { not: PARTNER_SOURCE } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toSummary);
}

async function createTokenRow(userId, label, extras, prefix) {
  const token = createMcpTokenSecret(prefix);
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
  return { token, row };
}

async function issueMcpToken(userId, label, extras = {}) {
  const { token, row } = await createTokenRow(userId, label, extras, TOKEN_PREFIX);
  return { token, ...toSummary(row) };
}

/**
 * Partner (TGE) access token: opaque `ddc_tge_…`, audience-bound to the partner resource,
 * 300 s, no refresh token. Stored in the same McpToken table with source 'partner'.
 */
async function issuePartnerToken(userId, client, { resource, scope } = {}) {
  const ttlSec = Number(client?.accessTtlSec) > 0 ? Number(client.accessTtlSec) : PARTNER_ACCESS_TTL_SEC;
  const expiresAt = new Date(Date.now() + ttlSec * 1000);
  const { token, row } = await createTokenRow(
    userId,
    client?.clientName || 'TGE',
    {
      source: PARTNER_SOURCE,
      clientId: client?.clientId || '',
      resource: resource || client?.resource || '',
      scope: scope || '',
      expiresAt,
    },
    PARTNER_TOKEN_PREFIX,
  );
  return { token, id: row.id, expiresAt: row.expiresAt, createdAt: row.createdAt, expiresIn: ttlSec };
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
    include: { user: { select: { id: true, email: true } } },
  });
  if (!row?.user) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;
  await prisma.mcpToken.update({
    where: { id: row.id },
    data: { lastUsedAt: new Date() },
  });
  return { id: row.user.id, email: row.user.email, tokenId: row.id };
}

function sameResource(a, b) {
  return String(a || '').replace(/\/$/, '') === String(b || '').replace(/\/$/, '');
}

/**
 * Resolves a partner access token for the given audience. Returns null unless the token has
 * the `ddc_tge_` prefix, exists, was issued with source 'partner' for exactly this resource
 * and has not expired. Disabled users are returned (the route answers 403 account_disabled),
 * so the whole user row is loaded — `disabledAt` is undefined until that column is merged.
 * `lastUsedAt` is refreshed at most once per 30 s, best-effort.
 */
async function findUserByPartnerToken(token, resource) {
  const trimmed = String(token || '').trim();
  if (!trimmed.startsWith(PARTNER_TOKEN_PREFIX)) return null;
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: hashToken(trimmed) },
    include: { user: true },
  });
  if (!row?.user) return null;
  if (row.source !== PARTNER_SOURCE) return null;
  if (!sameResource(row.resource, resource)) return null;
  const now = new Date();
  if (!row.expiresAt || row.expiresAt <= now) return null;
  if (!row.lastUsedAt || now.getTime() - new Date(row.lastUsedAt).getTime() > LAST_USED_WRITE_INTERVAL_MS) {
    try {
      await prisma.mcpToken.update({ where: { id: row.id }, data: { lastUsedAt: now } });
    } catch {
      // bookkeeping only
    }
  }
  return {
    user: row.user,
    token: {
      id: row.id,
      clientId: row.clientId,
      scope: row.scope,
      resource: row.resource,
      issuedAt: row.createdAt,
      expiresAt: row.expiresAt,
    },
  };
}

module.exports = {
  TOKEN_PREFIX,
  PARTNER_SOURCE,
  listMcpTokens,
  issueMcpToken,
  issuePartnerToken,
  revokeMcpToken,
  findUserByMcpToken,
  findUserByPartnerToken,
  hashToken,
  createMcpTokenSecret,
};
