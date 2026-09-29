#!/usr/bin/env node
/**
 * Devnet spike S1 (design §7.1): does a DDC-signed JWT derive a wallet on Web3Auth sapphire_devnet,
 * and is that wallet the one the server-side lookup predicts?
 *
 *   node scripts/nativeAuthSpike.js --key=<private JWK file>                 # dry run (default)
 *   node scripts/nativeAuthSpike.js --key=<file> --sample-jwt                # token for the dashboard (O3)
 *   node scripts/nativeAuthSpike.js --key=<file> --live --client-id=<id> [--second-user] [--negatives]
 *                                   [--deps-dir=<dir with node_modules>]
 *
 * Every mode mints a token exactly as design §2.4 specifies — header {alg RS256, typ JWT, kid =
 * RFC 7638 thumbprint}, payload {iss, aud, sub, user_id = sub, iat = now-2, exp = iat+60, jti}, no nbf
 * and no PII — and verifies it locally against the key's public half (and against the JWKS file
 * next to the key, which must pass nativeAuthJwksCheck).
 *
 * Dry run (no network, no extra dependencies): prints the decoded token and the lookup the live run
 * would make. `--sample-jwt` prints one token for the throwaway subject
 * 00000000-0000-4000-8000-000000000000 (the only subject it will mint a printable token for).
 * `--sub` takes only that subject or "random": the spike never mints for, derives or prints a real
 * user's subject (design §6 F11).
 *
 * Live run (needs owner steps O1 = the "DataDance Native Devnet" client id and O3 = the connection
 * ddc-jwt-devnet reading the published JWKS):
 *   A0  torus getPublicAddress(connection, sub)                — what /complete will check
 *   A1  torus retrieveShares(connection, sub, idToken)         — the exact call SFA 9.5.0 connect()
 *       makes (node details from fnd-base fetchLocalConfig, useDkg, checkCommitment false); the key
 *       is finalKeyData.privKey || oAuthKeyData.privKey as with usePnPKey:false. Only the address
 *       derived from it is kept; the key itself is never printed or stored.
 *   pass: A0 = A1; with --second-user a second random subject gives a different address; with
 *   --negatives the nodes refuse: a replayed token, iat 70 s old, a wrong aud, an unknown kid, and
 *   verifierId != sub.
 * Live mode refuses sapphire_mainnet. It needs @toruslabs/torus.js 15.x, @toruslabs/fnd-base 14.x and
 * @toruslabs/constants 14.x (the versions SFA 9.5.0 resolves); they are resolved from the repo, or from
 * --deps-dir (a scratch directory where they were installed with npm, outside the repo).
 *
 * Environment fallbacks: DDC_AUTH_SIGNING_KEY_FILE, DDC_AUTH_ISSUER, DDC_AUTH_AUDIENCE,
 * DDC_AUTH_W3A_NETWORK, DDC_AUTH_W3A_CLIENT_ID, DDC_AUTH_W3A_CONNECTION_ID.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const { checkJwksText, publicJwk, rfc7638Thumbprint } = require('./nativeAuthJwksCheck');
const { unsafeKeyLocation } = require('./nativeAuthKeygen');

const DEVNET_DEFAULTS = Object.freeze({
  network: 'sapphire_devnet',
  connection: 'ddc-jwt-devnet',
  iss: 'ddc-auth-devnet',
  aud: 'ddc-w3a-devnet',
});
const THROWAWAY_SUB = '00000000-0000-4000-8000-000000000000';
const JWT_TTL_SEC = 60;
const IAT_SKEW_SEC = 2;
const STALE_IAT_SEC = 70;
const NETWORK_TIMEOUT_MS = 20_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JWT_SHAPED_RE = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
// Any long hex run (a 32-byte key is 64 digits; nodes may add or drop leading zeros or a 0x).
const LONG_HEX_RE = /(0x)?[0-9a-fA-F]{60,}/g;

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/**
 * Mints a DDC JWT per design §2.4. `overrides` exist only for the spike's negative cases.
 * Returns { token, header, payload }.
 */
