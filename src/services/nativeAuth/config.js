/**
 * Native login configuration (DDC as the Web3Auth custom-JWT issuer). Every variable is
 * DDC_AUTH_*, read on demand from the environment (never cached), and everything defaults OFF:
 * with DDC_AUTH_ENABLED unset nothing in src/services/nativeAuth/* touches the disk, the
 * database or a Web3Auth node, and every /api/auth/native/* route answers 404.
 *
 * assertNativeAuthConfig() is the boot gate (src/server.js): with the switch on it refuses to
 * start while any problem remains, listing all of them at once (assertFinancialGradeConfig
 * style). The rules that make a key or a connection legal are here and nowhere else; the JWKS
 * route and the signer re-use them so a key that would refuse boot is never served either.
 *
 * Secrets: DDC_AUTH_STATE_SECRET is the HMAC root for OTP codes, loginSecret, loginRef, X PKCE
 * and IP hashes. It is never logged, never returned, and only ever used through stateKey().
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createLogger } = require('../../utils/logger');

const NATIVE_METHODS = Object.freeze(['email', 'google', 'apple', 'x']);
const PLATFORMS = Object.freeze(['web', 'ios', 'android']);
const AUTH_ENVS = Object.freeze(['local', 'test', 'prod']);
const W3A_NETWORKS = Object.freeze(['sapphire_devnet', 'sapphire_mainnet']);
const SIGNERS = Object.freeze(['file', 'kms']);
const NEW_ACCOUNT_MODES = Object.freeze(['open', 'allowlist', 'closed']);
const REBIND_POLICIES = Object.freeze(['refuse', 'lazy']);
const TURNSTILE_MODES = Object.freeze(['off', 'log', 'enforce']);

/**
 * Connection ids that must never be used by a production deployment (boot rule 5). The fallback
 * devnet name from the setup notes is listed too, and any id that names a non-prod environment is
 * refused by pattern, so a renamed test connection cannot slip through.
 */
const NON_PROD_CONNECTION_IDS = Object.freeze(['ddc-jwt-devnet', 'ddc-jwt-test', 'datadance-jwt-devnet', 'datadance-jwt-test']);
const NON_PROD_CONNECTION_PATTERN = /(devnet|testnet|[-_]test\b|[-_]local\b|[-_]dev\b)/i;

/**
 * The committed, publicly leaked key (keys/jwks.json + keys/private.json, kid `auth-key-1`). Its
 * RFC 7638 thumbprint is pinned here so the refusal survives the removal of keys/ (question 5);
 * keys/jwks.json is also read at boot when it still exists, and the kid is refused by name.
 */
const LEAKED_KIDS = Object.freeze(['auth-key-1']);
const LEAKED_THUMBPRINTS = Object.freeze(['PLLnYY27q1SnU7rXrZ6VmLwfxoa3CcswLranj-VLSvs']);
const REPO_ROOT = path.join(__dirname, '../../..');
const COMMITTED_JWKS = path.join(REPO_ROOT, 'keys/jwks.json');

const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const JWT_TTL_MIN_SEC = 30;
const JWT_TTL_MAX_SEC = 60;
const MIN_STATE_SECRET_BYTES = 32;
const OTP_CODE_LENGTH = 6;

const logger = createLogger('nativeAuth');

