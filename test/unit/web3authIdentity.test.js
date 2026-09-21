const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const jose = require('jose');
const { Wallet } = require('ethers');

// Env must be in place before the module loads (it asserts its config at load time).
const CLIENT_ID = 'test-web3auth-client-id';
const SOCIAL_ISS = 'https://api-auth.web3auth.io';
const EXTERNAL_ISS = 'https://authjs.web3auth.io';
process.env.NODE_ENV = 'test';
process.env.WEB3AUTH_VERIFY_MODE = 'enforce';
process.env.WEB3AUTH_CLIENT_ID = CLIENT_ID;

const identityService = require('../../src/services/web3authIdentity');
const { verifyIdToken, extractIdentity, assertWalletBound, resolveUser, _internals } = identityService;

// ---------------------------------------------------------------------------
// Local JWKS + token minting
// ---------------------------------------------------------------------------

const keys = {};
let server;
let baseUrl;

async function makeKey(kid) {
  const { publicKey, privateKey } = await jose.generateKeyPair('ES256');
  const jwk = await jose.exportJWK(publicKey);
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } };
}

before(async () => {
  keys.social = await makeKey('social-kid-1');
  keys.external = await makeKey('external-kid-1');
  keys.rogue = await makeKey('rogue-kid'); // never served

  server = http.createServer((req, res) => {
    const body =
      req.url === '/jwks'
        ? { keys: [keys.social.jwk] }
        : req.url === '/ext-jwks'
          ? { keys: [keys.external.jwk] }
          : null;
    if (!body) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.WEB3AUTH_JWKS_URL = `${baseUrl}/jwks`;
  process.env.WEB3AUTH_EXTERNAL_JWKS_URL = `${baseUrl}/ext-jwks`;
  _internals.resetConfig();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const social = () => Wallet.createRandom();
const compressedHex = (wallet) => wallet.signingKey.compressedPublicKey.slice(2); // 66 hex, no 0x

function socialClaims(wallet, overrides = {}) {
  return {
    email: 'alice@example.com',
    name: 'Alice',
    profileImage: 'https://img.example/alice.png',
    aggregateVerifier: 'web3auth-google-sapphire-devnet',
    verifier: 'torus',
    verifierId: 'alice@example.com',
    wallets: [{ public_key: compressedHex(wallet), type: 'web3auth_app_key', curve: 'secp256k1' }],
    ...overrides,
  };
}

async function mint(claims, { key = keys.social, iss = SOCIAL_ISS, aud = CLIENT_ID, exp = '1h', iat, kid, alg = 'ES256' } = {}) {
  const jwt = new jose.SignJWT(claims)
    .setProtectedHeader({ alg, kid: kid || key.kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setExpirationTime(exp);
  if (iat !== undefined) jwt.setIssuedAt(iat);
  else jwt.setIssuedAt();
  return jwt.sign(key.privateKey);
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
    assert.equal(err.httpStatus, _internals.HTTP_STATUS[code]);
    return true;
  });
}

// ---------------------------------------------------------------------------
// verifyIdToken
// ---------------------------------------------------------------------------

describe('verifyIdToken', () => {
  it('accepts a valid social token and derives the address from the compressed public key', async () => {
    const w = social();
    const token = await mint(socialClaims(w));
    const { kind, payload } = await verifyIdToken(token);
    assert.equal(kind, 'social');
    const identity = extractIdentity(payload, { kind });
    assert.equal(identity.verifier, 'web3auth-google-sapphire-devnet');
    assert.equal(identity.verifierId, 'alice@example.com');
    assert.equal(identity.email, 'alice@example.com');
    assert.equal(assertWalletBound(identity, w.address.toLowerCase()), w.address);
    assert.equal(assertWalletBound(identity, undefined), w.address);
  });

  it('accepts a valid external-wallet token from its own issuer/JWKS and keys identity on the address', async () => {
    const w = social();
    const token = await mint(
      { wallets: [{ address: w.address.toLowerCase(), type: 'ethereum' }] },
      { key: keys.external, iss: EXTERNAL_ISS }
    );
    const { kind, payload } = await verifyIdToken(token);
    assert.equal(kind, 'external');
    const identity = extractIdentity(payload, { kind });
    assert.equal(identity.verifier, identityService.EXTERNAL_WALLET_VERIFIER);
    assert.equal(identity.verifierId, w.address.toLowerCase());
    assert.equal(identity.email, null);
    assert.equal(assertWalletBound(identity, w.address), w.address);
  });

  it('rejects an expired token', async () => {
    const w = social();
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(socialClaims(w), { iat: now - 7200, exp: now - 3600 });
    await expectCode(verifyIdToken(token), 'IDTOKEN_EXPIRED');
  });

  it('rejects a token older than WEB3AUTH_MAX_TOKEN_AGE even when exp is in the future', async () => {
    const w = social();
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(socialClaims(w), { iat: now - 3 * 86400, exp: now + 3600 });
    await expectCode(verifyIdToken(token), 'IDTOKEN_EXPIRED');
  });

  it('rejects an unknown issuer', async () => {
    const w = social();
    const token = await mint(socialClaims(w), { iss: 'https://evil.example' });
    await expectCode(verifyIdToken(token), 'IDTOKEN_ISSUER');
  });

  it('rejects a token for another project (wrong aud)', async () => {
    const w = social();
    const token = await mint(socialClaims(w), { aud: 'some-other-client' });
    await expectCode(verifyIdToken(token), 'IDTOKEN_AUDIENCE');
  });

  it('rejects alg none', async () => {
    const w = social();
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const token = `${b64({ alg: 'none' })}.${b64({ ...socialClaims(w), iss: SOCIAL_ISS, aud: CLIENT_ID, iat: now, exp: now + 3600 })}.`;
    await assert.rejects(verifyIdToken(token), (err) => {
      assert.ok(['IDTOKEN_SIGNATURE', 'IDTOKEN_INVALID'].includes(err.code), err.code);
      return true;
    });
  });

  it('rejects HS256', async () => {
    const w = social();
    const now = Math.floor(Date.now() / 1000);
    const token = await new jose.SignJWT({ ...socialClaims(w), iss: SOCIAL_ISS, aud: CLIENT_ID, iat: now, exp: now + 3600 })
      .setProtectedHeader({ alg: 'HS256', kid: keys.social.kid })
      .sign(new TextEncoder().encode('not-a-secret-anyone-cares-about'));
    await expectCode(verifyIdToken(token), 'IDTOKEN_SIGNATURE');
  });

  it('rejects an unknown kid', async () => {
    const w = social();
    const token = await mint(socialClaims(w), { key: keys.rogue });
    await expectCode(verifyIdToken(token), 'IDTOKEN_SIGNATURE');
  });

  it('rejects a tampered signature (known kid, wrong key)', async () => {
    const w = social();
    const token = await mint(socialClaims(w), { key: keys.rogue, kid: keys.social.kid });
    await expectCode(verifyIdToken(token), 'IDTOKEN_SIGNATURE');
  });

  it('rejects an external-wallet token signed with the social key (JWKS are per kind)', async () => {
    const w = social();
    const token = await mint(
      { wallets: [{ address: w.address, type: 'ethereum' }] },
      { key: keys.social, iss: EXTERNAL_ISS }
    );
    await expectCode(verifyIdToken(token), 'IDTOKEN_SIGNATURE');
  });

  it('rejects a missing / malformed token', async () => {
    await expectCode(verifyIdToken(''), 'IDTOKEN_REQUIRED');
    await expectCode(verifyIdToken(undefined), 'IDTOKEN_REQUIRED');
    await expectCode(verifyIdToken('not.a.jwt'), 'IDTOKEN_INVALID');
  });
});

// ---------------------------------------------------------------------------
// extractIdentity / assertWalletBound
// ---------------------------------------------------------------------------

describe('extractIdentity', () => {
  it('fails with IDTOKEN_INVALID when the token has no verifierId', async () => {
    const w = social();
    const token = await mint(socialClaims(w, { verifierId: undefined }));
    const { kind, payload } = await verifyIdToken(token);
    assert.throws(() => extractIdentity(payload, { kind }), (err) => err.code === 'IDTOKEN_INVALID');
  });

  it('falls back to the v10 claim names (groupedAuthConnectionId / userId)', async () => {
    const w = social();
    const token = await mint(
      socialClaims(w, {
        aggregateVerifier: undefined,
        verifier: undefined,
        verifierId: undefined,
        groupedAuthConnectionId: 'web3auth-google-sapphire-mainnet',
        authConnectionId: 'google',
        userId: 'alice@example.com',
      })
    );
    const { kind, payload } = await verifyIdToken(token);
    const identity = extractIdentity(payload, { kind });
    assert.equal(identity.verifier, 'web3auth-google-sapphire-mainnet');
    assert.equal(identity.verifierId, 'alice@example.com');
  });

  it('prefers the aggregate verifier over the plain verifier', () => {
    const identity = extractIdentity({ aggregateVerifier: 'agg', verifier: 'plain', verifierId: 'x' });
    assert.equal(identity.verifier, 'agg');
    const plain = extractIdentity({ verifier: 'plain', verifierId: 'x' });
    assert.equal(plain.verifier, 'plain');
  });

  it('lower-cases an e-mail-shaped verifierId for the identity key and keeps the raw value', () => {
    const identity = extractIdentity({ verifier: 'torus', verifierId: 'Alice@Example.com', email: 'Alice@Example.com' });
    assert.equal(identity.verifierId, 'alice@example.com');
    assert.equal(identity.verifierIdRaw, 'Alice@Example.com');
    assert.equal(identity.email, 'Alice@Example.com');
    const opaque = extractIdentity({ verifier: 'torus', verifierId: 'twitter|ABC123' });
    assert.equal(opaque.verifierId, 'twitter|ABC123');
  });

  it('ignores an e-mail claim that is not an e-mail', () => {
    const identity = extractIdentity({ verifier: 'torus', verifierId: 'twitter|123', email: 'twitter|123' });
    assert.equal(identity.email, null);
  });
});

describe('assertWalletBound', () => {
  it('rejects a claimed wallet the token does not prove', () => {
    const w = social();
    const other = social();
    const identity = extractIdentity(socialClaims(w));
    assert.throws(() => assertWalletBound(identity, other.address), (err) => err.code === 'WALLET_NOT_IN_TOKEN');
  });

  it('prefers the app-scoped key when the token lists several secp256k1 keys and none is claimed', () => {
    const app = social();
    const threshold = social();
    const identity = extractIdentity(
      socialClaims(app, {
        wallets: [
          { public_key: compressedHex(threshold), type: 'web3auth_threshold_key', curve: 'secp256k1' },
          { public_key: compressedHex(app), type: 'web3auth_app_key', curve: 'secp256k1' },
        ],
      })
    );
    assert.equal(assertWalletBound(identity, undefined), app.address);
    assert.equal(assertWalletBound(identity, threshold.address), threshold.address);
  });

  it('returns null when the token proves no wallet and none is claimed', () => {
    const identity = extractIdentity({ verifier: 'torus', verifierId: 'x' });
    assert.equal(assertWalletBound(identity, undefined), null);
  });

  it('ignores public keys under WEB3AUTH_WALLET_MATCH=address and everything under none', () => {
    const w = social();
    const identity = extractIdentity(socialClaims(w));
    process.env.WEB3AUTH_WALLET_MATCH = 'address';
    _internals.resetConfig();
    try {
      assert.throws(() => assertWalletBound(identity, w.address), (err) => err.code === 'WALLET_NOT_IN_TOKEN');
      process.env.WEB3AUTH_WALLET_MATCH = 'none';
      _internals.resetConfig();
      assert.equal(assertWalletBound(identity, w.address), null);
    } finally {
      delete process.env.WEB3AUTH_WALLET_MATCH;
      _internals.resetConfig();
    }
  });
});

// ---------------------------------------------------------------------------
// Boot config
// ---------------------------------------------------------------------------

describe('assertBootConfig', () => {
  it('refuses off in production', () => {
    assert.throws(
      () => _internals.assertBootConfig({ NODE_ENV: 'production', WEB3AUTH_VERIFY_MODE: 'off' }),
      /not allowed when NODE_ENV=production/
    );
  });
  it('requires the client id unless off', () => {
    assert.throws(() => _internals.assertBootConfig({ WEB3AUTH_VERIFY_MODE: 'log' }), /WEB3AUTH_CLIENT_ID is required/);
    assert.equal(_internals.assertBootConfig({ WEB3AUTH_VERIFY_MODE: 'off' }).mode, 'off');
  });
  it('defaults to log mode, ES256, 1d and the public_key wallet match', () => {
    const cfg = _internals.loadConfig({ WEB3AUTH_CLIENT_ID: 'c' });
    assert.equal(cfg.mode, 'log');
    assert.deepEqual(cfg.algs, ['ES256']);
    assert.equal(cfg.maxTokenAge, '1d');
    assert.equal(cfg.walletMatch, 'public_key');
    assert.deepEqual(cfg.kinds.external.audience, ['c']);
  });
});

// ---------------------------------------------------------------------------
// resolveUser with a hand-rolled prisma mock
// ---------------------------------------------------------------------------

function mockPrisma(rows, { updateManyCount } = {}) {
  let seq = 0;
  const calls = [];
  const users = rows.map((r) => ({
    id: r.id || `u${++seq}`,
    name: null,
    avatar: null,
    walletAddress: null,
    authType: 'web3auth',
    userType: 'regular',
    isOrganization: false,
    xid: null,
    web3authVerifier: null,
    web3authVerifierId: null,
    web3authLinkedAt: null,
    disabledAt: null,
    ...r,
  }));
  const byId = (id) => users.find((u) => u.id === id) || null;
  const user = {
    async findUnique({ where }) {
      calls.push(['findUnique', where]);
      if (where.id) return byId(where.id);
      if (where.email) return users.find((u) => u.email === where.email) || null;
      if (where.web3authVerifier_web3authVerifierId) {
        const p = where.web3authVerifier_web3authVerifierId;
        return (
          users.find(
            (u) => u.web3authVerifier === p.web3authVerifier && u.web3authVerifierId === p.web3authVerifierId
          ) || null
        );
      }
      throw new Error('mock: unsupported findUnique ' + JSON.stringify(where));
    },
    async findFirst({ where }) {
      calls.push(['findFirst', where]);
      if (where.email) {
        const e = where.email;
        const target = typeof e === 'string' ? e : e.equals;
        const ci = typeof e === 'object' && e.mode === 'insensitive';
        return users.find((u) => (ci ? u.email.toLowerCase() === target.toLowerCase() : u.email === target)) || null;
      }
      const w = where.walletAddress;
      const target = typeof w === 'string' ? w : w && w.equals;
      return users.find((u) => u.walletAddress && u.walletAddress.toLowerCase() === target.toLowerCase()) || null;
    },
    async updateMany({ where, data }) {
      calls.push(['updateMany', where, data]);
      if (typeof updateManyCount === 'number') return { count: updateManyCount };
      const u = byId(where.id);
      if (!u || u.web3authVerifier !== null) return { count: 0 };
      Object.assign(u, data);
      return { count: 1 };
    },
    async create({ data }) {
      calls.push(['create', data]);
      const dup = users.find(
        (u) =>
          u.email === data.email ||
          (data.walletAddress && u.walletAddress && u.walletAddress.toLowerCase() === data.walletAddress.toLowerCase())
      );
      if (dup) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['email'] } });
      const { profile, ...rest } = data;
      const created = { id: `u${++seq}`, name: null, avatar: null, walletAddress: null, xid: null, disabledAt: null, ...rest };
      users.push(created);
      return created;
    },
  };
  const db = {
    user,
    referral: { async create({ data }) { calls.push(['referral.create', data]); return data; } },
    async $transaction(fn) { return fn(db); },
    _users: users,
    _calls: calls,
  };
  return db;
}

const IDENTITY = {
  kind: 'social',
  verifier: 'web3auth-google-sapphire-devnet',
  verifierId: 'alice@example.com',
  email: 'alice@example.com',
  name: 'Alice',
  profileImage: null,
  wallets: [],
};

/**
 * The only opt-in that lets an IdP-asserted e-mail key an existing account: the verifier is
 * named in WEB3AUTH_LEGACY_VERIFIERS and the token itself says the address is verified.
 */
function allowLegacyEmailBackfill(identity = IDENTITY) {
  process.env.WEB3AUTH_LEGACY_VERIFIERS = identity.verifier;
  _internals.resetConfig();
  return { ...identity, emailVerified: true };
}

async function conflictReason(promise) {
  let caught = null;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, 'expected IDENTITY_CONFLICT, got a resolved promise');
  assert.equal(caught.code, 'IDENTITY_CONFLICT', caught.message);
  return caught.details && caught.details.reason;
}

