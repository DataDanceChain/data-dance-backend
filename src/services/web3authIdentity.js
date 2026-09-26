/**
 * Web3Auth ID token verification and upstream-identity mapping (SSO plan §2.1, P0).
 *
 * The token is verified against the Web3Auth JWKS (jose), the identity pair
 * (verifier, verifierId) is read through env-configurable claim paths, the wallet the
 * client claims is checked against the wallets the token proves, and the DDC user is
 * resolved by the pair (lookup → lazy backfill → conflict → create).
 *
 * Claim names, issuers, audiences and JWKS URLs are env parameters because the exact
 * shape of a live token for DDC's project is still an open research item.
 *
 * Signing keys are pinned (hardening G4): the JWKS is fetched over the network, so a valid
 * signature only proves the token was signed by *some key that URL served*. The key that
 * actually verified the token is identified by its RFC 7638 thumbprint and checked against
 * WEB3AUTH_JWKS_PINNED_THUMBPRINTS (WEB3AUTH_JWKS_PIN_MODE = off | log | enforce).
 */
const jose = require('jose');
const { computeAddress, getAddress, isAddress } = require('ethers');
const { createLogger } = require('../utils/logger');

const logger = createLogger('web3authIdentity');

const VERIFY_MODES = ['off', 'log', 'enforce'];
const PIN_MODES = ['off', 'log', 'enforce'];
// RFC 7638 JWK thumbprint with SHA-256, base64url without padding: always 43 characters.
// Mirrored in constants/partnerClient.js assertFinancialGradeConfig (not imported, see there).
const THUMBPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WALLET_MATCH_MODES = ['address', 'public_key', 'none'];
const EXTERNAL_WALLET_VERIFIER = 'external-wallet';
const CLOCK_TOLERANCE_SEC = 60;

const DEFAULTS = {
  WEB3AUTH_VERIFY_MODE: 'log',
  WEB3AUTH_JWKS_URL: 'https://api-auth.web3auth.io/jwks',
  WEB3AUTH_ISSUERS: 'https://api-auth.web3auth.io',
  WEB3AUTH_CLIENT_ID: '',
  WEB3AUTH_ALGS: 'ES256',
  WEB3AUTH_MAX_TOKEN_AGE: '1d',
  // The login connections DataDance actually uses (csv of verifier / auth-connection names, as
  // they appear in the token). EMPTY is only allowed outside `enforce`: under `enforce` the boot
  // refuses to start, because an empty list would mean "whatever connection the token names".
  WEB3AUTH_ALLOWED_VERIFIERS: '',
  WEB3AUTH_VERIFIER_CLAIM: 'aggregateVerifier,verifier,groupedAuthConnectionId,authConnectionId',
  WEB3AUTH_VERIFIER_ID_CLAIM: 'verifierId,userId',
  WEB3AUTH_EMAIL_CLAIM: 'email',
  WEB3AUTH_EMAIL_VERIFIED_CLAIM: 'email_verified',
  WEB3AUTH_WALLETS_CLAIM: 'wallets',
  WEB3AUTH_WALLET_MATCH: 'public_key',
  WEB3AUTH_LEGACY_VERIFIERS: '', // empty = NEVER link a legacy row by e-mail (opt-in by verifier name)
  WEB3AUTH_ALLOW_LEGACY_FALLBACK: 'false',
  WEB3AUTH_EXTERNAL_ISSUERS: 'https://authjs.web3auth.io',
  WEB3AUTH_EXTERNAL_JWKS_URL: 'https://authjs.web3auth.io/jwks',
  WEB3AUTH_EXTERNAL_AUDIENCE: '', // empty → WEB3AUTH_CLIENT_ID
  // G4: the signing keys this deployment approves, as RFC 7638 SHA-256 thumbprints (csv,
  // base64url). ONE list covers both JWKS sets (social and external-wallet). Read the current
  // values with scripts/web3authJwksThumbprints.js. EMPTY is refused at boot under pin `enforce`.
  WEB3AUTH_JWKS_PINNED_THUMBPRINTS: '',
  // off = no check · log = accept, warn `jwks_key_not_pinned` · enforce = 401 IDTOKEN_KEY_NOT_PINNED
  WEB3AUTH_JWKS_PIN_MODE: 'log',
};

// Fixed (not env) claim fallbacks for display data. Never identity.
const NAME_CLAIMS = ['name'];
const AVATAR_CLAIMS = ['profileImage', 'picture'];

const HTTP_STATUS = {
  IDTOKEN_REQUIRED: 400,
  IDTOKEN_INVALID: 401,
  IDTOKEN_EXPIRED: 401,
  IDTOKEN_ISSUER: 401,
  IDTOKEN_AUDIENCE: 401,
  IDTOKEN_SIGNATURE: 401,
  IDTOKEN_VERIFIER_NOT_ALLOWED: 401,
  IDTOKEN_KEY_NOT_PINNED: 401,
  // Web3Auth's key service could not be used (timeout, non-200, junk, connection failure). Says
  // nothing about the token; nobody logs in until the key set is readable again (fail closed).
  IDTOKEN_UPSTREAM_UNAVAILABLE: 503,
  WALLET_NOT_IN_TOKEN: 401,
  IDENTITY_CONFLICT: 409,
  ORG_NOT_ALLOWED: 403,
  ACCOUNT_DISABLED: 403,
};