function csv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function flag(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function str(value) {
  return String(value ?? '').trim();
}

/** A positive integer, the default when unset, or NaN when set to anything else (boot refuses). */
function positiveInt(value, fallback) {
  const raw = str(value);
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : Number.NaN;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** The master switch alone, for callers that must stay inert without parsing the rest. */
function nativeAuthEnabled(env = process.env) {
  return flag(env.DDC_AUTH_ENABLED);
}

/**
 * Parses every DDC_AUTH_* variable. The two secrets (stateSecret, turnstile.secret) are
 * non-enumerable, so serialising or logging the object (or a request carrying it) never prints
 * them; still, never log the returned object.
 */
function readNativeAuthConfig(env = process.env) {
  const cfg = parseConfig(env);
  Object.defineProperty(cfg, 'stateSecret', { value: str(env.DDC_AUTH_STATE_SECRET), enumerable: false });
  Object.defineProperty(cfg.turnstile, 'secret', { value: str(env.DDC_AUTH_TURNSTILE_SECRET), enumerable: false });
  return cfg;
}

function parseConfig(env) {
  const jwtTtlRaw = positiveInt(env.DDC_AUTH_JWT_TTL_SEC, JWT_TTL_MAX_SEC);
  return {
    enabled: flag(env.DDC_AUTH_ENABLED),
    env: str(env.DDC_AUTH_ENV).toLowerCase(),
    methods: csv(str(env.DDC_AUTH_METHODS).toLowerCase()),
    platforms: env.DDC_AUTH_PLATFORMS === undefined ? [...PLATFORMS] : csv(str(env.DDC_AUTH_PLATFORMS).toLowerCase()),
    newAccounts: str(env.DDC_AUTH_NEW_ACCOUNTS).toLowerCase() || 'allowlist',
    allowlist: csv(str(env.DDC_AUTH_ALLOWLIST).toLowerCase()),
    newAccountsPerDay: positiveInt(env.DDC_AUTH_NEW_ACCOUNTS_PER_DAY, 200),
    issuer: str(env.DDC_AUTH_ISSUER),
    audience: str(env.DDC_AUTH_AUDIENCE),
    network: str(env.DDC_AUTH_W3A_NETWORK) || 'sapphire_devnet',
    w3aClientId: str(env.DDC_AUTH_W3A_CLIENT_ID),
    connectionId: str(env.DDC_AUTH_W3A_CONNECTION_ID),
    signer: str(env.DDC_AUTH_SIGNER).toLowerCase() || 'file',
    signingKeyFile: str(env.DDC_AUTH_SIGNING_KEY_FILE),
    kmsKeyId: str(env.DDC_AUTH_KMS_KEY_ID),
    jwksPinned: csv(env.DDC_AUTH_JWKS_PINNED),
    jwksExtraFile: str(env.DDC_AUTH_JWKS_EXTRA_FILE),
    jwtTtlSec: Number.isNaN(jwtTtlRaw) ? Number.NaN : clamp(jwtTtlRaw, JWT_TTL_MIN_SEC, JWT_TTL_MAX_SEC),
    loginTtlSec: positiveInt(env.DDC_AUTH_LOGIN_TTL_SEC, 600),
    rebindPolicy: str(env.DDC_AUTH_REBIND_POLICY).toLowerCase() || 'refuse',
    proofDomain: str(env.DDC_AUTH_PROOF_DOMAIN),
    proofUri: str(env.DDC_AUTH_PROOF_URI),
    emailFrom: str(env.DDC_AUTH_EMAIL_FROM),
    otp: {
      codeLength: OTP_CODE_LENGTH,
      ttlSec: positiveInt(env.DDC_AUTH_OTP_TTL_SEC, 600),
      maxAttempts: positiveInt(env.DDC_AUTH_OTP_MAX_ATTEMPTS, 5),
      resendSec: positiveInt(env.DDC_AUTH_OTP_RESEND_SEC, 60),
      perEmailHour: positiveInt(env.DDC_AUTH_OTP_PER_EMAIL_HOUR, 5),
      perEmailDay: positiveInt(env.DDC_AUTH_OTP_PER_EMAIL_DAY, 20),
      emailCeilingDay: positiveInt(env.DDC_AUTH_OTP_EMAIL_CEILING_DAY, 50),
      perIpHour: positiveInt(env.DDC_AUTH_OTP_PER_IP_HOUR, 60),
      softBudget: positiveInt(env.DDC_AUTH_OTP_SOFT_BUDGET, 2000),
      hardCeiling: positiveInt(env.DDC_AUTH_OTP_HARD_CEILING, 20000),
      devEcho: flag(env.DDC_AUTH_OTP_DEV_ECHO),
    },
    turnstile: {
      mode: str(env.DDC_AUTH_TURNSTILE_MODE).toLowerCase() || 'off',
      siteKey: str(env.DDC_AUTH_TURNSTILE_SITE_KEY),
    },
    google: {
      // Order matters for GET /config: the web client id first, the iOS client id second.
      clientIds: csv(env.DDC_AUTH_GOOGLE_CLIENT_IDS),
      azpIds: csv(env.DDC_AUTH_GOOGLE_AZP_IDS),
    },
    apple: { audiences: csv(env.DDC_AUTH_APPLE_AUDIENCES) },
    x: {
      callbackUrl: str(env.DDC_AUTH_X_CALLBACK_URL),
      webReturnUrl: str(env.DDC_AUTH_X_WEB_RETURN_URL),
      appReturnUrl: str(env.DDC_AUTH_X_APP_RETURN_URL),
    },
    legacy: {
      emailVerifiers: csv(env.DDC_AUTH_LEGACY_EMAIL_VERIFIERS),
      googleVerifiers: csv(env.DDC_AUTH_LEGACY_GOOGLE_VERIFIERS),
      xVerifiers: csv(env.DDC_AUTH_LEGACY_X_VERIFIERS),
    },
  };
}

function isRelaxedEnv(cfg) {
  return cfg.env === 'local' || cfg.env === 'test';
}

function methodEnabled(cfg, method) {
  return Boolean(cfg.enabled && cfg.methods.includes(method));
}

// ---------------------------------------------------------------------------------------------
// Derived keys and hashes
// ---------------------------------------------------------------------------------------------

/** HMAC key for one purpose ('otp', 'login', 'x-pkce', 'ip', 'flow:<kind>', …), derived from the state secret. */
function stateKey(purpose, cfg = readNativeAuthConfig()) {
  if (!cfg.stateSecret) throw new Error('DDC_AUTH_STATE_SECRET is not configured');
  return crypto.createHmac('sha256', cfg.stateSecret).update(`ddc-native-auth:${purpose}`).digest();
}

/** hex HMAC-SHA256 of `value` under stateKey(purpose). */
function stateHmac(purpose, value, cfg = readNativeAuthConfig()) {
  return crypto.createHmac('sha256', stateKey(purpose, cfg)).update(String(value)).digest('hex');
}

/** The only login identifier ever logged: HMAC-SHA256(state secret, loginId), first 16 hex. */
function loginRef(loginId, cfg = readNativeAuthConfig()) {
  if (!cfg.stateSecret) throw new Error('DDC_AUTH_STATE_SECRET is not configured');
  return crypto.createHmac('sha256', cfg.stateSecret).update(String(loginId)).digest('hex').slice(0, 16);
}

/**
 * The client address a limiter or an audit row should key on: IPv4 as is (an IPv4-mapped IPv6
 * address is unwrapped), IPv6 cut to its /64 (or `bits`) network. Returns '' when unparseable.
 */
function ipPrefix(ip, bits = 64) {
  const raw = str(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!raw) return '';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(raw);
  if (mapped) return mapped[1];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(raw)) return raw;
  if (!raw.includes(':')) return '';
  const groups = expandIpv6(raw);
  if (!groups) return '';
  const keep = Math.ceil(bits / 16);
  const out = groups.slice(0, keep);
  const rest = bits % 16;
  if (rest) out[keep - 1] &= (0xffff << (16 - rest)) & 0xffff;
  return `${out.map((g) => g.toString(16)).join(':')}::/${bits}`;
}

function expandIpv6(address) {
  let text = address;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const parts = v4[1].split('.').map(Number);
    if (parts.some((p) => p > 255)) return null;
    text = text.slice(0, -v4[1].length) + `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return all.map((g) => Number.parseInt(g, 16));
}

/** Keyed hash of the client /64 (or IPv4) for audit rows; never the address itself. */
function hashIp(ip, cfg = readNativeAuthConfig()) {
  const prefix = ipPrefix(ip);
  return prefix ? stateHmac('ip', prefix, cfg).slice(0, 32) : null;
}

// ---------------------------------------------------------------------------------------------
// Key rules (boot rule 2), shared with the JWKS route
// ---------------------------------------------------------------------------------------------

/** RFC 7638 SHA-256 thumbprint (base64url) of an RSA JWK: over {e, kty, n} only. */
function rsaThumbprint(jwk) {
  if (!jwk || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') return null;
  return crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })).digest('base64url');
}

let leakedCache = null;

/** Thumbprints and kids of the committed leaked key(s): the constants plus keys/jwks.json while it exists. */
function leakedKeys() {
  if (leakedCache) return leakedCache;
  const thumbprints = new Set(LEAKED_THUMBPRINTS);
  try {
    const committed = JSON.parse(fs.readFileSync(COMMITTED_JWKS, 'utf8'));
    for (const key of committed.keys || []) {
      const tp = rsaThumbprint(key);
      if (tp) thumbprints.add(tp);
    }
  } catch {
    // keys/ removed (question 5): the constants above still refuse the key.
  }
  leakedCache = { thumbprints, kids: new Set(LEAKED_KIDS) };
  return leakedCache;
}

/** Why a key must not be used or published, or '' when it may. `label` names it without its value. */
function keyProblem(jwk, thumbprint, cfg, label) {
  const leaked = leakedKeys();
  if (leaked.kids.has(String(jwk && jwk.kid)) || leaked.thumbprints.has(thumbprint)) {
    return `${label} is the committed, publicly leaked key auth-key-1 (keys/jwks.json); generate a new key with scripts/nativeAuthKeygen.js`;
  }
  if (!cfg.jwksPinned.includes(thumbprint)) {
    return `${label} (thumbprint ${thumbprint}) is not listed in DDC_AUTH_JWKS_PINNED`;
  }
  return '';
}

/** The nearest enclosing git work tree of `file`, or '' when there is none. */
function enclosingGitWorkTree(file) {
  let dir;
  try {
    dir = path.dirname(fs.realpathSync(file));
  } catch {
    dir = path.dirname(path.resolve(file));
  }
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
}

const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'];

/**
 * DDC_AUTH_JWKS_EXTRA_FILE: public next/previous keys. Returns { keys, problems }; each key is
 * { jwk (public members only), thumbprint }. Never echoes key material in a problem.
 */
function readExtraJwks(cfg) {
  const problems = [];
  const keys = [];
  if (!cfg.jwksExtraFile) return { keys, problems };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(cfg.jwksExtraFile, 'utf8'));
  } catch {
    return { keys, problems: ['DDC_AUTH_JWKS_EXTRA_FILE cannot be read as a JWKS JSON file'] };
  }
  const list = Array.isArray(parsed && parsed.keys) ? parsed.keys : null;
  if (!list) return { keys, problems: ['DDC_AUTH_JWKS_EXTRA_FILE must be a JWKS ({"keys": [...]})'] };
  list.forEach((key, index) => {
    const label = `DDC_AUTH_JWKS_EXTRA_FILE key #${index + 1}`;
    if (!key || typeof key !== 'object') return problems.push(`${label} is not a JWK`);
    if (PRIVATE_MEMBERS.some((member) => member in key)) return problems.push(`${label} contains private key members; the extra file holds public keys only`);
    if (key.kty !== 'RSA') return problems.push(`${label} must be an RSA key`);
    if (key.alg !== undefined && key.alg !== 'RS256') return problems.push(`${label} alg must be RS256`);
    const thumbprint = rsaThumbprint(key);
    if (!thumbprint) return problems.push(`${label} is missing n or e`);
    const problem = keyProblem(key, thumbprint, cfg, label);
    if (problem) return problems.push(problem);
    keys.push({ jwk: { kty: 'RSA', n: key.n, e: key.e }, thumbprint });
    return undefined;
  });
  return { keys, problems };
}