describe('resolveUser', () => {
  beforeEach(() => {
    delete process.env.WEB3AUTH_LEGACY_VERIFIERS;
    _internals.resetConfig();
  });

  it('hits by pair and does not touch e-mail', async () => {
    const db = mockPrisma([
      { id: 'linked', email: 'other@example.com', web3authVerifier: IDENTITY.verifier, web3authVerifierId: IDENTITY.verifierId },
      { id: 'byEmail', email: 'alice@example.com' },
    ]);
    const { user, action } = await resolveUser(IDENTITY, { db });
    assert.equal(action, 'login');
    assert.equal(user.id, 'linked');
    assert.equal(db._calls.filter(([op]) => op === 'updateMany' || op === 'create').length, 0);
  });

  it('backfills an unlinked legacy web3auth row found by e-mail (count 1)', async () => {
    const db = mockPrisma([{ id: 'legacy', email: 'alice@example.com', walletAddress: '0xAbC0000000000000000000000000000000000001' }]);
    const { user, action } = await resolveUser(IDENTITY, { db, walletAddress: '0xabc0000000000000000000000000000000000001' });
    assert.equal(action, 'backfilled');
    assert.equal(user.id, 'legacy');
    assert.equal(user.web3authVerifier, IDENTITY.verifier);
    assert.equal(user.web3authVerifierId, IDENTITY.verifierId);
    assert.ok(user.web3authLinkedAt instanceof Date);
    const um = db._calls.find(([op]) => op === 'updateMany');
    assert.deepEqual(um[1], { id: 'legacy', web3authVerifier: null });
  });

  it('backfills a legacy row whose stored e-mail differs only by case', async () => {
    const identity = allowLegacyEmailBackfill();
    const db = mockPrisma([{ id: 'legacy', email: 'Alice@Example.com' }]);
    const { user, action } = await resolveUser(identity, { db });
    assert.equal(action, 'backfilled');
    assert.equal(user.id, 'legacy');
    assert.equal(user.email, 'Alice@Example.com');
    const ff = db._calls.find(([op]) => op === 'findFirst');
    assert.deepEqual(ff[1], { email: { equals: 'alice@example.com', mode: 'insensitive' } });
  });

  it('backfills a legacy row found by the proven wallet when the e-mail differs', async () => {
    const db = mockPrisma([{ id: 'legacy', email: 'twitter|123', walletAddress: '0xAbC0000000000000000000000000000000000001' }]);
    const { user, action } = await resolveUser(IDENTITY, { db, walletAddress: '0xAbC0000000000000000000000000000000000001' });
    assert.equal(action, 'backfilled');
    assert.equal(user.id, 'legacy');
  });

  it('turns a lost backfill race (count 0) into IDENTITY_CONFLICT', async () => {
    const identity = allowLegacyEmailBackfill();
    const db = mockPrisma([{ id: 'legacy', email: 'alice@example.com' }], { updateManyCount: 0 });
    await expectCode(resolveUser(identity, { db }), 'IDENTITY_CONFLICT');
  });

  it('never merges into a traditional (password) account with the same e-mail', async () => {
    const db = mockPrisma([{ id: 'pw', email: 'alice@example.com', authType: 'traditional' }]);
    await expectCode(resolveUser(IDENTITY, { db }), 'IDENTITY_CONFLICT');
    assert.equal(db._users[0].web3authVerifier, null);
  });

  it('never re-links a row already linked to another pair', async () => {
    const db = mockPrisma([
      { id: 'linked', email: 'alice@example.com', web3authVerifier: 'web3auth-auth0-email-passwordless-sapphire-devnet', web3authVerifierId: 'alice@example.com' },
    ]);
    await expectCode(resolveUser(IDENTITY, { db }), 'IDENTITY_CONFLICT');
  });

  it('refuses a wallet-inconsistent candidate', async () => {
    const db = mockPrisma([{ id: 'legacy', email: 'alice@example.com', walletAddress: '0xAbC0000000000000000000000000000000000001' }]);
    await expectCode(
      resolveUser(IDENTITY, { db, walletAddress: '0xAbC0000000000000000000000000000000000002' }),
      'IDENTITY_CONFLICT'
    );
  });

  it('honours WEB3AUTH_LEGACY_VERIFIERS', async () => {
    process.env.WEB3AUTH_LEGACY_VERIFIERS = 'web3auth-auth0-email-passwordless-sapphire-devnet';
    _internals.resetConfig();
    const db = mockPrisma([{ id: 'legacy', email: 'alice@example.com' }]);
    await expectCode(resolveUser(IDENTITY, { db }), 'IDENTITY_CONFLICT');
  });

  it('creates a new user with the pair, token e-mail and the prepareCreate/afterCreate hooks', async () => {
    const db = mockPrisma([]);
    const seen = [];
    const { user, action } = await resolveUser(IDENTITY, {
      db,
      walletAddress: '0xAbC0000000000000000000000000000000000001',
      prepareCreate: async () => ({ referralCode: 'REF123', xid: '42' }),
      afterCreate: async (tx, created) => {
        seen.push(created.id);
        await tx.referral.create({ data: { inviteeId: created.id } });
      },
    });
    assert.equal(action, 'created');
    assert.deepEqual(seen, [user.id]);
    assert.equal(user.email, 'alice@example.com');
    assert.equal(user.name, 'Alice');
    assert.equal(user.authType, 'web3auth');
    assert.equal(user.web3authVerifier, IDENTITY.verifier);
    assert.equal(user.web3authVerifierId, IDENTITY.verifierId);
    assert.equal(user.referralCode, 'REF123');
    assert.equal(user.xid, '42');
    assert.equal(user.walletAddress, '0xAbC0000000000000000000000000000000000001');
    assert.ok(db._calls.some(([op]) => op === 'referral.create'));
  });

  it('uses the verifierId as the account e-mail when the token carries none (legacy X rows)', async () => {
    const db = mockPrisma([]);
    const { user } = await resolveUser({ ...IDENTITY, email: null, verifierId: 'twitter|123', name: null }, { db });
    assert.equal(user.email, 'twitter|123');
    assert.equal(user.name, 'User');
  });

  it('maps a unique violation on create to IDENTITY_CONFLICT', async () => {
    const db = mockPrisma([{ id: 'w', email: 'zed@example.com', walletAddress: '0xAbC0000000000000000000000000000000000009', authType: 'web3auth' }]);
    // e-mail candidate absent, wallet candidate found → wallet-consistent backfill, so force the create path instead
    db.user.findFirst = async () => null;
    await expectCode(
      resolveUser(IDENTITY, { db, walletAddress: '0xAbC0000000000000000000000000000000000009' }),
      'IDENTITY_CONFLICT'
    );
  });

  it('refuses organization accounts (by pair and as backfill candidate)', async () => {
    const byPair = mockPrisma([
      { id: 'org', email: 'alice@example.com', userType: 'organization', isOrganization: true, web3authVerifier: IDENTITY.verifier, web3authVerifierId: IDENTITY.verifierId },
    ]);
    await expectCode(resolveUser(IDENTITY, { db: byPair }), 'ORG_NOT_ALLOWED');
    const candidate = mockPrisma([{ id: 'org', email: 'alice@example.com', userType: 'organization', isOrganization: true }]);
    await expectCode(resolveUser(IDENTITY, { db: candidate }), 'ORG_NOT_ALLOWED');
    assert.equal(candidate._users[0].web3authVerifier, null);
  });

  it('refuses disabled accounts (by pair and as backfill candidate)', async () => {
    const byPair = mockPrisma([
      { id: 'dis', email: 'alice@example.com', disabledAt: new Date(), web3authVerifier: IDENTITY.verifier, web3authVerifierId: IDENTITY.verifierId },
    ]);
    await expectCode(resolveUser(IDENTITY, { db: byPair }), 'ACCOUNT_DISABLED');
    const candidate = mockPrisma([{ id: 'dis', email: 'alice@example.com', disabledAt: new Date() }]);
    await expectCode(resolveUser(IDENTITY, { db: candidate }), 'ACCOUNT_DISABLED');
    assert.equal(candidate._users[0].web3authVerifier, null);
  });
});

