/**
 * No private key lives in source. The repository is public; a chain signer key was once committed in
 * src/utils/web3Utils.js, and the same shape could come back in any file under src/ or scripts/.
 *
 * Every quoted 64-hex literal in a .js/.ts file under src/ and scripts/ is a failure, except the
 * three existing non-key literals below, which are let through by file AND name. The scan reports
 * file:line only, never the literal.
 *
 * The scan is itself tested against a temp tree whose literals are generated at run time: random,
 * never committed, never printed.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { findKeyLiterals } = require('../helpers/keyLiteralScan');

const ROOT = path.join(__dirname, '../..');

// The only quoted 64-hex literals that are not keys: public NFT metadata key hashes and a device
// push token in a test script. Matched by file AND variable name.
const ALLOWLIST = [
  { file: 'src/services/ddcNFTMetadataService.js', name: 'keyHash' },
  { file: 'scripts/recordDataNFTToBlockchain.js', name: 'keyHash' },
  { file: 'scripts/testPushNotification.js', name: 'pushToken' },
];

describe('no private key is committed under src/ or scripts/', () => {
  it('every quoted 64-hex literal is an allowed non-key, by file and name', () => {
    const offenders = findKeyLiterals(ROOT, { allowlist: ALLOWLIST })
      .filter((hit) => !hit.allowed)
      .map((hit) => `${hit.file}:${hit.line}`);
    assert.deepEqual(
      offenders,
      [],
      'quoted 64-hex literal(s) outside the allowlist (file:line, value withheld): a key belongs in the environment, never in source',
    );
  });

  it('the allowlist names only literals that exist, so it cannot rot into a blanket pass', () => {
    const hits = findKeyLiterals(ROOT, { allowlist: ALLOWLIST });
    for (const entry of ALLOWLIST) {
      assert.ok(
        hits.some((hit) => hit.allowed && hit.file === entry.file && hit.name === entry.name),
        `${entry.file} / ${entry.name} matches no literal any more: remove it from the allowlist`,
      );
    }
  });
});

describe('the scan (literals generated at run time in a temp tree)', () => {
  let dir;
  const planted = [];
  const hex = () => {
    const value = crypto.randomBytes(32).toString('hex');
    planted.push(value);
    return value;
  };
  const put = (file, text) => {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  };
  const scan = () => findKeyLiterals(dir, { allowlist: ALLOWLIST });
  const flagged = (hits) => hits.filter((hit) => !hit.allowed).map((hit) => `${hit.file}:${hit.line}`);

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyscan-'));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags a literal in every shape a key has been, or could be, written in', () => {
    put('src/default.js', `const PRIVATE_KEY = process.env.SIGNER || "0x${hex()}";\n`);
    put('src/argument.js', `const wallet = new ethers.Wallet("0x${hex()}", provider);\n`);
    put('src/bare.ts', `export const signerKey = '${hex()}';\n`);
    put('src/template.js', `const k = \`0x${hex()}\`;\n`);
    put('src/multiline.js', `const OPERATOR =\n  "0x${hex()}";\n`);
    put('src/member.js', `module.exports = {\n  key:\n    '0x${hex()}',\n  list: [\n    "${hex()}",\n  ],\n};\n`);
    put('src/module.mjs', `export default { anything: '0x${hex()}' };\n`);
    put('scripts/legacy.cjs', `const secret = "${hex()}";\n`);
    put('scripts/component.tsx', `const k = "0x${hex()}";\n`);
    put('scripts/deep/nested/file.js', `\n\nconst deploy = "0x${hex()}";\n`);

    const hits = scan();
    assert.deepEqual(flagged(hits).sort(), [
      'scripts/component.tsx:1',
      'scripts/deep/nested/file.js:3',
      'scripts/legacy.cjs:1',
      'src/argument.js:1',
      'src/bare.ts:1',
      'src/default.js:1',
      'src/member.js:3',
      'src/member.js:5',
      'src/module.mjs:1',
      'src/multiline.js:2',
      'src/template.js:1',
    ]);
    const report = JSON.stringify(hits);
    assert.ok(planted.every((value) => !report.includes(value)), 'the report must never contain a literal');
  });

  it('reads the name a literal is bound to, across a line break, and none for a default or an argument', () => {
    put('src/names/bound.js', `const alpha = "${hex()}";\nbeta:\n  '${hex()}',\n`);
    put('src/names/unbound.js', `x(process.env.A || "${hex()}");\n`);
    const byLine = Object.fromEntries(
      scan().filter((hit) => hit.file.startsWith('src/names/')).map((hit) => [`${hit.file}:${hit.line}`, hit.name]),
    );
    assert.deepEqual(byLine, {
      'src/names/bound.js:1': 'alpha',
      'src/names/bound.js:3': 'beta',
      'src/names/unbound.js:1': null,
    });
  });

  it('lets a literal through only when BOTH its file and its name are on the allowlist', () => {
    put('src/services/ddcNFTMetadataService.js', `const CFG = {\n  keyHash: '${hex()}',\n  secret: '${hex()}',\n  alsoKeyHash: x || '${hex()}',\n};\n`);
    put('src/elsewhere.js', `const CFG = { keyHash: '${hex()}' };\n`);
    put('scripts/testPushNotification.js', `const pushToken = '${hex()}';\nconst other = process.env.T || '${hex()}';\n`);
    put('scripts/recordDataNFTToBlockchain.js', `const CONFIG = {\n  keyHash: '${hex()}',\n};\n`);

    const hits = scan().filter((hit) => /ddcNFTMetadataService|elsewhere|testPushNotification|recordDataNFTToBlockchain/.test(hit.file));
    const status = Object.fromEntries(hits.map((hit) => [`${hit.file}:${hit.line}`, hit.allowed]));
    assert.deepEqual(status, {
      'src/services/ddcNFTMetadataService.js:2': true,
      'src/services/ddcNFTMetadataService.js:3': false, // right file, wrong name
      'src/services/ddcNFTMetadataService.js:4': false, // right file, no name (a default)
      'src/elsewhere.js:1': false, // right name, wrong file
      'scripts/testPushNotification.js:1': true,
      'scripts/testPushNotification.js:2': false,
      'scripts/recordDataNFTToBlockchain.js:2': true,
    });
  });

  it('ignores what is not a 64-hex quoted literal in a source file under src/ or scripts/', () => {
    const baseline = scan().length;
    put('src/near-misses.js', [
      `const a = "${crypto.randomBytes(31).toString('hex')}";`, // 62 hex
      `const b = "0x${crypto.randomBytes(32).toString('hex')}00";`, // 66 hex after the prefix
      `const c = "${'g'.repeat(64)}";`, // 64 characters, not hex
      `const d = "${crypto.randomBytes(32).toString('hex')} ";`, // trailing space inside the quotes
    ].join('\n'));
    put('src/data.json', `{ "k": "${hex()}" }\n`); // not a script
    put('src/notes.md', `"${hex()}"\n`);
    put('src/node_modules/pkg/index.js', `const k = "${hex()}";\n`); // dependencies are not ours
    put('docs/example.js', `const k = "${hex()}";\n`); // outside src/ and scripts/
    put('test/fixture.js', `const k = "${hex()}";\n`);
    assert.equal(scan().length, baseline);
  });
});