class Web3AuthIdentityError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'Web3AuthIdentityError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code] || 401;
    this.details = details;
  }
}

function fail(code, message, details) {
  return new Web3AuthIdentityError(code, message, details);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function csv(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function envOr(env, key) {
  const v = env[key];
  return v === undefined || v === null || String(v).trim() === '' ? DEFAULTS[key] : String(v).trim();
}

/** Strict boolean env: only "true"/"false" (any case). A typo must not read as "on". */
function envBool(env, key) {
  const raw = envOr(env, key).toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${key} must be "true" or "false" (got "${raw}")`);
}

function loadConfig(env = process.env) {
  const mode = envOr(env, 'WEB3AUTH_VERIFY_MODE').toLowerCase();
  const walletMatch = envOr(env, 'WEB3AUTH_WALLET_MATCH').toLowerCase();
  const clientId = envOr(env, 'WEB3AUTH_CLIENT_ID');
  const externalAudience = csv(envOr(env, 'WEB3AUTH_EXTERNAL_AUDIENCE'));
  return {
    mode,
    nodeEnv: env.NODE_ENV || 'development',
    clientId,
    algs: csv(envOr(env, 'WEB3AUTH_ALGS')),
    maxTokenAge: envOr(env, 'WEB3AUTH_MAX_TOKEN_AGE'),
    // Connections this deployment accepts as an identity source. Required under `enforce`.
    allowedVerifiers: csv(envOr(env, 'WEB3AUTH_ALLOWED_VERIFIERS')),
    verifierClaims: csv(envOr(env, 'WEB3AUTH_VERIFIER_CLAIM')),
    verifierIdClaims: csv(envOr(env, 'WEB3AUTH_VERIFIER_ID_CLAIM')),
    emailClaims: csv(envOr(env, 'WEB3AUTH_EMAIL_CLAIM')),
    emailVerifiedClaim: envOr(env, 'WEB3AUTH_EMAIL_VERIFIED_CLAIM'),
    walletsClaim: envOr(env, 'WEB3AUTH_WALLETS_CLAIM'),
    walletMatch,
    // Verifiers allowed to lazily link a legacy row by IdP-asserted e-mail. EMPTY = NONE.
    legacyVerifiers: csv(envOr(env, 'WEB3AUTH_LEGACY_VERIFIERS')),
    // `log` mode only: allow a request with NO idToken at all to use the legacy path.
    allowLegacyFallback: envBool(env, 'WEB3AUTH_ALLOW_LEGACY_FALLBACK'),
    // G4: which signing keys may verify a token at all, by RFC 7638 thumbprint (both JWKS sets).
    pinMode: envOr(env, 'WEB3AUTH_JWKS_PIN_MODE').toLowerCase(),
    pinnedThumbprints: csv(envOr(env, 'WEB3AUTH_JWKS_PINNED_THUMBPRINTS')),
    kinds: {
      social: {
        jwksUrl: envOr(env, 'WEB3AUTH_JWKS_URL'),
        issuers: csv(envOr(env, 'WEB3AUTH_ISSUERS')),
        audience: clientId ? [clientId] : [],
      },
      external: {
        jwksUrl: envOr(env, 'WEB3AUTH_EXTERNAL_JWKS_URL'),
        issuers: csv(envOr(env, 'WEB3AUTH_EXTERNAL_ISSUERS')),
        audience: externalAudience.length ? externalAudience : clientId ? [clientId] : [],
      },
    },
  };
}

/** 1-based positions (`#2`) of pin-list entries that are not a SHA-256 JWK thumbprint. */
function malformedThumbprints(list) {
  return list.map((value, index) => (THUMBPRINT_PATTERN.test(value) ? null : `#${index + 1}`)).filter(Boolean);
}

/**
 * Boot-time checks. Throws with a clear message; called at module load and by tests.
 */
function assertBootConfig(env = process.env) {
  const cfg = loadConfig(env);
  if (!VERIFY_MODES.includes(cfg.mode)) {
    throw new Error(
      `WEB3AUTH_VERIFY_MODE must be one of ${VERIFY_MODES.join('|')} (got "${cfg.mode}")`
    );
  }
  if (!WALLET_MATCH_MODES.includes(cfg.walletMatch)) {
    throw new Error(
      `WEB3AUTH_WALLET_MATCH must be one of ${WALLET_MATCH_MODES.join('|')} (got "${cfg.walletMatch}")`
    );
  }
  if (!PIN_MODES.includes(cfg.pinMode)) {
    throw new Error(`WEB3AUTH_JWKS_PIN_MODE must be one of ${PIN_MODES.join('|')} (got "${cfg.pinMode}")`);
  }
  // Positions, not values: a malformed entry may be something other than a thumbprint.
  const malformedPins = malformedThumbprints(cfg.pinnedThumbprints);
  if (malformedPins.length) {
    const one = malformedPins.length === 1;
    throw new Error(
      `WEB3AUTH_JWKS_PINNED_THUMBPRINTS ${one ? 'entry' : 'entries'} ${malformedPins.join(', ')} ` +
        `${one ? 'is not an RFC 7638 SHA-256 JWK thumbprint' : 'are not RFC 7638 SHA-256 JWK thumbprints'} ` +
        '(43 base64url characters, no padding). Copy the values printed by scripts/web3authJwksThumbprints.js.'
    );
  }
  if (cfg.pinMode === 'enforce' && !cfg.pinnedThumbprints.length) {
    throw new Error(
      'WEB3AUTH_JWKS_PINNED_THUMBPRINTS is required when WEB3AUTH_JWKS_PIN_MODE=enforce (csv of the RFC 7638 thumbprints ' +
        'of the approved Web3Auth signing keys, printed by scripts/web3authJwksThumbprints.js). An empty list would ' +
        'refuse every login.'
    );
  }
  if (cfg.nodeEnv === 'production' && cfg.mode === 'off') {
    throw new Error(
      'WEB3AUTH_VERIFY_MODE=off is not allowed when NODE_ENV=production; use "log" (rollout) or "enforce".'
    );
  }
  if (cfg.mode !== 'off' && !cfg.clientId) {
    throw new Error(
      'WEB3AUTH_CLIENT_ID is required when WEB3AUTH_VERIFY_MODE is "log" or "enforce" (it is the expected ID token audience). ' +
        'Set it to the Web3Auth project client id the Wallet uses, or set WEB3AUTH_VERIFY_MODE=off outside production.'
    );
  }
  if (cfg.mode === 'enforce' && !cfg.allowedVerifiers.length) {
    throw new Error(
      'WEB3AUTH_ALLOWED_VERIFIERS is required when WEB3AUTH_VERIFY_MODE=enforce (csv of the login connections DataDance uses, ' +
        'e.g. "web3auth-google-sapphire-devnet,external-wallet"). Without it, ANY connection added in the Web3Auth project — ' +
        'by anyone holding a console credential — is accepted as an identity source and can impersonate any user. ' +
        'Add "external-wallet" if sign-in-with-wallet is offered.'
    );
  }
  for (const kind of Object.keys(cfg.kinds)) {
    const k = cfg.kinds[kind];
    // eslint-disable-next-line no-new
    new URL(k.jwksUrl);
    if (!k.issuers.length) throw new Error(`Web3Auth ${kind} issuer list must not be empty`);
  }
  return cfg;
}

let cachedConfig = null;
const jwksCache = new Map();

function getConfig() {
  if (!cachedConfig) cachedConfig = assertBootConfig(process.env);
  return cachedConfig;
}

function resetConfig() {
  cachedConfig = null;
  jwksCache.clear();
}

// jose's own default, stated explicitly; tests shorten it through _internals.
const DEFAULT_JWKS_TIMEOUT_MS = 5000;
let jwksTimeoutMs = DEFAULT_JWKS_TIMEOUT_MS;

/**
 * "The key set could not be obtained" — thrown by fetchJwksStrict below, never by jose.
 * `reason` is one of `network` | `http_status` | `invalid_json` (a timeout is jose's JWKSTimeout,
 * a JSON body that is not a key set is jose's JWKSInvalid; mapJoseError adds `timeout` and
 * `invalid_jwks`).
 */
class JwksUnavailableError extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'JwksUnavailableError';
    this.reason = reason;
    Object.assign(this, extra);
  }
}

/**
 * The fetch jose uses for the JWKS (`jose.customFetch`, a documented createRemoteJWKSet option).
 *
 * jose reports a non-200 answer and an unparseable body as a plain JOSEError — the base class,
 * distinguishable from a token problem only by its message — and a connection failure as whatever
 * fetch threw. So those three are decided HERE, where the HTTP response is in hand, and surface as
 * a JwksUnavailableError that jose passes through untouched. A timeout is left to jose (it turns
 * the abort into JWKSTimeout), so the request, redirect policy, headers and timeout signal are
 * exactly the ones jose built.
 */
async function fetchJwksStrict(url, options) {
  const isTimeout = (err) => Boolean(err) && err.name === 'TimeoutError';
  let response;
  try {
    response = await fetch(url, options);
  } catch (err) {
    if (isTimeout(err)) throw err;
    throw new JwksUnavailableError('network', 'JWKS request failed before a response arrived', {
      cause: err,
    });
  }
  if (response.status !== 200) {
    try {
      await response.body?.cancel();
    } catch {
      /* the body is irrelevant */
    }
    throw new JwksUnavailableError('http_status', `JWKS answered HTTP ${response.status}`, {
      upstreamStatus: response.status,
    });
  }
  let body;
  try {
    body = await response.text();
  } catch (err) {
    if (isTimeout(err)) throw err;
    throw new JwksUnavailableError('network', 'JWKS response body could not be read', { cause: err });
  }
  try {
    JSON.parse(body);
  } catch {
    throw new JwksUnavailableError('invalid_json', 'JWKS response is not JSON');
  }
  // jose parses it again and checks it is a key set (JWKSInvalid otherwise).
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

function getJwks(url) {
  if (!jwksCache.has(url)) {
    jwksCache.set(
      url,
      jose.createRemoteJWKSet(new URL(url), {
        timeoutDuration: jwksTimeoutMs,
        [jose.customFetch]: fetchJwksStrict,
      })
    );
  }
  return jwksCache.get(url);
}

/** Tests only: a shorter JWKS timeout (drops the cached key sets). No argument restores 5 s. */
function setJwksTimeoutMs(ms = DEFAULT_JWKS_TIMEOUT_MS) {
  jwksTimeoutMs = ms;
  jwksCache.clear();
}

function getVerifyMode() {
  return getConfig().mode;
}

/**
 * `log` mode only, and only for a request that supplied NO idToken: may it use the legacy
 * client-asserted path? Default false — the body alone never mints a session (SSO plan §5 F03).
 * A supplied-but-rejected token is never covered by this flag; it fails closed in every mode.
 */
function getAllowLegacyFallback() {
  return getConfig().allowLegacyFallback;
}

// ---------------------------------------------------------------------------
// Token verification
// ---------------------------------------------------------------------------

function pickKind(cfg, iss) {
  if (typeof iss === 'string') {
    if (cfg.kinds.social.issuers.includes(iss)) return 'social';
    if (cfg.kinds.external.issuers.includes(iss)) return 'external';
  }
  return null;
}

/**
 * The identity provider's key service is unusable. Every case where the key set could not be
 * OBTAINED lands here — never on an IDTOKEN_* code that blames the token.
 */
function upstreamUnavailable(reason, extra = {}) {
  return fail(
    'IDTOKEN_UPSTREAM_UNAVAILABLE',
    'The identity provider (Web3Auth) is temporarily unavailable. Please try again shortly.',
    { reason, ...extra }
  );
}

function mapJoseError(err) {
  const code = err && err.code;
  // Key set not obtainable — checked first: JWKSTimeout and JWKSInvalid are JOSEErrors too.
  if (err instanceof JwksUnavailableError) {
    return upstreamUnavailable(err.reason, err.upstreamStatus ? { upstreamStatus: err.upstreamStatus } : {});
  }
  if (err instanceof jose.errors.JWKSTimeout || code === 'ERR_JWKS_TIMEOUT') {
    return upstreamUnavailable('timeout');
  }
  // Only jose's key-set code throws JWKSInvalid: the endpoint answered JSON that is not a usable
  // public key set. That is the provider's fault, not the token's.
  if (err instanceof jose.errors.JWKSInvalid || code === 'ERR_JWKS_INVALID') {
    return upstreamUnavailable('invalid_jwks');
  }
  if (err instanceof jose.errors.JWTExpired || code === 'ERR_JWT_EXPIRED') {
    return fail('IDTOKEN_EXPIRED', 'ID token has expired');
  }
  if (err instanceof jose.errors.JWTClaimValidationFailed || code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (err.claim === 'iss') return fail('IDTOKEN_ISSUER', 'ID token issuer is not accepted');
    if (err.claim === 'aud') return fail('IDTOKEN_AUDIENCE', 'ID token audience does not match this project');
    return fail('IDTOKEN_INVALID', `ID token claim "${err.claim}" failed validation`);
  }
  if (
    err instanceof jose.errors.JWSSignatureVerificationFailed ||
    err instanceof jose.errors.JWKSNoMatchingKey ||
    err instanceof jose.errors.JWKSMultipleMatchingKeys ||
    err instanceof jose.errors.JOSEAlgNotAllowed ||
    code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' ||
    code === 'ERR_JWKS_NO_MATCHING_KEY' ||
    code === 'ERR_JOSE_ALG_NOT_ALLOWED'
  ) {
    return fail('IDTOKEN_SIGNATURE', 'ID token signature could not be verified');
  }
  if (err instanceof jose.errors.JOSEError) {
    // JWSInvalid, JWTInvalid, JOSENotSupported, ...
    return fail('IDTOKEN_INVALID', 'ID token is malformed or not supported');
  }
  // Anything else is a bug, not a verdict on the token: it propagates and the caller answers 500.
  return err;
}

/**
 * RFC 7638 SHA-256 thumbprint (base64url) of the key that verified a token, or null when it
 * cannot be computed (a null thumbprint is never pinned).
 *
 * `key` is the CryptoKey jose's key resolver handed to the signature check — `jwtVerify(...).key`,
 * jose's documented `ResolvedKey` — so this is the key material the signature was actually
 * verified with, not whatever a JWKS entry's `kid` says. jose imports JWKS members as extractable
 * public keys, and the thumbprint covers only the required public members (EC: crv, kty, x, y),
 * so it equals the thumbprint of the JWKS entry that key came from, which is what
 * scripts/web3authJwksThumbprints.js prints.
 */
async function keyThumbprint(key) {
  if (!key) return null;
  try {
    return await jose.calculateJwkThumbprint(key, 'sha256');
  } catch (err) {
    return null;
  }
}

/**
 * G4 — signing-key pinning. The JWKS is fetched over the network when a token is verified, so
 * whoever can influence that one response (DNS, a TLS-intercepting proxy, a compromise or a
 * malicious rotation at the provider) can serve a key of their own — under a new kid, or under
 * the kid of the real key — and mint any identity: the signature check passes, because the
 * signature IS genuine for the key that was served. A kid is only a label; the thumbprint is the
 * key. Runs only after the token has fully verified (signature, iss, aud, exp).
 *
 * `enforce` → IDTOKEN_KEY_NOT_PINNED (401), logged at error level.
 * `log`     → accepted, `jwks_key_not_pinned` warning on every such token.
 * `off`     → no check.
 * Logged: kid, thumbprint, JWKS URL (all public). Never the token.
 */
async function assertKeyPinned(cfg, { key, protectedHeader, jwksUrl, kind }) {
  if (cfg.pinMode === 'off') return;
  const thumbprint = await keyThumbprint(key);
  if (thumbprint && cfg.pinnedThumbprints.includes(thumbprint)) return;
  const kid = protectedHeader && typeof protectedHeader.kid === 'string' ? protectedHeader.kid : null;
  const meta = {
    kid,
    thumbprint,
    jwksUrl,
    kind,
    alg: (protectedHeader && protectedHeader.alg) || null,
    mode: cfg.pinMode,
    pinnedCount: cfg.pinnedThumbprints.length,
  };
  if (cfg.pinMode === 'enforce') {
    logger.error('jwks_key_not_pinned', { ...meta, outcome: 'refused' });
    throw fail('IDTOKEN_KEY_NOT_PINNED', 'ID token was signed with a key DataDance has not approved', {
      kid,
      thumbprint,
    });
  }
  logger.warn('jwks_key_not_pinned', { ...meta, outcome: 'accepted_log_mode' });
}

/**
 * Verify a Web3Auth ID token. Resolves `{ kind: 'social'|'external', payload, protectedHeader }`.
 * Throws Web3AuthIdentityError with one of IDTOKEN_REQUIRED|IDTOKEN_INVALID|IDTOKEN_EXPIRED|
 * IDTOKEN_ISSUER|IDTOKEN_AUDIENCE|IDTOKEN_SIGNATURE|IDTOKEN_KEY_NOT_PINNED (401) or, when the
 * Web3Auth key set cannot be obtained at all, IDTOKEN_UPSTREAM_UNAVAILABLE (503, logged at error
 * level as `idtoken_upstream_unavailable` {jwksUrl, reason}). Still fail closed: nothing verifies
 * without the key set.
 */
async function verifyIdToken(idToken) {
  const cfg = getConfig();
  if (typeof idToken !== 'string' || !idToken.trim()) {
    throw fail('IDTOKEN_REQUIRED', 'idToken is required');
  }
  const token = idToken.trim();

  let peek;
  try {
    peek = jose.decodeJwt(token); // UNVERIFIED: only used to pick the issuer branch; jwtVerify re-checks iss
  } catch (err) {
    throw fail('IDTOKEN_INVALID', 'ID token is malformed');
  }
  const kind = pickKind(cfg, peek.iss);
  if (!kind) throw fail('IDTOKEN_ISSUER', 'ID token issuer is not accepted');

  const k = cfg.kinds[kind];
  if (!k.audience.length) throw fail('IDTOKEN_AUDIENCE', 'No audience configured for this token kind');

  let verified;
  try {
    verified = await jose.jwtVerify(token, getJwks(k.jwksUrl), {
      issuer: k.issuers,
      audience: k.audience,
      algorithms: cfg.algs,
      clockTolerance: CLOCK_TOLERANCE_SEC,
      maxTokenAge: cfg.maxTokenAge,
    });
  } catch (err) {
    const mapped = mapJoseError(err);
    if (mapped && mapped.code === 'IDTOKEN_UPSTREAM_UNAVAILABLE') {
      // The signal the T17 outage procedure looks for. Public data only — never the token.
      logger.error('idtoken_upstream_unavailable', {
        jwksUrl: k.jwksUrl,
        reason: mapped.details.reason,
        ...(mapped.details.upstreamStatus ? { upstreamStatus: mapped.details.upstreamStatus } : {}),
        kind,
      });
    }
    throw mapped;
  }
  // A key resolver was passed, so jose returns the key it resolved (and verified with) as `key`.
  const { payload, protectedHeader, key } = verified;
  await assertKeyPinned(cfg, { key, protectedHeader, jwksUrl: k.jwksUrl, kind });
  return { kind, payload, protectedHeader };
}

// ---------------------------------------------------------------------------
// Identity extraction
// ---------------------------------------------------------------------------

function readPath(obj, path) {
  return String(path)
    .split('.')
    .reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), obj);
}