function mintJwt({ privateKey, kid, iss, aud, sub, nowSec = Math.floor(Date.now() / 1000), overrides = {} }) {
  const iat = (overrides.iat !== undefined ? overrides.iat : nowSec - IAT_SKEW_SEC);
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const payload = {
    iss,
    aud: overrides.aud !== undefined ? overrides.aud : aud,
    sub,
    user_id: sub,
    iat,
    exp: iat + JWT_TTL_SEC,
    jti: crypto.randomUUID(),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  return { token: `${signingInput}.${signature}`, header, payload };
}

/** Verifies an RS256 compact JWS against a public JWK; returns the decoded { header, payload }. */
function verifyJwt(token, publicKeyJwk) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('token is not a compact JWS');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error('alg is not RS256');
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: publicKeyJwk, format: 'jwk' }),
    Buffer.from(parts[2], 'base64url'),
  );
  if (!ok) throw new Error('signature does not verify');
  return { header, payload };
}

/** Checks a minted token's shape against design §2.4; returns a list of problems (empty = ok). */
function claimProblems({ header, payload }, { kid, iss, aud, nowSec }) {
  const problems = [];
  const expectKeys = ['iss', 'aud', 'sub', 'user_id', 'iat', 'exp', 'jti'];
  if (JSON.stringify(Object.keys(header)) !== JSON.stringify(['alg', 'typ', 'kid'])) problems.push('header members');
  if (header.typ !== 'JWT' || header.kid !== kid) problems.push('header typ/kid');
  if (JSON.stringify(Object.keys(payload)) !== JSON.stringify(expectKeys)) problems.push('payload members');
  if (payload.iss !== iss || payload.aud !== aud) problems.push('iss/aud');
  if (payload.sub !== payload.user_id || !UUID_RE.test(payload.sub)) problems.push('sub/user_id');
  if (payload.exp - payload.iat !== JWT_TTL_SEC) problems.push('exp - iat');
  if (Math.abs(nowSec - IAT_SKEW_SEC - payload.iat) > 1) problems.push('iat');
  if (!UUID_RE.test(payload.jti)) problems.push('jti');
  return problems;
}

/** Removes anything token- or key-shaped from an error message before it is printed. */
function sanitize(message) {
  return String(message || '')
    .replace(JWT_SHAPED_RE, '<jwt>')
    .replace(LONG_HEX_RE, '<hex>')
    .slice(0, 300);
}

