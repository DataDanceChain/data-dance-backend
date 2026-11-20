/**
 * Linked sign-in methods (WEB3AUTH_LINK_TRUSTED_METHODS), no database: the boot rules and every
 * branch of resolveUser's link rules against a hand-rolled prisma mock. The same logins run
 * through the real controller on real Postgres in test/db/linkedLoginMethods.dbtest.js.
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const G = 'web3auth-google-sapphire-mainnet';
const E = 'web3auth-auth0-email-passwordless-sapphire-mainnet';
const A = 'web3auth-auth0-apple-sapphire-mainnet';
const X = 'web3auth-auth0-twitter-sapphire-mainnet';
const ROGUE = 'web3auth-rogue-sapphire-mainnet'; // accepted connection that does not verify e-mail

const BASE_ENV = {
  NODE_ENV: 'test',
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: 'unit-client-id',
  WEB3AUTH_ALLOWED_VERIFIERS: [G, E, A, X, ROGUE, 'external-wallet'].join(','),
  WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: [G, E, A].join(','),
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_WALLET_MATCH: 'public_key',
  WEB3AUTH_LINK_TRUSTED_METHODS: 'on',
};
const MANAGED = [...Object.keys(BASE_ENV), 'WEB3AUTH_NETWORK_REBIND', 'WEB3AUTH_REBIND_VERIFIERS', 'WEB3AUTH_LEGACY_VERIFIERS'];

function setEnv(patch = {}) {
  for (const k of MANAGED) delete process.env[k];
  Object.assign(process.env, BASE_ENV, patch);
  _internals.resetConfig();
}

Object.assign(process.env, BASE_ENV);
const { resolveUser, describeLinkedMethods, _internals } = require('../../src/services/web3authIdentity');

const W = {
  primary: '0x1111111111111111111111111111111111111111',
  google: '0x2222222222222222222222222222222222222222',
  apple: '0x3333333333333333333333333333333333333333',
  x: '0x4444444444444444444444444444444444444444',
  other: '0x5555555555555555555555555555555555555555',
};

// ---------------------------------------------------------------------------
// Mock prisma: User, Web3AuthLinkedMethod, Web3AuthNetworkRebind
// ---------------------------------------------------------------------------

function mockDb({ users = [], links = [], rebinds = [], linkTable = true } = {}) {
  let seq = 0;
  const calls = [];
  const U = users.map((r) => ({
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
  const L = links.map((l) => ({ id: `l${++seq}`, createdAt: new Date(), ...l }));
  const byId = (id) => U.find((u) => u.id === id) || null;
  const ci = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const pick = (row, select) => (row && select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : row);

  const user = {
    async findUnique({ where }) {
      calls.push(['user.findUnique', Object.keys(where)[0]]);
      if (where.id) return byId(where.id);
      if (where.email) return U.find((u) => u.email === where.email) || null;
      if (where.web3authVerifier_web3authVerifierId) {
        const p = where.web3authVerifier_web3authVerifierId;
        return U.find((u) => u.web3authVerifier === p.web3authVerifier && u.web3authVerifierId === p.web3authVerifierId) || null;
      }
      throw new Error('mock: unsupported user.findUnique ' + JSON.stringify(where));
    },
    async findFirst({ where, select }) {
      calls.push(['user.findFirst', Object.keys(where).join(',')]);
      if (where.email) return pick(U.find((u) => ci(u.email, where.email.equals)) || null, select);
      const notId = where.id && where.id.not;
      return pick(
        U.find((u) => u.walletAddress && ci(u.walletAddress, where.walletAddress.equals) && u.id !== notId) || null,
        select
      );
    },
    async findMany({ where, take, select }) {
      calls.push(['user.findMany', 'email']);
      return U.filter((u) => ci(u.email, where.email.equals)).slice(0, take).map((u) => pick(u, select));
    },
    async updateMany({ where, data }) {
      calls.push(['user.updateMany']);
      const u = byId(where.id);
      if (!u || u.web3authVerifier !== null) return { count: 0 };
      Object.assign(u, data);
      return { count: 1 };
    },
    async update({ where, data }) {
      calls.push(['user.update']);
      return Object.assign(byId(where.id), data);
    },
    async create({ data }) {
      calls.push(['user.create']);
      if (U.some((u) => u.email === data.email)) {
        throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['email'] } });
      }
      const { profile, ...rest } = data;
      const created = { id: `u${++seq}`, disabledAt: null, ...rest };
      U.push(created);
      return created;
    },
  };
  const linkModel = {
    async findUnique({ where, include }) {
      calls.push(['link.findUnique']);
      const k = where.verifier_verifierId;
      const row = L.find((l) => l.verifier === k.verifier && l.verifierId === k.verifierId) || null;
      if (!row) return null;
      return include && include.user ? { ...row, user: byId(row.userId) } : { ...row };
    },
    async createMany({ data, skipDuplicates }) {
      calls.push(['link.createMany']);
      assert.equal(skipDuplicates, true);
      let count = 0;
      for (const d of data) {
        if (L.some((l) => l.verifier === d.verifier && l.verifierId === d.verifierId)) continue;
        L.push({ id: `l${++seq}`, createdAt: new Date(), ...d });
        count += 1;
      }
      return { count };
    },
  };
  const rebindModel = {
    async findUnique({ where }) {
      calls.push(['rebind.findUnique']);
      return rebinds.find((r) => r.userId === where.userId) || null;
    },
    async findFirst() {
      calls.push(['rebind.findFirst']);
      return null;
    },
    async updateMany({ where, data }) {
      calls.push(['rebind.updateMany']);
      let count = 0;
      for (const r of rebinds) {
        if (r.userId === where.userId && r.status === where.status) {
          Object.assign(r, data);
          count += 1;
        }
      }
      return { count };
    },
  };
  const db = {
    user,
    web3AuthNetworkRebind: rebindModel,
    async $transaction(fn) {
      calls.push(['tx']);
      return fn(db);
    },
    _users: U,
    _links: L,
    _calls: calls,
  };
  if (linkTable) db.web3AuthLinkedMethod = linkModel;
  else {
    Object.defineProperty(db, 'web3AuthLinkedMethod', {
      get() {
        throw new Error('the link table must not be touched while the switch is off');
      },
    });
  }
  return db;
}

/** An account made with the e-mail code: its pair is (E, address), its wallet the E wallet. */
const emailCodeAccount = (patch = {}) => ({
  id: 'acct',
  email: 'alice@example.com',
  walletAddress: W.primary,
  web3authVerifier: E,
  web3authVerifierId: 'alice@example.com',
  ...patch,
});

