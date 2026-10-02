/**
 * The DDC issuer: mints the short-lived custom JWT that the Web3Auth nodes of the native
 * connection accept (§2.4), and publishes the public keys they verify it with.
 *
 * Token: header {alg:'RS256', typ:'JWT', kid:<RFC 7638 thumbprint>}; payload {iss, aud,
 * sub:<w3aSubject>, user_id:<w3aSubject>, iat: now-2, exp: iat+TTL (30..60 s), jti}. No nbf, no
 * e-mail, no other PII. `sub` is the opaque random w3aSubject of NativeWalletBinding, never the
 * DDC user id (F11).
 *
 * A token is minted only by identify.createLoginAttempt() and POST /token — there is no path from
 * a DDC session to a wallet JWT (F2/D4). Each mint logs `native_auth.w3a_jwt_issued` with
 * {loginRef, kid, jti, exp, count}: never `sub`, never the token.
 *
 * JWKS (GET /.well-known/ddc-auth/jwks.json): built only from pinned keys (the active key and the
 * rotation keys: DDC_AUTH_JWKS_EXTRA_FILE for the file signer, DDC_AUTH_KMS_EXTRA_KEYS for KMS),
 * public members kty,n,e,kid,alg,use only, `Cache-Control: public, max-age=300`. Served whenever a
 * key is configured, even with DDC_AUTH_ENABLED off; with no key configured (the default) the
 * request falls through to exactly what the app answered before.
 */
const crypto = require('crypto');
const {
  readNativeAuthConfig,
  keyProblem,
  readExtraJwks,
  logger,
  isRelaxedEnv,
} = require('./config');
const { getSigner, ensureSignerReady, readyKid } = require('./signer');

const JWKS_CACHE_CONTROL = 'public, max-age=300';
const IAT_BACKDATE_SEC = 2;

function nativeError(message) {
  const err = new Error(message);
  err.statusCode = 500;
  return err;
}

/** The active signer, refused when its key is leaked or not pinned (boot checks this too). */
function activeSigner(cfg) {
  const signer = getSigner(cfg);
  const problem = keyProblem(signer.publicJwk(), signer.kid, cfg, 'The signing key');
  if (problem) throw nativeError(`native issuer refused: ${problem}`);
  return signer;
}

/**
 * Mint one Web3Auth custom JWT for `subject` (the w3aSubject). Returns
 * { idToken, jti, kid, iat, exp, expiresAt (ISO) }. Does not log; see issueW3aToken.
 */