function firstString(payload, paths) {
  for (const p of paths) {
    const v = readPath(payload, p);
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return null;
}

function normalizeWallets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const w of raw) {
    if (!w || typeof w !== 'object') continue;
    const entry = {
      type: typeof w.type === 'string' ? w.type : null,
      curve: typeof w.curve === 'string' ? w.curve : null,
      publicKey: typeof w.public_key === 'string' ? w.public_key.replace(/^0x/i, '') : null,
      address: typeof w.address === 'string' && isAddress(w.address) ? getAddress(w.address) : null,
    };
    if (entry.publicKey || entry.address) out.push(entry);
  }
  return out;
}

/**
 * Did the IdP assert that it VERIFIED this e-mail? Only a real boolean `true` counts: a
 * string, 1, or a missing claim means "not verified", because an unverified e-mail is a
 * value the token holder types in, not a fact the provider checked.
 */
function emailVerifiedFrom(payload, cfg) {
  return readPath(payload, cfg.emailVerifiedClaim) === true;
}

/**
 * Is this verifier one of the login connections DataDance actually uses?
 * An EMPTY list means "not configured", which is only reachable outside `enforce` (the boot
 * assertion refuses an empty list under `enforce`); it then allows everything, as before.
 */
function isVerifierAllowed(cfg, verifier) {
  return !cfg.allowedVerifiers.length || cfg.allowedVerifiers.includes(String(verifier || ''));
}

