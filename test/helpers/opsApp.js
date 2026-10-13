/**
 * The REAL application (src/app.js) on the in-memory Prisma stand-in, for the ops roles and audit
 * tests (admin issue #2). The mock honours orderBy/skip/take and rolls an interactive transaction
 * back when it throws, so "a failed audit write leaves nothing changed" can be tested.
 *
 * Call installOpsApp() once at the top of a test file, before requiring anything under src/.
 * Synthetic values only.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { installMockPrisma } = require('./mockPrisma');
const { listenLoopback } = require('./loopbackServer');

const JWT_SECRET = 'ops-roles-unit-test-jwt-key';
const ISSUER = 'https://api.test.local';

const BASE_ENV = {
  LOG_LEVEL: 'error',
  WEB3AUTH_VERIFY_MODE: 'off',
  // passWebServiceController builds an APNs provider at load time; identifiers only.
  APNS_KEY_ID: 'TESTKEY001',
  APNS_TEAM_ID: 'TESTTEAM01',
  SSO_ENVIRONMENT: 'test',
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
  JWT_SECRET,
  SSO_SESSION_SECRET: 'ops-roles-unit-test-session-key',
  OPS_ADMIN_URL: 'https://admin.test.local',
};

function installOpsApp({ env = {}, unset = [] } = {}) {
  const prisma = installMockPrisma({ paging: true, rollback: true });
  // `protect` and `auth.authenticate` construct their own PrismaClient at load; same store.
  require.cache[require.resolve('@prisma/client')].exports = {
    PrismaClient: function PrismaClient() {
      return prisma;
    },
  };
  Object.assign(process.env, BASE_ENV, env);
  for (const name of ['OPS_SHARED_LOGIN', 'OPS_USER_TOKEN_TTL_SEC', 'SSO_DEVELOPER_REGISTRATION', ...unset]) {
    if (!(name in env)) delete process.env[name];
  }
  const app = require('../../src/app');
  return { prisma, app };
}

let seq = 0;

/** A plain C-end account (the columns the code under test reads). */
async function seedUser(prisma, over = {}) {
  seq += 1;
  const id = over.id || `user-${seq}-${crypto.randomBytes(3).toString('hex')}`;
  return prisma.user.create({
    data: {
      id,
      email: `${id}@example.test`,
      name: `Name ${seq}`,
      walletAddress: null,
      referralCode: `R${String(seq).padStart(5, '0')}`,
      totalPoints: 0,
      authType: 'web3auth',
      userType: 'regular',
      isOrganization: false,
      xid: null,
      xUsername: null,
      disabledAt: null,
      disabledBy: null,
      disabledReason: null,
      sessionsResetAt: null,
      web3authVerifier: null,
      web3authVerifierId: null,
      web3authLinkedAt: null,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      ...over,
    },
  });
}

async function grant(prisma, userId, role, over = {}) {
  return prisma.userRoleGrant.create({
    data: { userId, role, grantedBy: 'script', grantedByUserId: null, reason: 'seed for test', ...over },
  });
}

const bearer = (token) => `Bearer ${token}`;

const tokens = {
  /**
   * The wallet's user JWT (`ver: 2` = a verified session). `ageSec` backdates its `iat` (a sign-in
   * that many seconds ago).
   */
  wallet: (user, { ver = 2, ageSec = 0 } = {}) =>
    jwt.sign({ id: user.id, ver, iat: Math.floor(Date.now() / 1000) - ageSec }, JWT_SECRET, { expiresIn: '1h' }),
  /** A personal ops session; `ageSec` backdates its `iat`. */
  ops: (user, { expiresIn = '5m', ageSec = 0 } = {}) =>
    jwt.sign({ type: 'ops_admin', kind: 'user', sub: user.id, iat: Math.floor(Date.now() / 1000) - ageSec }, JWT_SECRET, { expiresIn }),
  /** A legacy shared-login token (before personal sign-in): role 'admin'. */
  legacyShared: () => jwt.sign({ type: 'ops_admin', sub: 'ops-legacy', role: 'admin' }, JWT_SECRET, { expiresIn: '5m' }),
  /** A shared-login token as POST /auth/login issues it now. */
  shared: () => jwt.sign({ type: 'ops_admin', kind: 'shared', sub: 'shared', role: 'shared' }, JWT_SECRET, { expiresIn: '5m' }),
  demo: () => jwt.sign({ type: 'ops_admin', sub: 'demo-viewer', role: 'demo' }, JWT_SECRET, { expiresIn: '5m' }),
};

/**
 * The record label staff writes outside the audit log, computed here on its own so the tests check
 * the server's: `ops:` and the first 10 hex of HMAC-SHA256(HMAC-SHA256(JWT_SECRET, 'ops-record-label'), id).
 */
function recordLabel(userId, secret = process.env.JWT_SECRET) {
  const key = crypto.createHmac('sha256', secret).update('ops-record-label').digest();
  return `ops:${crypto.createHmac('sha256', key).update(String(userId)).digest('hex').slice(0, 10)}`;
}

/** Lets background work (the generic audit row) land before asserting on it. */
function settle(ms = 25) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  JWT_SECRET,
  ISSUER,
  installOpsApp,
  listenLoopback,
  seedUser,
  grant,
  bearer,
  tokens,
  settle,
  recordLabel,
};
