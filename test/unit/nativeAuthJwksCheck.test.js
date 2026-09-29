/**
 * Native login BE0 — issuer key tooling (design §5 items 3–4, §6 F1, §7.1).
 *
 * The question this file answers: CAN ANYTHING BUT THE PINNED PUBLIC KEYS REACH THE PUBLISHED JWKS?
 * Whatever that file holds can derive every native wallet, so the publish check must refuse private
 * members, foreign members, the wrong kid/alg/use, unpinned keys and the committed auth-key-1; the
 * keygen must only ever write a file that passes it (private half 0400 in a 0700 dir outside every
 * repo); and the spike must mint exactly the §2.4 claims and never make a network call in dry mode.
 *
 * Everything is local: generated keys, temp directories, a loopback HTTP server, a fake torus client.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const jose = require('jose');

const check = require('../../scripts/nativeAuthJwksCheck');
const keygen = require('../../scripts/nativeAuthKeygen');
const spike = require('../../scripts/nativeAuthSpike');

const ROOT = path.join(__dirname, '../..');
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi'];

function rsaJwk(bits = 2048) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
  return privateKey.export({ format: 'jwk' });
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddc-native-be0-'));
}

function rmrf(dir) {
  // The private key file is 0400; rm with force handles it.
  fs.rmSync(dir, { recursive: true, force: true });
}

const priv = rsaJwk();
const pub = check.publicJwk(priv);
const other = check.publicJwk(rsaJwk());
const good = () => ({ keys: [{ ...pub }] });

describe('RFC 7638 thumbprint and publicJwk', () => {
  it('matches jose.calculateJwkThumbprint', async () => {
    assert.equal(check.rfc7638Thumbprint(priv), await jose.calculateJwkThumbprint(priv, 'sha256'));
  });

  it('publicJwk keeps exactly kty, n, e, kid, alg, use with kid = thumbprint', () => {
    assert.deepEqual(Object.keys(pub).sort(), ['alg', 'e', 'kid', 'kty', 'n', 'use']);
    assert.equal(pub.kid, check.rfc7638Thumbprint(priv));
    assert.equal(pub.alg, 'RS256');
    assert.equal(pub.use, 'sig');
  });

  it('the hard-coded auth-key-1 thumbprint equals keys/jwks.json (while that file exists)', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys/jwks.json'), 'utf8'));
    assert.equal(check.rfc7638Thumbprint(committed.keys[0]), check.COMMITTED_AUTH_KEY_1_THUMBPRINT);
  });
});

describe('checkJwks — the publish rules', () => {
  const pinned = [pub.kid];

  it('accepts a pinned public key', () => {
    const result = check.checkJwks(good(), { pinned });
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.deepEqual(result.keys.map((k) => k.thumbprint), [pub.kid]);
  });

  for (const member of [...PRIVATE_MEMBERS, 'oth', 'k']) {
    it(`refuses private member ${member}, naming the member but never its value`, () => {
      const key = { ...pub, [member]: member in priv ? priv[member] : 'c2VjcmV0' };
      const result = check.checkJwks({ keys: [key] }, { pinned });
      assert.equal(result.ok, false);
      const text = JSON.stringify(result);
      assert.match(text, new RegExp(`PRIVATE member\\(s\\): ${member}`));
      assert.ok(!text.includes(key[member]), 'the member value must not appear in the result');
    });
  }

  it('refuses a full private JWK (the classic mistake: publishing the key file)', () => {
    const result = check.checkJwks({ keys: [{ ...priv, kid: pub.kid, alg: 'RS256', use: 'sig' }] }, { pinned });
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(priv.d));
  });

  it('refuses foreign members (x5c, key_ops) and missing members', () => {
    assert.equal(check.checkJwks({ keys: [{ ...pub, x5c: ['AAAA'] }] }, { pinned }).ok, false);
    assert.equal(check.checkJwks({ keys: [{ ...pub, key_ops: ['verify'] }] }, { pinned }).ok, false);
    for (const member of ['kid', 'alg', 'use', 'kty', 'n', 'e']) {
      const key = { ...pub };
      delete key[member];
      assert.equal(check.checkJwks({ keys: [key] }, { pinned }).ok, false, `missing ${member}`);
    }
  });

  it('refuses the wrong alg, use, kty or exponent', () => {
    for (const bad of [{ alg: 'RS512' }, { alg: 'none' }, { use: 'enc' }, { kty: 'EC' }, { e: 'Aw' }, { alg: 256 }]) {
      assert.equal(check.checkJwks({ keys: [{ ...pub, ...bad }] }, { pinned }).ok, false, JSON.stringify(bad));
    }
  });

  it('refuses a kid that is not the thumbprint, even when the key itself is pinned', () => {
    const result = check.checkJwks({ keys: [{ ...pub, kid: 'ddc-devnet-1' }] }, { pinned });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /kid does not equal its RFC 7638 thumbprint/);
  });

  it('refuses an unpinned key', () => {
    const result = check.checkJwks({ keys: [{ ...pub }, { ...other }] }, { pinned });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), new RegExp(`${other.kid} is not pinned`));
  });

  it('refuses the committed auth-key-1 even when someone pins it and fixes its kid', () => {
    const committed = JSON.parse(fs.readFileSync(path.join(ROOT, 'keys/jwks.json'), 'utf8')).keys[0];
    const asPublished = { ...committed, kid: check.rfc7638Thumbprint(committed) };
    const result = check.checkJwks({ keys: [asPublished] }, { pinned: [asPublished.kid] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /committed auth-key-1/);
    // By kid alone, too.
    assert.match(check.checkJwks({ keys: [{ ...pub, kid: 'auth-key-1' }] }, { pinned }).errors.join(' '), /kid auth-key-1/);
  });

  it('refuses the committed key via the constant when keys/jwks.json is gone', () => {
    const forbidden = check.forbiddenThumbprints({ committedJwksPath: path.join(os.tmpdir(), 'no-such-jwks.json') });
    assert.ok(forbidden.has(check.COMMITTED_AUTH_KEY_1_THUMBPRINT));
  });

  it('refuses a modulus under 2048 bits', () => {
    const small = check.publicJwk(rsaJwk(1024));
    const result = check.checkJwks({ keys: [small] }, { pinned: [small.kid] });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /1024 bits/);
  });

  it('refuses extra top-level members, an empty or missing key list, non-objects and duplicates', () => {
    assert.equal(check.checkJwks({ ...good(), private: {} }, { pinned }).ok, false);
    assert.equal(check.checkJwks({ keys: [] }, { pinned }).ok, false);
    assert.equal(check.checkJwks({}, { pinned }).ok, false);
    assert.equal(check.checkJwks([], { pinned }).ok, false);
    assert.equal(check.checkJwks({ keys: ['x'] }, { pinned }).ok, false);
    assert.equal(check.checkJwks({ keys: [{ ...pub }, { ...pub }] }, { pinned }).ok, false);
  });

  it('needs a well-formed, non-empty pinned list', () => {
    assert.throws(() => check.checkJwks(good(), { pinned: '' }), /no pinned thumbprints/);
    assert.throws(() => check.checkJwks(good(), { pinned: 'auth-key-1' }), /not RFC 7638/);
  });

  it('a pinned but unpublished key is a note, and an error only with exact', () => {
    const loose = check.checkJwks(good(), { pinned: [pub.kid, other.kid] });
    assert.equal(loose.ok, true);
    assert.match(loose.notes.join(' '), new RegExp(other.kid));
    assert.equal(check.checkJwks(good(), { pinned: [pub.kid, other.kid], exact: true }).ok, false);
  });
});

describe('checkSource and watch over HTTP', () => {
  let server;
  let base;
  let body = JSON.stringify(good());
  let status = 200;

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/jwks.json' });
        return res.end();
      }
      res.writeHead(status, { 'content-type': 'application/json' });
      return res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(() => server.close());

  it('passes a good live file and fails one that leaks a private member', async () => {
    body = JSON.stringify(good());
    status = 200;
    assert.equal((await check.checkSource(`${base}/jwks.json`, { pinned: [pub.kid] })).ok, true);
    body = JSON.stringify({ keys: [{ ...pub, d: priv.d }] });
    const leaked = await check.checkSource(`${base}/jwks.json`, { pinned: [pub.kid] });
    assert.equal(leaked.ok, false);
    assert.ok(!check.formatResult(leaked, 'x').join('\n').includes(priv.d));
  });

  it('reports non-200, invalid JSON, oversize bodies and redirects as failures', async () => {
    status = 404;
    assert.match((await check.checkSource(`${base}/jwks.json`, { pinned: [pub.kid] })).fetchError, /HTTP 404/);
    status = 200;
    body = 'not json';
    assert.deepEqual((await check.checkSource(`${base}/jwks.json`, { pinned: [pub.kid] })).errors, ['body is not valid JSON']);
    body = JSON.stringify({ keys: [pub], pad: 'x'.repeat(70 * 1024) });
    assert.match((await check.checkSource(`${base}/jwks.json`, { pinned: [pub.kid] })).fetchError, /larger than/);
    body = JSON.stringify(good());
    assert.ok((await check.checkSource(`${base}/redirect`, { pinned: [pub.kid] })).fetchError);
  });

  it('refuses plain http to anything but loopback, before any request', async () => {
    let called = false;
    const fetchImpl = async () => {
      called = true;
      throw new Error('should not be called');
    };
    const result = await check.checkSource('http://datadancechain.github.io/ddc-login-jwks/devnet/jwks.json', { pinned: [pub.kid], fetchImpl });
    assert.match(result.fetchError, /must be https/);
    assert.equal(called, false);
  });

  it('watch reports each run and says when the published bytes change', async () => {
    const lines = [];
    const bodies = [JSON.stringify(good()), JSON.stringify(good()), JSON.stringify({ keys: [pub, other] })];
    let run = 0;
    const fetchImpl = async () => ({ status: 200, text: async () => bodies[run++] });
    const last = await check.watchJwks({
      source: 'https://example.invalid/jwks.json',
      pinned: [pub.kid],
      maxRuns: 3,
      fetchImpl,
      sleep: async () => {},
      report: (line, isProblem) => lines.push({ line, isProblem }),
    });
    assert.equal(last.ok, false);
    const changed = lines.filter((l) => l.line.includes('CHANGED'));
    assert.equal(changed.length, 1);
    assert.equal(changed[0].isProblem, true);
    assert.equal(lines.filter((l) => / OK /.test(l.line)).length, 2);
    assert.ok(lines.some((l) => l.isProblem && l.line.includes(`${other.kid} is not pinned`)));
  });

  it('the CLI exits 0 / 1 / 2 for ok / violation / usage', () => {
    const dir = tempDir();
    try {
      const okFile = path.join(dir, 'ok.json');
      const badFile = path.join(dir, 'bad.json');
      fs.writeFileSync(okFile, JSON.stringify(good()));
      fs.writeFileSync(badFile, JSON.stringify({ keys: [{ ...pub, d: priv.d }] }));
      const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/nativeAuthJwksCheck.js'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
      assert.equal(run([okFile, `--pinned=${pub.kid}`]).status, 0);
      const bad = run([badFile, `--pinned=${pub.kid}`]);
      assert.equal(bad.status, 1);
      assert.ok(!bad.stdout.includes(priv.d) && !bad.stderr.includes(priv.d));
      assert.equal(run([okFile]).status, 2);
    } finally {
      rmrf(dir);
    }
  });
});

describe('nativeAuthKeygen', () => {
  it('writes a 0400 private JWK in a 0700 dir and a JWKS that passes the check; prints no key material', () => {
    const dir = tempDir();
    try {
      const outDir = path.join(dir, 'secrets', 'native-auth');
      const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/nativeAuthKeygen.js'), '--env=devnet', `--out-dir=${outDir}`], { encoding: 'utf8' });
      assert.equal(res.status, 0, res.stderr);
      const privatePath = path.join(outDir, 'devnet-signing-key.jwk.json');
      const jwksPath = path.join(outDir, 'devnet-jwks.json');
      assert.equal(fs.statSync(outDir).mode & 0o777, 0o700);
      assert.equal(fs.statSync(privatePath).mode & 0o777, 0o400);

      const stored = JSON.parse(fs.readFileSync(privatePath, 'utf8'));
      const jwks = JSON.parse(fs.readFileSync(jwksPath, 'utf8'));
      assert.equal(stored.kid, check.rfc7638Thumbprint(stored));
      assert.equal(stored.alg, 'RS256');
      assert.equal(stored.use, 'sig');
      assert.equal(Buffer.from(stored.n, 'base64url').length * 8, 2048);
      assert.deepEqual(jwks, { keys: [check.publicJwk(stored)] });
      assert.equal(check.checkJwks(jwks, { pinned: [stored.kid], exact: true }).ok, true);

      for (const member of PRIVATE_MEMBERS) {
        assert.ok(!res.stdout.includes(stored[member]) && !res.stderr.includes(stored[member]), `stdout leaks ${member}`);
      }
      assert.ok(!res.stdout.includes(stored.n), 'no need to print the modulus either');
      assert.match(res.stdout, new RegExp(`DDC_AUTH_JWKS_PINNED=${stored.kid}\\n`));
      assert.match(res.stdout, new RegExp(`DDC_AUTH_SIGNING_KEY_FILE=${privatePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));

      // Never overwrites.
      const again = spawnSync(process.execPath, [path.join(ROOT, 'scripts/nativeAuthKeygen.js'), '--env=devnet', `--out-dir=${outDir}`], { encoding: 'utf8' });
      assert.equal(again.status, 1);
      assert.match(again.stderr, /refusing to overwrite/);
      assert.equal(fs.readFileSync(privatePath, 'utf8'), `${JSON.stringify(stored, null, 2)}\n`);
    } finally {
      rmrf(dir);
    }
  });

  it('--rotate appends a next key and pins both', () => {
    const dir = tempDir();
    try {
      const first = keygen.generate({ env: 'devnet', outDir: dir });
      assert.throws(() => keygen.generate({ env: 'devnet', outDir: dir, name: 'devnet-signing-key-2' }), /pass --rotate/);
      const second = keygen.generate({ env: 'devnet', outDir: dir, name: 'devnet-signing-key-2', rotate: true });
      assert.deepEqual(second.pinned, [first.kid, second.kid]);
      const jwks = JSON.parse(fs.readFileSync(second.jwksPath, 'utf8'));
      assert.equal(check.checkJwks(jwks, { pinned: second.pinned, exact: true }).ok, true);
    } finally {
      rmrf(dir);
    }
  });

  it('refuses production envs, git work trees and cloud-synced folders, writing nothing', () => {
    const dir = tempDir();
    try {
      for (const env of ['prod', 'mainnet', 'sapphire_mainnet', '']) {
        assert.throws(() => keygen.generate({ env, outDir: dir }), /KMS/);
      }
      assert.deepEqual(fs.readdirSync(dir), []);
      const inRepo = path.join(ROOT, 'test', 'no-such-dir-be0', 'keys');
      assert.throws(() => keygen.generate({ env: 'devnet', outDir: inRepo }), /inside the git work tree/);
      assert.equal(fs.existsSync(path.join(ROOT, 'test', 'no-such-dir-be0')), false);
      assert.ok(keygen.insideCloudSync('/Users/someone/Library/CloudStorage/GoogleDrive-x/My Drive/keys'));
      assert.equal(keygen.insideGitWorkTree(dir), null);
    } finally {
      rmrf(dir);
    }
  });
});

describe('nativeAuthSpike', () => {
  let dir;
  let keyFile;
  let signing;

  before(() => {
    dir = tempDir();
    keyFile = keygen.generate({ env: 'devnet', outDir: dir }).privatePath;
    signing = spike.loadSigningKey(keyFile);
  });
  after(() => rmrf(dir));

  it('mints exactly the §2.4 header and claims, verifiable against the published JWKS', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const minted = spike.mintJwt({ privateKey: signing.privateKey, kid: signing.kid, iss: 'ddc-auth-devnet', aud: 'ddc-w3a-devnet', sub: spike.THROWAWAY_SUB, nowSec });
    assert.deepEqual(minted.header, { alg: 'RS256', typ: 'JWT', kid: signing.kid });
    assert.deepEqual(Object.keys(minted.payload), ['iss', 'aud', 'sub', 'user_id', 'iat', 'exp', 'jti']);
    assert.equal(minted.payload.iat, nowSec - 2);
    assert.equal(minted.payload.exp, nowSec - 2 + 60);
    assert.equal(minted.payload.user_id, minted.payload.sub);
    assert.equal(minted.payload.nbf, undefined);
    assert.deepEqual(spike.claimProblems(minted, { kid: signing.kid, iss: 'ddc-auth-devnet', aud: 'ddc-w3a-devnet', nowSec }), []);

    const jwks = jose.createLocalJWKSet(JSON.parse(fs.readFileSync(path.join(dir, 'devnet-jwks.json'), 'utf8')));
    const { payload, protectedHeader } = await jose.jwtVerify(minted.token, jwks, {
      issuer: 'ddc-auth-devnet',
      audience: 'ddc-w3a-devnet',
      algorithms: ['RS256'],
    });
    assert.equal(protectedHeader.kid, signing.kid);
    assert.equal(payload.sub, spike.THROWAWAY_SUB);
  });

  it('refuses a key file that others can read or that lives in a repo', () => {
    const loose = path.join(dir, 'loose.jwk.json');
    fs.writeFileSync(loose, fs.readFileSync(keyFile), { mode: 0o644 });
    assert.throws(() => spike.loadSigningKey(loose), /readable by group or others/);
    assert.throws(() => spike.loadSigningKey(path.join(ROOT, 'keys', 'private.json')), /git work tree/);
  });

  it('dry run makes no network call and prints no token or key material', async () => {
    let out = '';
    let err = '';
    const code = await spike.main([`--key=${keyFile}`], {
      out: { write: (s) => { out += s; } },
      err: { write: (s) => { err += s; } },
      depsLoader: () => {
        throw new Error('dry run must not load the torus client');
      },
    });
    assert.equal(code, 0, err);
    assert.match(out, /dry run \(no network\)/);
    assert.match(out, /claims per design §2.4: ok/);
    assert.match(out, /passes the publish check/);
    assert.doesNotMatch(out, /eyJ[A-Za-z0-9_-]+\.eyJ/);
    const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    for (const member of PRIVATE_MEMBERS) assert.ok(!out.includes(stored[member]));
  });

  it('--sample-jwt prints one token, only for the throwaway subject', async () => {
    let out = '';
    const code = await spike.main([`--key=${keyFile}`, '--sample-jwt'], { out: { write: (s) => { out += s; } }, err: { write: () => {} } });
    assert.equal(code, 0);
    const [token] = out.trim().split('\n');
    assert.equal(spike.verifyJwt(token, signing.publicJwk).payload.sub, spike.THROWAWAY_SUB);
    assert.throws(() => spike.parseArgs(['--sample-jwt', `--sub=${crypto.randomUUID()}`], {}), /throwaway/);
  });

  describe('live run logic (fake torus client)', () => {
    const ADDR_A = '0x' + 'a'.repeat(40);
    // A fixed secp256k1 test scalar; the derived address is what "A1" must report.
    const PRIV_HEX = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
    const { computeAddress } = require('ethers');
    const DERIVED = computeAddress(`0x${PRIV_HEX}`);

    function fakeDeps({ lookupAddress = DERIVED, acceptAll = false } = {}) {
      const seen = new Set();
      class FakeTorus {
        async getPublicAddress(endpoints, pubs, { verifier, verifierId }) {
          assert.equal(verifier, 'ddc-jwt-devnet');
          return { finalKeyData: { walletAddress: verifierId === spike.THROWAWAY_SUB ? lookupAddress : ADDR_A } };
        }

        async retrieveShares({ verifier, verifierParams, idToken, checkCommitment, useDkg }) {
          assert.equal(verifier, 'ddc-jwt-devnet');
          assert.equal(checkCommitment, false);
          assert.equal(useDkg, true);
          if (!acceptAll) {
            if (seen.has(idToken)) throw new Error(`Duplicate token found ${idToken}`);
            seen.add(idToken);
            const { header, payload } = spike.verifyJwt(idToken, signing.publicJwk);
            if (header.kid !== signing.kid) throw new Error('kid not found');
            if (payload.aud !== 'ddc-w3a-devnet') throw new Error('aud mismatch');
            if (Math.floor(Date.now() / 1000) - payload.iat > 60) throw new Error('timesigned more than 60 seconds ago');
            if (payload.sub !== verifierParams.verifier_id) throw new Error('verifier_id mismatch');
          }
          return { metadata: {}, finalKeyData: { privKey: PRIV_HEX }, oAuthKeyData: { privKey: '11'.repeat(32) } };
        }
      }
      return { Torus: FakeTorus, fetchLocalConfig: () => ({ torusNodeEndpoints: ['e'], torusIndexes: [1], torusNodePub: [{}] }), keyType: 'secp256k1' };
    }

    const base = () => ({ signing, iss: 'ddc-auth-devnet', aud: 'ddc-w3a-devnet', network: 'sapphire_devnet', connection: 'ddc-jwt-devnet', clientId: 'cid', sub: spike.THROWAWAY_SUB });

    it('passes when A0 = A1, the second user differs and every negative is refused; the key never appears', async () => {
      const result = await spike.runLive({ ...base(), secondUser: true, negatives: true, deps: fakeDeps() });
      assert.equal(result.pass, true, JSON.stringify(result.steps));
      assert.equal(result.steps.length, 9);
      assert.ok(!JSON.stringify(result).includes(PRIV_HEX));
    });

    it('fails when the lookup and the derived key disagree', async () => {
      const result = await spike.runLive({ ...base(), deps: fakeDeps({ lookupAddress: ADDR_A }) });
      assert.equal(result.pass, false);
      assert.equal(result.steps.find((s) => s.name === 'A0 = A1').pass, false);
    });

    it('fails when the nodes accept a token they should refuse', async () => {
      const result = await spike.runLive({ ...base(), negatives: true, deps: fakeDeps({ acceptAll: true }) });
      assert.equal(result.pass, false);
      assert.ok(result.steps.filter((s) => s.name.startsWith('refused:')).every((s) => !s.pass));
    });

    it('scrubs tokens from node error messages', () => {
      assert.equal(spike.sanitize('Duplicate token found eyJhbGciOi.eyJpc3MiOi.c2ln'), 'Duplicate token found <jwt>');
    });

    it('refuses mainnet and a missing client id', async () => {
      await assert.rejects(spike.runLive({ ...base(), network: 'sapphire_mainnet', deps: fakeDeps() }), /only on sapphire_devnet/);
      await assert.rejects(spike.runLive({ ...base(), clientId: '', deps: fakeDeps() }), /client-id/);
    });
  });
});
