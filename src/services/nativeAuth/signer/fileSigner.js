/**
 * File signer: the DDC issuer key as a private RSA JWK in a file. Legal only with
 * DDC_AUTH_ENV=local|test (boot rule 5 requires `kms` in production); the devnet key is generated
 * by scripts/nativeAuthKeygen.js on the Mac that runs the local stack.
 *
 * The file must live outside every git work tree, be readable by its owner only (0400 or 0600),
 * hold an RSA key of at least 2048 bits, and name alg RS256 (scripts/nativeAuthKeygen.js writes it). The published kid
 * is the key's RFC 7638 thumbprint; a `kid` inside the file is ignored, except that the leaked
 * `auth-key-1` is refused by config.keyProblem at boot and by the JWKS route.
 *
 * Nothing here ever prints, logs or returns private key material: every failure is reported
 * with a fixed `publicMessage` (JSON.parse and crypto messages can quote the file's contents, so
 * they are dropped).
 */
const crypto = require('crypto');
const fs = require('fs');
const { rsaThumbprint, enclosingGitWorkTree, leakedKeys } = require('../config');

const MIN_MODULUS_BITS = 2048;

function keyError(publicMessage) {
  const err = new Error(publicMessage);
  err.publicMessage = publicMessage;
  return err;
}

/**
 * Loads and checks the key. Returns { privateKey (KeyObject), publicJwk {kty,n,e}, thumbprint,
 * fileKid }. Throws an Error with `publicMessage` only.
 */
function loadSigningKey(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw keyError('the file does not exist or cannot be read');
  }
  if (!stat.isFile()) throw keyError('the path is not a regular file');
  const workTree = enclosingGitWorkTree(file);
  if (workTree) throw keyError(`the key file is inside a git work tree (${workTree}); keep it outside every repository`);
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw keyError(`the key file must be readable by its owner only (chmod 0400); mode is ${(stat.mode & 0o777).toString(8)}`);
  }
  let jwk;
  try {
    jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw keyError('the file is not a JSON Web Key');
  }
  if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) throw keyError('the file is not a JSON Web Key');
  if (jwk.kty !== 'RSA') throw keyError('the key must be an RSA key (RS256)');
  if (jwk.alg !== 'RS256') throw keyError('the key alg must be RS256 (the file must name it: "alg": "RS256")');
  if (typeof jwk.d !== 'string') throw keyError('the file holds no private key');
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  } catch {
    throw keyError('the private key cannot be loaded');
  }
  const bits = privateKey.asymmetricKeyDetails && privateKey.asymmetricKeyDetails.modulusLength;
  if (!bits || bits < MIN_MODULUS_BITS) throw keyError(`the RSA modulus must be at least ${MIN_MODULUS_BITS} bits`);
  if (leakedKeys().kids.has(String(jwk.kid))) {
    throw keyError('the key is the committed, publicly leaked key auth-key-1 (keys/jwks.json); generate a new key with scripts/nativeAuthKeygen.js');
  }
  const publicJwk = { kty: 'RSA', n: jwk.n, e: jwk.e };
  // The public members in the file must belong to the private key (a swapped n would publish a
  // key that verifies nothing and pin the wrong thumbprint). Node does not check a JWK's
  // consistency on import, so prove it with a sign / verify round trip.
  let consistent = false;
  try {
    const probe = crypto.randomBytes(32);
    const signature = crypto.sign('sha256', probe, privateKey);
    consistent = crypto.verify('sha256', probe, crypto.createPublicKey({ key: publicJwk, format: 'jwk' }), signature);
  } catch {
    consistent = false;
  }
  if (!consistent) throw keyError('the public members do not match the private key');
  return { privateKey, publicJwk, thumbprint: rsaThumbprint(publicJwk), fileKid: typeof jwk.kid === 'string' ? jwk.kid : null };
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * The signer interface (shared with signer/kmsSigner.js):
 *   kind        'file' | 'kms'
 *   kid         RFC 7638 thumbprint of the public key
 *   publicJwk() { kty, n, e } — public members only
 *   sign(header, payload) → Promise<compact JWS>; header.alg must be RS256 and header.kid, when
 *               present, must be this signer's kid.
 */
function createFileSigner({ keyFile }) {
  const { privateKey, publicJwk, thumbprint } = loadSigningKey(keyFile);
  return Object.freeze({
    kind: 'file',
    kid: thumbprint,
    publicJwk: () => ({ ...publicJwk }),
    async sign(header, payload) {
      if (!header || header.alg !== 'RS256') throw new Error('fileSigner signs RS256 only');
      if (header.kid !== undefined && header.kid !== thumbprint) throw new Error('fileSigner: header kid does not name this key');
      const signingInput = `${b64urlJson({ ...header, kid: thumbprint })}.${b64urlJson(payload)}`;
      const signature = crypto.sign('sha256', Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
      return `${signingInput}.${signature}`;
    },
  });
}

module.exports = { loadSigningKey, createFileSigner, MIN_MODULUS_BITS };
