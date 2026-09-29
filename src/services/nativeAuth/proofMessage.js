/**
 * The wallet proof message (EIP-4361 / Sign-In with Ethereum), shared byte for byte with the
 * frontend (src/services/nativeLogin/proofMessage.ts). Both sides assert the same fixture,
 * test/fixtures/proofMessage.fixture.json — change the two implementations and the fixture
 * together, never one of them.
 *
 *   ${domain} wants you to sign in with your Ethereum account:
 *   ${EIP-55 address}
 *
 *   ${statement}
 *
 *   URI: ${uri}
 *   Version: 1
 *   Chain ID: ${chainId}
 *   Nonce: ${nonce}
 *   Issued At: ${issuedAt}
 *   Expiration Time: ${expirationTime}
 *   Request ID: ${requestId}
 *
 * Lines are joined with "\n", no trailing newline. issuedAt / expirationTime are copied verbatim
 * (the server issues them as ISO strings); the address is the only field normalised (checksummed).
 * `Request ID` is omitted when walletProof.requestId is absent (step-up challenges may omit it).
 */
const crypto = require('crypto');
const { getAddress } = require('ethers');

/** The DataDance chain (DDC_CHAIN on the frontend). */
const DDC_CHAIN_ID = 44508;
const DEFAULT_STATEMENT = 'Confirm your DataDance wallet for this sign-in.';
const PROOF_VERSION = '1';

const DOMAIN_PATTERN = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
const NONCE_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._~:@!$&'()*+,;=-]{1,128}$/;

function invalid(field) {
  return new TypeError(`walletProof.${field} is invalid`);
}

function assertField(ok, field) {
  if (!ok) throw invalid(field);
}

/** Build the exact message the wallet signs. Throws TypeError on any malformed field. */
function buildProofMessage(walletProof, address) {
  assertField(walletProof && typeof walletProof === 'object', 'object');
  const { domain, uri, chainId, statement, nonce, issuedAt, expirationTime, requestId } = walletProof;
  assertField(typeof domain === 'string' && DOMAIN_PATTERN.test(domain), 'domain');
  let parsedUri;
  try {
    parsedUri = new URL(uri);
  } catch {
    parsedUri = null;
  }
  assertField(typeof uri === 'string' && parsedUri && !/[\s]/.test(uri), 'uri');
  assertField(Number.isSafeInteger(chainId) && chainId > 0, 'chainId');
  assertField(typeof statement === 'string' && statement.length > 0 && !/[\r\n]/.test(statement), 'statement');
  assertField(typeof nonce === 'string' && NONCE_PATTERN.test(nonce), 'nonce');
  assertField(typeof issuedAt === 'string' && RFC3339_PATTERN.test(issuedAt), 'issuedAt');
  assertField(typeof expirationTime === 'string' && RFC3339_PATTERN.test(expirationTime), 'expirationTime');
  assertField(requestId === undefined || requestId === null || (typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId)), 'requestId');
  let checksummed;
  try {
    checksummed = getAddress(String(address));
  } catch {
    throw new TypeError('address is not an Ethereum address');
  }
  const lines = [
    `${domain} wants you to sign in with your Ethereum account:`,
    checksummed,
    '',
    statement,
    '',
    `URI: ${uri}`,
    `Version: ${PROOF_VERSION}`,
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
    `Expiration Time: ${expirationTime}`,
  ];
  if (requestId !== undefined && requestId !== null) lines.push(`Request ID: ${requestId}`);
  return lines.join('\n');
}

/**
 * The walletProof returned in `Identified` (§2.1): domain/URI from DDC_AUTH_PROOF_DOMAIN/_URI,
 * a fresh 32-hex nonce, issued now, expiring with the login attempt, requestId = loginRef.
 */
function createWalletProof({ cfg, loginRef, expiresAt, now = new Date(), statement = DEFAULT_STATEMENT }) {
  const proof = {
    domain: cfg.proofDomain,
    uri: cfg.proofUri,
    chainId: DDC_CHAIN_ID,
    statement,
    nonce: crypto.randomBytes(16).toString('hex'),
    issuedAt: now.toISOString(),
    expirationTime: new Date(expiresAt).toISOString(),
    requestId: loginRef,
  };
  // Fail at creation, not at /complete, if the configuration cannot produce a valid message.
  buildProofMessage(proof, '0x0000000000000000000000000000000000000000');
  return proof;
}

module.exports = { DDC_CHAIN_ID, DEFAULT_STATEMENT, PROOF_VERSION, buildProofMessage, createWalletProof };
