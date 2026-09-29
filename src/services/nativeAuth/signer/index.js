/**
 * Signer selection (DDC_AUTH_SIGNER). One signer per process, created on first use and cached
 * by its configuration, so a key file is read once and a changed variable (tests) takes effect.
 * The file signer is refused outside DDC_AUTH_ENV=local|test here as well as at boot.
 */
const { createFileSigner } = require('./fileSigner');
const { createKmsSigner } = require('./kmsSigner');
const { readNativeAuthConfig, isRelaxedEnv } = require('../config');

let cached = null;

function signerCacheKey(cfg) {
  return [cfg.signer, cfg.env, cfg.signingKeyFile, cfg.kmsKeyId].join('\u0000');
}

function createSigner(cfg) {
  if (cfg.signer === 'file') {
    if (!isRelaxedEnv(cfg)) throw new Error('DDC_AUTH_SIGNER=file is legal only with DDC_AUTH_ENV=local|test');
    if (!cfg.signingKeyFile) throw new Error('DDC_AUTH_SIGNING_KEY_FILE is not configured');
    return createFileSigner({ keyFile: cfg.signingKeyFile });
  }
  if (cfg.signer === 'kms') return createKmsSigner({ kmsKeyId: cfg.kmsKeyId });
  throw new Error(`unknown DDC_AUTH_SIGNER "${cfg.signer}"`);
}

/** The active signer for `cfg` (default: the current environment). */
function getSigner(cfg = readNativeAuthConfig()) {
  const key = signerCacheKey(cfg);
  if (cached && cached.key === key) return cached.signer;
  const signer = createSigner(cfg);
  cached = { key, signer };
  return signer;
}

/** Tests only: forget the cached signer. */
function resetSignerCache() {
  cached = null;
}

module.exports = { createSigner, getSigner, resetSignerCache };