async function mintW3aJwt({ subject, cfg = readNativeAuthConfig(), now = Date.now(), jti = crypto.randomUUID() } = {}) {
  if (!cfg.enabled) throw nativeError('native login is disabled');
  if (typeof subject !== 'string' || !subject || subject.length > 128) throw nativeError('a w3aSubject is required');
  if (!cfg.issuer || !cfg.audience) throw nativeError('DDC_AUTH_ISSUER / DDC_AUTH_AUDIENCE are not configured');
  // KMS: the public key must be loaded before kid is known (fetched at start; this re-tries after
  // a failure). Any KMS failure rejects the mint: there is no fallback key.
  if (cfg.signer === 'kms') await ensureSignerReady(cfg);
  const signer = activeSigner(cfg);
  const iat = Math.floor(now / 1000) - IAT_BACKDATE_SEC;
  const exp = iat + cfg.jwtTtlSec;
  const header = { alg: 'RS256', typ: 'JWT', kid: signer.kid };
  const payload = { iss: cfg.issuer, aud: cfg.audience, sub: subject, user_id: subject, iat, exp, jti };
  const idToken = await signer.sign(header, payload);
  return { idToken, jti, kid: signer.kid, iat, exp, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * mintW3aJwt + the `native_auth.w3a_jwt_issued` log line. `count` is the attempt's token count
 * after this mint (the caller increments AuthLoginAttempt.w3aTokenCount in the same step).
 */
async function issueW3aToken({ subject, loginRef, count, cfg = readNativeAuthConfig(), now } = {}) {
  const minted = await mintW3aJwt({ subject, cfg, now });
  const signer = getSigner(cfg);
  // With KMS, kmsSignCount (successful AsymmetricSign calls by this process) sits next to every
  // issued token so the KMS-side Sign count can be reconciled with the tokens we issued (F1).
  const kms = signer.kind === 'kms' ? { signer: 'kms', kmsSignCount: signer.signCount() } : {};
  logger.info('native_auth.w3a_jwt_issued', { loginRef, kid: minted.kid, jti: minted.jti, exp: minted.exp, count, ...kms });
  return minted;
}

function publicMembers(jwk, kid) {
  return { kty: 'RSA', n: jwk.n, e: jwk.e, kid, alg: 'RS256', use: 'sig' };
}

/**
 * The published key set: active key + extra keys, each pinned and not leaked, deduplicated by
 * thumbprint. Throws when a configured key cannot be used (the route then falls through).
 * Returns null when no key is configured at all.
 */
function buildPublicJwks(cfg = readNativeAuthConfig()) {
  const hasActive = cfg.signer === 'file' ? Boolean(cfg.signingKeyFile) : cfg.signer === 'kms' && Boolean(cfg.kms.keyId);
  if (!hasActive && !cfg.jwksExtraFile) return null;
  if (cfg.env === 'prod' && cfg.jwksExtraFile) throw nativeError('DDC_AUTH_JWKS_EXTRA_FILE is refused in production');
  const keys = [];
  const seen = new Set();
  if (hasActive) {
    // The file signer is legal only for local/test; with the master switch off DDC_AUTH_ENV may be
    // unset, so a file key is published only when the environment says local|test.
    if (cfg.signer === 'file' && !isRelaxedEnv(cfg)) throw nativeError('the file signer is published only with DDC_AUTH_ENV=local|test');
    const signer = activeSigner(cfg);
    keys.push(publicMembers(signer.publicJwk(), signer.kid));
    seen.add(signer.kid);
    // KMS rotation keys (next / previous key versions): published, never used to sign.
    if (signer.kind === 'kms') {
      for (const extra of signer.extraPublicKeys()) {
        const problem = keyProblem(extra.jwk, extra.thumbprint, cfg, `DDC_AUTH_KMS_EXTRA_KEYS key ${extra.keyId}/${extra.keyVersionId}`);
        if (problem) throw nativeError(`native issuer refused: ${problem}`);
        if (seen.has(extra.thumbprint)) continue;
        seen.add(extra.thumbprint);
        keys.push(publicMembers(extra.jwk, extra.thumbprint));
      }
    }
  }
  const extra = readExtraJwks(cfg);
  if (extra.problems.length) throw nativeError(`DDC_AUTH_JWKS_EXTRA_FILE refused: ${extra.problems.join('; ')}`);
  for (const { jwk, thumbprint } of extra.keys) {
    if (seen.has(thumbprint)) continue;
    seen.add(thumbprint);
    keys.push(publicMembers(jwk, thumbprint));
  }
  return { keys };
}

let lastJwksProblem = '';

// The published set (or the refusal) is cached per configuration for JWKS_RECHECK_MS, so a public,
// unauthenticated path does not stat/read/parse the key files on every request (the signer itself
// is cached on success only). The window is short so a rotated DDC_AUTH_JWKS_EXTRA_FILE is picked
// up well within the published max-age.
const JWKS_RECHECK_MS = 60 * 1000;
let jwksCache = null;

function jwksCacheKey(cfg) {
  const { kms } = cfg;
  return [cfg.enabled, cfg.env, cfg.signer, cfg.signingKeyFile, kms.keyId, kms.keyVersionId, kms.region, kms.endpoint, kms.extraKeys.join(','), cfg.jwksExtraFile, cfg.jwksPinned.join(',')].join('\u0000');
}

/** buildPublicJwks through the cache: { jwks } or { problem }. */
function cachedPublicJwks(cfg, now = Date.now()) {
  const key = jwksCacheKey(cfg);
  if (jwksCache && jwksCache.key === key && now - jwksCache.at < JWKS_RECHECK_MS) return jwksCache.result;
  let result;
  try {
    result = { jwks: buildPublicJwks(cfg) };
  } catch (err) {
    result = { problem: err.publicMessage || err.message };
  }
  // A KMS key that is not loaded yet is not cached as a refusal: the signer itself throttles the
  // reload, and the set must appear as soon as the key is in.
  if (result.problem && cfg.signer === 'kms' && !readyKid(cfg)) return result;
  jwksCache = { key, at: now, result };
  return result;
}

/** Tests only: forget the cached key set. */
function resetJwksCache() {
  jwksCache = null;
  lastJwksProblem = '';
}

/**
 * Express handler for GET /.well-known/ddc-auth/jwks.json. No key configured, or a configured key
 * refused → next() (the refusal is logged once per distinct reason, without key material).
 * With the KMS signer the public key is normally fetched at start; if it is not loaded yet (native
 * login off, or the fetch failed) the first request loads it, and a failure is remembered by the
 * signer for 30 s so this public path cannot drive a KMS call per request.
 */
async function jwksHandler(req, res, next) {
  try {
    const cfg = readNativeAuthConfig();
    if (cfg.signer === 'kms' && cfg.kms.keyId) {
      try {
        await ensureSignerReady(cfg);
      } catch {
        // Falls through below: buildPublicJwks reports the load failure and the route answers next().
      }
    }
    const { jwks, problem } = cachedPublicJwks(cfg);
    if (problem) {
      if (problem !== lastJwksProblem) {
        lastJwksProblem = problem;
        logger.error('native_auth.jwks_refused', { problem });
      }
      return next();
    }
    if (!jwks || !jwks.keys.length) return next();
    res.set('Cache-Control', JWKS_CACHE_CONTROL);
    return res.status(200).json(jwks);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  JWKS_CACHE_CONTROL,
  IAT_BACKDATE_SEC,
  mintW3aJwt,
  issueW3aToken,
  JWKS_RECHECK_MS,
  buildPublicJwks,
  cachedPublicJwks,
  resetJwksCache,
  jwksHandler,
};
