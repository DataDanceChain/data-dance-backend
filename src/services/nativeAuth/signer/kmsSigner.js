/**
 * KMS signer: the production issuer key, held in a cloud KMS (asymmetric RSA_SIGN_PKCS1_2048_SHA256
 * or the vendor's equivalent), never exported. v1 ships the interface only: the KMS vendor and who
 * may rotate the key are decided before the mainnet cut (question 8), so this refuses to start.
 * Boot already refuses DDC_AUTH_SIGNER=kms with a clear message; this throw is the second fence.
 *
 * To implement (same interface as signer/fileSigner.js):
 *   kind        'kms'
 *   kid         RFC 7638 thumbprint of the KMS public key (fetched once at start, then pinned)
 *   publicJwk() { kty, n, e }
 *   sign(header, payload) → Promise<compact JWS> via the KMS Sign call on sha256(signingInput)
 * and log the KMS Sign count next to `native_auth.w3a_jwt_issued` (prod monitoring precondition).
 */
function createKmsSigner({ kmsKeyId } = {}) {
  const err = new Error(
    `DDC_AUTH_SIGNER=kms is not implemented in v1${kmsKeyId ? '' : ' (and DDC_AUTH_KMS_KEY_ID is unset)'}; ` +
      'the KMS signer is built with the mainnet cut',
  );
  err.publicMessage = err.message;
  throw err;
}

module.exports = { createKmsSigner };
