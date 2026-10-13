/**
 * Personal operator sign-in for the ops site (admin issue #2).
 *
 * The developer console (on the wallet origin, where the DataDance sign-in lives) mints a one-time
 * code for a staff account: POST /api/ops/auth/code with the wallet JWT and a PKCE challenge. The
 * ops site exchanges it with the verifier (POST /api/ops/auth/exchange) for an ops session token.
 *
 *   - the code is single use (a conditional update consumes it), lives 60 s, and only its sha256 is
 *     stored; a wrong verifier still burns it;
 *   - the redirect target is fixed by the server (OPS_ADMIN_URL), never taken from the request;
 *   - the account must be enabled and staff when the code is minted, when it is exchanged, and on
 *     every later request (protectOps).
 *
 * Ops session tokens: `{ type: 'ops_admin', kind: 'user', sub: <User.id> }`, signed with
 * JWT_SECRET, OPS_USER_TOKEN_TTL_SEC (default 12 h, clamped to 5 min..12 h), no refresh. They never
 * carry `id`, so the wallet's `protect` refuses them.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const prisma = require('../utils/prisma');
const { permissionsFor } = require('../constants/opsRoles');
const { OpsError, writeAudit, actorFromUser } = require('./opsAudit');
const { loadUserWithRoles } = require('./userRoles');

const OPS_TOKEN_TYPE = 'ops_admin';
const CODE_PREFIX = 'osc_';
const CODE_TTL_SEC = 60;
const CODE_RETENTION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TTL_SEC = 43200;
const MIN_TTL_SEC = 300;
const MAX_TTL_SEC = 43200;
const DEFAULT_OPS_ADMIN_URL = 'https://admin.datadance.ai';

const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CODE_PATTERN = /^osc_[A-Za-z0-9_-]{43}$/;

/** OPS_SHARED_LOGIN: 'on' enables the shared emergency login; anything else (default) is off. */
function sharedLoginOn(env = process.env) {
  return String(env.OPS_SHARED_LOGIN || '').trim().toLowerCase() === 'on';
}

/** OPS_USER_TOKEN_TTL_SEC, default 43200, clamped to 300..43200. */
function opsUserTokenTtlSec(env = process.env) {
  const parsed = Number.parseInt(String(env.OPS_USER_TOKEN_TTL_SEC ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_SEC;
  return Math.min(Math.max(parsed, MIN_TTL_SEC), MAX_TTL_SEC);
}

/**
 * OPS_ADMIN_URL as an origin (default https://admin.datadance.ai), or null when it is not an https
 * origin or http://localhost:<port>.
 */
function opsAdminUrl(env = process.env) {
  const raw = String(env.OPS_ADMIN_URL ?? '').trim() || DEFAULT_OPS_ADMIN_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && url.hostname === 'localhost' && url.port) return url.origin;
  return null;
}

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new OpsError(500, 'SERVER_ERROR', 'JWT_SECRET is not configured');
  return secret;
}

function signUserOpsToken(userId) {
  const expiresIn = opsUserTokenTtlSec();
  const token = jwt.sign({ type: OPS_TOKEN_TYPE, kind: 'user', sub: userId }, jwtSecret(), { expiresIn });
  return { token, expiresIn };
}

