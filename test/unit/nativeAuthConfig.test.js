/**
 * Native login configuration and boot assertions (design §3.1, §6 F1/F13/F20). With the master
 * switch off nothing is read and the gate answers { enabled: false }; with it on, every rule of
 * the boot list refuses to start, all problems listed at once, never with a secret in the text.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.LOG_LEVEL = 'error';

const config = require('../../src/services/nativeAuth/config');
const { assertFinancialGradeConfig } = require('../../src/constants/partnerClient');
const { makeKeyFile, makeJwksFile, makeFakeWorkTree, localEnv, STATE_SECRET } = require('../helpers/nativeAuthKeys');

const {
  readNativeAuthConfig,
  assertNativeAuthConfig,
  nativeAuthProblems,
  buildLoginConfig,
  loginRef,
  stateKey,
  stateHmac,
  ipPrefix,
  hashIp,
  LEAKED_THUMBPRINTS,
} = config;

const key = makeKeyFile();

function problemsFor(env) {
  return nativeAuthProblems(readNativeAuthConfig(env), env);
}

function assertRefused(env, pattern) {
  assert.throws(() => assertNativeAuthConfig(env), (err) => {
    assert.match(err.message, pattern);
    return true;
  });
}

describe('native auth config: off by default', () => {
  it('every switch defaults off / to its documented default', () => {
    const cfg = readNativeAuthConfig({});
    assert.equal(cfg.enabled, false);
    assert.deepEqual(cfg.methods, []);
    assert.deepEqual(cfg.platforms, ['web', 'ios', 'android']);
    assert.equal(cfg.newAccounts, 'allowlist');
    assert.equal(cfg.newAccountsPerDay, 200);
    assert.equal(cfg.network, 'sapphire_devnet');
    assert.equal(cfg.signer, 'file');
    assert.equal(cfg.jwtTtlSec, 60);
    assert.equal(cfg.loginTtlSec, 600);
    assert.equal(cfg.rebindPolicy, 'refuse');
    assert.equal(cfg.turnstile.mode, 'off');
    assert.equal(cfg.otp.devEcho, false);
    assert.deepEqual(
      [cfg.otp.ttlSec, cfg.otp.maxAttempts, cfg.otp.resendSec, cfg.otp.perEmailHour, cfg.otp.perEmailDay, cfg.otp.emailCeilingDay, cfg.otp.perIpHour, cfg.otp.softBudget, cfg.otp.hardCeiling],
      [600, 5, 60, 5, 20, 50, 60, 2000, 20000],
    );
  });

  it('the boot gate is silent and reads nothing while off, whatever else is set', () => {
    let loads = 0;
    const loadKey = () => {
      loads += 1;
      throw new Error('must not be called');
    };
    assert.deepEqual(assertNativeAuthConfig({}, { loadKey }), { enabled: false });
    assert.deepEqual(assertNativeAuthConfig({ DDC_AUTH_ENABLED: 'false', DDC_AUTH_SIGNER: 'kms', DDC_AUTH_ENV: 'prod' }, { loadKey }), { enabled: false });
    assert.deepEqual(assertNativeAuthConfig({ DDC_AUTH_ENABLED: 'yes' }, { loadKey }), { enabled: false }, 'only "true" turns it on');
    assert.equal(loads, 0);
  });

  it('LoginConfig with the switch off says enabled:false and every method off', () => {
    const lc = buildLoginConfig(readNativeAuthConfig({ DDC_AUTH_METHODS: 'email,google' }));
    assert.equal(lc.enabled, false);
    for (const method of Object.values(lc.methods)) assert.deepEqual(method, { web: false, ios: false, android: false });
  });
});

describe('native auth config: a valid local configuration boots', () => {
  it('returns a secret-free summary with the key thumbprint as kid', () => {
    const env = localEnv(key);
    const summary = assertNativeAuthConfig(env);
    assert.equal(summary.enabled, true);
    assert.equal(summary.env, 'local');
    assert.equal(summary.kid, key.thumbprint);
    const text = JSON.stringify(summary) + config.summaryLine(summary);
    assert.ok(!text.includes(STATE_SECRET), 'state secret in summary');
    assert.ok(!text.includes(key.publicJwk.n.slice(0, 40)), 'key material in summary');
    assert.match(config.summaryLine(summary), /^nativeAuth=on env=local methods=\(none\) kid=[A-Za-z0-9_-]{43} /);
  });

  it('accepts every method with its configuration', () => {
    const env = localEnv(key, {
      DDC_AUTH_METHODS: 'email,google,apple,x',
      DDC_AUTH_EMAIL_FROM: 'DataDance <no-reply@datadance.ai>',
      SMTP_HOST: 'localhost',
      DDC_AUTH_TURNSTILE_MODE: 'log',
      DDC_AUTH_TURNSTILE_SECRET: '1x0000000000000000000000000000000AA',
      DDC_AUTH_TURNSTILE_SITE_KEY: '1x00000000000000000000AA',
      DDC_AUTH_GOOGLE_CLIENT_IDS: 'web.apps.googleusercontent.com,ios.apps.googleusercontent.com',
      DDC_AUTH_GOOGLE_AZP_IDS: 'web.apps.googleusercontent.com,ios.apps.googleusercontent.com,android.apps.googleusercontent.com',
      DDC_AUTH_APPLE_AUDIENCES: 'co.datadance.app,ai.datadance.web',
      X_CLIENT_ID: 'x-id',
      X_CLIENT_SECRET: 'x-secret',
      DDC_AUTH_X_CALLBACK_URL: 'http://localhost:20080/api/auth/native/x/callback',
      DDC_AUTH_X_WEB_RETURN_URL: 'https://localhost:20444/login/callback',
      DDC_AUTH_X_APP_RETURN_URL: 'ai.datadance.app://auth/callback',
    });
    assert.deepEqual(problemsFor(env), []);
    const lc = buildLoginConfig(readNativeAuthConfig(env));
    assert.equal(lc.enabled, true);
    assert.deepEqual(lc.platforms, { web: true, ios: true, android: true });
    assert.deepEqual(lc.methods.apple, { web: true, ios: true, android: false }, 'Apple is never offered on Android in v1');
    assert.deepEqual(lc.methods.wallet, { web: true, ios: false, android: false }, 'no wallets in the App');
    assert.deepEqual(lc.methods.email, { web: true, ios: true, android: true });
    assert.equal(lc.allowOverride, true);
    assert.deepEqual(lc.web3auth, { network: 'sapphire_devnet', clientId: 'BNativeDevnetClientId', verifier: 'ddc-jwt-devnet' });
    assert.deepEqual(lc.google, { webClientId: 'web.apps.googleusercontent.com', iosClientId: 'ios.apps.googleusercontent.com' });
    assert.deepEqual(lc.apple, { servicesId: 'ai.datadance.web' });
    assert.deepEqual(lc.turnstile, { siteKey: '1x00000000000000000000AA' });
    assert.deepEqual(lc.otp, { codeLength: 6, resendAfterSec: 60 });
    assert.ok(!JSON.stringify(lc).includes('x-secret'), 'no secret in LoginConfig');
    assert.ok(!JSON.stringify(lc).includes(STATE_SECRET), 'no state secret in LoginConfig');
  });

  it('platform switches turn every method off on that platform; prod never allows the override', () => {
    const env = localEnv(key, { DDC_AUTH_PLATFORMS: 'web', DDC_AUTH_METHODS: 'google', DDC_AUTH_GOOGLE_CLIENT_IDS: 'w', DDC_AUTH_GOOGLE_AZP_IDS: 'w' });
    const lc = buildLoginConfig(readNativeAuthConfig(env));
    assert.deepEqual(lc.methods.google, { web: true, ios: false, android: false });
    assert.equal(buildLoginConfig(readNativeAuthConfig({ ...env, DDC_AUTH_ENV: 'prod' })).allowOverride, false);
  });

  it('keeps the secrets out of any serialisation of the parsed configuration', () => {
    const cfg = readNativeAuthConfig(localEnv(key, { DDC_AUTH_TURNSTILE_SECRET: 'turnstile-secret-value' }));
    assert.equal(cfg.stateSecret, STATE_SECRET);
    assert.equal(cfg.turnstile.secret, 'turnstile-secret-value');
    const text = JSON.stringify(cfg);
    assert.ok(!text.includes(STATE_SECRET) && !text.includes('turnstile-secret-value'));
  });

  it('clamps the JWT lifetime to 30..60 s', () => {
    assert.equal(readNativeAuthConfig({ DDC_AUTH_JWT_TTL_SEC: '5' }).jwtTtlSec, 30);
    assert.equal(readNativeAuthConfig({ DDC_AUTH_JWT_TTL_SEC: '3600' }).jwtTtlSec, 60);
    assert.equal(readNativeAuthConfig({ DDC_AUTH_JWT_TTL_SEC: '45' }).jwtTtlSec, 45);
  });
});

describe('native auth boot rule 1: required values and per-method configuration', () => {
  it('lists every missing value at once', () => {
    const problems = problemsFor({ DDC_AUTH_ENABLED: 'true' });
    for (const needle of ['DDC_AUTH_ENV', 'DDC_AUTH_ISSUER', 'DDC_AUTH_AUDIENCE', 'DDC_AUTH_W3A_CLIENT_ID', 'DDC_AUTH_W3A_CONNECTION_ID', 'DDC_AUTH_JWKS_PINNED', 'DDC_AUTH_STATE_SECRET', 'DDC_AUTH_PROOF_DOMAIN', 'DDC_AUTH_PROOF_URI', 'DDC_AUTH_SIGNING_KEY_FILE']) {
      assert.ok(problems.some((p) => p.includes(needle)), `no problem names ${needle}: ${problems.join(' | ')}`);
    }
    assert.throws(() => assertNativeAuthConfig({ DDC_AUTH_ENABLED: 'true' }), /refusing to start:\n - /);
  });

  it('refuses unknown enums, methods, platforms and malformed numbers', () => {
    const problems = problemsFor(localEnv(key, {
      DDC_AUTH_ENV: 'staging',
      DDC_AUTH_METHODS: 'email,passkey',
      DDC_AUTH_PLATFORMS: 'web,desktop',
      DDC_AUTH_NEW_ACCOUNTS: 'maybe',
      DDC_AUTH_TURNSTILE_MODE: 'strict',
      DDC_AUTH_W3A_NETWORK: 'cyan',
      DDC_AUTH_OTP_TTL_SEC: '10m',
    }));
    for (const re of [/DDC_AUTH_ENV must be one of/, /unknown method\(s\) passkey/, /unknown platform\(s\) desktop/, /DDC_AUTH_NEW_ACCOUNTS must be one of/, /DDC_AUTH_TURNSTILE_MODE must be one of/, /DDC_AUTH_W3A_NETWORK must be one of/, /DDC_AUTH_OTP_TTL_SEC must be a positive integer/]) {
      assert.ok(problems.some((p) => re.test(p)), `missing ${re}: ${problems.join(' | ')}`);
    }
  });

  it('an enabled method lacking its configuration refuses boot', () => {
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'email' }), /DDC_AUTH_EMAIL_FROM is required/);
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'email', DDC_AUTH_EMAIL_FROM: 'a@b.c' }), /needs SMTP_\*/);
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'email', DDC_AUTH_EMAIL_FROM: 'a@b.c', SMTP_HOST: 'h', DDC_AUTH_TURNSTILE_MODE: 'log' }), /TURNSTILE_SECRET and DDC_AUTH_TURNSTILE_SITE_KEY/);
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'google' }), /DDC_AUTH_GOOGLE_CLIENT_IDS is required/);
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'google', DDC_AUTH_GOOGLE_CLIENT_IDS: 'a' }), /DDC_AUTH_GOOGLE_AZP_IDS is required/);
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'apple' }), /DDC_AUTH_APPLE_AUDIENCES is required/);
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'x' }), /X_CLIENT_ID and X_CLIENT_SECRET/);
    assertRefused(localEnv(key, { DDC_AUTH_METHODS: 'x', X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b' }), /DDC_AUTH_X_CALLBACK_URL is required/);
  });

  it('the X custom-scheme App return is legal only with DDC_AUTH_ENV=local', () => {
    const x = { DDC_AUTH_METHODS: 'x', X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b', DDC_AUTH_X_CALLBACK_URL: 'https://api.test/cb', DDC_AUTH_X_WEB_RETURN_URL: 'https://app.test/login/callback', DDC_AUTH_X_APP_RETURN_URL: 'ai.datadance.app://auth/callback' };
    assert.deepEqual(problemsFor(localEnv(key, x)), []);
    assertRefused(localEnv(key, { ...x, DDC_AUTH_ENV: 'test' }), /custom scheme only with DDC_AUTH_ENV=local/);
  });

  it('dev echo is legal only locally with SMTP unset; lazy rebind only local/test', () => {
    assertRefused(localEnv(key, { DDC_AUTH_ENV: 'test', DDC_AUTH_OTP_DEV_ECHO: 'true' }), /DEV_ECHO is legal only with DDC_AUTH_ENV=local/);
    assertRefused(localEnv(key, { DDC_AUTH_OTP_DEV_ECHO: 'true', SMTP_HOST: 'smtp.example.com' }), /DEV_ECHO is legal only while SMTP_HOST is unset/);
    assert.deepEqual(problemsFor(localEnv(key, { DDC_AUTH_OTP_DEV_ECHO: 'true', DDC_AUTH_REBIND_POLICY: 'lazy' })), []);
  });
});

