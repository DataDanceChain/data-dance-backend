const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const partnerClient = require('../../src/constants/partnerClient');

const {
  readPartnerConfig,
  getPartnerClient,
  verifyClientSecret,
  parseBasicAuth,
  maskEmail,
  partnerResourceUrl,
  assertPartnerConfig,
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
  'PUBLIC_BASE_URL', 'APP_PUBLIC_URL', 'NODE_ENV', 'PORT',
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

describe('partnerResourceUrl', () => {
  it('uses PUBLIC_BASE_URL (trailing slash stripped) or the request host', () => {
    setEnv({ PUBLIC_BASE_URL: 'https://api.test.local/' });
    assert.equal(partnerResourceUrl(), 'https://api.test.local/partner/tge');
    setEnv({});
    const req = { get: (name) => ({ host: 'localhost:4000' }[name.toLowerCase()] || '') };
    assert.equal(partnerResourceUrl(req), 'http://localhost:4000/partner/tge');
    setEnv({ PORT: '9090' });
    assert.equal(partnerResourceUrl(), 'http://localhost:9090/partner/tge');
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
