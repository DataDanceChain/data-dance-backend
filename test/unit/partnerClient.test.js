const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const partnerClient = require('../../src/constants/partnerClient');
const { publicBaseUrl } = require('../../src/constants/lifeContext');

const {
  readPartnerConfig,
  getPartnerClient,
  verifyClientSecret,
  parseBasicAuth,
  maskEmail,
  partnerResourceUrl,
  assertPartnerConfig,
  assertFinancialGradeConfig,
  sha256Hex,
  PARTNER_SCOPES,
} = partnerClient;

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const OLD_SECRET = 'old-secret-value';
const OLD_HASH = crypto.createHash('sha256').update(OLD_SECRET).digest('hex');

const ENV_KEYS = [
  'SSO_ENVIRONMENT', 'SSO_TGE_ENABLED', 'SSO_TGE_CLIENT_ID', 'SSO_TGE_CLIENT_NAME',
  'SSO_TGE_CLIENT_SECRET_SHA256', 'SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS', 'SSO_TGE_SECRET_ROTATION_UNTIL',
  'SSO_TGE_REDIRECT_URIS', 'SSO_TGE_INITIATE_LOGIN_URI', 'SSO_TGE_STATUS_FIELDS', 'SSO_REQUIRE_VERIFIED_SESSION',
  'SSO_SESSION_SECRET', 'JWT_SECRET',
  'PUBLIC_BASE_URL', 'APP_PUBLIC_URL', 'NODE_ENV', 'PORT', 'FRONTEND_URL',
  'WEB3AUTH_VERIFY_MODE', 'WEB3AUTH_ALLOW_LEGACY_FALLBACK', 'WEB3AUTH_CLIENT_ID', 'WEB3AUTH_ALLOWED_VERIFIERS',
  'OAUTH_PUBLIC_REGISTRATION_ENABLED',
];
const saved = {};

function setEnv(values) {
  ENV_KEYS.forEach((key) => delete process.env[key]);
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) process.env[key] = value;
  });
}

function baseEnv(overrides = {}) {
  return {
    SSO_ENVIRONMENT: 'test',
    SSO_TGE_ENABLED: 'true',
    SSO_TGE_CLIENT_ID: 'tge-test',
    SSO_TGE_CLIENT_NAME: 'DDC TGE',
    SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
    SSO_TGE_REDIRECT_URIS: ' https://tge.example.com/oauth/callback , https://tge.example.com/alt ',
    SSO_SESSION_SECRET: 'sso-session-key-for-tests',
    PUBLIC_BASE_URL: 'https://api.test.local',
    APP_PUBLIC_URL: 'https://app.test.local',
    ...overrides,
  };
}

beforeEach(() => {
  ENV_KEYS.forEach((key) => {
    saved[key] = process.env[key];
  });
});

afterEach(() => {
  ENV_KEYS.forEach((key) => {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  });
});

describe('readPartnerConfig / getPartnerClient', () => {
  it('parses csv lists with trimming, flags, and hashes', () => {
    setEnv(baseEnv({ SSO_TGE_STATUS_FIELDS: ' registered_at, wallet_bound ', SSO_REQUIRE_VERIFIED_SESSION: 'TRUE' }));
    const cfg = readPartnerConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.environment, 'test');
    assert.deepEqual(cfg.redirectUris, ['https://tge.example.com/oauth/callback', 'https://tge.example.com/alt']);
    assert.deepEqual(cfg.statusFields, ['registered_at', 'wallet_bound']);
    assert.equal(cfg.requireVerifiedSession, true);
    assert.equal(cfg.secretHash, SECRET_HASH);
  });

  it('defaults: no status fields frozen when the variable is unset, empty list when it is empty', () => {
    setEnv(baseEnv());
    assert.deepEqual(readPartnerConfig().statusFields, []);
    setEnv(baseEnv({ SSO_TGE_STATUS_FIELDS: '' }));
    assert.deepEqual(readPartnerConfig().statusFields, []);
  });

  it('rejects a malformed hash instead of half-accepting it', () => {
    setEnv(baseEnv({ SSO_TGE_CLIENT_SECRET_SHA256: 'not-a-hash' }));
    assert.equal(readPartnerConfig().secretHash, '');
  });

  it('returns null when no client is configured or the id differs; the enabled flag does not hide the client', () => {
    setEnv({});
    assert.equal(getPartnerClient('tge-test'), null);
    setEnv(baseEnv());
    assert.equal(getPartnerClient('someone-else'), null);
    assert.equal(getPartnerClient('tge-test').kind, 'partner');
    setEnv(baseEnv({ SSO_TGE_ENABLED: 'false' }));
    const disabled = getPartnerClient('tge-test');
    assert.equal(disabled.enabled, false);
    assert.equal(getPartnerClient().clientId, 'tge-test');
  });

  it('never exposes secret hashes on the client object and carries the contract constants', () => {
    setEnv(baseEnv());
    const client = getPartnerClient('tge-test');
    assert.equal(JSON.stringify(client).includes(SECRET_HASH), false);
    assert.equal(client.tokenEndpointAuthMethod, 'client_secret_basic');
    assert.deepEqual(client.tokenEndpointAuthMethods, ['client_secret_basic', 'client_secret_post']);
    assert.deepEqual(client.scopes, [...PARTNER_SCOPES]);
    assert.equal(client.defaultScope, 'tge:identity');
    assert.equal(client.requestTtlMs, 10 * 60 * 1000);
    assert.equal(client.codeTtlMs, 60 * 1000);
    assert.equal(client.accessTtlSec, 300);
    assert.equal(client.resource, 'https://api.test.local/partner/tge');
  });
});

