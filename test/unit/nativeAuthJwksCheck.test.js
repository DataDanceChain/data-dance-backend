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

function rsaJwk(bits = 2048, publicExponent = 0x10001) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits, publicExponent });
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

  it('refuses the wrong alg, use, kty or exponent, each by its own rule', () => {
    // alg and use are not hashed into the thumbprint, so the kid and pin stay valid and only the rule fires.
    for (const [bad, rule] of [
      [{ alg: 'RS512' }, /alg is not RS256/],
      [{ alg: 'none' }, /alg is not RS256/],
      [{ alg: 256 }, /alg is not RS256/],
      [{ use: 'enc' }, /use is not sig/],
    ]) {
      const result = check.checkJwks({ keys: [{ ...pub, ...bad }] }, { pinned });
      assert.equal(result.ok, false, JSON.stringify(bad));
      assert.match(result.errors.join(' '), rule, JSON.stringify(bad));
      assert.doesNotMatch(result.errors.join(' '), /kid does not equal|is not pinned/, JSON.stringify(bad));
    }
    // kty takes the key out of RSA altogether: no thumbprint, and the kty rule says why.
    assert.match(check.checkJwks({ keys: [{ ...pub, kty: 'EC' }] }, { pinned }).errors.join(' '), /kty is not RSA/);
    // e = 3 with a kid that IS its thumbprint and is pinned: only the exponent rule can refuse it.
    const e3 = check.publicJwk(rsaJwk(2048, 3));
    assert.equal(e3.e, 'Aw');
    const result = check.checkJwks({ keys: [e3] }, { pinned: [e3.kid] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [`keys[0] e is not AQAB (65537)`]);
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

describe('checkJwksText — rules on the published bytes, not just the parsed object', () => {
  const pinned = [pub.kid];
  const fullPrivate = () => JSON.stringify({ ...priv, kid: pub.kid, alg: 'RS256', use: 'sig' });
  const assertNoPrivateValues = (text) => {
    for (const member of PRIVATE_MEMBERS) assert.ok(!text.includes(priv[member]), `value of ${member} leaked`);
  };

  it('refuses a repeated top-level "keys" that hides a full private JWK behind a clean one', () => {
    const text = `{"keys":[${fullPrivate()}],"keys":[${JSON.stringify(pub)}]}`;
    // The parsed object alone is clean — this is exactly what JSON.parse lets through.
    assert.equal(check.checkJwks(JSON.parse(text), { pinned }).ok, true);
    assert.ok(text.includes(priv.d));
    const result = check.checkJwksText(text, { pinned });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /top level repeats member keys/);
    assert.match(result.errors.join(' '), /keys\[0\] has PRIVATE member\(s\) in the raw text: d/);
    assertNoPrivateValues(JSON.stringify(result));
    assertNoPrivateValues(check.formatResult({ ...result, sha256: 'ab' }, 'x').join('\n'));
  });

  it('refuses a member repeated inside one key (two n, two kid)', () => {
    const one = JSON.stringify({ keys: [pub] });
    const twoN = one.replace('"n":', `"n":"${priv.d}","n":`);
    const twoKid = one.replace('"kid":', '"kid":"auth-key-1","kid":');
    for (const [text, member] of [[twoN, 'n'], [twoKid, 'kid']]) {
      assert.equal(check.checkJwks(JSON.parse(text), { pinned }).ok, true, 'parsed object alone passes');
      const result = check.checkJwksText(text, { pinned });
      assert.equal(result.ok, false, member);
      assert.deepEqual(result.errors, [`keys[0] repeats member ${member} (JSON.parse would hide the earlier copy, which is still published)`]);
    }
    assertNoPrivateValues(JSON.stringify(check.checkJwksText(twoN, { pinned })));
  });

  it('decodes escaped member names, so "\\u0064" counts as d', () => {
    const text = JSON.stringify({ keys: [pub] }).replace('"kty":', `"\\u0064":"${priv.d}","kty":`);
    assert.ok(text.includes('\\u0064'));
    const result = check.checkJwksText(text, { pinned });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /PRIVATE member\(s\) in the raw text: d/);
    assertNoPrivateValues(JSON.stringify(result));
  });

  it('keeps a raw-text backstop for a private member name pattern the scan does not attribute', () => {
    // The member name is x"d, not d, but the bytes contain "d": — refused anyway.
    const text = JSON.stringify({ keys: [pub] }).replace('"kty":', '"x\\"d":1,"kty":');
    assert.deepEqual(check.rawTextErrors(text), ['raw text contains a private member name (d, p, q, dp, dq, qi, oth or k)']);
    assert.equal(check.checkJwksText(text, { pinned }).ok, false);
  });

  it('accepts a clean file however it is formatted, and reports invalid JSON as before', () => {
    for (const text of [JSON.stringify(good()), JSON.stringify(good(), null, 2), `\n ${JSON.stringify(good(), null, '\t')} \n`]) {
      assert.equal(check.checkJwksText(text, { pinned }).ok, true);
    }
    assert.deepEqual(check.checkJwksText('{"keys":', { pinned }).errors, ['body is not valid JSON']);
  });

  it('never prints a member name that could be a value', () => {
    const text = JSON.stringify({ keys: [{ ...pub, [priv.d.slice(0, 40)]: 1 }] });
    assertNoPrivateValues(JSON.stringify(check.checkJwksText(text, { pinned })));
    assert.ok(!JSON.stringify(check.checkJwksText(text, { pinned })).includes(priv.d.slice(0, 40)));
  });

  it('the CLI (text and --json) exits 1 on the repeated-member file and never shows d', () => {
    const dir = tempDir();
    try {
      const file = path.join(dir, 'dup.json');
      fs.writeFileSync(file, `{"keys":[${fullPrivate()}],"keys":[${JSON.stringify(pub)}]}`);
      for (const extra of [[], ['--json']]) {
        const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts/nativeAuthJwksCheck.js'), file, `--pinned=${pub.kid}`, ...extra], { encoding: 'utf8', env: { PATH: process.env.PATH } });
        assert.equal(res.status, 1, extra.join(' '));
        assert.match(res.stdout + res.stderr, /repeats member keys/);
        assertNoPrivateValues(res.stdout + res.stderr);
      }
    } finally {
      rmrf(dir);
    }
  });

  it('watch catches the repeated-member file too', async () => {
    const lines = [];
    const text = `{"keys":[${fullPrivate()}],"keys":[${JSON.stringify(pub)}]}`;
    const last = await check.watchJwks({
      source: 'https://example.invalid/jwks.json',
      pinned,
      maxRuns: 1,
      fetchImpl: async () => ({ status: 200, text: async () => text }),
      sleep: async () => {},
      report: (line, isProblem) => lines.push({ line, isProblem }),
    });
    assert.equal(last.ok, false);
    assert.ok(lines.some((l) => l.isProblem && /repeats member keys/.test(l.line)));
    assertNoPrivateValues(lines.map((l) => l.line).join('\n'));
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
      if (req.url === '/chunked') {
        // No content-length: the cap must be enforced while reading, not after.
        res.writeHead(200, { 'content-type': 'application/json' });
        for (let i = 0; i < 70; i += 1) res.write('x'.repeat(1024));
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
    assert.match((await check.checkSource(`${base}/chunked`, { pinned: [pub.kid] })).fetchError, /larger than/);
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

  it('--rotate refuses an existing JWKS that hides a repeated member', () => {
    const dir = tempDir();
    try {
      const first = keygen.generate({ env: 'devnet', outDir: dir });
      const text = fs.readFileSync(first.jwksPath, 'utf8');
      fs.writeFileSync(first.jwksPath, text.replace('"keys":', `"keys":[${JSON.stringify(other)}],"keys":`));
      assert.throws(
        () => keygen.generate({ env: 'devnet', outDir: dir, name: 'devnet-signing-key-2', rotate: true }),
        /repeats member keys/,
      );
      assert.equal(fs.existsSync(path.join(dir, 'devnet-signing-key-2.jwk.json')), false);
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
      // An existing out-dir that others could read is refused, not silently tightened.
      const loose = path.join(dir, 'loose');
      fs.mkdirSync(loose, { mode: 0o755 });
      fs.chmodSync(loose, 0o755);
      assert.throws(() => keygen.generate({ env: 'devnet', outDir: loose }), /mode 755; run chmod 700/);
      assert.equal(fs.statSync(loose).mode & 0o777, 0o755);
      assert.deepEqual(fs.readdirSync(loose), []);
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

  it('--sub takes only the throwaway subject or random, in every mode', () => {
    for (const extra of [[], ['--live'], ['--sample-jwt']]) {
      assert.throws(() => spike.parseArgs([...extra, `--sub=${crypto.randomUUID()}`], {}), /throwaway/, extra.join(' '));
    }
    assert.equal(spike.parseArgs(['--live'], {}).sub, spike.THROWAWAY_SUB);
    const random = spike.parseArgs(['--live', '--sub=random'], {}).sub;
    assert.match(random, /^[0-9a-f-]{36}$/);
    assert.notEqual(random, spike.THROWAWAY_SUB);
  });

  it('checks the JWKS next to the key with the raw-text rules, whatever the env prefix', () => {
    assert.equal(spike.defaultJwksPath('/k/test-signing-key.jwk.json'), '/k/test-jwks.json');
    assert.equal(spike.defaultJwksPath('/k/devnet-signing-key-2.jwk.json'), '/k/devnet-jwks.json');
    const jwksPath = path.join(dir, 'dup-jwks.json');
    const pubHere = signing.publicJwk;
    fs.writeFileSync(jwksPath, `{"keys":[${JSON.stringify({ ...pubHere, d: 'c2VjcmV0' })}],"keys":[${JSON.stringify(pubHere)}]}`);
    const result = spike.checkPublishedJwks(jwksPath, signing.kid, {});
    assert.equal(result.ok, false);
    assert.match(result.errors.join(' '), /repeats member keys/);
    assert.ok(!result.errors.join(' ').includes('c2VjcmV0'));
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

    it('scrubs tokens and key-length hex from node error messages', () => {
      assert.equal(spike.sanitize('Duplicate token found eyJhbGciOi.eyJpc3MiOi.c2ln'), 'Duplicate token found <jwt>');
      for (const len of [62, 64, 66, 130]) {
        const hex = 'ab'.repeat(len / 2);
        assert.equal(spike.sanitize(`invalid private key 0x${hex}`), 'invalid private key <hex>', `${len}`);
      }
      assert.equal(spike.sanitize(`address ${ADDR_A}`), `address ${ADDR_A}`);
    });

    it('a malformed key from the nodes fails without echoing it', async () => {
      for (const bad of ['ab'.repeat(33), '00'.repeat(32), 'zz'.repeat(32)]) {
        try {
          spike.addressFromPrivKeyHex(bad);
          assert.fail(`accepted ${bad.length}`);
        } catch (err) {
          assert.ok(!err.message.includes(bad), err.message);
        }
      }
      const deps = fakeDeps();
      const original = deps.Torus.prototype.retrieveShares;
      deps.Torus.prototype.retrieveShares = async function (...args) {
        const res = await original.apply(this, args);
        return { ...res, finalKeyData: { privKey: 'cd'.repeat(33) } };
      };
      const result = await spike.runLive({ ...base(), deps });
      assert.equal(result.pass, false);
      assert.ok(!JSON.stringify(result).includes('cd'.repeat(33)));
    });

    it('refuses mainnet and a missing client id', async () => {
      await assert.rejects(spike.runLive({ ...base(), network: 'sapphire_mainnet', deps: fakeDeps() }), /only on sapphire_devnet/);
      await assert.rejects(spike.runLive({ ...base(), clientId: '', deps: fakeDeps() }), /client-id/);
    });
  });
});