/** Loads the private JWK file after checking where it lives and who can read it. */
function loadSigningKey(file) {
  if (!file) throw new Error('--key (or DDC_AUTH_SIGNING_KEY_FILE) is required');
  const resolved = path.resolve(file);
  const reason = unsafeKeyLocation(path.dirname(resolved));
  if (reason) throw new Error(`refusing a signing key that ${reason}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error('signing key path is not a file');
  if (stat.mode & 0o077) throw new Error('signing key file is readable by group or others (expected mode 0400)');
  const jwk = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  if (jwk.kty !== 'RSA' || typeof jwk.d !== 'string') throw new Error('signing key file is not a private RSA JWK');
  if (jwk.alg !== undefined && jwk.alg !== 'RS256') throw new Error('signing key alg is not RS256');
  const pub = publicJwk(jwk);
  if (jwk.kid !== undefined && jwk.kid !== pub.kid) throw new Error('signing key kid is not its RFC 7638 thumbprint');
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  return { privateKey, publicJwk: pub, kid: pub.kid, path: resolved };
}

/** The JWKS keygen wrote next to a key file: <env>-signing-key[-N].jwk.json -> <env>-jwks.json. */
function defaultJwksPath(keyPath) {
  const match = /^(.+?)-signing-key(?:[._-][A-Za-z0-9._-]*)?\.jwk\.json$/.exec(path.basename(keyPath));
  return path.join(path.dirname(keyPath), `${match ? match[1] : 'devnet'}-jwks.json`);
}

/**
 * Checks the JWKS next to the key (or --jwks): it must contain the key and pass the publish check
 * (raw-text rules included), pinned to DDC_AUTH_JWKS_PINNED when that is set, else to the keys the
 * file itself lists (then only the structural rules apply).
 */
function checkPublishedJwks(jwksPath, kid, env = process.env) {
  if (!jwksPath || !fs.existsSync(jwksPath)) return { checked: false };
  const text = fs.readFileSync(jwksPath, 'utf8');
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { checked: true, ok: false, errors: ['JWKS is not valid JSON'] };
  }
  const listed = [];
  for (const key of Array.isArray(doc.keys) ? doc.keys : []) {
    try {
      listed.push(rfc7638Thumbprint(key));
    } catch {
      // reported by checkJwks
    }
  }
  if (!listed.includes(kid)) return { checked: true, ok: false, errors: ['the signing key is not in this JWKS'] };
  const envPinned = (env.DDC_AUTH_JWKS_PINNED || '').split(',').map((item) => item.trim()).filter(Boolean);
  const result = checkJwksText(text, { pinned: envPinned.length ? envPinned : listed });
  return { checked: true, ok: result.ok, errors: result.errors };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Resolves torus.js, fnd-base and constants from the repo or from `depsDir`. */
function loadTorusDeps(depsDir) {
  const req = depsDir ? createRequire(path.join(path.resolve(depsDir), 'package.json')) : require;
  try {
    const torusModule = req('@toruslabs/torus.js');
    const fnd = req('@toruslabs/fnd-base');
    const constants = req('@toruslabs/constants');
    return {
      Torus: torusModule.Torus || torusModule.default,
      fetchLocalConfig: fnd.fetchLocalConfig,
      keyType: constants.KEY_TYPE.SECP256K1,
    };
  } catch {
    throw new Error(
      'live mode needs @toruslabs/torus.js@15, @toruslabs/fnd-base@14 and @toruslabs/constants@14 ' +
        '(not in package.json yet); install them in a scratch directory and pass --deps-dir=<that directory>',
    );
  }
}

/** Address of a secp256k1 key given as hex. Errors never carry the input (ethers echoes it). */
function addressFromPrivKeyHex(privHex) {
  const { computeAddress } = require('ethers');
  const hex = String(privHex).replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{1,64}$/.test(hex)) throw new Error('nodes returned a key that is not 32-byte hex');
  try {
    return computeAddress(`0x${hex.padStart(64, '0')}`);
  } catch {
    throw new Error('nodes returned a key that is not a valid secp256k1 scalar');
  }
}

function sameAddress(a, b) {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/**
 * Live run against the nodes. `deps` = { Torus, fetchLocalConfig, keyType } (injectable for tests).
 * Returns { steps:[{name, pass, detail}], pass }. Never returns or prints a private key.
 */
async function runLive({ signing, iss, aud, network, connection, clientId, sub, secondUser, negatives, deps, timeoutMs = NETWORK_TIMEOUT_MS }) {
  if (network !== 'sapphire_devnet') throw new Error('live mode runs only on sapphire_devnet (no laptop key on mainnet)');
  if (!clientId) throw new Error('live mode needs --client-id (owner step O1) or DDC_AUTH_W3A_CLIENT_ID');
  const nodeDetails = deps.fetchLocalConfig(network, deps.keyType);
  const torus = new deps.Torus({ clientId, enableOneKey: true, network });
  const steps = [];
  const record = (name, pass, detail) => steps.push({ name, pass, detail: sanitize(detail) });

  const lookup = (verifierId) =>
    withTimeout(
      torus.getPublicAddress(nodeDetails.torusNodeEndpoints, nodeDetails.torusNodePub, { verifier: connection, verifierId }),
      timeoutMs,
      'getPublicAddress',
    ).then((res) => res.finalKeyData.walletAddress);

  const derive = async (verifierId, idToken) => {
    const res = await withTimeout(
      torus.retrieveShares({
        endpoints: nodeDetails.torusNodeEndpoints,
        indexes: nodeDetails.torusIndexes,
        verifier: connection,
        verifierParams: { verifier_id: verifierId },
        idToken,
        nodePubkeys: nodeDetails.torusNodePub,
        checkCommitment: false,
        useDkg: true,
        extraParams: {},
      }),
      timeoutMs,
      'retrieveShares',
    );
    if (res.metadata && res.metadata.upgraded) throw new Error('account is MFA-upgraded (KEY_MFA_UNSUPPORTED)');
    const priv = (res.finalKeyData && res.finalKeyData.privKey) || (res.oAuthKeyData && res.oAuthKeyData.privKey);
    if (!priv) throw new Error('nodes returned no key');
    return addressFromPrivKeyHex(priv);
  };

  const mint = (subject, overrides, key = signing) =>
    mintJwt({ privateKey: key.privateKey, kid: key.kid, iss, aud, sub: subject, overrides }).token;

  let a0 = null;
  let a1 = null;
  let firstToken = null;
  try {
    a0 = await lookup(sub);
    record('A0 getPublicAddress', true, a0);
  } catch (err) {
    record('A0 getPublicAddress', false, err.message);
  }
  try {
    firstToken = mint(sub);
    a1 = await derive(sub, firstToken);
    record('A1 retrieveShares (SFA key)', true, a1);
  } catch (err) {
    record('A1 retrieveShares (SFA key)', false, err.message);
  }
  record('A0 = A1', Boolean(a0 && a1 && sameAddress(a0, a1)), a0 && a1 ? `${a0} vs ${a1}` : 'missing address');

  if (secondUser) {
    try {
      const other = await lookup(crypto.randomUUID());
      record('second user differs', Boolean(a0) && !sameAddress(other, a0), other);
    } catch (err) {
      record('second user differs', false, err.message);
    }
  }

  if (negatives) {
    const expectRefusal = async (name, run) => {
      try {
        await run();
        record(`refused: ${name}`, false, 'the nodes ACCEPTED this token');
      } catch (err) {
        record(`refused: ${name}`, true, err.message);
      }
    };
    const nowSec = Math.floor(Date.now() / 1000);
    if (firstToken) await expectRefusal('replayed token', () => derive(sub, firstToken));
    else record('refused: replayed token', false, 'not run: no first token');
    await expectRefusal(`iat ${STALE_IAT_SEC} s old`, async () => {
      const s = crypto.randomUUID();
      await derive(s, mint(s, { iat: nowSec - STALE_IAT_SEC }));
    });
    await expectRefusal('wrong aud', async () => {
      const s = crypto.randomUUID();
      await derive(s, mint(s, { aud: `${aud}-wrong` }));
    });
    await expectRefusal('unknown kid', async () => {
      const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
      const kid = rfc7638Thumbprint(privateKey.export({ format: 'jwk' }));
      const s = crypto.randomUUID();
      await derive(s, mint(s, {}, { privateKey, kid }));
    });
    await expectRefusal('verifierId != sub', async () => {
      await derive(crypto.randomUUID(), mint(crypto.randomUUID()));
    });
  }

  return { steps, pass: steps.every((step) => step.pass) };
}

function parseArgs(argv, env = process.env) {
  const args = {
    key: env.DDC_AUTH_SIGNING_KEY_FILE || '',
    jwks: '',
    iss: env.DDC_AUTH_ISSUER || DEVNET_DEFAULTS.iss,
    aud: env.DDC_AUTH_AUDIENCE || DEVNET_DEFAULTS.aud,
    network: env.DDC_AUTH_W3A_NETWORK || DEVNET_DEFAULTS.network,
    connection: env.DDC_AUTH_W3A_CONNECTION_ID || DEVNET_DEFAULTS.connection,
    clientId: env.DDC_AUTH_W3A_CLIENT_ID || '',
    sub: THROWAWAY_SUB,
    live: false,
    sampleJwt: false,
    secondUser: false,
    negatives: false,
    depsDir: '',
  };
  const valued = { '--key': 'key', '--jwks': 'jwks', '--iss': 'iss', '--aud': 'aud', '--network': 'network', '--connection': 'connection', '--client-id': 'clientId', '--sub': 'sub', '--deps-dir': 'depsDir' };
  const flags = { '--live': 'live', '--sample-jwt': 'sampleJwt', '--second-user': 'secondUser', '--negatives': 'negatives' };
  for (const arg of argv) {
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (flags[name] && eq === -1) args[flags[name]] = true;
    else if (valued[name] && eq !== -1) args[valued[name]] = arg.slice(eq + 1);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (args.sub === 'random') args.sub = crypto.randomUUID();
  else if (args.sub !== THROWAWAY_SUB) throw new Error(`--sub takes only the throwaway subject ${THROWAWAY_SUB} or "random"`);
  if (args.sampleJwt && args.sub !== THROWAWAY_SUB) throw new Error(`--sample-jwt only mints for the throwaway subject ${THROWAWAY_SUB}`);
  if (args.sampleJwt && args.live) throw new Error('--sample-jwt and --live are separate runs');
  return args;
}

async function main(argv = process.argv.slice(2), { out = process.stdout, err = process.stderr, depsLoader = loadTorusDeps } = {}) {
  const write = (line = '') => out.write(`${line}\n`);
  let args;
  let signing;
  try {
    args = parseArgs(argv);
    signing = loadSigningKey(args.key);
  } catch (e) {
    err.write(`nativeAuthSpike: ${e.message}\n`);
    return 2;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const minted = mintJwt({ privateKey: signing.privateKey, kid: signing.kid, iss: args.iss, aud: args.aud, sub: args.sub, nowSec });
  const decoded = verifyJwt(minted.token, signing.publicJwk);
  const problems = claimProblems(decoded, { kid: signing.kid, iss: args.iss, aud: args.aud, nowSec });
  const jwksPath = args.jwks || defaultJwksPath(signing.path);
  const jwks = checkPublishedJwks(jwksPath, signing.kid);

  if (args.sampleJwt) {
    if (problems.length || (jwks.checked && !jwks.ok)) {
      err.write(`nativeAuthSpike: refusing to print a sample token: ${[...problems, ...(jwks.errors || [])].join('; ')}\n`);
      return 1;
    }
    write(minted.token);
    return 0;
  }

  write(`mode: ${args.live ? 'LIVE' : 'dry run (no network)'}`);
  write(`kid: ${signing.kid}`);
  write(`header: ${JSON.stringify(decoded.header)}`);
  write(`payload: ${JSON.stringify(decoded.payload)}`);
  write(`local signature check: ok`);
  write(`claims per design §2.4: ${problems.length ? `PROBLEMS ${problems.join(', ')}` : 'ok'}`);
  write(`JWKS ${jwksPath}: ${jwks.checked ? (jwks.ok ? 'passes the publish check and contains the kid' : `FAILS: ${jwks.errors.join('; ')}`) : 'not found (skipped)'}`);
  write(`lookup plan: network=${args.network} connection=${args.connection} verifierId=<sub> clientId=${args.clientId ? 'set' : 'MISSING (owner step O1)'}`);
  if (problems.length || (jwks.checked && !jwks.ok)) return 1;

  if (!args.live) {
    write('live steps not run: A0 getPublicAddress, A1 retrieveShares (SFA key), A0 = A1' +
      `${args.secondUser ? ', second user differs' : ''}${args.negatives ? ', negatives' : ''}. Re-run with --live after O1 and O3.`);
    return 0;
  }

  let result;
  try {
    const deps = depsLoader(args.depsDir);
    result = await runLive({ signing, iss: args.iss, aud: args.aud, network: args.network, connection: args.connection, clientId: args.clientId, sub: args.sub, secondUser: args.secondUser, negatives: args.negatives, deps });
  } catch (e) {
    err.write(`nativeAuthSpike: ${sanitize(e.message)}\n`);
    return 2;
  }
  for (const step of result.steps) write(`${step.pass ? 'PASS' : 'FAIL'} ${step.name}: ${step.detail}`);
  write(result.pass ? 'S1 PASS' : 'S1 FAIL');
  return result.pass ? 0 : 1;
}

module.exports = {
  DEVNET_DEFAULTS,
  THROWAWAY_SUB,
  mintJwt,
  verifyJwt,
  claimProblems,
  sanitize,
  loadSigningKey,
  checkPublishedJwks,
  defaultJwksPath,
  addressFromPrivKeyHex,
  loadTorusDeps,
  runLive,
  parseArgs,
  main,
};

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`nativeAuthSpike: ${sanitize(e.message)}\n`);
      process.exitCode = 2;
    },
  );
}