const identityFor = (verifier, patch = {}) => ({
  kind: 'social',
  verifier,
  verifierId: 'alice@example.com',
  email: 'alice@example.com',
  emailVerified: false,
  name: 'Alice',
  profileImage: null,
  wallets: [],
  ...patch,
});

async function caught(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected a refusal, got a resolved promise');
}

async function conflictReason(promise) {
  const err = await caught(promise);
  assert.equal(err.code, 'IDENTITY_CONFLICT', err.message);
  return err.details.reason;
}

const writes = (db) => db._calls.filter(([op]) => /createMany|updateMany|update$|create$/.test(op)).map(([op]) => op);

// ---------------------------------------------------------------------------
// Boot rules
// ---------------------------------------------------------------------------

describe('WEB3AUTH_LINK_TRUSTED_METHODS boot rules', () => {
  const boot = (patch) => _internals.assertBootConfig({ ...BASE_ENV, ...patch });

  it('defaults to off and needs nothing else', () => {
    const cfg = _internals.assertBootConfig({ WEB3AUTH_CLIENT_ID: 'x' });
    assert.equal(cfg.linkTrustedMethods, false);
    assert.equal(describeLinkedMethods(cfg), 'Linked sign-in methods: WEB3AUTH_LINK_TRUSTED_METHODS=off');
  });

  it('accepts a complete configuration, with or without the network re-bind', () => {
    const cfg = boot({});
    assert.equal(cfg.linkTrustedMethods, true);
    assert.equal(cfg.networkRebind, false);
    assert.equal(describeLinkedMethods(cfg), `Linked sign-in methods: WEB3AUTH_LINK_TRUSTED_METHODS=on connections=${G},${E},${A}`);
    const both = boot({ WEB3AUTH_NETWORK_REBIND: 'on', WEB3AUTH_REBIND_VERIFIERS: [G, E, A, X].join(',') });
    assert.equal(both.linkTrustedMethods, true);
    assert.equal(both.networkRebind, true);
  });

  const refused = [
    ['a typo', { WEB3AUTH_LINK_TRUSTED_METHODS: 'true' }, /WEB3AUTH_LINK_TRUSTED_METHODS must be "on" or "off"/],
    ['verification off', { WEB3AUTH_VERIFY_MODE: 'off' }, /VERIFY_MODE must be log or enforce/],
    ['the body-asserted legacy path', { WEB3AUTH_VERIFY_MODE: 'log', WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'true' }, /ALLOW_LEGACY_FALLBACK must be false/],
    ['no wallet proof', { WEB3AUTH_WALLET_MATCH: 'none' }, /WALLET_MATCH must not be none/],
    ['no allow-list', { WEB3AUTH_VERIFY_MODE: 'log', WEB3AUTH_ALLOWED_VERIFIERS: '' }, /WEB3AUTH_ALLOWED_VERIFIERS must be set/],
    ['no e-mail-verifying connection', { WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: '' }, /WEB3AUTH_EMAIL_TRUSTED_VERIFIERS must name/],
    ['external-wallet as an e-mail-verifying connection', { WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: `${G},external-wallet` }, /must not contain external-wallet/],
    ['a connection outside the allow-list', { WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: `${G},web3auth-other` }, /not in WEB3AUTH_ALLOWED_VERIFIERS: web3auth-other/],
  ];
  for (const [name, patch, pattern] of refused) {
    it(`refuses ${name}`, () => {
      assert.throws(() => boot(patch), pattern);
    });
  }
});

