#!/usr/bin/env node
/**
 * Generates a native-login issuer signing key for a NON-production environment (design §5 item 4).
 *
 *   node scripts/nativeAuthKeygen.js --env=devnet --out-dir=<dir outside every repo>
 *   node scripts/nativeAuthKeygen.js --env=devnet --out-dir=<dir> --name=devnet-signing-key-2 --rotate
 *
 * Writes, and prints nothing secret:
 *   <out-dir>/<name>.jwk.json   private JWK (RSA-2048, kid = RFC 7638 thumbprint, alg RS256, use sig),
 *                               created with O_EXCL and mode 0400 in a 0700 directory. This is what
 *                               DDC_AUTH_SIGNING_KEY_FILE points at. Never commit, copy or print it.
 *   <out-dir>/<env>-jwks.json   public JWKS (kty, n, e, kid, alg, use only), checked by
 *                               nativeAuthJwksCheck before it is written. This is the file to publish.
 * `--rotate` appends the new public key to an existing <env>-jwks.json instead (publish the next key
 * at least 24 h before switching, design §3.2); without it the JWKS file must not exist yet.
 *
 * Refuses: env other than devnet|test (production keys live in KMS), an out-dir inside any git work
 * tree or a cloud-synced folder, an existing private key file. Prints the kid/thumbprint and the two
 * environment lines for the local backend.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { checkJwks, publicJwk, rfc7638Thumbprint } = require('./nativeAuthJwksCheck');

const ALLOWED_ENVS = Object.freeze(['devnet', 'test']);
const MODULUS_BITS = 2048;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLOUD_SYNC_MARKERS = ['/Library/CloudStorage/', '/Library/Mobile Documents/'];

/** Nearest existing ancestor of `p` (p itself when it exists), resolved through symlinks. */
function nearestExistingRealpath(p) {
  let current = path.resolve(p);
  for (;;) {
    try {
      return fs.realpathSync(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** Top of the git work tree containing `p` (a `.git` dir or file in an ancestor), else null. */
function insideGitWorkTree(p) {
  let current = nearestExistingRealpath(p);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function insideCloudSync(p) {
  const real = `${nearestExistingRealpath(p)}/`;
  const resolved = `${path.resolve(p)}/`;
  return CLOUD_SYNC_MARKERS.some((marker) => real.includes(marker) || resolved.includes(marker));
}

/** Refuses a location for private key material; returns a reason string or null. */
function unsafeKeyLocation(dir) {
  const repo = insideGitWorkTree(dir);
  if (repo) return `is inside the git work tree ${repo}`;
  if (insideCloudSync(dir)) return 'is inside a cloud-synced folder';
  return null;
}

function generateKeyPair() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: MODULUS_BITS, publicExponent: 0x10001 });
  const raw = privateKey.export({ format: 'jwk' });
  const pub = publicJwk(raw);
  const privateJwk = {
    kid: pub.kid,
    alg: 'RS256',
    use: 'sig',
    kty: raw.kty,
    n: raw.n,
    e: raw.e,
    d: raw.d,
    p: raw.p,
    q: raw.q,
    dp: raw.dp,
    dq: raw.dq,
    qi: raw.qi,
  };
  return { privateJwk, publicJwk: pub };
}

/** Round-trips a private JWK file: same thumbprint and a signature its public half verifies. */
function selfTest(privatePath, expectedPublic) {
  const stored = JSON.parse(fs.readFileSync(privatePath, 'utf8'));
  if (rfc7638Thumbprint(stored) !== expectedPublic.kid || stored.kid !== expectedPublic.kid) {
    throw new Error('self-test failed: stored key thumbprint does not match');
  }
  const message = Buffer.from('ddc-native-auth-keygen-self-test');
  const signature = crypto.sign('sha256', message, crypto.createPrivateKey({ key: stored, format: 'jwk' }));
  const ok = crypto.verify('sha256', message, crypto.createPublicKey({ key: expectedPublic, format: 'jwk' }), signature);
  if (!ok) throw new Error('self-test failed: signature does not verify with the public JWK');
}

function writePrivateFile(file, jwk) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o400);
  try {
    fs.fchmodSync(fd, 0o400);
    fs.writeSync(fd, `${JSON.stringify(jwk, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writePublicFileAtomic(file, doc) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
  try {
    fs.fchmodSync(fd, 0o644);
    fs.writeSync(fd, `${JSON.stringify(doc, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory()) throw new Error('out-dir is not a directory');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('out-dir is owned by another user');
  if ((stat.mode & 0o777) !== 0o700) fs.chmodSync(dir, 0o700);
}

/**
 * Generates and writes one key. Returns { kid, privatePath, jwksPath, pinned } — no key material.
 */
function generate({ env, outDir, name, rotate = false }) {
  if (!ALLOWED_ENVS.includes(env)) {
    throw new Error(`--env must be one of ${ALLOWED_ENVS.join('|')}; production keys live in KMS (design §3.2)`);
  }
  if (!outDir) throw new Error('--out-dir is required');
  const baseName = name || `${env}-signing-key`;
  if (!NAME_RE.test(baseName)) throw new Error('--name may use letters, digits, dot, dash and underscore only');
  const dir = path.resolve(outDir);
  const reason = unsafeKeyLocation(dir);
  if (reason) throw new Error(`refusing to write a private key: out-dir ${reason}`);

  const privatePath = path.join(dir, `${baseName}.jwk.json`);
  const jwksPath = path.join(dir, `${env}-jwks.json`);
  if (fs.existsSync(privatePath)) throw new Error(`refusing to overwrite existing private key file ${privatePath}`);

  let existingKeys = [];
  if (rotate) {
    if (!fs.existsSync(jwksPath)) throw new Error(`--rotate needs an existing ${path.basename(jwksPath)}`);
    const existing = JSON.parse(fs.readFileSync(jwksPath, 'utf8'));
    existingKeys = Array.isArray(existing.keys) ? existing.keys : [];
  } else if (fs.existsSync(jwksPath)) {
    throw new Error(`${path.basename(jwksPath)} already exists; pass --rotate to add a next key to it`);
  }

  const pair = generateKeyPair();
  const jwks = { keys: [...existingKeys, pair.publicJwk] };
  const pinned = jwks.keys.map((key) => key.kid);
  const check = checkJwks(jwks, { pinned, exact: true });
  if (!check.ok) throw new Error(`generated JWKS fails the publish check: ${check.errors.join('; ')}`);

  ensurePrivateDir(dir);
  writePrivateFile(privatePath, pair.privateJwk);
  pair.privateJwk = null;
  selfTest(privatePath, pair.publicJwk);
  writePublicFileAtomic(jwksPath, jwks);
  return { kid: pair.publicJwk.kid, privatePath, jwksPath, pinned };
}

function parseArgs(argv) {
  const args = { rotate: false };
  for (const arg of argv) {
    if (arg === '--rotate') args.rotate = true;
    else if (arg.startsWith('--env=')) args.env = arg.slice('--env='.length);
    else if (arg.startsWith('--out-dir=')) args.outDir = arg.slice('--out-dir='.length);
    else if (arg.startsWith('--name=')) args.name = arg.slice('--name='.length);
    else throw new Error(`unknown argument ${arg}`);
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  let result;
  try {
    const args = parseArgs(argv);
    result = generate(args);
  } catch (err) {
    process.stderr.write(`nativeAuthKeygen: ${err.message}\n`);
    return 1;
  }
  process.stdout.write(
    [
      'Generated a native-auth issuer key (RSA-2048, RS256). No key material is printed.',
      `kid (RFC 7638 SHA-256 thumbprint): ${result.kid}`,
      `private JWK: ${result.privatePath} (mode 0400; never commit, copy or print it)`,
      `public JWKS: ${result.jwksPath} (the only file to publish)`,
      '',
      '# Local backend environment:',
      `DDC_AUTH_SIGNING_KEY_FILE=${result.privatePath}`,
      `DDC_AUTH_JWKS_PINNED=${result.pinned.join(',')}`,
      '',
    ].join('\n'),
  );
  return 0;
}

module.exports = {
  ALLOWED_ENVS,
  insideGitWorkTree,
  insideCloudSync,
  unsafeKeyLocation,
  generate,
  main,
};

if (require.main === module) {
  process.exitCode = main();
}