// ---------------------------------------------------------------------------------------------
// Boot assertions
// ---------------------------------------------------------------------------------------------

function absoluteUrlProblem(name, value, { httpsOnly = false, allowLoopbackHttp = false } = {}) {
  if (!value) return `${name} is required`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return `${name} must be an absolute URL`;
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'https:') return '';
  if (parsed.protocol === 'http:' && allowLoopbackHttp && loopback && !httpsOnly) return '';
  return `${name} must be https${allowLoopbackHttp && !httpsOnly ? ' (http only for localhost)' : ''}`;
}

/**
 * Rule 5: what a production deployment must hold. Applied when DDC_AUTH_ENV=prod, and by
 * assertFinancialGradeConfig whenever SSO_TGE_ENABLED and DDC_AUTH_ENABLED are both on, whatever
 * DDC_AUTH_ENV says (the money path is production by definition).
 */
function productionProblems(cfg) {
  const problems = [];
  if (cfg.network !== 'sapphire_mainnet') problems.push(`production requires DDC_AUTH_W3A_NETWORK=sapphire_mainnet (got "${cfg.network}")`);
  if (cfg.signer !== 'kms') problems.push(`production requires DDC_AUTH_SIGNER=kms (got "${cfg.signer}"); the file signer is for local/test only`);
  if (cfg.jwksExtraFile) problems.push('DDC_AUTH_JWKS_EXTRA_FILE is refused in production (publish rotation keys through the KMS key set)');
  if (NON_PROD_CONNECTION_IDS.includes(cfg.connectionId) || NON_PROD_CONNECTION_PATTERN.test(cfg.connectionId)) {
    problems.push(`DDC_AUTH_W3A_CONNECTION_ID "${cfg.connectionId}" is a non-production connection`);
  }
  if (cfg.rebindPolicy === 'lazy') problems.push('DDC_AUTH_REBIND_POLICY=lazy is refused in production');
  if (cfg.otp.devEcho) problems.push('DDC_AUTH_OTP_DEV_ECHO is refused in production');
  if (cfg.methods.includes('email') && cfg.turnstile.mode !== 'enforce') {
    problems.push(`production with e-mail login requires DDC_AUTH_TURNSTILE_MODE=enforce (got "${cfg.turnstile.mode}")`);
  }
  if (cfg.x.appReturnUrl && !/^https:\/\//i.test(cfg.x.appReturnUrl)) {
    problems.push('DDC_AUTH_X_APP_RETURN_URL must be https in production (a verified app link, never a custom scheme)');
  }
  if (cfg.newAccounts === 'allowlist' && !cfg.allowlist.length) {
    problems.push('DDC_AUTH_NEW_ACCOUNTS=allowlist requires a non-empty DDC_AUTH_ALLOWLIST in production');
  }
  return problems;
}

