/**
 * Web3Auth network switch, no database: the boot rules of WEB3AUTH_NETWORK_REBIND, the partner
 * wallet view while a re-bind is pending, and the pure parts of scripts/mainnetSwitch.js.
 * The logins themselves run against real Postgres in test/db/mainnetSwitch.dbtest.js.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.WEB3AUTH_VERIFY_MODE = 'log';
process.env.WEB3AUTH_CLIENT_ID = 'unit-client-id';

const { _internals } = require('../../src/services/web3authIdentity');
const { withPartnerVisibleWallet, networkRebindOn } = require('../../src/services/networkRebindWallet');
const ms = require('../../scripts/mainnetSwitch');

const G = 'web3auth-google-sapphire-mainnet';
const E = 'web3auth-auth0-email-passwordless-sapphire-mainnet';
const X = 'web3auth-auth0-twitter-sapphire-mainnet';

const ON = {
  NODE_ENV: 'production',
  WEB3AUTH_VERIFY_MODE: 'enforce',
  WEB3AUTH_CLIENT_ID: 'mainnet',
  WEB3AUTH_ALLOWED_VERIFIERS: `${G},${E},${X},external-wallet`,
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_NETWORK_REBIND: 'on',
  WEB3AUTH_REBIND_VERIFIERS: `${G},${E},${X}`,
  WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: `${G},${E}`,
};

describe('WEB3AUTH_NETWORK_REBIND boot rules', () => {
  const boot = (env) => _internals.assertBootConfig(env);

  it('defaults to off and needs nothing else', () => {
    const cfg = boot({ WEB3AUTH_CLIENT_ID: 'x' });
    assert.equal(cfg.networkRebind, false);
  });

  it('accepts a complete cut configuration', () => {
    const cfg = boot(ON);
    assert.equal(cfg.networkRebind, true);
    assert.deepEqual(cfg.rebindVerifiers, [G, E, X]);
    assert.deepEqual(cfg.emailTrustedVerifiers, [G, E]);
  });

  const refused = [
    ['a typo', { WEB3AUTH_NETWORK_REBIND: 'yes' }, /must be "on" or "off"/],
    ['no re-bind connections', { WEB3AUTH_REBIND_VERIFIERS: '' }, /WEB3AUTH_REBIND_VERIFIERS must name/],
    ['a re-bind connection outside the allow-list', { WEB3AUTH_REBIND_VERIFIERS: `${G},web3auth-rogue` }, /not in WEB3AUTH_ALLOWED_VERIFIERS: web3auth-rogue/],
    ['external-wallet as a re-bind connection', { WEB3AUTH_REBIND_VERIFIERS: `${G},external-wallet` }, /must not contain external-wallet/],
    ['an e-mail-trusted connection outside the re-bind list', { WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: `${G},web3auth-apple` }, /not in WEB3AUTH_REBIND_VERIFIERS: web3auth-apple/],
    ['the body-asserted legacy path', { WEB3AUTH_VERIFY_MODE: 'log', NODE_ENV: 'test', WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'true' }, /ALLOW_LEGACY_FALLBACK must be false/],
    ['no wallet proof', { WEB3AUTH_WALLET_MATCH: 'none' }, /WALLET_MATCH must not be none/],
    ['verification off', { NODE_ENV: 'test', WEB3AUTH_VERIFY_MODE: 'off' }, /VERIFY_MODE must be log or enforce/],
  ];
  for (const [name, patch, pattern] of refused) {
    it(`refuses ${name}`, () => {
      assert.throws(() => boot({ ...ON, ...patch }), pattern);
    });
  }
});

describe('partner wallet view while a re-bind is pending', () => {
  const user = { id: 'u1', walletAddress: '0x00000000000000000000000000000000000000aa' };
  const dbWith = (record) => ({
    web3AuthNetworkRebind: {
      async findUnique({ where }) {
        assert.equal(where.userId, 'u1');
        return record;
      },
    },
  });
  const explode = {
    web3AuthNetworkRebind: {
      async findUnique() {
        throw new Error('must not query while the switch is off');
      },
    },
  };

  it('switch off: the stored wallet, no query', async () => {
    assert.equal(networkRebindOn({}), false);
    assert.equal(await withPartnerVisibleWallet(user, { db: explode, env: {} }), user);
  });

  it('pending replace: unbound; keep or rebound or no record: as stored', async () => {
    const env = { WEB3AUTH_NETWORK_REBIND: 'on' };
    const pendingRecord = { status: 'pending', walletPolicy: 'replace', oldAddress: user.walletAddress.toUpperCase().replace('0X', '0x') };
    const pending = await withPartnerVisibleWallet(user, { db: dbWith(pendingRecord), env });
    assert.equal(pending.walletAddress, null);
    assert.equal(user.walletAddress, '0x00000000000000000000000000000000000000aa', 'the user object itself is not mutated');
    const others = [
      { status: 'pending', walletPolicy: 'keep', oldAddress: user.walletAddress },
      { status: 'rebound', walletPolicy: 'replace', oldAddress: user.walletAddress },
      { status: 'pending', walletPolicy: 'replace', oldAddress: '0x00000000000000000000000000000000000000bb' }, // bound after the apply
      null,
    ];
    for (const record of others) {
      assert.equal((await withPartnerVisibleWallet(user, { db: dbWith(record), env })).walletAddress, user.walletAddress);
    }
  });
});

describe('scripts/mainnetSwitch.js', () => {
  it('parses exactly one mode and refuses anything else', () => {
    assert.equal(ms.parseArgs(['--plan']).mode, 'plan');
    assert.equal(ms.parseArgs(['--apply', '--yes']).yes, true);
    assert.equal(ms.parseArgs(['--rollback', '--run', '20261005120000_ab12']).run, '20261005120000_ab12');
    for (const bad of [[], ['--plan', '--apply'], ['--rollback'], ['--rollback', '--run', 'x; DROP'], ['--nope'], ['--plan', '--from-network', 'a', '--to-network', 'a']]) {
      assert.throws(() => ms.parseArgs(bad), undefined, bad.join(' '));
    }
  });

  it('main() answers a usage error with exit 2 and never reaches the database', async () => {
    const lines = [];
    const code = await ms.main(['--bogus'], { db: {}, log: (l) => lines.push(l) });
    assert.equal(code, ms.EXIT.USAGE);
    assert.match(lines.join('\n'), /usage error/);
  });

  it('a run id is a sortable timestamp plus a suffix', () => {
    assert.match(ms.newRunId(new Date('2026-10-05T12:00:00Z')), /^20261005120000_[0-9a-f]{4}$/);
  });

  it('login keys', () => {
    assert.equal(ms.loginKey('a@b.c'), 'email');
    assert.equal(ms.loginKey('x@privaterelay.appleid.com'), 'apple_relay');
    assert.equal(ms.loginKey('twitter|1'), 'x');
    assert.equal(ms.loginKey('0x00000000000000000000000000000000000000aa'), 'wallet_address');
    assert.equal(ms.loginKey('facebook|1'), 'other');
  });

  it('classifies in order: operator keep, server key, devnet pair, external wallet, X, no wallet, e-mail', () => {
    const base = { id: 'u', email: 'a@b.c', walletAddress: '0xold', hasServerKey: false, web3authVerifier: null, web3authVerifierId: null };
    const allowed = [G, 'external-wallet'];
    const c = (patch, keepIds) => ms.classify({ ...base, ...patch }, { allowed, keepIds });
    assert.deepEqual(
      [c({}, new Set(['u'])).evidence, c({ hasServerKey: true }).evidence],
      ['operator_keep', 'server_wallet']
    );
    const paired = c({ web3authVerifier: 'web3auth-google-sapphire-devnet', web3authVerifierId: 'a@b.c' });
    assert.deepEqual([paired.evidence, paired.walletPolicy, paired.oldVerifier], ['devnet_pair', 'replace', 'web3auth-google-sapphire-devnet']);
    assert.equal(c({ email: '0x00000000000000000000000000000000000000aa' }).walletPolicy, 'keep');
    assert.equal(c({ email: 'twitter|9' }).evidence, 'x_verifier_id');
    assert.equal(c({ walletAddress: null }).evidence, 'no_wallet');
    assert.deepEqual([c({}).evidence, c({}).walletPolicy, c({}).oldAddress], ['email_unpaired', 'replace', '0xold']);
  });

  it('the plan selects only unlinked or old-network web3auth regular rows, and names what will not re-bind', () => {
    const r = (id, patch) => ({
      id,
      email: `${id}@b.c`,
      walletAddress: null,
      authType: 'web3auth',
      userType: 'regular',
      isOrganization: false,
      disabled: false,
      hasServerKey: false,
      web3authVerifier: null,
      web3authVerifierId: null,
      rebindStatus: null,
      ...patch,
    });
    const rows = [
      r('a'),
      r('A2', { email: 'A@b.c' }),
      r('cur', { web3authVerifier: G, web3authVerifierId: 'cur@b.c' }),
      r('ext', { web3authVerifier: 'external-wallet', web3authVerifierId: '0xabc' }),
      r('old', { web3authVerifier: 'web3auth-google-sapphire-devnet', web3authVerifierId: 'old@b.c' }),
      r('rec', { rebindStatus: 'pending' }),
      r('off', { disabled: true }),
      r('pw', { authType: 'traditional' }),
      r('x', { email: 'twitter|1' }),
    ];
    const plan = ms.buildPlan(rows, { allowed: [G, 'external-wallet'], keepIds: new Set(), allIds: true, rebindVerifiers: [G], emailTrustedVerifiers: [G] });
    assert.equal(plan.to_record.total, 4); // a, A2, old, x
    assert.equal(plan.to_record.old_network_pairs_cleared, 1);
    assert.deepEqual(plan.web3auth_regular.by_pair_state, { unlinked: 5, current: 1, external_wallet: 1, old_network: 1 });
    assert.deepEqual(plan.not_automatic.ambiguous_email.ids.sort(), ['A2', 'a']);
    assert.deepEqual(plan.not_automatic.x_not_in_rebind_verifiers.ids, ['x']);
    assert.deepEqual(plan.not_automatic.disabled.ids, ['off']);
    assert.deepEqual(plan.not_automatic.not_web3auth.ids, ['pw']);
    assert.equal(plan.records.pending, 1);
  });

  it('readiness: refuses an environment that still accepts devnet connections or has the switch off', () => {
    const opts = { fromNetwork: 'sapphire_devnet', toNetwork: 'sapphire_mainnet' };
    assert.deepEqual(ms.checkEnvironment(ON, opts).blockers, []);
    const devnet = ms.checkEnvironment(
      { ...ON, WEB3AUTH_ALLOWED_VERIFIERS: `${ON.WEB3AUTH_ALLOWED_VERIFIERS},web3auth-google-sapphire-devnet` },
      opts
    );
    assert.match(devnet.blockers.join(' '), /still names sapphire-devnet connections/);
    assert.match(ms.checkEnvironment({ ...ON, WEB3AUTH_NETWORK_REBIND: 'off' }, opts).blockers.join(' '), /not "on"/);
    assert.match(ms.checkEnvironment({ ...ON, WEB3AUTH_REBIND_VERIFIERS: 'zzz' }, opts).blockers.join(' '), /would not boot/);
  });
});
