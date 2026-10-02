/**
 * KMS signer: the production issuer key held in Aliyun KMS (decision 54: Singapore,
 * ap-southeast-1, the same cloud as the server). The private key never leaves KMS; this process
 * only ever holds the public key.
 *
 * Key: an asymmetric KMS key with KeySpec RSA_2048 and usage SIGN/VERIFY, named by key id (or
 * ARN) and key version id. Signing uses AsymmetricSign with Algorithm RSA_PKCS1_SHA_256, which is
 * JWS RS256 (RSASSA-PKCS1-v1_5 with SHA-256): we hash the JWS signing input ourselves and send the
 * base64 SHA-256 digest; KMS returns the base64 signature, which becomes the base64url third part
 * of the token.
 *
 * Same interface as signer/fileSigner.js, plus what an asynchronous key needs:
 *   kind              'kms'
 *   ready()           fetch and check the public key(s) once (GetPublicKey); must resolve before
 *                     kid / publicJwk() / extraPublicKeys() can be read. prepareSigner() in
 *                     signer/index.js runs it before the server listens.
 *   isReady()
 *   kid               RFC 7638 thumbprint of the KMS public key (stable for a key version)
 *   publicJwk()       { kty, n, e }
 *   extraPublicKeys() [{ jwk, thumbprint, keyId, keyVersionId }] for DDC_AUTH_KMS_EXTRA_KEYS: other
 *                     KMS key versions published for rotation (next / previous), never used to sign
 *   sign(header, payload) → Promise<compact JWS>
 *   selfTest()        one real sign + local verify (boot)
 *   signCount()       successful AsymmetricSign calls by this process (monitoring: compare with the
 *                     KMS-side count and with `native_auth.w3a_jwt_issued`)
 *   describe()        { keyId, keyVersionId, region, endpoint, credentials } — public identifiers only
 *
 * Fail closed: there is no fallback to a local key. A KMS error, a timeout, a signature from
 * another key version or one that does not verify against the published key rejects the mint.
 * Every call has a timeout and at most MAX_ATTEMPTS tries, retrying only transient failures
 * (network, timeout, 5xx, throttling). A failed key load is remembered for LOAD_RETRY_AFTER_MS so
 * the public JWKS route cannot turn into a KMS request per hit.
 *
 * Logs carry key id, key version, kid and KMS request ids only: never a digest, a signature, a
 * credential or key material.
 */
const crypto = require('crypto');

const KMS_SIGN_ALGORITHM = 'RSA_PKCS1_SHA_256';
const MIN_MODULUS_BITS = 2048;
const RSA_E_65537 = 'AQAB';
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = Object.freeze([100, 300]);
const LOAD_RETRY_AFTER_MS = 30 * 1000;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const SAFE_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const NETWORK_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);
const RETRYABLE_CODE_PATTERN = /throttl|serviceunavailable|internalfailure|internalerror|timeout|unavailable/i;
// @alicloud/credentials: the default chain found nothing (or the SDK's InvalidCredentials).
const NO_CREDENTIALS_PATTERN = /unable to get credentials|InvalidCredentials|set up the credentials/i;
const NO_CREDENTIALS_HINT =
  'no Alibaba Cloud credentials found (DDC_AUTH_KMS_CREDENTIALS=env: set ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET ' +
  "of a RAM user limited to kms:GetPublicKey and kms:AsymmetricSign on this environment's key; =chain, production only: the default chain " +
  'found nothing, e.g. no RAM role on the ECS instance)';

function config() {
  // Required lazily: config.js requires the signer lazily too (summarize), and this module is
  // only loaded through signer/index.js.
  return require('../config');
}

function kmsError(publicMessage, { retryable = false } = {}) {
  const err = new Error(publicMessage);
  err.publicMessage = publicMessage;
  err.kmsRetryable = retryable;
  return err;
}