function signSharedOpsToken() {
  const expiresIn = opsUserTokenTtlSec();
  const token = jwt.sign(
    { type: OPS_TOKEN_TYPE, kind: 'shared', sub: 'shared', role: 'shared' },
    jwtSecret(),
    { expiresIn },
  );
  return { token, expiresIn };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function challengeOf(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function sameText(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * POST /api/ops/auth/code, after `protect`: the caller is req.user, req.authClaims its wallet JWT.
 * Answers the code, its lifetime, the fixed redirect target and the e-mail it signs in as.
 */
async function mintSignInCode({ user, authClaims, body }, db = prisma) {
  if (!(Number(authClaims && authClaims.ver) >= 2)) {
    throw new OpsError(403, 'VERIFIED_SESSION_REQUIRED', 'Please sign in again to continue.');
  }
  const staff = await loadUserWithRoles(user.id, db);
  if (!staff || staff.user.disabledAt) throw new OpsError(403, 'ACCOUNT_DISABLED', 'This account has been disabled.');
  if (!staff.role) throw new OpsError(403, 'NOT_STAFF', 'This account has no operations access.');
  const challenge = body && typeof body.code_challenge === 'string' ? body.code_challenge : '';
  if (!CHALLENGE_PATTERN.test(challenge)) {
    throw new OpsError(400, 'INVALID_REQUEST', 'code_challenge must be 43 base64url characters.');
  }
  const adminUrl = opsAdminUrl();
  if (!adminUrl) throw new OpsError(500, 'SERVER_ERROR', 'OPS_ADMIN_URL is not configured correctly.');

  const now = Date.now();
  const code = `${CODE_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
  await db.opsSignInCode.deleteMany({ where: { expiresAt: { lt: new Date(now - CODE_RETENTION_MS) } } });
  await db.opsSignInCode.create({
    data: {
      codeHash: sha256Hex(code),
      userId: staff.user.id,
      challenge,
      expiresAt: new Date(now + CODE_TTL_SEC * 1000),
    },
  });
  return {
    code,
    expires_in: CODE_TTL_SEC,
    redirect_uri: `${adminUrl}/auth/callback`,
    email: staff.user.email,
  };
}

function invalidGrant() {
  return new OpsError(400, 'INVALID_GRANT', 'This sign-in link is no longer valid. Please sign in again.');
}

/**
 * POST /api/ops/auth/exchange (public). Consume the code (exactly one row), check the verifier in
 * constant time, re-read the account (it must exist, be enabled and be staff), write auth.sign_in
 * and answer the session. Every failure is 400 INVALID_GRANT.
 */
async function exchangeSignInCode({ body, requestId = null }, db = prisma) {
  const code = body && typeof body.code === 'string' ? body.code : '';
  const verifier = body && typeof body.code_verifier === 'string' ? body.code_verifier : '';
  if (!CODE_PATTERN.test(code)) throw invalidGrant();

  const codeHash = sha256Hex(code);
  const now = new Date();
  const consumed = await db.opsSignInCode.updateMany({
    where: { codeHash, consumedAt: null, expiresAt: { gt: now } },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) throw invalidGrant();
  const row = await db.opsSignInCode.findUnique({ where: { codeHash } });
  if (!row) throw invalidGrant();
  if (!VERIFIER_PATTERN.test(verifier) || !sameText(challengeOf(verifier), row.challenge)) throw invalidGrant();

  const staff = await loadUserWithRoles(row.userId, db);
  if (!staff || staff.user.disabledAt || !staff.role) throw invalidGrant();

  await writeAudit(db, {
    actor: actorFromUser(staff.user, staff.role),
    action: 'auth.sign_in',
    target: { type: 'user', id: staff.user.id, label: staff.user.email },
    detail: { role: staff.role },
    surface: 'ops',
    requestId,
  });
  const session = signUserOpsToken(staff.user.id);
  return {
    token: session.token,
    expiresIn: session.expiresIn,
    kind: 'user',
    userId: staff.user.id,
    email: staff.user.email,
    name: staff.user.name,
    role: staff.role,
    roles: staff.roles,
    permissions: permissionsFor(staff.role),
  };
}

module.exports = {
  OPS_TOKEN_TYPE,
  CODE_TTL_SEC,
  sharedLoginOn,
  opsUserTokenTtlSec,
  opsAdminUrl,
  signUserOpsToken,
  signSharedOpsToken,
  mintSignInCode,
  exchangeSignInCode,
  _internals: { challengeOf, sha256Hex, CHALLENGE_PATTERN, VERIFIER_PATTERN, CODE_PATTERN },
};