function enumProblem(name, value, allowed) {
  return allowed.includes(value) ? '' : `${name} must be one of ${allowed.join('|')} (got "${value}")`;
}

/**
 * Every problem with the configuration, key checks included. `loadKey` is injectable for tests;
 * by default the file signer's loader. Does not throw.
 */
function nativeAuthProblems(cfg, env = process.env, { loadKey } = {}) {
  const problems = [];
  const push = (problem) => problem && problems.push(problem);

  // 1. Required values, enums, per-method configuration.
  push(enumProblem('DDC_AUTH_ENV', cfg.env || '(unset)', AUTH_ENVS));
  for (const name of ['issuer', 'audience', 'w3aClientId', 'connectionId']) {
    const variable = { issuer: 'DDC_AUTH_ISSUER', audience: 'DDC_AUTH_AUDIENCE', w3aClientId: 'DDC_AUTH_W3A_CLIENT_ID', connectionId: 'DDC_AUTH_W3A_CONNECTION_ID' }[name];
    if (!cfg[name]) problems.push(`${variable} is required`);
  }
  push(enumProblem('DDC_AUTH_W3A_NETWORK', cfg.network, W3A_NETWORKS));
  push(enumProblem('DDC_AUTH_SIGNER', cfg.signer, SIGNERS));
  push(enumProblem('DDC_AUTH_NEW_ACCOUNTS', cfg.newAccounts, NEW_ACCOUNT_MODES));
  push(enumProblem('DDC_AUTH_REBIND_POLICY', cfg.rebindPolicy, REBIND_POLICIES));
  push(enumProblem('DDC_AUTH_TURNSTILE_MODE', cfg.turnstile.mode, TURNSTILE_MODES));
  const unknownMethods = cfg.methods.filter((m) => !NATIVE_METHODS.includes(m));
  if (unknownMethods.length) problems.push(`DDC_AUTH_METHODS: unknown method(s) ${unknownMethods.join(', ')} (allowed: ${NATIVE_METHODS.join(',')})`);
  const unknownPlatforms = cfg.platforms.filter((p) => !PLATFORMS.includes(p));
  if (unknownPlatforms.length) problems.push(`DDC_AUTH_PLATFORMS: unknown platform(s) ${unknownPlatforms.join(', ')} (allowed: ${PLATFORMS.join(',')})`);
  const numbers = {
    DDC_AUTH_NEW_ACCOUNTS_PER_DAY: cfg.newAccountsPerDay,
    DDC_AUTH_JWT_TTL_SEC: cfg.jwtTtlSec,
    DDC_AUTH_LOGIN_TTL_SEC: cfg.loginTtlSec,
    DDC_AUTH_OTP_TTL_SEC: cfg.otp.ttlSec,
    DDC_AUTH_OTP_MAX_ATTEMPTS: cfg.otp.maxAttempts,
    DDC_AUTH_OTP_RESEND_SEC: cfg.otp.resendSec,
    DDC_AUTH_OTP_PER_EMAIL_HOUR: cfg.otp.perEmailHour,
    DDC_AUTH_OTP_PER_EMAIL_DAY: cfg.otp.perEmailDay,
    DDC_AUTH_OTP_EMAIL_CEILING_DAY: cfg.otp.emailCeilingDay,
    DDC_AUTH_OTP_PER_IP_HOUR: cfg.otp.perIpHour,
    DDC_AUTH_OTP_SOFT_BUDGET: cfg.otp.softBudget,
    DDC_AUTH_OTP_HARD_CEILING: cfg.otp.hardCeiling,
  };
  for (const [name, value] of Object.entries(numbers)) {
    if (Number.isNaN(value)) problems.push(`${name} must be a positive integer`);
  }
  if (!cfg.proofDomain) problems.push('DDC_AUTH_PROOF_DOMAIN is required (EIP-4361 domain, e.g. app.datadance.ai or localhost:20444)');
  else if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(cfg.proofDomain)) problems.push('DDC_AUTH_PROOF_DOMAIN must be a host[:port] without scheme or path');
  push(absoluteUrlProblem('DDC_AUTH_PROOF_URI', cfg.proofUri, { allowLoopbackHttp: isRelaxedEnv(cfg) }));

  if (cfg.methods.includes('email')) {
    if (!cfg.emailFrom) problems.push('DDC_AUTH_EMAIL_FROM is required when e-mail login is enabled');
    if (!str(env.SMTP_HOST) && !cfg.otp.devEcho) problems.push('e-mail login needs SMTP_* (or DDC_AUTH_OTP_DEV_ECHO=true locally)');
    if (cfg.turnstile.mode !== 'off' && (!cfg.turnstile.secret || !cfg.turnstile.siteKey)) {
      problems.push('DDC_AUTH_TURNSTILE_SECRET and DDC_AUTH_TURNSTILE_SITE_KEY are required unless DDC_AUTH_TURNSTILE_MODE=off');
    }
  }
  if (cfg.methods.includes('google')) {
    if (!cfg.google.clientIds.length) problems.push('DDC_AUTH_GOOGLE_CLIENT_IDS is required when Google login is enabled');
    if (!cfg.google.azpIds.length) problems.push('DDC_AUTH_GOOGLE_AZP_IDS is required when Google login is enabled');
  }
  if (cfg.methods.includes('apple') && !cfg.apple.audiences.length) {
    problems.push('DDC_AUTH_APPLE_AUDIENCES is required when Apple login is enabled');
  }
  if (cfg.methods.includes('x')) {
    if (!str(env.X_CLIENT_ID) || !str(env.X_CLIENT_SECRET)) problems.push('X_CLIENT_ID and X_CLIENT_SECRET are required when X login is enabled');
    push(absoluteUrlProblem('DDC_AUTH_X_CALLBACK_URL', cfg.x.callbackUrl, { allowLoopbackHttp: isRelaxedEnv(cfg) }));
    if (cfg.platforms.includes('web')) push(absoluteUrlProblem('DDC_AUTH_X_WEB_RETURN_URL', cfg.x.webReturnUrl, { allowLoopbackHttp: isRelaxedEnv(cfg) }));
    if (cfg.platforms.includes('ios') || cfg.platforms.includes('android')) {
      if (!cfg.x.appReturnUrl) problems.push('DDC_AUTH_X_APP_RETURN_URL is required when X login is enabled on ios/android');
      else if (!/^https:\/\//i.test(cfg.x.appReturnUrl) && cfg.env !== 'local') {
        problems.push('DDC_AUTH_X_APP_RETURN_URL may use a custom scheme only with DDC_AUTH_ENV=local');
      }
    }
  }

  // Local-only relaxations.
  if (cfg.rebindPolicy === 'lazy' && !isRelaxedEnv(cfg)) problems.push('DDC_AUTH_REBIND_POLICY=lazy is legal only with DDC_AUTH_ENV=local|test');
  if (cfg.otp.devEcho) {
    if (cfg.env !== 'local') problems.push('DDC_AUTH_OTP_DEV_ECHO is legal only with DDC_AUTH_ENV=local');
    if (str(env.SMTP_HOST)) problems.push('DDC_AUTH_OTP_DEV_ECHO is legal only while SMTP_HOST is unset');
  }

  // 2. Signing key and published keys.
  if (!cfg.jwksPinned.length) {
    problems.push('DDC_AUTH_JWKS_PINNED is required (csv of the RFC 7638 thumbprints allowed in the published JWKS)');
  } else {
    const malformed = cfg.jwksPinned.map((v, i) => (THUMBPRINT_PATTERN.test(v) ? null : `#${i + 1}`)).filter(Boolean);
    if (malformed.length) problems.push(`DDC_AUTH_JWKS_PINNED entries ${malformed.join(', ')} must be RFC 7638 SHA-256 thumbprints (43 base64url characters)`);
  }
  if (cfg.signer === 'file') {
    if (!isRelaxedEnv(cfg)) problems.push('DDC_AUTH_SIGNER=file is legal only with DDC_AUTH_ENV=local|test');
    if (!cfg.signingKeyFile) {
      problems.push('DDC_AUTH_SIGNING_KEY_FILE is required with DDC_AUTH_SIGNER=file');
    } else {
      const loader = loadKey || require('./signer/fileSigner').loadSigningKey;
      try {
        const key = loader(cfg.signingKeyFile);
        push(keyProblem({ ...key.publicJwk, kid: key.fileKid }, key.thumbprint, cfg, 'The signing key'));
      } catch (err) {
        problems.push(`DDC_AUTH_SIGNING_KEY_FILE: ${err.publicMessage || 'the signing key cannot be used'}`);
      }
    }
  } else if (cfg.signer === 'kms') {
    // The KMS signer is an interface stub in v1 (question 8): refuse rather than start without a key.
    problems.push('DDC_AUTH_SIGNER=kms is not available in v1 (the KMS signer is chosen before the mainnet cut)');
  }
  problems.push(...readExtraJwks(cfg).problems);

  // 3. State secret.
  if (!cfg.stateSecret) {
    problems.push('DDC_AUTH_STATE_SECRET is required');
  } else {
    if (Buffer.byteLength(cfg.stateSecret, 'utf8') < MIN_STATE_SECRET_BYTES) problems.push(`DDC_AUTH_STATE_SECRET must be at least ${MIN_STATE_SECRET_BYTES} bytes`);
    if (cfg.stateSecret === str(env.JWT_SECRET)) problems.push('DDC_AUTH_STATE_SECRET must differ from JWT_SECRET');
    if (cfg.stateSecret === str(env.SSO_SESSION_SECRET)) problems.push('DDC_AUTH_STATE_SECRET must differ from SSO_SESSION_SECRET');
  }

  // 4. The legacy path must never accept our connection.
  if (cfg.connectionId && csv(env.WEB3AUTH_ALLOWED_VERIFIERS).includes(cfg.connectionId)) {
    problems.push(`DDC_AUTH_W3A_CONNECTION_ID "${cfg.connectionId}" must not appear in WEB3AUTH_ALLOWED_VERIFIERS (the legacy login must never accept the native connection)`);
  }

  // 5. Production.
  if (cfg.env === 'prod') problems.push(...productionProblems(cfg));

  // 6. No laptop key on mainnet.
  if (isRelaxedEnv(cfg) && cfg.network === 'sapphire_mainnet') {
    problems.push(`DDC_AUTH_ENV=${cfg.env} must not use DDC_AUTH_W3A_NETWORK=sapphire_mainnet`);
  }
  return problems;
}