/** A short, secret-free description of an SDK / network error: code, HTTP status, request id, message. */
function describeError(err) {
  if (!err) return 'unknown error';
  if (err.publicMessage) return err.publicMessage;
  const parts = [];
  if (isNoCredentials(err)) parts.push(NO_CREDENTIALS_HINT);
  const code = typeof err.code === 'string' && SAFE_CODE_PATTERN.test(err.code) ? err.code : '';
  if (code) parts.push(code);
  if (Number.isInteger(err.statusCode)) parts.push(`HTTP ${err.statusCode}`);
  const requestId = err.requestId || (err.data && err.data.RequestId);
  if (typeof requestId === 'string' && SAFE_CODE_PATTERN.test(requestId)) parts.push(`requestId ${requestId}`);
  const message = typeof err.message === 'string' ? err.message : '';
  // Long base64/hex runs (tokens, digests, signatures) are cut out of free text.
  const safeMessage = message.replace(/[A-Za-z0-9+/=_-]{24,}/g, '[…]').slice(0, 200);
  if (safeMessage) parts.push(safeMessage);
  return parts.join(' — ') || 'unknown error';
}

function isNoCredentials(err) {
  return Boolean(err) && !Number.isInteger(err.statusCode) && (NO_CREDENTIALS_PATTERN.test(String(err.message || '')) || err.code === 'InvalidCredentials');
}

function isRetryable(err) {
  if (!err) return false;
  if (typeof err.kmsRetryable === 'boolean') return err.kmsRetryable;
  if (isNoCredentials(err)) return false;
  const status = err.statusCode;
  if (Number.isInteger(status)) return status >= 500 || status === 429;
  if (typeof err.code === 'string' && (NETWORK_ERROR_CODES.has(err.code) || RETRYABLE_CODE_PATTERN.test(err.code))) return true;
  // A request that never got an HTTP answer (socket error without a known code).
  return /socket|network|timed? ?out|ECONN/i.test(String(err.message || ''));
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** `promise` or a retryable timeout error after `ms` (the timer is cleared as soon as either settles). */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(kmsError(`KMS ${label} timed out after ${ms} ms`, { retryable: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Runs `call` with a per-attempt timeout, retrying transient failures. Throws an Error whose
 * publicMessage names the operation, the attempts and the last failure (secret-free).
 */
async function callKms(label, call, { timeoutMs, maxAttempts = MAX_ATTEMPTS, backoffMs = BACKOFF_MS, wait = sleep, onFailure } = {}) {
  let last;
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await withTimeout(Promise.resolve().then(call), timeoutMs, label);
    } catch (err) {
      last = err;
      if (onFailure) onFailure(err);
      if (!isRetryable(err) || attempt >= maxAttempts) break;
      await wait(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
    }
  }
  throw kmsError(`KMS ${label} failed after ${attempt} attempt(s): ${describeError(last)}`);
}

/**
 * GetPublicKey PEM → { jwk {kty,n,e}, thumbprint, publicKey (KeyObject), modulusBytes }. Refuses
 * anything but an RSA key of at least 2048 bits with e = 65537.
 */
function publicKeyFromPem(pem, label) {
  if (typeof pem !== 'string' || !pem.includes('-----BEGIN')) throw kmsError(`${label}: KMS returned no PEM public key`);
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: pem, format: 'pem' });
  } catch {
    throw kmsError(`${label}: the KMS public key cannot be parsed`);
  }
  if (publicKey.asymmetricKeyType !== 'rsa') {
    throw kmsError(`${label}: the KMS key is not RSA (create it with KeySpec RSA_2048 and usage SIGN/VERIFY)`);
  }
  const bits = publicKey.asymmetricKeyDetails && publicKey.asymmetricKeyDetails.modulusLength;
  if (!bits || bits < MIN_MODULUS_BITS) throw kmsError(`${label}: the RSA modulus must be at least ${MIN_MODULUS_BITS} bits`);
  const exported = publicKey.export({ format: 'jwk' });
  if (exported.e !== RSA_E_65537) throw kmsError(`${label}: the RSA public exponent must be 65537`);
  const jwk = { kty: 'RSA', n: exported.n, e: exported.e };
  return { jwk, thumbprint: config().rsaThumbprint(jwk), publicKey, modulusBytes: Math.ceil(bits / 8) };
}

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function keyLabel(ref) {
  return `KMS key ${ref.keyId} version ${ref.keyVersionId}`;
}

