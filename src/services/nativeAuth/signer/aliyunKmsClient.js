/**
 * The two Aliyun KMS calls the KMS signer needs, through the official Alibaba Cloud SDK
 * (@alicloud/kms20160120 on @alicloud/openapi-core; ACS3-HMAC-SHA256 request signing):
 *
 *   getPublicKey({ keyId, keyVersionId })                        → { keyId, keyVersionId, publicKey (PEM), requestId }
 *   asymmetricSign({ keyId, keyVersionId, algorithm, digest })   → { keyId, keyVersionId, value (base64), requestId }
 *
 * `digest` is the BASE64 (standard alphabet, padded) of the SHA-256 digest of the message, which is
 * what AsymmetricSign expects for RSA_PKCS1_SHA_256; `value` comes back as standard base64.
 *
 * Credentials: never in code or in DDC_AUTH_* variables. The SDK's default credential chain
 * (@alicloud/credentials) is used, in its order: ALIBABA_CLOUD_ACCESS_KEY_ID /
 * ALIBABA_CLOUD_ACCESS_KEY_SECRET (+ ALIBABA_CLOUD_SECURITY_TOKEN), OIDC role (RRSA), the
 * ~/.aliyun CLI profile, ~/.alibabacloud/credentials, then the ECS instance RAM role from the
 * instance metadata service (IMDSv2 first), then ALIBABA_CLOUD_CREDENTIALS_URI.
 *
 * Endpoint: kms.<region>.aliyuncs.com unless DDC_AUTH_KMS_ENDPOINT names another Alibaba Cloud host
 * (config.kmsProblems enforces *.aliyuncs.com). Always https. A dedicated KMS instance gateway
 * presents a certificate from the instance CA; DDC_AUTH_KMS_CA_FILE supplies that bundle.
 *
 * The SDK is required lazily, so nothing is loaded unless DDC_AUTH_SIGNER=kms is in use. The SDK's
 * own retry is left off (its default); kmsSigner.js times out and retries each call itself.
 *
 * `protocol` and `credential` exist for the wire-format test (a loopback fake KMS with a throwaway
 * access key); configuration never sets them.
 */
const fs = require('fs');

const CONNECT_TIMEOUT_CAP_MS = 2000;

function createAliyunKmsClient({ region, endpoint, caFile, timeoutMs, protocol, credential } = {}) {
  const { $OpenApiUtil } = require('@alicloud/openapi-core');
  const Kms = require('@alicloud/kms20160120');
  const Credential = require('@alicloud/credentials').default;

  const config = new $OpenApiUtil.Config({
    regionId: region,
    endpoint: endpoint || `kms.${region}.aliyuncs.com`,
    credential: credential || new Credential(),
    readTimeout: timeoutMs,
    connectTimeout: Math.min(timeoutMs, CONNECT_TIMEOUT_CAP_MS),
  });
  if (protocol) config.protocol = protocol;
  if (caFile) config.ca = fs.readFileSync(caFile, 'utf8');
  const client = new Kms.default(config);

  return {
    async getPublicKey({ keyId, keyVersionId }) {
      const res = await client.getPublicKey(new Kms.GetPublicKeyRequest({ keyId, keyVersionId }));
      const body = (res && res.body) || {};
      return { keyId: body.keyId, keyVersionId: body.keyVersionId, publicKey: body.publicKey, requestId: body.requestId };
    },
    async asymmetricSign({ keyId, keyVersionId, algorithm, digest }) {
      const res = await client.asymmetricSign(new Kms.AsymmetricSignRequest({ keyId, keyVersionId, algorithm, digest }));
      const body = (res && res.body) || {};
      return { keyId: body.keyId, keyVersionId: body.keyVersionId, value: body.value, requestId: body.requestId };
    },
  };
}

module.exports = { createAliyunKmsClient };