/**
 * Boot gate (src/server.js). Off → { enabled: false } without reading anything else. On → throws
 * one Error listing every problem, or returns a summary with no secret values (the kid is a
 * public thumbprint).
 */
function assertNativeAuthConfig(env = process.env, options = {}) {
  const cfg = readNativeAuthConfig(env);
  if (!cfg.enabled) return { enabled: false };
  const problems = nativeAuthProblems(cfg, env, options);
  if (problems.length) {
    throw new Error(`Native login (DDC_AUTH_ENABLED=true) configuration is invalid; refusing to start:\n - ${problems.join('\n - ')}`);
  }
  return summarize(cfg, options);
}

/** Secret-free summary of the native configuration (kid = public thumbprint). */
function summarize(cfg, { loadKey } = {}) {
  let kid = '(none)';
  if (cfg.signer === 'file' && cfg.signingKeyFile) {
    try {
      kid = (loadKey || require('./signer/fileSigner').loadSigningKey)(cfg.signingKeyFile).thumbprint;
    } catch {
      kid = '(unusable)';
    }
  }
  return {
    enabled: true,
    env: cfg.env,
    methods: [...cfg.methods],
    platforms: [...cfg.platforms],
    network: cfg.network,
    connectionId: cfg.connectionId,
    signer: cfg.signer,
    kid,
    newAccounts: cfg.newAccounts,
    rebindPolicy: cfg.rebindPolicy,
  };
}