/**
 * The identity key may only come from a connection we chose (item 2). Without this, whoever can
 * add a connection in the DataDance Web3Auth project — a console credential, a hijacked
 * dashboard session — mints tokens this server accepts, and `verifierId` is theirs to choose:
 * that is "become any user", and no amount of signature checking sees it, because the signature
 * is genuine.
 *
 * `enforce` → IDTOKEN_VERIFIER_NOT_ALLOWED (401). `log` → accept, but say so loudly on every
 * single token, so the rollout cannot end quietly with the list still wrong.
 */
function assertVerifierAllowed(cfg, identity) {
  if (isVerifierAllowed(cfg, identity.verifier)) return;
  const meta = { verifier: identity.verifier, kind: identity.kind, mode: cfg.mode, allowedCount: cfg.allowedVerifiers.length };
  if (cfg.mode === 'enforce') {
    logger.warn('idtoken_verifier_not_allowed', { ...meta, outcome: 'refused' });
    throw fail('IDTOKEN_VERIFIER_NOT_ALLOWED', 'This login method is not accepted by DataDance', {
      verifier: identity.verifier,
    });
  }
  logger.warn('idtoken_verifier_not_allowed', { ...meta, outcome: 'accepted_log_mode' });
}

/**
 * Read the upstream identity out of a verified payload.
 * Returns `{ kind, verifier, verifierId, email, emailVerified, name, profileImage, wallets }`.
 * Throws IDTOKEN_INVALID when no identity can be established, or
 * IDTOKEN_VERIFIER_NOT_ALLOWED when the connection is not on WEB3AUTH_ALLOWED_VERIFIERS.
 */
