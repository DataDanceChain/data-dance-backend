/**
 * Signer selection (DDC_AUTH_SIGNER). One signer per process, created on first use and cached
 * by its configuration, so a key file is read once (a KMS public key fetched once) and a changed
 * variable (tests) takes effect. The file signer is refused outside DDC_AUTH_ENV=local|test here
 * as well as at boot.
 *
 * The KMS signer's public key arrives asynchronously, so its kid / publicJwk() can be read only
 * after ready(). prepareSigner() is the boot step (src/server.js, before listen): fetch, check
 * pinned / not leaked, one real sign + verify. ensureSignerReady() is what request paths await.
 */
const { createFileSigner } = require('./fileSigner');
const { createKmsSigner } = require('./kmsSigner');
const { readNativeAuthConfig, isRelaxedEnv, parseKmsKeyRef, keyProblem, kmsCredentialsProblem, KMS_CREDENTIAL_MODES } = require('../config');

let cached = null;

function signerCacheKey(cfg) {
  const kms = cfg.kms || {};
  return [cfg.signer, cfg.env, cfg.signingKeyFile, kms.keyId, kms.keyVersionId, kms.region, kms.endpoint, kms.caFile, kms.timeoutMs, kms.credentials, kms.accessKeyInEnv, (kms.extraKeys || []).join(',')].join('\u0000');
}

function createSigner(cfg, { kmsClient } = {}) {
  if (cfg.signer === 'file') {
    if (!isRelaxedEnv(cfg)) throw new Error('DDC_AUTH_SIGNER=file is legal only with DDC_AUTH_ENV=local|test');
    if (!cfg.signingKeyFile) throw new Error('DDC_AUTH_SIGNING_KEY_FILE is not configured');
    return createFileSigner({ keyFile: cfg.signingKeyFile });
  }
  if (cfg.signer === 'kms') {
    const { kms } = cfg;
    // The credentials mode is enforced here too (not only at boot) because the public JWKS route
    // can create the signer with native login off, when the boot rules do not run. A missing
    // access key is left to the first KMS call, which fails closed with a clear message.
    if (!KMS_CREDENTIAL_MODES.includes(kms.credentials) || (kms.credentials === 'chain' && cfg.env !== 'prod')) {
      const problem = kmsCredentialsProblem(cfg);
      throw Object.assign(new Error(problem), { publicMessage: problem });
    }
    const extraKeys = kms.extraKeys.map(parseKmsKeyRef);
    if (extraKeys.some((ref) => !ref)) throw new Error('DDC_AUTH_KMS_EXTRA_KEYS entries must be <keyId>/<keyVersionId>');
    return createKmsSigner({
      keyId: kms.keyId,
      keyVersionId: kms.keyVersionId,
      region: kms.region,
      endpoint: kms.endpoint,
      caFile: kms.caFile,
      timeoutMs: kms.timeoutMs,
      credentials: kms.credentials,
      extraKeys,
      client: kmsClient || null,
    });
  }
  throw new Error(`unknown DDC_AUTH_SIGNER "${cfg.signer}"`);
}

/** The active signer for `cfg` (default: the current environment). */
function getSigner(cfg = readNativeAuthConfig(), options) {
  const key = signerCacheKey(cfg);
  if (cached && cached.key === key) return cached.signer;
  const signer = createSigner(cfg, options);
  cached = { key, signer };
  return signer;
}

/** Resolves once the active signer can sign and publish (KMS: public key fetched); rejects otherwise. */
async function ensureSignerReady(cfg = readNativeAuthConfig()) {
  const signer = getSigner(cfg);
  if (typeof signer.ready === 'function') await signer.ready();
  return signer;
}

/** The kid of the cached signer for `cfg` when it is already known without I/O, else ''. */
function readyKid(cfg = readNativeAuthConfig()) {
  if (!cached || cached.key !== signerCacheKey(cfg)) return '';
  const { signer } = cached;
  if (typeof signer.isReady === 'function' && !signer.isReady()) return '';
  return signer.kid;
}

/**
 * Boot step for the KMS signer (no-op summary for the file signer, which boot already checked):
 * fetch the public key(s), refuse a key that is leaked or not in DDC_AUTH_JWKS_PINNED, then sign
 * one throwaway token through KMS and verify it locally. Throws an Error with a secret-free
 * message; returns { kid, extraKids, keyId, keyVersionId, region, endpoint, credentials }.
 */
async function prepareSigner(cfg = readNativeAuthConfig(), options) {
  const signer = getSigner(cfg, options);
  if (signer.kind !== 'kms') return { kid: signer.kid, extraKids: [] };
  await signer.ready();
  const problems = [];
  const active = keyProblem(signer.publicJwk(), signer.kid, cfg, 'The KMS signing key');
  if (active) problems.push(active);
  for (const extra of signer.extraPublicKeys()) {
    const problem = keyProblem(extra.jwk, extra.thumbprint, cfg, `DDC_AUTH_KMS_EXTRA_KEYS key ${extra.keyId}/${extra.keyVersionId}`);
    if (problem) problems.push(problem);
  }
  if (problems.length) throw new Error(problems.join('; '));
  await signer.selfTest();
  return { kid: signer.kid, extraKids: signer.extraPublicKeys().map((k) => k.thumbprint), ...signer.describe() };
}

/** Tests only: forget the cached signer. */
function resetSignerCache() {
  cached = null;
}

module.exports = { createSigner, getSigner, ensureSignerReady, readyKid, prepareSigner, resetSignerCache };
