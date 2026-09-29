/**
 * The EIP-4361 wallet proof (design §2.1): the backend builder reproduces the shared fixture byte
 * for byte (the frontend asserts the same file), refuses malformed input, and the server-issued
 * walletProof always builds.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Wallet, verifyMessage } = require('ethers');

const { buildProofMessage, createWalletProof, DDC_CHAIN_ID, DEFAULT_STATEMENT } = require('../../src/services/nativeAuth/proofMessage');

const FIXTURE_PATH = path.join(__dirname, '../fixtures/proofMessage.fixture.json');
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

describe('buildProofMessage: shared fixture', () => {
  for (const c of fixture.cases) {
    it(`matches: ${c.name}`, () => {
      assert.equal(buildProofMessage(c.walletProof, c.address), c.message);
    });
  }
  for (const c of fixture.invalid) {
    it(`throws: ${c.name}`, () => {
      assert.throws(() => buildProofMessage(c.walletProof, c.address), TypeError);
    });
  }

  it('the fixture file is plain LF JSON with a trailing newline (byte-identical copies in both repos)', () => {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
    assert.ok(!raw.includes('\r'));
    assert.ok(raw.endsWith('}\n'));
  });
});

describe('createWalletProof', () => {
  const cfg = { proofDomain: 'localhost:20444', proofUri: 'https://localhost:20444' };

  it('issues the contract shape with a fresh 32-hex nonce, DDC chain id and loginRef as request id', () => {
    const now = new Date('2026-09-30T09:00:00.000Z');
    const expiresAt = new Date('2026-09-30T09:10:00.000Z');
    const a = createWalletProof({ cfg, loginRef: '0123456789abcdef', expiresAt, now });
    const b = createWalletProof({ cfg, loginRef: '0123456789abcdef', expiresAt, now });
    assert.deepEqual(Object.keys(a).sort(), ['chainId', 'domain', 'expirationTime', 'issuedAt', 'nonce', 'requestId', 'statement', 'uri']);
    assert.equal(a.chainId, DDC_CHAIN_ID);
    assert.equal(a.chainId, 44508);
    assert.equal(a.statement, DEFAULT_STATEMENT);
    assert.match(a.nonce, /^[0-9a-f]{32}$/);
    assert.notEqual(a.nonce, b.nonce);
    assert.equal(a.issuedAt, '2026-09-30T09:00:00.000Z');
    assert.equal(a.expirationTime, '2026-09-30T09:10:00.000Z');
    assert.equal(a.requestId, '0123456789abcdef');
  });

  it('a wallet signature over the message recovers the signer (what /complete checks)', async () => {
    const wallet = Wallet.createRandom();
    const proof = createWalletProof({ cfg, loginRef: 'abcdefabcdefabcd', expiresAt: Date.now() + 600_000 });
    const message = buildProofMessage(proof, wallet.address.toLowerCase());
    const signature = await wallet.signMessage(message);
    assert.equal(verifyMessage(message, signature), wallet.address);
    const other = createWalletProof({ cfg, loginRef: 'abcdefabcdefabcd', expiresAt: Date.now() + 600_000 });
    assert.notEqual(verifyMessage(buildProofMessage(other, wallet.address), signature), wallet.address, 'another nonce, another message');
  });

  it('refuses a configuration that cannot produce a valid message', () => {
    assert.throws(() => createWalletProof({ cfg: { proofDomain: 'https://x', proofUri: 'https://x' }, loginRef: 'a', expiresAt: Date.now() }), TypeError);
  });
});