function extractIdentity(payload, { kind } = {}) {
  const cfg = getConfig();
  if (!payload || typeof payload !== 'object') throw fail('IDTOKEN_INVALID', 'ID token payload is empty');

  const wallets = normalizeWallets(readPath(payload, cfg.walletsClaim));
  let verifier = firstString(payload, cfg.verifierClaims);
  let verifierId = firstString(payload, cfg.verifierIdClaims);
  let resolvedKind = kind || (pickKind(cfg, payload.iss) || 'social');

  if (!verifier || !verifierId) {
    // External-wallet tokens carry no verifier claims: the proven address is the identity.
    const ext = wallets.find((w) => w.address && (!w.type || w.type === 'ethereum'));
    if (ext && resolvedKind === 'external') {
      verifier = EXTERNAL_WALLET_VERIFIER;
      verifierId = ext.address.toLowerCase();
      resolvedKind = 'external';
    } else {
      throw fail('IDTOKEN_INVALID', 'ID token carries no verifier identity', {
        hasVerifier: Boolean(verifier),
        hasVerifierId: Boolean(verifierId),
      });
    }
  }

  // Identity key: an e-mail-shaped verifierId is lower-cased so `Alice@x` and `alice@x` from the
  // same provider map to one row (web3auth-idtoken.md §4); opaque ids (`twitter|123`) stay as-is.
  const verifierIdRaw = verifierId;
  if (verifierId.includes('@')) verifierId = verifierId.toLowerCase();

  const emailRaw = firstString(payload, cfg.emailClaims);
  const email = emailRaw && emailRaw.includes('@') ? emailRaw : null;
  const emailVerified = Boolean(email) && emailVerifiedFrom(payload, cfg);
  const name = firstString(payload, NAME_CLAIMS);
  const profileImage = firstString(payload, AVATAR_CLAIMS);

  // Every caller reaches the identity through here, so this is the one place the allow-list has
  // to hold — including the external-wallet branch above, which must be listed explicitly.
  assertVerifierAllowed(cfg, { verifier, kind: resolvedKind });

  return {
    kind: resolvedKind,
    verifier,
    verifierId,
    verifierIdRaw,
    email,
    emailVerified,
    name,
    profileImage,
    wallets,
  };
}