// ---------------------------------------------------------------------------
// resolveUser
// ---------------------------------------------------------------------------

describe('resolveUser: linked sign-in methods', () => {
  beforeEach(() => setEnv());

  it('switch off: today\'s answer, and the link table is never touched', async () => {
    setEnv({ WEB3AUTH_LINK_TRUSTED_METHODS: 'off' });
    const db = mockDb({ users: [emailCodeAccount()], linkTable: false });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'candidate_already_linked');
    assert.deepEqual(db._calls, [
      ['user.findUnique', 'web3authVerifier_web3authVerifierId'],
      ['user.findUnique', 'email'],
    ]);
    // A pair hit and a new account are untouched as well.
    const hit = mockDb({ users: [emailCodeAccount()], linkTable: false });
    assert.equal((await resolveUser(identityFor(E), { db: hit, walletAddress: W.primary })).action, 'login');
    const fresh = mockDb({ users: [], linkTable: false });
    assert.equal((await resolveUser(identityFor(G), { db: fresh, walletAddress: W.google })).action, 'created');
  });

  it('e-mail-code account, then Google with the same address: linked, same account, wallet and pair unchanged', async () => {
    const db = mockDb({ users: [emailCodeAccount()] });
    const res = await resolveUser(identityFor(G), { db, walletAddress: W.google });
    assert.equal(res.action, 'linked');
    assert.equal(res.linkedMethod, true);
    assert.equal(res.user.id, 'acct');
    assert.equal(res.user.walletAddress, W.primary);
    assert.equal(res.user.web3authVerifier, E);
    assert.equal(res.user.web3authVerifierId, 'alice@example.com');
    assert.deepEqual(
      db._links.map(({ userId, verifier, verifierId, walletAddress }) => ({ userId, verifier, verifierId, walletAddress })),
      [{ userId: 'acct', verifier: G, verifierId: 'alice@example.com', walletAddress: W.google }]
    );
    assert.deepEqual(writes(db), ['link.createMany'], 'no write to the User row');
  });

  it('the linked method again: a plain login through the link, nothing written', async () => {
    const db = mockDb({ users: [emailCodeAccount()] });
    await resolveUser(identityFor(G), { db, walletAddress: W.google });
    db._calls.length = 0;
    const again = await resolveUser(identityFor(G), { db, walletAddress: W.google });
    assert.equal(again.action, 'login');
    assert.equal(again.linkedMethod, true);
    assert.equal(again.user.id, 'acct');
    assert.deepEqual(writes(db), []);
    assert.equal(db._links.length, 1);
    // The account's own method is still the ordinary pair hit.
    const own = await resolveUser(identityFor(E), { db, walletAddress: W.primary });
    assert.deepEqual([own.action, own.linkedMethod, own.user.id], ['login', undefined, 'acct']);
  });

  it('Google account, then the e-mail code (verifierId only, no e-mail claim): linked', async () => {
    const db = mockDb({ users: [emailCodeAccount({ web3authVerifier: G })] });
    const res = await resolveUser(identityFor(E, { email: null }), { db, walletAddress: W.google });
    assert.deepEqual([res.action, res.user.id, res.user.walletAddress], ['linked', 'acct', W.primary]);
    assert.equal(db._links[0].verifier, E);
  });

  it('Apple with the same address (e-mail claim, opaque verifierId): linked', async () => {
    const db = mockDb({ users: [emailCodeAccount()] });
    const res = await resolveUser(identityFor(A, { verifierId: 'apple|000123.abc' }), { db, walletAddress: W.apple });
    assert.deepEqual([res.action, res.user.id], ['linked', 'acct']);
    assert.deepEqual([db._links[0].verifier, db._links[0].verifierId], [A, 'apple|000123.abc']);
  });

  it('X with the same address: still IDENTITY_CONFLICT, nothing linked', async () => {
    const db = mockDb({ users: [emailCodeAccount()] });
    const reason = await conflictReason(
      resolveUser(identityFor(X, { verifierId: 'twitter|42' }), { db, walletAddress: W.x })
    );
    assert.equal(reason, 'candidate_already_linked');
    assert.equal(db._links.length, 0);
    assert.deepEqual(writes(db), []);
  });

  it('an accepted connection that does not verify e-mail: refused as today', async () => {
    const db = mockDb({ users: [emailCodeAccount()] });
    assert.equal(await conflictReason(resolveUser(identityFor(ROGUE), { db, walletAddress: W.other })), 'candidate_already_linked');
    assert.equal(db._links.length, 0);
  });

  it('external-wallet never links (its e-mail column is the wallet address)', async () => {
    const db = mockDb({ users: [emailCodeAccount({ email: W.google.toLowerCase(), web3authVerifierId: W.google.toLowerCase() })] });
    const ext = identityFor('external-wallet', { kind: 'external', verifierId: W.google.toLowerCase(), email: null });
    assert.equal(await conflictReason(resolveUser(ext, { db, walletAddress: W.google })), 'candidate_already_linked');
    assert.equal(db._links.length, 0);
  });

  it('a disabled account: ACCOUNT_DISABLED, nothing linked', async () => {
    const db = mockDb({ users: [emailCodeAccount({ disabledAt: new Date() })] });
    assert.equal((await caught(resolveUser(identityFor(G), { db, walletAddress: W.google }))).code, 'ACCOUNT_DISABLED');
    assert.equal(db._links.length, 0);
  });

  it('a disabled account is not reachable through an existing link either', async () => {
    const db = mockDb({
      users: [emailCodeAccount({ disabledAt: new Date() })],
      links: [{ userId: 'acct', verifier: G, verifierId: 'alice@example.com', walletAddress: W.google }],
    });
    assert.equal((await caught(resolveUser(identityFor(G), { db, walletAddress: W.google }))).code, 'ACCOUNT_DISABLED');
  });

  it('an organization account: ORG_NOT_ALLOWED', async () => {
    const db = mockDb({ users: [emailCodeAccount({ userType: 'organization' })] });
    assert.equal((await caught(resolveUser(identityFor(G), { db, walletAddress: W.google }))).code, 'ORG_NOT_ALLOWED');
    assert.equal(db._links.length, 0);
  });

  it('two accounts whose e-mails differ only in case: refused, nothing linked', async () => {
    const db = mockDb({ users: [emailCodeAccount(), { id: 'twin', email: 'Alice@Example.com', walletAddress: W.other, web3authVerifier: G, web3authVerifierId: 'alice@example.com.twin' }] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'candidate_already_linked');
    assert.equal(db._links.length, 0);
  });

  it('an account whose own connection does not verify e-mail (X with an address): refused', async () => {
    const db = mockDb({ users: [emailCodeAccount({ web3authVerifier: X, web3authVerifierId: 'twitter|42' })] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'candidate_already_linked');
    assert.equal(db._links.length, 0);
  });

  it('an account whose e-mail is not the identity its connection proved: refused', async () => {
    // A legacy row linked through the wallet its token proved keeps the e-mail a body supplied.
    const db = mockDb({ users: [emailCodeAccount({ web3authVerifier: G, web3authVerifierId: 'someone-else@example.com' })] });
    assert.equal(await conflictReason(resolveUser(identityFor(E), { db, walletAddress: W.google })), 'candidate_already_linked');
    assert.equal(db._links.length, 0);
  });

  it('the same connection with another verifierId: refused', async () => {
    const db = mockDb({ users: [emailCodeAccount({ web3authVerifier: G, web3authVerifierId: 'alice@example.com' })] });
    const other = identityFor(G, { verifierId: 'google|99' });
    assert.equal(await conflictReason(resolveUser(other, { db, walletAddress: W.google })), 'candidate_already_linked');
  });

  it('no wallet proof, no stored wallet, or the same wallet: refused as today', async () => {
    const noProof = mockDb({ users: [emailCodeAccount()] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db: noProof })), 'candidate_already_linked');
    const noStored = mockDb({ users: [emailCodeAccount({ walletAddress: null })] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db: noStored, walletAddress: W.google })), 'candidate_already_linked');
    const same = mockDb({ users: [emailCodeAccount()] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db: same, walletAddress: W.primary.toUpperCase().replace('0X', '0x') })), 'candidate_already_linked');
    for (const db of [noProof, noStored, same]) assert.equal(db._links.length, 0);
  });

  it('a proven wallet another account holds: refused', async () => {
    const db = mockDb({ users: [emailCodeAccount(), { id: 'holder', email: 'bob@example.com', walletAddress: W.google, web3authVerifier: G, web3authVerifierId: 'bob@example.com' }] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'candidate_already_linked');
    assert.equal(db._links.length, 0);
  });

  it('an account that is not a web3auth row: refused as today', async () => {
    const db = mockDb({ users: [emailCodeAccount({ authType: 'traditional' })] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'candidate_not_web3auth');
  });

  it('an unlinked legacy row keeps its own routes (wallet_mismatch as today)', async () => {
    const db = mockDb({ users: [emailCodeAccount({ web3authVerifier: null, web3authVerifierId: null })] });
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'wallet_mismatch');
    assert.equal(db._links.length, 0);
  });

  it('the pair is linked to another account by the time the row is read back: link_race', async () => {
    const db = mockDb({ users: [emailCodeAccount(), { id: 'bob', email: 'bob@example.com' }] });
    const createMany = db.web3AuthLinkedMethod.createMany;
    db.web3AuthLinkedMethod.createMany = async (args) => {
      db._links.push({ id: 'theirs', userId: 'bob', verifier: G, verifierId: 'alice@example.com', walletAddress: W.google });
      return createMany(args);
    };
    db.web3AuthLinkedMethod.findUnique = async () => db._links[0];
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'link_race');
  });

  it('a concurrent first link of the same pair to the same account: one row, both sign in', async () => {
    const db = mockDb({ users: [emailCodeAccount()] });
    const [a, b] = await Promise.all([
      resolveUser(identityFor(G), { db, walletAddress: W.google }),
      resolveUser(identityFor(G), { db, walletAddress: W.google }),
    ]);
    assert.equal(db._links.length, 1);
    assert.deepEqual([a.user.id, b.user.id], ['acct', 'acct']);
    assert.deepEqual([a.action, b.action].sort(), ['linked', 'login']);
  });

  it('the account changed between the checks and the write: link_race, nothing linked', async () => {
    const db = mockDb({ users: [emailCodeAccount()] });
    const findUnique = db.user.findUnique;
    db.user.findUnique = async (args) => {
      const row = await findUnique(args);
      if (args.where.id && db._calls.some(([op]) => op === 'tx')) return { ...row, walletAddress: W.other };
      return row;
    };
    assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'link_race');
    assert.equal(db._links.length, 0);
  });

  it('a connection taken off the list no longer signs in through its links', async () => {
    const db = mockDb({
      users: [emailCodeAccount()],
      links: [{ userId: 'acct', verifier: A, verifierId: 'apple|1', walletAddress: W.apple }],
    });
    setEnv({ WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: [G, E].join(',') });
    const apple = identityFor(A, { verifierId: 'apple|1' });
    assert.equal(await conflictReason(resolveUser(apple, { db, walletAddress: W.apple })), 'candidate_already_linked');
  });

  describe('with the network re-bind on', () => {
    const REBIND = { WEB3AUTH_NETWORK_REBIND: 'on', WEB3AUTH_REBIND_VERIFIERS: [G, E, A, X].join(',') };

    it('a pending re-bind record takes the re-bind path, not a link', async () => {
      setEnv(REBIND);
      const legacy = emailCodeAccount({ web3authVerifier: null, web3authVerifierId: null, walletAddress: '0x9999999999999999999999999999999999999999' });
      const record = { userId: 'acct', status: 'pending', walletPolicy: 'replace', oldAddress: legacy.walletAddress, evidence: 'email_unpaired' };
      const db = mockDb({ users: [legacy], rebinds: [record] });
      const res = await resolveUser(identityFor(G), { db, walletAddress: W.google });
      assert.equal(res.action, 'rebound');
      assert.equal(res.user.walletAddress, W.google);
      assert.equal(res.user.web3authVerifier, G);
      assert.equal(db._links.length, 0);
    });

    it('a link of an account whose re-bind is pending does not sign in: the re-bind decides', async () => {
      setEnv(REBIND);
      const legacy = emailCodeAccount({ web3authVerifier: null, web3authVerifierId: null, walletAddress: '0x9999999999999999999999999999999999999999' });
      const record = { userId: 'acct', status: 'pending', walletPolicy: 'replace', oldAddress: legacy.walletAddress, evidence: 'email_unpaired' };
      const db = mockDb({
        users: [legacy],
        rebinds: [record],
        links: [{ userId: 'acct', verifier: G, verifierId: 'alice@example.com', walletAddress: '0x8888888888888888888888888888888888888888' }],
      });
      const res = await resolveUser(identityFor(G), { db, walletAddress: W.google });
      assert.equal(res.action, 'rebound');
      assert.equal(res.linkedMethod, undefined);
    });

    it('after a re-bind, a further e-mail-verifying connection still uses the re-bind\'s own answer', async () => {
      setEnv(REBIND);
      const rebound = emailCodeAccount({ web3authVerifier: G, web3authVerifierId: 'alice@example.com', walletAddress: W.google });
      const record = { userId: 'acct', status: 'rebound', walletPolicy: 'replace' };
      const db = mockDb({ users: [rebound], rebinds: [record] });
      const res = await resolveUser(identityFor(E), { db, walletAddress: W.primary });
      assert.deepEqual([res.action, res.user.id, res.linkedMethod], ['login', 'acct', undefined]);
      assert.equal(db._links.length, 0);
    });

    it('a pending record on an account that has a pair: never linked (the re-bind keeps its answer)', async () => {
      setEnv(REBIND);
      const db = mockDb({ users: [emailCodeAccount()], rebinds: [{ userId: 'acct', status: 'pending', walletPolicy: 'replace' }] });
      assert.equal(await conflictReason(resolveUser(identityFor(G), { db, walletAddress: W.google })), 'candidate_already_linked');
      assert.equal(db._links.length, 0);
    });

    it('an account created on the new network links as with the re-bind off', async () => {
      setEnv(REBIND);
      const db = mockDb({ users: [emailCodeAccount()] });
      const res = await resolveUser(identityFor(G), { db, walletAddress: W.google });
      assert.deepEqual([res.action, res.user.id], ['linked', 'acct']);
    });
  });
});