// ---------------------------------------------------------------------------
// Legacy-row linking: what may key someone else's account (plan §5 F03)
// ---------------------------------------------------------------------------

describe('legacy backfill gating', () => {
  const WALLET = '0xAbC0000000000000000000000000000000000001';

  beforeEach(() => {
    delete process.env.WEB3AUTH_LEGACY_VERIFIERS;
    delete process.env.WEB3AUTH_EMAIL_VERIFIED_CLAIM;
    _internals.resetConfig();
  });

  it('never backfills by e-mail while WEB3AUTH_LEGACY_VERIFIERS is empty', async () => {
    // The Web3Auth client id ships in the SPA bundle, so "any verifier" is "any attacker".
    const db = mockPrisma([{ id: 'victim', email: 'alice@example.com' }]);
    assert.equal(await conflictReason(resolveUser({ ...IDENTITY, emailVerified: true }, { db })), 'verifier_not_allowed');
    assert.equal(db._users[0].web3authVerifier, null);
  });

  it('never backfills on an e-mail the IdP did not mark verified', async () => {
    process.env.WEB3AUTH_LEGACY_VERIFIERS = IDENTITY.verifier;
    _internals.resetConfig();
    const db = mockPrisma([{ id: 'victim', email: 'alice@example.com' }]);
    assert.equal(await conflictReason(resolveUser({ ...IDENTITY, emailVerified: false }, { db })), 'email_not_verified');
    assert.equal(await conflictReason(resolveUser(IDENTITY, { db })), 'email_not_verified', 'absent claim = unverified');
    assert.equal(db._users[0].web3authVerifier, null);
  });

  it('does not treat a NULL wallet as wallet-consistent', async () => {
    const { walletConsistent } = _internals;
    assert.equal(walletConsistent({ walletAddress: null }, WALLET), false, 'a row with no wallet proves nothing');
    assert.equal(walletConsistent({ walletAddress: WALLET }, WALLET.toLowerCase()), true);
    assert.equal(walletConsistent({ walletAddress: WALLET }, null), false);

    // Most legacy rows have no wallet: that used to make the e-mail route "consistent" for free.
    const db = mockPrisma([{ id: 'victim', email: 'alice@example.com', walletAddress: null }]);
    assert.equal(
      await conflictReason(resolveUser({ ...IDENTITY, emailVerified: true }, { db, walletAddress: WALLET })),
      'verifier_not_allowed'
    );
    assert.equal(db._users[0].web3authVerifier, null);
  });

  it('backfills when the verifier is allow-listed and the e-mail is verified', async () => {
    const identity = allowLegacyEmailBackfill();
    const db = mockPrisma([{ id: 'legacy', email: 'alice@example.com' }]);
    const { user, action } = await resolveUser(identity, { db });
    assert.equal(action, 'backfilled');
    assert.equal(user.id, 'legacy');
    assert.equal(user.web3authVerifier, identity.verifier);
  });

  it('keeps the cryptographic route: a wallet the token proves needs no allow-list', async () => {
    const db = mockPrisma([{ id: 'legacy', email: 'alice@example.com', walletAddress: WALLET }]);
    const { action } = await resolveUser({ ...IDENTITY, emailVerified: false }, { db, walletAddress: WALLET.toLowerCase() });
    assert.equal(action, 'backfilled', 'ownership of the row’s wallet is proof, unlike an e-mail claim');
  });

  it('refuses a linked or non-web3auth row before it looks at the verifier at all', async () => {
    const identity = allowLegacyEmailBackfill();
    const password = mockPrisma([{ id: 'pw', email: 'alice@example.com', authType: 'traditional' }]);
    assert.equal(await conflictReason(resolveUser(identity, { db: password })), 'candidate_not_web3auth');
    const linked = mockPrisma([
      { id: 'other', email: 'alice@example.com', web3authVerifier: 'v2', web3authVerifierId: 'someone-else' },
    ]);
    assert.equal(await conflictReason(resolveUser(identity, { db: linked })), 'candidate_already_linked');
  });
});