// ---------------------------------------------------------------------------
// Wallet binding
// ---------------------------------------------------------------------------

function addressFromCompressedKey(hex) {
  if (!/^0[23][0-9a-fA-F]{64}$/.test(hex)) return null;
  try {
    return computeAddress('0x' + hex);
  } catch (err) {
    return null;
  }
}

/** Addresses the token proves, per WEB3AUTH_WALLET_MATCH (checksummed, deduplicated). */
function tokenAddresses(identity, walletMatch) {
  const out = new Set();
  // The Wallet signs in with the app-scoped key; list it first so an unclaimed bind picks it.
  const ordered = [...(identity.wallets || [])].sort(
    (a, b) => Number(b.type === 'web3auth_app_key') - Number(a.type === 'web3auth_app_key')
  );
  for (const w of ordered) {
    if (w.address && (!w.type || w.type === 'ethereum')) out.add(w.address);
    if (walletMatch === 'public_key' && w.publicKey && (!w.curve || w.curve === 'secp256k1')) {
      const addr = addressFromCompressedKey(w.publicKey);
      if (addr) out.add(addr);
    }
  }
  return [...out];
}

/**
 * Check the client-claimed wallet against the wallets the token proves.
 * Returns the proven address to bind (checksummed), or `null` when WEB3AUTH_WALLET_MATCH=none
 * (the supplied address is then ignored for binding) or when the token proves no wallet.
 * Throws WALLET_NOT_IN_TOKEN when an address was claimed but the token does not prove it.
 */