/**
 * Options: keyId, keyVersionId, region, endpoint, caFile, timeoutMs, credentials ('env' | 'chain',
 * see aliyunKmsClient.js), extraKeys ([{keyId, keyVersionId}]); tests inject `client` (the aliyunKmsClient interface), `now` and `wait`.
 * Throws (publicMessage) on a missing key id / version; does not touch the network.
 */
function createKmsSigner({
  keyId,
  keyVersionId,
  region,
  endpoint = '',
  caFile = '',
  timeoutMs = 3000,
  credentials = 'env',
  extraKeys = [],
  client: injectedClient = null,
  now = Date.now,
  wait = sleep,
} = {}) {
  if (!keyId) throw kmsError('DDC_AUTH_KMS_KEY_ID is not configured');
  if (!keyVersionId) throw kmsError('DDC_AUTH_KMS_KEY_VERSION_ID is not configured');
  const main = { keyId, keyVersionId };
  const extras = extraKeys.map((ref) => ({ keyId: ref.keyId, keyVersionId: ref.keyVersionId }));
  const state = { active: null, extra: [], loading: null, failedAt: 0, failure: null, signs: 0 };
  let client = injectedClient;
  // After a failure that got no HTTP answer (credentials, network, timeout) the SDK client is
  // rebuilt for the next attempt: @alicloud/credentials 2.4.7's default chain otherwise sticks to
  // the LAST provider it tried after a complete miss, so it would never find e.g. the ECS RAM role
  // again once the metadata service had a hiccup.
  const callOptions = {
    timeoutMs,
    wait,
    onFailure(err) {
      if (!injectedClient && !Number.isInteger(err && err.statusCode)) client = null;
    },
  };

  function kms() {
    if (!client) {
      const { createAliyunKmsClient } = require('./aliyunKmsClient');
      client = createAliyunKmsClient({ region, endpoint, caFile, timeoutMs, credentials });
    }
    return client;
  }

  async function loadKey(ref) {
    const label = keyLabel(ref);
    const res = await callKms('GetPublicKey', () => kms().getPublicKey({ keyId: ref.keyId, keyVersionId: ref.keyVersionId }), callOptions);
    if (!res || (res.keyVersionId && res.keyVersionId !== ref.keyVersionId)) {
      throw kmsError(`${label}: GetPublicKey answered for another key version`);
    }
    return { ...publicKeyFromPem(res.publicKey, label), ref };
  }

  function requireReady() {
    if (!state.active) {
      if (state.failure) throw kmsError(`the KMS signing key could not be loaded: ${state.failure.publicMessage}`);
      throw kmsError(`the KMS signing key is not loaded yet (${keyLabel(main)}); prepareSigner() fetches it at start`);
    }
    return state.active;
  }

  async function load() {
    const active = await loadKey(main);
    const extra = [];
    for (const ref of extras) extra.push(await loadKey(ref));
    state.active = active;
    state.extra = extra;
    config().logger.info('native_auth.kms_key_loaded', {
      keyId: main.keyId,
      keyVersionId: main.keyVersionId,
      kid: active.thumbprint,
      extra: extra.map((k) => ({ keyId: k.ref.keyId, keyVersionId: k.ref.keyVersionId, kid: k.thumbprint })),
    });
  }

  function ready() {
    if (state.active) return Promise.resolve();
    if (state.loading) return state.loading;
    if (state.failure && now() - state.failedAt < LOAD_RETRY_AFTER_MS) return Promise.reject(state.failure);
    state.loading = load().then(
      () => {
        state.failure = null;
        state.loading = null;
      },
      (err) => {
        state.failure = err.publicMessage ? err : kmsError(`loading ${keyLabel(main)} failed: ${describeError(err)}`);
        state.failedAt = now();
        state.loading = null;
        config().logger.error('native_auth.kms_key_load_failed', { keyId: main.keyId, keyVersionId: main.keyVersionId, problem: state.failure.publicMessage });
        throw state.failure;
      },
    );
    return state.loading;
  }

  async function sign(header, payload) {
    if (!header || header.alg !== 'RS256') throw new Error('kmsSigner signs RS256 only');
    await ready();
    const { thumbprint, publicKey, modulusBytes } = requireReady();
    if (header.kid !== undefined && header.kid !== thumbprint) throw new Error('kmsSigner: header kid does not name this key');
    const signingInput = `${b64urlJson({ ...header, kid: thumbprint })}.${b64urlJson(payload)}`;
    const message = Buffer.from(signingInput, 'ascii');
    const digest = crypto.createHash('sha256').update(message).digest('base64');
    const res = await callKms(
      'AsymmetricSign',
      () => kms().asymmetricSign({ keyId: main.keyId, keyVersionId: main.keyVersionId, algorithm: KMS_SIGN_ALGORITHM, digest }),
      callOptions,
    );
    if (!res || (res.keyVersionId && res.keyVersionId !== main.keyVersionId)) {
      throw kmsError(`${keyLabel(main)}: AsymmetricSign answered for another key version`);
    }
    if (typeof res.value !== 'string' || !BASE64_PATTERN.test(res.value)) throw kmsError(`${keyLabel(main)}: AsymmetricSign returned no base64 signature`);
    const signature = Buffer.from(res.value, 'base64');
    if (signature.length !== modulusBytes) throw kmsError(`${keyLabel(main)}: the KMS signature has the wrong length`);
    // Never hand out a token the published key does not verify (wrong algorithm, key or digest).
    if (!crypto.verify('sha256', message, publicKey, signature)) {
      throw kmsError(`${keyLabel(main)}: the KMS signature does not verify against the published public key`);
    }
    state.signs += 1;
    return `${signingInput}.${signature.toString('base64url')}`;
  }

  return Object.freeze({
    kind: 'kms',
    get kid() {
      return requireReady().thumbprint;
    },
    publicJwk: () => ({ ...requireReady().jwk }),
    extraPublicKeys: () => {
      requireReady();
      return state.extra.map((k) => ({ jwk: { ...k.jwk }, thumbprint: k.thumbprint, keyId: k.ref.keyId, keyVersionId: k.ref.keyVersionId }));
    },
    ready,
    isReady: () => Boolean(state.active),
    sign,
    async selfTest() {
      await ready();
      const kid = requireReady().thumbprint;
      const iat = Math.floor(now() / 1000);
      const token = await sign({ alg: 'RS256', typ: 'JWT', kid }, { purpose: 'ddc-kms-self-test', iat, exp: iat });
      config().logger.info('native_auth.kms_self_test', { keyId: main.keyId, keyVersionId: main.keyVersionId, kid, signCount: state.signs });
      return token;
    },
    signCount: () => state.signs,
    describe: () => ({ keyId: main.keyId, keyVersionId: main.keyVersionId, region, endpoint: endpoint || `kms.${region}.aliyuncs.com`, credentials }),
  });
}

module.exports = {
  KMS_SIGN_ALGORITHM,
  MAX_ATTEMPTS,
  LOAD_RETRY_AFTER_MS,
  createKmsSigner,
  publicKeyFromPem,
  callKms,
  isRetryable,
  isNoCredentials,
  describeError,
};