/** One-line boot summary: `nativeAuth=on env=… methods=… kid=…`. */
function summaryLine(summary) {
  if (!summary || !summary.enabled) return 'nativeAuth=off';
  return (
    `nativeAuth=on env=${summary.env} methods=${summary.methods.join(',') || '(none)'} kid=${summary.kid} ` +
    `network=${summary.network} connection=${summary.connectionId} signer=${summary.signer} ` +
    `platforms=${summary.platforms.join(',') || '(none)'} newAccounts=${summary.newAccounts} rebind=${summary.rebindPolicy}`
  );
}

// ---------------------------------------------------------------------------------------------
// GET /config
// ---------------------------------------------------------------------------------------------

/**
 * LoginConfig (§2.3). Only public values: client ids, the connection name, the Turnstile site
 * key. `methods.apple.android` and `methods.wallet.ios|android` are always false in v1; the wallet
 * path on web is today's endpoint, so it follows the web platform switch.
 */
function buildLoginConfig(cfg = readNativeAuthConfig()) {
  const platformOn = Object.fromEntries(PLATFORMS.map((p) => [p, Boolean(cfg.enabled && cfg.platforms.includes(p))]));
  const methods = {};
  for (const method of NATIVE_METHODS) {
    methods[method] = Object.fromEntries(
      PLATFORMS.map((p) => [p, Boolean(platformOn[p] && methodEnabled(cfg, method) && !(method === 'apple' && p === 'android'))]),
    );
  }
  methods.wallet = { web: platformOn.web, ios: false, android: false };
  const appleBundleIds = new Set(['co.datadance.app']);
  return {
    enabled: cfg.enabled,
    platforms: platformOn,
    methods,
    allowOverride: isRelaxedEnv(cfg),
    web3auth: { network: cfg.network, clientId: cfg.w3aClientId, verifier: cfg.connectionId },
    google: { webClientId: cfg.google.clientIds[0] || '', iosClientId: cfg.google.clientIds[1] || '' },
    apple: { servicesId: cfg.apple.audiences.find((aud) => !appleBundleIds.has(aud)) || '' },
    turnstile: { siteKey: cfg.turnstile.mode === 'off' ? '' : cfg.turnstile.siteKey },
    otp: { codeLength: OTP_CODE_LENGTH, resendAfterSec: Number.isNaN(cfg.otp.resendSec) ? 60 : cfg.otp.resendSec },
  };
}

module.exports = {
  NATIVE_METHODS,
  PLATFORMS,
  AUTH_ENVS,
  W3A_NETWORKS,
  NON_PROD_CONNECTION_IDS,
  LEAKED_KIDS,
  LEAKED_THUMBPRINTS,
  THUMBPRINT_PATTERN,
  JWT_TTL_MIN_SEC,
  JWT_TTL_MAX_SEC,
  MIN_STATE_SECRET_BYTES,
  OTP_CODE_LENGTH,
  logger,
  nativeAuthEnabled,
  readNativeAuthConfig,
  isRelaxedEnv,
  methodEnabled,
  stateKey,
  stateHmac,
  loginRef,
  ipPrefix,
  hashIp,
  rsaThumbprint,
  leakedKeys,
  keyProblem,
  enclosingGitWorkTree,
  readExtraJwks,
  productionProblems,
  nativeAuthProblems,
  assertNativeAuthConfig,
  summarize,
  summaryLine,
  buildLoginConfig,
};