function assertWalletBound(identity, walletAddress) {
  const cfg = getConfig();
  if (cfg.walletMatch === 'none') return null;

  const proven = tokenAddresses(identity, cfg.walletMatch);
  if (walletAddress) {
    const claimed = String(walletAddress).trim();
    if (!isAddress(claimed)) throw fail('WALLET_NOT_IN_TOKEN', 'Wallet address is not a valid Ethereum address');
    const match = proven.find((a) => a.toLowerCase() === claimed.toLowerCase());
    if (!match) throw fail('WALLET_NOT_IN_TOKEN', 'ID token does not prove ownership of the supplied wallet');
    return match;
  }
  return proven[0] || null;
}

// ---------------------------------------------------------------------------
// User resolution
// ---------------------------------------------------------------------------

function isOrganization(user) {
  return Boolean(user && (user.userType === 'organization' || user.isOrganization));
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

function guardAccount(user) {
  if (user.disabledAt) throw fail('ACCOUNT_DISABLED', 'This account has been disabled');
  if (isOrganization(user)) throw fail('ORG_NOT_ALLOWED', 'Organization accounts cannot use Web3Auth');
}

/**
 * Does the token PROVE the candidate row's wallet? A row with a NULL wallet proves nothing and
 * is NOT "consistent": most legacy rows have no wallet, and treating that as consistency was
 * what let an IdP-asserted e-mail alone claim someone else's account.
 */
function walletConsistent(candidate, walletAddress) {
  return Boolean(walletAddress) && sameAddress(candidate && candidate.walletAddress, walletAddress);
}

/**
 * The e-mail column is NOT NULL; the legacy frontend stored `verifierId` there when the
 * provider released no e-mail (X: `twitter|<id>`). Mirror that so legacy rows are found.
 */
function accountEmailFor(identity) {
  return identity.email || identity.verifierId;
}

function defaultName(identity, accountEmail) {
  if (identity.name) return identity.name;
  if (identity.email) return identity.email.split('@')[0];
  return accountEmail && accountEmail.includes('@') ? accountEmail.split('@')[0] : 'User';
}

/**
 * Map a verified identity to a DDC user (plan §2.1):
 *   1. hit by (web3authVerifier, web3authVerifierId) → login
 *   2. lazy backfill of a legacy `web3auth` row, via updateMany(... web3authVerifier: null)
 *      requiring count === 1, on exactly two routes:
 *        - the token PROVES the wallet the row already holds (cryptographic), or
 *        - the row is found by the key the token carries in the e-mail column AND the verifier
 *          is named in WEB3AUTH_LEGACY_VERIFIERS AND, when that key is an IdP-asserted e-mail,
 *          the token asserts `email_verified === true` (F03: an e-mail claim alone is not proof)
 *   3. otherwise IDENTITY_CONFLICT (never merged)
 *   4. no candidate → create
 *
 * @param identity from extractIdentity
 * @param options.walletAddress proven wallet from assertWalletBound (or null)
 * @param options.prepareCreate async () => extra `user.create` data (referralCode, x fields, ...);
 *        runs only when a new row will be created and may throw to abort
 * @param options.afterCreate async (tx, user) => void; runs inside the create transaction
 * @param options.db prisma client (tests inject a mock)
 * @returns {{ user, action: 'login'|'backfilled'|'created' }}
 */
async function resolveUser(identity, options = {}) {
  const cfg = getConfig();
  const db = options.db || require('../utils/prisma');
  const walletAddress = options.walletAddress || null;
  const pair = { web3authVerifier: identity.verifier, web3authVerifierId: identity.verifierId };

  // 1. Hit by pair
  const linked = await db.user.findUnique({ where: { web3authVerifier_web3authVerifierId: pair } });
  if (linked) {
    guardAccount(linked);
    return { user: linked, action: 'login' };
  }

  // 2. Lazy backfill candidate — only facts the verified token asserts (e-mail / verifierId / proven wallet)
  const accountEmail = accountEmailFor(identity);
  let candidate = accountEmail ? await db.user.findUnique({ where: { email: accountEmail } }) : null;
  if (!candidate && accountEmail && accountEmail.includes('@')) {
    // Legacy rows kept the provider's casing; the unique index is case-sensitive.
    candidate = await db.user.findFirst({
      where: { email: { equals: accountEmail, mode: 'insensitive' } },
    });
  }
  // `email` = the IdP asserted this address; `verifier_id` = the legacy column holds the
  // token-proven verifierId (X rows kept `twitter|<id>` there, the column being NOT NULL).
  let candidateBy = candidate ? (identity.email ? 'email' : 'verifier_id') : null;
  if (!candidate && walletAddress) {
    candidate = await db.user.findFirst({
      where: { walletAddress: { equals: walletAddress, mode: 'insensitive' } },
    });
    candidateBy = candidate ? 'wallet' : null;
  }

  if (candidate) {
    guardAccount(candidate);
    // Explicit opt-in, by verifier name: an EMPTY list links nothing by e-mail (it used to mean
    // "any verifier", and the Web3Auth client id ships in the SPA bundle, so "any verifier with a
    // token whose e-mail claim the holder controls" was enough to claim a victim's row).
    const verifierAllowed = cfg.legacyVerifiers.includes(identity.verifier);
    const unlinked = candidate.web3authVerifier == null && candidate.web3authVerifierId == null;
    const walletProven = walletConsistent(candidate, walletAddress);
    const walletMismatch =
      Boolean(walletAddress) &&
      Boolean(candidate.walletAddress) &&
      !sameAddress(candidate.walletAddress, walletAddress);

    let reason = null;
    if (candidate.authType !== 'web3auth') reason = 'candidate_not_web3auth';
    else if (!unlinked) reason = 'candidate_already_linked';
    else if (walletMismatch) reason = 'wallet_mismatch';
    // The connection allow-list guards EVERY route into an existing account, the cryptographic
    // one included (item 2). The "proof" on that route is a key Web3Auth derives for the
    // connection, so a connection we never chose proves nothing about the person — and in `log`
    // mode extractIdentity only warns, which used to leave this route wide open.
    else if (!isVerifierAllowed(cfg, identity.verifier)) reason = 'verifier_not_in_allowlist';
    else if (!walletProven) {
      // Not the cryptographic route: the e-mail-column route needs the opt-in, and a real
      // e-mail needs the IdP's own `email_verified` before it may key a legacy account.
      if (!verifierAllowed) reason = 'verifier_not_allowed';
      else if (candidateBy === 'email' && identity.emailVerified !== true) reason = 'email_not_verified';
    }

    if (reason) {
      logger.warn('identity_conflict', {
        reason,
        candidateBy,
        candidateUserId: candidate.id,
        candidateAuthType: candidate.authType,
        verifier: identity.verifier,
      });
      throw fail('IDENTITY_CONFLICT', 'This login cannot be linked to the existing account automatically', {
        reason,
        candidateUserId: candidate.id,
      });
    }

    const res = await db.user.updateMany({
      where: { id: candidate.id, web3authVerifier: null },
      data: { ...pair, web3authLinkedAt: new Date() },
    });
    if (res.count !== 1) {
      logger.warn('identity_conflict', {
        reason: 'backfill_race',
        candidateBy,
        candidateUserId: candidate.id,
        verifier: identity.verifier,
      });
      throw fail('IDENTITY_CONFLICT', 'Account was linked concurrently; please retry', {
        reason: 'backfill_race',
        candidateUserId: candidate.id,
      });
    }
    const user = await db.user.findUnique({ where: { id: candidate.id } });
    logger.info('identity_backfilled', { userId: user.id, candidateBy, verifier: identity.verifier });
    return { user, action: 'backfilled' };
  }

  // 4. Create
  const extra = options.prepareCreate ? (await options.prepareCreate()) || {} : {};
  const now = new Date();
  try {
    const user = await db.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email: accountEmail,
          name: defaultName(identity, accountEmail),
          avatar: identity.profileImage || undefined,
          walletAddress: walletAddress || undefined,
          authType: 'web3auth',
          userType: 'regular',
          ...pair,
          web3authLinkedAt: now,
          ...extra,
          profile: { create: { language: 'en' } },
        },
      });
      if (options.afterCreate) await options.afterCreate(tx, created);
      return created;
    });
    logger.info('identity_created', { userId: user.id, verifier: identity.verifier });
    return { user, action: 'created' };
  } catch (err) {
    if (err && err.code === 'P2002') {
      logger.warn('identity_conflict', {
        reason: 'unique_violation',
        target: err.meta && err.meta.target,
        verifier: identity.verifier,
      });
      throw fail('IDENTITY_CONFLICT', 'An account with these details already exists', {
        reason: 'unique_violation',
      });
    }
    throw err;
  }
}

// Boot assertion: this module is loaded by the auth routes at app start.
assertBootConfig(process.env);

module.exports = {
  verifyIdToken,
  extractIdentity,
  assertWalletBound,
  resolveUser,
  getVerifyMode,
  getAllowLegacyFallback,
  Web3AuthIdentityError,
  EXTERNAL_WALLET_VERIFIER,
  _internals: {
    DEFAULTS,
    HTTP_STATUS,
    PIN_MODES,
    THUMBPRINT_PATTERN,
    JwksUnavailableError,
    fetchJwksStrict,
    setJwksTimeoutMs,
    malformedThumbprints,
    keyThumbprint,
    assertKeyPinned,
    isVerifierAllowed,
    assertVerifierAllowed,
    loadConfig,
    assertBootConfig,
    getConfig,
    resetConfig,
    pickKind,
    mapJoseError,
    readPath,
    normalizeWallets,
    tokenAddresses,
    addressFromCompressedKey,
    accountEmailFor,
    guardAccount,
    walletConsistent,
    emailVerifiedFrom,
  },
};