describe('native auth boot rule 2: the signing key', () => {
  it('refuses a key that is not pinned', () => {
    const other = makeKeyFile();
    assertRefused(localEnv(key, { DDC_AUTH_JWKS_PINNED: other.thumbprint }), /not listed in DDC_AUTH_JWKS_PINNED/);
  });

  it('refuses the committed leaked auth-key-1, by kid and by thumbprint, even when pinned', () => {
    const byKid = makeKeyFile({ kid: 'auth-key-1' });
    assertRefused(localEnv(byKid), /publicly leaked key auth-key-1/);
    // The committed public key's thumbprint is refused even if an operator pins it.
    assert.equal(config.leakedKeys().thumbprints.has(LEAKED_THUMBPRINTS[0]), true);
    const committed = JSON.parse(fs.readFileSync(path.join(__dirname, '../../keys/jwks.json'), 'utf8')).keys[0];
    assert.equal(config.rsaThumbprint(committed), LEAKED_THUMBPRINTS[0], 'the constant is the thumbprint of keys/jwks.json');
    const cfg = readNativeAuthConfig(localEnv(key, { DDC_AUTH_JWKS_PINNED: LEAKED_THUMBPRINTS[0] }));
    assert.match(config.keyProblem({ kty: 'RSA' }, LEAKED_THUMBPRINTS[0], cfg, 'k'), /leaked/);
  });

  it('refuses a key file inside a git work tree', () => {
    const inRepo = makeKeyFile({ inDir: makeFakeWorkTree() });
    assertRefused(localEnv(inRepo), /inside a git work tree/);
  });

  it('refuses a key file readable by group or others', () => {
    const loose = makeKeyFile({ mode: 0o644 });
    assertRefused(localEnv(loose), /readable by its owner only/);
  });

  it('refuses a non-RS256, too-small, public-only or inconsistent key, without echoing key material', () => {
    const es = makeKeyFile({ alg: 'PS256' });
    assertRefused(localEnv(es), /alg must be RS256/);
    const noAlg = makeKeyFile({ alg: null });
    assertRefused(localEnv(noAlg), /alg must be RS256/);
    const small = makeKeyFile({ bits: 1024 });
    assertRefused(localEnv(small), /at least 2048 bits/);
    const pub = makeKeyFile({ extra: { d: undefined } });
    assertRefused(localEnv(pub), /holds no private key/);
    const donor = makeKeyFile();
    const swapped = makeKeyFile({ extra: { n: donor.publicJwk.n } });
    assert.throws(() => assertNativeAuthConfig(localEnv(swapped, { DDC_AUTH_JWKS_PINNED: donor.thumbprint })), (err) => {
      assert.match(err.message, /cannot be loaded|do not match the private key/);
      assert.ok(!err.message.includes(donor.publicJwk.n.slice(0, 32)), 'modulus echoed');
      return true;
    });
    assertRefused(localEnv({ file: '/nonexistent/ddc-key.json', thumbprint: key.thumbprint }), /does not exist/);
  });

  it('refuses a malformed pin list and extra keys that are private, leaked or unpinned', () => {
    assertRefused(localEnv(key, { DDC_AUTH_JWKS_PINNED: `${key.thumbprint},not-a-thumbprint` }), /entries #2 must be RFC 7638/);
    const next = makeKeyFile();
    const extraOk = makeJwksFile([next.publicJwk]);
    assert.deepEqual(problemsFor(localEnv(key, { DDC_AUTH_JWKS_EXTRA_FILE: extraOk, DDC_AUTH_JWKS_PINNED: `${key.thumbprint},${next.thumbprint}` })), []);
    assertRefused(localEnv(key, { DDC_AUTH_JWKS_EXTRA_FILE: extraOk }), /extra.*|not listed in DDC_AUTH_JWKS_PINNED/i);
    const withPrivate = makeJwksFile([{ ...next.publicJwk, d: 'secret-member' }]);
    assert.throws(() => assertNativeAuthConfig(localEnv(key, { DDC_AUTH_JWKS_EXTRA_FILE: withPrivate, DDC_AUTH_JWKS_PINNED: `${key.thumbprint},${next.thumbprint}` })), (err) => {
      assert.match(err.message, /contains private key members/);
      assert.ok(!err.message.includes('secret-member'));
      return true;
    });
  });

  it('the file signer is refused outside local/test', () => {
    assertRefused(localEnv(key, { DDC_AUTH_ENV: 'prod' }), /DDC_AUTH_SIGNER=file is legal only with DDC_AUTH_ENV=local\|test/);
  });

});

describe('native auth boot rules 3 and 4: state secret and the legacy allow-list', () => {
  it('refuses a short or reused state secret', () => {
    assertRefused(localEnv(key, { DDC_AUTH_STATE_SECRET: 'short' }), /at least 32 bytes/);
    const s = 's'.repeat(40);
    assertRefused(localEnv(key, { DDC_AUTH_STATE_SECRET: s, JWT_SECRET: s }), /must differ from JWT_SECRET/);
    assertRefused(localEnv(key, { DDC_AUTH_STATE_SECRET: s, SSO_SESSION_SECRET: s }), /must differ from SSO_SESSION_SECRET/);
  });

  it('never states the secret in a problem', () => {
    const s = 'x'.repeat(12);
    assert.throws(() => assertNativeAuthConfig(localEnv(key, { DDC_AUTH_STATE_SECRET: s })), (err) => !err.message.includes(s));
  });

  it('refuses our connection in WEB3AUTH_ALLOWED_VERIFIERS', () => {
    assertRefused(localEnv(key, { WEB3AUTH_ALLOWED_VERIFIERS: 'web3auth-google-sapphire-devnet, ddc-jwt-devnet' }), /must not appear in WEB3AUTH_ALLOWED_VERIFIERS/);
  });
});

describe('native auth boot rules 5 and 6: production and mainnet', () => {
  const prodBase = (overrides = {}) => localEnv(key, {
    DDC_AUTH_ENV: 'prod',
    DDC_AUTH_SIGNER: 'kms',
    DDC_AUTH_KMS_KEY_ID: 'key-sgp00000000000000000',
    DDC_AUTH_KMS_KEY_VERSION_ID: '00000000-0000-4000-8000-000000000001',
    DDC_AUTH_SIGNING_KEY_FILE: '',
    DDC_AUTH_W3A_NETWORK: 'sapphire_mainnet',
    DDC_AUTH_W3A_CONNECTION_ID: 'ddc-jwt-mainnet',
    DDC_AUTH_ISSUER: 'ddc-auth-mainnet',
    DDC_AUTH_AUDIENCE: 'ddc-w3a-mainnet',
    DDC_AUTH_PROOF_DOMAIN: 'app.datadance.ai',
    DDC_AUTH_PROOF_URI: 'https://app.datadance.ai',
    DDC_AUTH_ALLOWLIST: '@datadance.ai',
    // Presence only (DDC_AUTH_KMS_CREDENTIALS=env, the default); throwaway strings.
    ALIBABA_CLOUD_ACCESS_KEY_ID: 'TEST-ONLY-AK-ID',
    ALIBABA_CLOUD_ACCESS_KEY_SECRET: 'test-only-not-a-secret',
    ...overrides,
  });

  it('the production rules list every relaxation', () => {
    const cfg = readNativeAuthConfig(prodBase({
      DDC_AUTH_W3A_NETWORK: 'sapphire_devnet',
      DDC_AUTH_SIGNER: 'file',
      DDC_AUTH_JWKS_EXTRA_FILE: '/some/file.json',
      DDC_AUTH_W3A_CONNECTION_ID: 'ddc-jwt-devnet',
      DDC_AUTH_REBIND_POLICY: 'lazy',
      DDC_AUTH_OTP_DEV_ECHO: 'true',
      DDC_AUTH_METHODS: 'email',
      DDC_AUTH_TURNSTILE_MODE: 'log',
      DDC_AUTH_X_APP_RETURN_URL: 'ai.datadance.app://auth/callback',
      DDC_AUTH_NEW_ACCOUNTS: 'allowlist',
      DDC_AUTH_ALLOWLIST: '',
    }));
    const problems = config.productionProblems(cfg);
    for (const re of [/sapphire_mainnet/, /DDC_AUTH_SIGNER=kms/, /EXTRA_FILE is refused in production/, /non-production connection/, /lazy is refused/, /DEV_ECHO is refused/, /TURNSTILE_MODE=enforce/, /APP_RETURN_URL must be https/, /non-empty DDC_AUTH_ALLOWLIST/]) {
      assert.ok(problems.some((p) => re.test(p)), `missing ${re}: ${problems.join(' | ')}`);
    }
  });

  it('refuses devnet and test connection ids in production, by list and by pattern', () => {
    for (const id of ['ddc-jwt-devnet', 'ddc-jwt-test', 'datadance-jwt-devnet', 'ddc-jwt-devnet-2', 'my-testnet-conn']) {
      const problems = config.productionProblems(readNativeAuthConfig(prodBase({ DDC_AUTH_W3A_CONNECTION_ID: id })));
      assert.ok(problems.some((p) => /non-production connection/.test(p)), `${id} accepted in production`);
    }
    assert.deepEqual(config.productionProblems(readNativeAuthConfig(prodBase())), []);
  });

  it('the boot gate applies the production rules when DDC_AUTH_ENV=prod', () => {
    for (const [overrides, re] of [
      [{ DDC_AUTH_W3A_CONNECTION_ID: 'ddc-jwt-devnet' }, /"ddc-jwt-devnet" is a non-production connection/],
      [{ DDC_AUTH_W3A_NETWORK: 'sapphire_devnet' }, /production requires DDC_AUTH_W3A_NETWORK=sapphire_mainnet/],
      [{ DDC_AUTH_REBIND_POLICY: 'lazy' }, /DDC_AUTH_REBIND_POLICY=lazy is refused in production/],
      [{ DDC_AUTH_NEW_ACCOUNTS: 'allowlist', DDC_AUTH_ALLOWLIST: '' }, /non-empty DDC_AUTH_ALLOWLIST in production/],
    ]) {
      assertRefused(prodBase(overrides), re);
      assert.ok(!problemsFor(localEnv(key, overrides)).some((p) => re.test(p)), `${re} applied outside prod`);
    }
  });

  it('a complete prod configuration with the KMS signer passes the boot gate (the key itself is checked by prepareSigner)', () => {
    const summary = assertNativeAuthConfig(prodBase());
    assert.equal(summary.enabled, true);
    assert.equal(summary.signer, 'kms');
    assert.equal(summary.kid, '(kms: fetched at start)');
    assert.match(config.summaryLine(summary), / kmsKey=key-sgp00000000000000000\/00000000-0000-4000-8000-000000000001 kmsRegion=ap-southeast-1 kmsCredentials=env$/);
  });

  it('prod with DDC_AUTH_SIGNER=kms refuses to start, with a clear message, while the KMS key is not fully named', () => {
    assert.throws(() => assertNativeAuthConfig(prodBase({ DDC_AUTH_KMS_KEY_ID: '', DDC_AUTH_KMS_KEY_VERSION_ID: '' })), (err) => {
      assert.match(err.message, /refusing to start/);
      assert.match(err.message, /DDC_AUTH_KMS_KEY_ID is required with DDC_AUTH_SIGNER=kms/);
      assert.match(err.message, /DDC_AUTH_KMS_KEY_VERSION_ID is required with DDC_AUTH_SIGNER=kms/);
      return true;
    });
    assertRefused(prodBase({ DDC_AUTH_SIGNER: 'file' }), /production requires DDC_AUTH_SIGNER=kms/);
    assertRefused(prodBase({ ALIBABA_CLOUD_ACCESS_KEY_SECRET: '' }), /DDC_AUTH_KMS_CREDENTIALS=env needs ALIBABA_CLOUD_ACCESS_KEY_ID and ALIBABA_CLOUD_ACCESS_KEY_SECRET/);
    // Production may use the default chain (ECS instance RAM role) instead of an access key.
    assert.equal(assertNativeAuthConfig(prodBase({ DDC_AUTH_KMS_CREDENTIALS: 'chain', ALIBABA_CLOUD_ACCESS_KEY_ID: '', ALIBABA_CLOUD_ACCESS_KEY_SECRET: '' })).signer, 'kms');
  });

  it('refuses sapphire_mainnet with DDC_AUTH_ENV=local|test', () => {
    assertRefused(localEnv(key, { DDC_AUTH_W3A_NETWORK: 'sapphire_mainnet' }), /DDC_AUTH_ENV=local must not use DDC_AUTH_W3A_NETWORK=sapphire_mainnet/);
    assertRefused(localEnv(key, { DDC_AUTH_ENV: 'test', DDC_AUTH_W3A_NETWORK: 'sapphire_mainnet' }), /DDC_AUTH_ENV=test must not use/);
  });
});

describe('assertFinancialGradeConfig: native login on the money path', () => {
  const crypto = require('crypto');
  const moneyPathEnv = {
    NODE_ENV: 'production',
    SSO_ENVIRONMENT: 'prod',
    SSO_TGE_ENABLED: 'true',
    SSO_TGE_CLIENT_ID: 'tge',
    SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update('s').digest('hex'),
    SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/cb',
    WEB3AUTH_VERIFY_MODE: 'enforce',
    WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
    WEB3AUTH_CLIENT_ID: 'legacy',
    WEB3AUTH_ALLOWED_VERIFIERS: 'web3auth-google-sapphire-mainnet',
    WEB3AUTH_JWKS_PIN_MODE: 'enforce',
    WEB3AUTH_JWKS_PINNED_THUMBPRINTS: 'A'.repeat(43),
    SSO_SESSION_SECRET: 'sso-secret',
    JWT_SECRET: 'jwt-secret',
    PUBLIC_BASE_URL: 'https://api.datadance.ai',
    APP_PUBLIC_URL: 'https://app.datadance.ai',
  };

  it('is unchanged while DDC_AUTH_ENABLED is off (no nativeAuth key in the summary)', () => {
    const result = assertFinancialGradeConfig({ ...moneyPathEnv, DDC_AUTH_ENV: 'local', DDC_AUTH_SIGNER: 'file' });
    assert.equal(result.enforced, true);
    assert.equal('nativeAuth' in result, false);
  });

  const nativeOnMoneyPath = (overrides = {}) => ({ ...moneyPathEnv, ...localEnv(key), JWT_SECRET: 'jwt-secret', SSO_SESSION_SECRET: 'sso-secret', ...overrides });
  const refusedAsProduction = (env) => assert.throws(() => assertFinancialGradeConfig(env), (err) => {
    assert.match(err.message, /native login: production requires DDC_AUTH_W3A_NETWORK=sapphire_mainnet/);
    assert.match(err.message, /native login: production requires DDC_AUTH_SIGNER=kms/);
    assert.match(err.message, /native login: DDC_AUTH_W3A_CONNECTION_ID "ddc-jwt-devnet" is a non-production connection/);
    return true;
  });
  // The local stack as it runs today (docker inspect ddclocal-api): NODE_ENV=production,
  // SSO_ENVIRONMENT=test, both public origins on localhost.
  const localStack = { SSO_ENVIRONMENT: 'test', PUBLIC_BASE_URL: 'https://localhost:20443', APP_PUBLIC_URL: 'https://localhost:20444' };

  it('applies the production rules to native login with DDC_AUTH_ENV=local on public origins', () => {
    refusedAsProduction(nativeOnMoneyPath());
  });

  it('applies them on public origins whatever DDC_AUTH_ENV says (unset, test, prod)', () => {
    for (const env of [undefined, 'test', 'prod']) refusedAsProduction(nativeOnMoneyPath({ DDC_AUTH_ENV: env }));
  });

  it('lets the loopback-only local stack run native login next to the partner flow (DDC_AUTH_ENV=local)', () => {
    for (const hosts of [
      localStack,
      { PUBLIC_BASE_URL: 'https://127.0.0.1:20443', APP_PUBLIC_URL: 'https://[::1]:20444' },
    ]) {
      const env = nativeOnMoneyPath(hosts);
      assert.equal(env.NODE_ENV, 'production', 'NODE_ENV=production does not force the production rules');
      const result = assertFinancialGradeConfig(env);
      assert.equal(result.enforced, true);
      assert.equal(result.nativeAuth.enabled, true);
      assert.match(config.summaryLine(result.nativeAuth), /^nativeAuth=on env=local /);
      // The native boot gate itself still accepts it, and still refuses a laptop key on mainnet (rule 6).
      assert.equal(assertNativeAuthConfig(env).enabled, true);
      assertRefused({ ...env, DDC_AUTH_W3A_NETWORK: 'sapphire_mainnet' }, /DDC_AUTH_ENV=local must not use DDC_AUTH_W3A_NETWORK=sapphire_mainnet/);
    }
  });

  it('keeps the production rules on loopback origins unless DDC_AUTH_ENV=local, and when only one origin is loopback', () => {
    for (const env of [undefined, 'test', 'prod']) refusedAsProduction(nativeOnMoneyPath({ ...localStack, DDC_AUTH_ENV: env }));
    refusedAsProduction(nativeOnMoneyPath({ ...localStack, APP_PUBLIC_URL: 'https://app.datadance.ai' }));
    refusedAsProduction(nativeOnMoneyPath({ ...localStack, PUBLIC_BASE_URL: 'https://api.datadance.ai' }));
    // Hosts that merely contain a loopback name are not loopback.
    refusedAsProduction(nativeOnMoneyPath({ PUBLIC_BASE_URL: 'https://localhost.datadance.ai', APP_PUBLIC_URL: 'https://127.0.0.1.nip.io' }));
  });

  it('adds the native summary when the native production rules hold', () => {
    const result = assertFinancialGradeConfig({
      ...moneyPathEnv,
      DDC_AUTH_ENABLED: 'true',
      DDC_AUTH_ENV: 'prod',
      DDC_AUTH_METHODS: 'google',
      DDC_AUTH_SIGNER: 'kms',
      DDC_AUTH_W3A_NETWORK: 'sapphire_mainnet',
      DDC_AUTH_W3A_CONNECTION_ID: 'ddc-jwt-mainnet',
      DDC_AUTH_NEW_ACCOUNTS: 'closed',
    });
    assert.equal(result.nativeAuth.enabled, true);
    assert.match(config.summaryLine(result.nativeAuth), /^nativeAuth=on env=prod methods=google kid=\(none\)/);
  });
});

describe('derived keys and hashes', () => {
  const cfg = readNativeAuthConfig(localEnv(key));

  it('loginRef is HMAC-SHA256(state secret, loginId), first 16 hex', () => {
    const crypto = require('crypto');
    const expected = crypto.createHmac('sha256', STATE_SECRET).update('login-123').digest('hex').slice(0, 16);
    assert.equal(loginRef('login-123', cfg), expected);
    assert.match(loginRef('login-123', cfg), /^[0-9a-f]{16}$/);
  });

  it('stateKey separates purposes and never equals the secret', () => {
    assert.notDeepEqual(stateKey('otp', cfg), stateKey('login', cfg));
    assert.notEqual(stateKey('otp', cfg).toString('utf8'), STATE_SECRET);
    assert.notEqual(stateHmac('otp', 'v', cfg), stateHmac('login', 'v', cfg));
    assert.throws(() => stateKey('otp', readNativeAuthConfig({})), /not configured/);
  });

  it('ipPrefix: IPv4 as is, IPv4-mapped unwrapped, IPv6 cut to /64 and /48', () => {
    assert.equal(ipPrefix('203.0.113.7'), '203.0.113.7');
    assert.equal(ipPrefix('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(ipPrefix('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64');
    assert.equal(ipPrefix('2001:db8:1:2::9'), '2001:db8:1:2::/64');
    assert.equal(ipPrefix('2001:db8:1:2:ffff::1', 48), '2001:db8:1::/48');
    assert.equal(ipPrefix('2001:db8::1', 64), '2001:db8:0:0::/64');
    assert.equal(ipPrefix('garbage'), '');
    assert.equal(ipPrefix(undefined), '');
  });

  it('hashIp hides the address and is stable per /64', () => {
    const a = hashIp('2001:db8:1:2::1', cfg);
    assert.equal(a, hashIp('2001:db8:1:2:aaaa::2', cfg));
    assert.notEqual(a, hashIp('2001:db8:1:3::1', cfg));
    assert.ok(!a.includes('2001'));
  });
});