describe('email_verified claim', () => {
  beforeEach(() => {
    delete process.env.WEB3AUTH_EMAIL_VERIFIED_CLAIM;
    _internals.resetConfig();
  });

  it('is true only for a real boolean true on the configured claim', () => {
    const base = { verifier: 'torus', verifierId: 'alice@example.com', email: 'alice@example.com' };
    assert.equal(extractIdentity({ ...base, email_verified: true }).emailVerified, true);
    assert.equal(extractIdentity({ ...base, email_verified: 'true' }).emailVerified, false, 'a string is not the IdP saying yes');
    assert.equal(extractIdentity({ ...base, email_verified: 1 }).emailVerified, false);
    assert.equal(extractIdentity(base).emailVerified, false, 'absent = unverified');
    // No e-mail at all (X-style verifierId) is never a verified e-mail.
    assert.equal(extractIdentity({ verifier: 'torus', verifierId: 'twitter|123', email_verified: true }).emailVerified, false);
  });

  it('reads the dot path in WEB3AUTH_EMAIL_VERIFIED_CLAIM', () => {
    process.env.WEB3AUTH_EMAIL_VERIFIED_CLAIM = 'idp.emailVerified';
    _internals.resetConfig();
    try {
      const payload = { verifier: 'torus', verifierId: 'alice@example.com', email: 'alice@example.com' };
      assert.equal(extractIdentity({ ...payload, email_verified: true }).emailVerified, false, 'default claim is ignored now');
      assert.equal(extractIdentity({ ...payload, idp: { emailVerified: true } }).emailVerified, true);
    } finally {
      delete process.env.WEB3AUTH_EMAIL_VERIFIED_CLAIM;
      _internals.resetConfig();
    }
  });
});