/**
 * Item 9 — the issuer (and therefore every token audience) is configuration, never a header.
 * The request host used to win whenever PUBLIC_BASE_URL was unset, which let whoever sent the
 * request decide what this server calls itself.
 */
describe('partnerResourceUrl / publicBaseUrl', () => {
  const forgedHost = {
    get: (name) => ({ host: 'evil.example', 'x-forwarded-host': 'evil.example' }[name.toLowerCase()] || ''),
  };

  it('uses PUBLIC_BASE_URL, trailing slash stripped', () => {
    setEnv({ PUBLIC_BASE_URL: 'https://api.test.local/' });
    assert.equal(partnerResourceUrl(), 'https://api.test.local/partner/tge');
  });

  it('ignores Host and X-Forwarded-Host entirely', () => {
    setEnv({ PUBLIC_BASE_URL: 'https://api.test.local' });
    assert.equal(partnerResourceUrl(forgedHost), 'https://api.test.local/partner/tge');
    assert.equal(publicBaseUrl(forgedHost), 'https://api.test.local');
  });

  it('refuses to invent one when PUBLIC_BASE_URL is unset — no host fallback, no localhost guess', () => {
    setEnv({});
    assert.throws(() => partnerResourceUrl(forgedHost), /PUBLIC_BASE_URL is required/);
    assert.throws(() => partnerResourceUrl(), /PUBLIC_BASE_URL is required/);
    assert.throws(() => publicBaseUrl(forgedHost), /PUBLIC_BASE_URL is required/);
    setEnv({ PORT: '9090' });
    assert.throws(() => partnerResourceUrl(), /PUBLIC_BASE_URL is required/);
  });
});

/** Item 10 — the production origin list is deployed front-ends only. */
describe('CORS origins', () => {
  const { corsOrigins, LOCAL_FRONTEND_ORIGINS, PUBLIC_ORIGINS } = require('../../src/constants/corsOrigins');

  it('production carries no loopback origin at all', () => {
    const origins = corsOrigins({ NODE_ENV: 'production' });
    assert.deepEqual(origins, [...PUBLIC_ORIGINS]);
    assert.equal(origins.includes('http://localhost:5174'), false, 'a developer port may not read authenticated responses in production');
    assert.equal(origins.some((o) => /localhost|127\.0\.0\.1/.test(o)), false);
    assert.equal(PUBLIC_ORIGINS.some((o) => o.startsWith('http://')), false, 'and nothing on the list is plaintext');
  });

  it('FRONTEND_URL adds to the deployed list without re-opening loopback', () => {
    const origins = corsOrigins({ FRONTEND_URL: 'https://app.staging.datadance.ai, https://app.datadance.ai' });
    assert.deepEqual(origins, ['https://app.staging.datadance.ai', ...PUBLIC_ORIGINS], 'deduplicated, deployed origins only');
  });

  it('development still gets the local list, 5174 included', () => {
    const origins = corsOrigins({});
    assert.deepEqual(origins, [...LOCAL_FRONTEND_ORIGINS]);
    assert.ok(origins.includes('http://localhost:5174'));
  });
});

