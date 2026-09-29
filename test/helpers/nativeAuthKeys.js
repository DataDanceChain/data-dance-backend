/**
 * Throwaway issuer keys for the native-login tests. Keys are generated per process into a fresh
 * directory under the OS temp dir (never inside a git work tree, never printed) and removed on
 * exit. Only public members and thumbprints ever reach an assertion message.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-native-keys-'));
process.on('exit', () => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

function thumbprint(jwk) {
  return crypto.createHash('sha256').update(JSON.stringify({ e: jwk.e, kty: 'RSA', n: jwk.n })).digest('base64url');
}

let counter = 0;

/**
 * Writes a private RSA JWK and returns { file, thumbprint, publicJwk }.
 * Options: bits (2048), mode (0o400), alg ('RS256'; null to omit), kid, extra (merged into the JWK).
 */
function makeKeyFile({ bits = 2048, mode = 0o400, alg = 'RS256', kid, extra = {}, inDir = dir } = {}) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = privateKey.export({ format: 'jwk' });
  if (alg) jwk.alg = alg;
  if (kid) jwk.kid = kid;
  Object.assign(jwk, extra);
  const file = path.join(inDir, `key-${process.pid}-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify(jwk), { mode: 0o600 });
  fs.chmodSync(file, mode);
  return { file, thumbprint: thumbprint(jwk), publicJwk: { kty: 'RSA', n: jwk.n, e: jwk.e } };
}

/** A public JWKS file (for DDC_AUTH_JWKS_EXTRA_FILE). */
function makeJwksFile(keys) {
  const file = path.join(dir, `jwks-${process.pid}-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify({ keys }));
  return file;
}

/** A directory that looks like a git work tree (has a .git entry). */
function makeFakeWorkTree() {
  const root = fs.mkdtempSync(path.join(dir, 'repo-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'secrets'));
  return path.join(root, 'secrets');
}

const STATE_SECRET = crypto.randomBytes(32).toString('base64url');

/** A complete, valid local configuration for `key`, as an env object. */
function localEnv(key, overrides = {}) {
  return {
    DDC_AUTH_ENABLED: 'true',
    DDC_AUTH_ENV: 'local',
    DDC_AUTH_METHODS: '',
    DDC_AUTH_ISSUER: 'ddc-auth-devnet',
    DDC_AUTH_AUDIENCE: 'ddc-w3a-devnet',
    DDC_AUTH_W3A_CLIENT_ID: 'BNativeDevnetClientId',
    DDC_AUTH_W3A_CONNECTION_ID: 'ddc-jwt-devnet',
    DDC_AUTH_SIGNER: 'file',
    DDC_AUTH_SIGNING_KEY_FILE: key.file,
    DDC_AUTH_JWKS_PINNED: key.thumbprint,
    DDC_AUTH_STATE_SECRET: STATE_SECRET,
    DDC_AUTH_PROOF_DOMAIN: 'localhost:20444',
    DDC_AUTH_PROOF_URI: 'https://localhost:20444',
    JWT_SECRET: 'user-session-secret',
    SSO_SESSION_SECRET: 'sso-session-secret',
    ...overrides,
  };
}

module.exports = { keyDir: dir, thumbprint, makeKeyFile, makeJwksFile, makeFakeWorkTree, localEnv, STATE_SECRET };