describe('parseBasicAuth (RFC 6749 §2.3.1)', () => {
  const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

  it('parses plain credentials', () => {
    assert.deepEqual(parseBasicAuth(basic('tge', 'secret')), { clientId: 'tge', clientSecret: 'secret' });
  });

  it('percent-decodes both halves after base64 (openid-client style)', () => {
    assert.deepEqual(parseBasicAuth(basic('tge%2Dtest', 'tge%2Dsecret%2Ddev')), { clientId: 'tge-test', clientSecret: 'tge-secret-dev' });
    assert.deepEqual(parseBasicAuth(basic('tge', 'a%3Ab%2Fc%3D')), { clientId: 'tge', clientSecret: 'a:b/c=' });
    assert.deepEqual(parseBasicAuth(basic('tge', 'with+plus')), { clientId: 'tge', clientSecret: 'with plus' });
  });

  it('keeps a secret containing a colon intact and tolerates un-encoded percent signs', () => {
    assert.deepEqual(parseBasicAuth(basic('tge', 'se:cr:et')), { clientId: 'tge', clientSecret: 'se:cr:et' });
    assert.deepEqual(parseBasicAuth(basic('tge', '100%')), { clientId: 'tge', clientSecret: '100%' });
  });

  it('is case-insensitive on the scheme and returns null for anything not well-formed', () => {
    assert.deepEqual(parseBasicAuth(`basic ${Buffer.from('a:b').toString('base64')}`), { clientId: 'a', clientSecret: 'b' });
    assert.equal(parseBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`), null);
    assert.equal(parseBasicAuth('Bearer abc'), null);
    assert.equal(parseBasicAuth('Basic'), null);
    assert.equal(parseBasicAuth(''), null);
    assert.equal(parseBasicAuth(undefined), null);
  });
});

describe('verifyClientSecret', () => {
  it('accepts the current secret only for the configured client', () => {
    setEnv(baseEnv());
    const client = getPartnerClient('tge-test');
    assert.equal(verifyClientSecret(client, SECRET), true);
    assert.equal(verifyClientSecret(client, 'wrong'), false);
    assert.equal(verifyClientSecret(client, ''), false);
    assert.equal(verifyClientSecret(client, undefined), false);
    assert.equal(verifyClientSecret({ ...client, clientId: 'other' }, SECRET), false);
    assert.equal(verifyClientSecret(null, SECRET), false);
  });

  it('accepts the previous secret only while the rotation window is open', () => {
    const now = Date.parse('2026-09-21T12:00:00Z');
    setEnv(baseEnv({
      SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS: OLD_HASH,
      SSO_TGE_SECRET_ROTATION_UNTIL: '2026-09-22T00:00:00Z',
    }));
    const client = getPartnerClient('tge-test');
    assert.equal(verifyClientSecret(client, OLD_SECRET, { now }), true);
    assert.equal(verifyClientSecret(client, SECRET, { now }), true);
    assert.equal(verifyClientSecret(client, OLD_SECRET, { now: Date.parse('2026-09-22T00:00:00Z') }), false);
    assert.equal(verifyClientSecret(client, OLD_SECRET, { now: Date.parse('2026-09-23T00:00:00Z') }), false);
  });

  it('ignores a previous hash without a rotation deadline', () => {
    setEnv(baseEnv({ SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS: OLD_HASH }));
    assert.equal(verifyClientSecret(getPartnerClient('tge-test'), OLD_SECRET), false);
  });

  it('does not accept the hash itself as the secret', () => {
    setEnv(baseEnv());
    assert.equal(verifyClientSecret(getPartnerClient('tge-test'), SECRET_HASH), false);
    assert.equal(sha256Hex(SECRET), SECRET_HASH);
  });
});

describe('maskEmail', () => {
  it('masks to first letter + *** + domain, null when unusable', () => {
    assert.equal(maskEmail('sloan@gmail.com'), 's***@gmail.com');
    assert.equal(maskEmail('  J@x.io '), 'J***@x.io');
    assert.equal(maskEmail('@nouser.com'), null);
    assert.equal(maskEmail('nodomain@'), null);
    assert.equal(maskEmail(''), null);
    assert.equal(maskEmail(null), null);
  });
});

describe('assertPartnerConfig (boot)', () => {
  it('passes when disabled even with nothing else set, and reports disabled', () => {
    setEnv({});
    assert.deepEqual(assertPartnerConfig().enabled, false);
  });

  it('passes a complete test configuration and returns a secret-free summary', () => {
    setEnv(baseEnv({ SSO_TGE_STATUS_FIELDS: 'registered_at,wallet_bound,data_licence_granted,email_masked' }));
    const summary = assertPartnerConfig();
    assert.equal(summary.enabled, true);
    assert.equal(summary.clientId, 'tge-test');
    assert.equal(summary.redirectUriCount, 2);
    assert.equal(summary.rotationOpen, false);
    assert.equal(JSON.stringify(summary).includes(SECRET_HASH), false);
  });

  it('lists every missing field at once when enabled', () => {
    setEnv({ SSO_TGE_ENABLED: 'true' });
    assert.throws(() => assertPartnerConfig(), (error) => {
      assert.match(error.message, /SSO_ENVIRONMENT must be test\|prod/);
      assert.match(error.message, /SSO_TGE_CLIENT_ID is required/);
      assert.match(error.message, /SSO_TGE_CLIENT_SECRET_SHA256 must be the 64-hex/);
      assert.match(error.message, /SSO_TGE_REDIRECT_URIS must list at least one/);
      return true;
    });
  });

  it('rejects an unknown SSO_ENVIRONMENT even when disabled', () => {
    setEnv({ SSO_ENVIRONMENT: 'staging' });
    assert.throws(() => assertPartnerConfig(), /SSO_ENVIRONMENT must be one of test\|prod/);
  });

  it('rejects a client id that could collide with CIMD URLs or break Basic encoding', () => {
    setEnv(baseEnv({ SSO_TGE_CLIENT_ID: 'https://evil.example/client' }));
    assert.throws(() => assertPartnerConfig(), /SSO_TGE_CLIENT_ID must match/);
    setEnv(baseEnv({ SSO_TGE_CLIENT_ID: 'a:b' }));
    assert.throws(() => assertPartnerConfig(), /SSO_TGE_CLIENT_ID must match/);
  });

  it('enforces redirect URI rules: absolute, no fragment, https except localhost outside prod', () => {
    setEnv(baseEnv({ SSO_TGE_REDIRECT_URIS: 'relative/path' }));
    assert.throws(() => assertPartnerConfig(), /not an absolute URL/);
    setEnv(baseEnv({ SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/cb#frag' }));
    assert.throws(() => assertPartnerConfig(), /must not contain a fragment/);
    setEnv(baseEnv({ SSO_TGE_REDIRECT_URIS: 'http://tge.example.com/cb' }));
    assert.throws(() => assertPartnerConfig(), /must be https/);
    setEnv(baseEnv({ SSO_TGE_REDIRECT_URIS: 'http://localhost:3000/cb,http://127.0.0.1:3000/cb' }));
    assert.doesNotThrow(() => assertPartnerConfig());
    setEnv(baseEnv({ SSO_ENVIRONMENT: 'prod', SSO_TGE_REDIRECT_URIS: 'http://localhost:3000/cb' }));
    assert.throws(() => assertPartnerConfig(), /must be https/);
    setEnv(baseEnv({ SSO_TGE_INITIATE_LOGIN_URI: 'ftp://tge.example.com/login' }));
    assert.throws(() => assertPartnerConfig(), /SSO_TGE_INITIATE_LOGIN_URI: .*must use http\(s\)/);
  });

  it('requires a rotation deadline with a previous hash and rejects malformed previous hashes', () => {
    setEnv(baseEnv({ SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS: OLD_HASH }));
    assert.throws(() => assertPartnerConfig(), /SSO_TGE_SECRET_ROTATION_UNTIL .* is required/);
    setEnv(baseEnv({ SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS: 'zz', SSO_TGE_SECRET_ROTATION_UNTIL: '2026-10-01T00:00:00Z' }));
    assert.throws(() => assertPartnerConfig(), /SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS must be a 64-hex/);
    setEnv(baseEnv({ SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS: OLD_HASH, SSO_TGE_SECRET_ROTATION_UNTIL: '2999-01-01T00:00:00Z' }));
    assert.equal(assertPartnerConfig().rotationOpen, true);
  });

  it('rejects unknown status fields', () => {
    setEnv(baseEnv({ SSO_TGE_STATUS_FIELDS: 'registered_at,points_balance' }));
    assert.throws(() => assertPartnerConfig(), /unknown field "points_balance"/);
  });

  it('requires public URLs in production (NODE_ENV or SSO_ENVIRONMENT=prod)', () => {
    setEnv(baseEnv({ SSO_ENVIRONMENT: 'prod', PUBLIC_BASE_URL: undefined, APP_PUBLIC_URL: undefined }));
    assert.throws(() => assertPartnerConfig(), (error) => {
      assert.match(error.message, /PUBLIC_BASE_URL is required in production/);
      assert.match(error.message, /APP_PUBLIC_URL is required in production/);
      return true;
    });
    setEnv(baseEnv({ NODE_ENV: 'production', PUBLIC_BASE_URL: undefined }));
    assert.throws(() => assertPartnerConfig(), /PUBLIC_BASE_URL is required in production/);
  });
});

/**
 * Item 8 — the money-path boot assertions. `SSO_TGE_ENABLED=true` is the moment DataDance
 * identities appear in front of the partner page, so the deployment shape around the protocol
 * has to be the hardened one before the process is allowed to serve anything.
 */
describe('assertFinancialGradeConfig (boot, item 8)', () => {
  // G4: two RFC 7638 SHA-256 thumbprints (43 base64url characters each).
  const PIN_A = 'NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs';
  const PIN_B = 'G6-iP7C_4NdppFwiEuckNCU_etFIVBBxxt4UH9cB9G0';
  const hardened = (overrides = {}) => ({
    SSO_ENVIRONMENT: 'prod',
    SSO_TGE_ENABLED: 'true',
    SSO_TGE_CLIENT_ID: 'tge-prod',
    SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
    SSO_TGE_REDIRECT_URIS: 'https://tge.example.com/oauth/callback',
    NODE_ENV: 'production',
    WEB3AUTH_VERIFY_MODE: 'enforce',
    WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
    WEB3AUTH_CLIENT_ID: 'web3auth-client',
    WEB3AUTH_ALLOWED_VERIFIERS: 'web3auth-google-sapphire-devnet,external-wallet',
    WEB3AUTH_JWKS_PIN_MODE: 'enforce',
    WEB3AUTH_JWKS_PINNED_THUMBPRINTS: `${PIN_A},${PIN_B}`,
    SSO_SESSION_SECRET: 'a-dedicated-sso-session-key',
    JWT_SECRET: 'the-user-session-key',
    PUBLIC_BASE_URL: 'https://api.datadance.ai',
    APP_PUBLIC_URL: 'https://app.datadance.ai',
    ...overrides,
  });

  it('says nothing while the partner client is off — this is not a global policy', () => {
    assert.deepEqual(assertFinancialGradeConfig({ SSO_TGE_ENABLED: 'false' }), { enforced: false });
    assert.deepEqual(assertFinancialGradeConfig({ NODE_ENV: 'development' }), { enforced: false });
  });

  it('passes a fully hardened environment and returns a summary with no secret in it', () => {
    const summary = assertFinancialGradeConfig(hardened());
    assert.equal(summary.enforced, true);
    assert.equal(summary.verifyMode, 'enforce');
    assert.equal(summary.allowedVerifierCount, 2);
    assert.equal(summary.jwksPinMode, 'enforce');
    assert.equal(summary.jwksPinCount, 2);
    assert.equal(summary.publicBaseUrl, 'https://api.datadance.ai');
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes('a-dedicated-sso-session-key'), false);
    assert.equal(serialized.includes('the-user-session-key'), false);
    assert.equal(serialized.includes(SECRET_HASH), false);
    // G4: the pins are reported as a count, never as values.
    assert.equal(serialized.includes(PIN_A), false);
    assert.equal(serialized.includes(PIN_B), false);
  });

  it('refuses each unsafe shape on its own', () => {
    const cases = [
      [{ NODE_ENV: 'development' }, /NODE_ENV must be "production"/],
      [{ WEB3AUTH_VERIFY_MODE: 'log' }, /WEB3AUTH_VERIFY_MODE must be "enforce"/],
      [{ WEB3AUTH_VERIFY_MODE: 'off' }, /WEB3AUTH_VERIFY_MODE must be "enforce"/],
      [{ WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'true' }, /WEB3AUTH_ALLOW_LEGACY_FALLBACK must be false/],
      [{ WEB3AUTH_CLIENT_ID: '' }, /WEB3AUTH_CLIENT_ID is required/],
      [{ WEB3AUTH_ALLOWED_VERIFIERS: '' }, /WEB3AUTH_ALLOWED_VERIFIERS must list/],
      // G4 — pinned Web3Auth signing keys
      [{ WEB3AUTH_JWKS_PIN_MODE: 'log' }, /WEB3AUTH_JWKS_PIN_MODE must be "enforce" when SSO_TGE_ENABLED=true \(got "log"\)/],
      [{ WEB3AUTH_JWKS_PIN_MODE: 'off' }, /WEB3AUTH_JWKS_PIN_MODE must be "enforce"/],
      [{ WEB3AUTH_JWKS_PIN_MODE: '' }, /WEB3AUTH_JWKS_PIN_MODE must be "enforce" .*\(got "\(unset = log\)"\)/],
      [{ WEB3AUTH_JWKS_PINNED_THUMBPRINTS: '' }, /WEB3AUTH_JWKS_PINNED_THUMBPRINTS must list the approved/],
      [{ WEB3AUTH_JWKS_PINNED_THUMBPRINTS: ' , ' }, /WEB3AUTH_JWKS_PINNED_THUMBPRINTS must list the approved/],
      [{ WEB3AUTH_JWKS_PINNED_THUMBPRINTS: `${PIN_A},${PIN_B}=` }, /WEB3AUTH_JWKS_PINNED_THUMBPRINTS entry #2 must be RFC 7638/],
      [{ WEB3AUTH_JWKS_PINNED_THUMBPRINTS: `social-kid-1,${PIN_A}` }, /WEB3AUTH_JWKS_PINNED_THUMBPRINTS entry #1 must be RFC 7638/],
      [{ SSO_SESSION_SECRET: '' }, /SSO_SESSION_SECRET is required/],
      [{ SSO_SESSION_SECRET: 'same', JWT_SECRET: 'same' }, /SSO_SESSION_SECRET must differ from JWT_SECRET/],
      [{ PUBLIC_BASE_URL: '' }, /PUBLIC_BASE_URL is required/],
      [{ PUBLIC_BASE_URL: 'http://api.datadance.ai' }, /PUBLIC_BASE_URL must be https/],
      [{ APP_PUBLIC_URL: '' }, /APP_PUBLIC_URL is required/],
      [{ APP_PUBLIC_URL: 'http://app.datadance.ai' }, /APP_PUBLIC_URL must be https/],
      [{ APP_PUBLIC_URL: 'app.datadance.ai' }, /APP_PUBLIC_URL must be an absolute URL/],
    ];
    for (const [overrides, pattern] of cases) {
      assert.throws(() => assertFinancialGradeConfig(hardened(overrides)), pattern, JSON.stringify(overrides));
    }
  });

  it('never echoes a rejected pin value', () => {
    assert.throws(
      () => assertFinancialGradeConfig(hardened({ WEB3AUTH_JWKS_PINNED_THUMBPRINTS: 'some-pasted-value,another+one' })),
      (error) => {
        assert.match(error.message, /entries #1, #2 must be RFC 7638/);
        assert.equal(error.message.includes('some-pasted-value'), false);
        assert.equal(error.message.includes('another+one'), false);
        return true;
      }
    );
  });

  it('lists the G4 problems together with the others, in one error', () => {
    assert.throws(
      () =>
        assertFinancialGradeConfig(
          hardened({ WEB3AUTH_VERIFY_MODE: 'log', WEB3AUTH_JWKS_PIN_MODE: 'log', WEB3AUTH_JWKS_PINNED_THUMBPRINTS: '' })
        ),
      (error) => {
        assert.match(error.message, /refusing to start/);
        assert.match(error.message, /WEB3AUTH_VERIFY_MODE must be "enforce"/);
        assert.match(error.message, /WEB3AUTH_JWKS_PIN_MODE must be "enforce"/);
        assert.match(error.message, /WEB3AUTH_JWKS_PINNED_THUMBPRINTS must list the approved/);
        return true;
      }
    );
  });

  it('lists every problem at once, so one restart shows the whole gap', () => {
    assert.throws(
      () => assertFinancialGradeConfig(hardened({ NODE_ENV: 'test', WEB3AUTH_VERIFY_MODE: 'log', WEB3AUTH_ALLOWED_VERIFIERS: '' })),
      (error) => {
        assert.match(error.message, /refusing to start/);
        assert.match(error.message, /NODE_ENV must be "production"/);
        assert.match(error.message, /WEB3AUTH_VERIFY_MODE must be "enforce"/);
        assert.match(error.message, /WEB3AUTH_ALLOWED_VERIFIERS must list/);
        return true;
      }
    );
  });

  it('reports whether public client registration is still open (item 11)', () => {
    assert.equal(assertFinancialGradeConfig(hardened()).publicRegistration, true);
    assert.equal(
      assertFinancialGradeConfig(hardened({ OAUTH_PUBLIC_REGISTRATION_ENABLED: 'false' })).publicRegistration,
      false
    );
  });
});
