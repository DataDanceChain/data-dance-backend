#!/usr/bin/env node
/**
 * Operator check for the native-login KMS signer (Aliyun KMS, decision 54). Run it ON A MACHINE THAT
 * HAS KMS ACCESS (the test or production server, or inside its API container), with the same
 * environment the API gets. It cannot run on a laptop without Alibaba Cloud credentials.
 *
 *   node scripts/nativeAuthKmsCheck.js
 *   node scripts/nativeAuthKmsCheck.js --jwks=https://test-api.datadance.ai/.well-known/ddc-auth/jwks.json
 *   node scripts/nativeAuthKmsCheck.js --print-jwks      # also print the public JWKS (public members only)
 *   node scripts/nativeAuthKmsCheck.js --json
 *
 * Reads: DDC_AUTH_KMS_KEY_ID, DDC_AUTH_KMS_KEY_VERSION_ID, DDC_AUTH_KMS_REGION (default
 * ap-southeast-1), DDC_AUTH_KMS_ENDPOINT / DDC_AUTH_KMS_CA_FILE (optional), DDC_AUTH_KMS_TIMEOUT_MS,
 * DDC_AUTH_KMS_EXTRA_KEYS, DDC_AUTH_JWKS_PINNED (or --pinned). Credentials come from the Alibaba
 * Cloud default credential chain (ECS RAM role, or ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET, ...), never
 * from arguments. DDC_AUTH_ENABLED does not need to be on.
 *
 * Steps:
 *   1. GetPublicKey: prints key id/version, RSA size and the kid (RFC 7638 thumbprint). The kid is
 *      the value DDC_AUTH_JWKS_PINNED must contain (it is public).
 *   2. AsymmetricSign (RSA_PKCS1_SHA_256) of one sample token through the same code path the API uses
 *      (signer/kmsSigner.js). The sample is useless as a login: iss/aud/sub are "ddc-kms-check" and
 *      it expires in 60 s. It is never printed.
 *   3. Verifies the sample with jose against the JWKS built from the KMS public key (checked by
 *      nativeAuthJwksCheck: public members only, kid = thumbprint, pinned, not the leaked key).
 *   4. With --jwks=<url|file>: fetches the PUBLISHED key set, runs the same publish-safety check, and
 *      verifies the sample against it (proves what the Web3Auth nodes read matches the KMS key).
 *
 * Output: identifiers, thumbprints and OK/FAIL lines only — no token, digest, signature or
 * credential. Exit codes: 0 all checks passed, 1 a check failed, 2 configuration or KMS error.
 */
const crypto = require('crypto');

const { readNativeAuthConfig, kmsProblems, parseKmsKeyRef } = require('../src/services/nativeAuth/config');
const { createKmsSigner } = require('../src/services/nativeAuth/signer/kmsSigner');
const { checkJwksText, loadJwksText, parsePinned } = require('./nativeAuthJwksCheck');

const SAMPLE_CLAIM = 'ddc-kms-check';

function parseArgs(argv) {
  const args = { jwks: '', pinned: '', json: false, printJwks: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--print-jwks') args.printJwks = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg.startsWith('--jwks=')) args.jwks = arg.slice('--jwks='.length);
    else if (arg.startsWith('--pinned=')) args.pinned = arg.slice('--pinned='.length);
    else throw new Error(`unknown argument ${arg.split('=')[0]}`);
  }
  return args;
}

function publicJwks(signer) {
  const member = (jwk, kid) => ({ kty: 'RSA', n: jwk.n, e: jwk.e, kid, alg: 'RS256', use: 'sig' });
  return { keys: [member(signer.publicJwk(), signer.kid), ...signer.extraPublicKeys().map((k) => member(k.jwk, k.thumbprint))] };
}

async function verifyAgainst(token, jwks, kid) {
  const jose = await import('jose');
  const { payload, protectedHeader } = await jose.jwtVerify(token, jose.createLocalJWKSet(jwks), {
    issuer: SAMPLE_CLAIM,
    audience: SAMPLE_CLAIM,
    algorithms: ['RS256'],
  });
  if (protectedHeader.kid !== kid) throw new Error('the token header kid is not the KMS key kid');
  if (payload.sub !== SAMPLE_CLAIM) throw new Error('unexpected subject');
}

/**
 * Runs the check. `env` and `client` (an aliyunKmsClient-shaped mock) are injectable for tests.
 * Returns { code, report } and writes through `out` / `err`.
 */
async function main(argv = process.argv.slice(2), { env = process.env, client, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`nativeAuthKmsCheck: ${e.message}`);
    return { code: 2 };
  }
  if (args.help) {
    out('usage: node scripts/nativeAuthKmsCheck.js [--jwks=<url|file>] [--pinned=<tp,tp>] [--print-jwks] [--json]');
    return { code: 0 };
  }
  const cfg = readNativeAuthConfig(env);
  const report = { keyId: cfg.kms.keyId, keyVersionId: cfg.kms.keyVersionId, region: cfg.kms.region, endpoint: cfg.kms.endpoint || `kms.${cfg.kms.region}.aliyuncs.com`, checks: [] };
  const line = (ok, name, detail = '') => {
    report.checks.push({ name, ok, detail });
    if (!args.json) (ok ? out : err)(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  };
  const finish = (code) => {
    report.ok = code === 0;
    if (args.json) out(JSON.stringify(report, null, 2));
    return { code, report };
  };

  const problems = kmsProblems(cfg);
  if (problems.length) {
    for (const problem of problems) line(false, 'configuration', problem);
    return finish(2);
  }
  if (!args.json) out(`KMS key ${report.keyId} version ${report.keyVersionId} via ${report.endpoint} (region ${report.region})`);

  const signer = createKmsSigner({
    keyId: cfg.kms.keyId,
    keyVersionId: cfg.kms.keyVersionId,
    region: cfg.kms.region,
    endpoint: cfg.kms.endpoint,
    caFile: cfg.kms.caFile,
    timeoutMs: cfg.kms.timeoutMs,
    extraKeys: cfg.kms.extraKeys.map(parseKmsKeyRef),
    client,
  });

  // 1. Public key.
  try {
    await signer.ready();
  } catch (e) {
    line(false, 'GetPublicKey', e.publicMessage || 'failed');
    return finish(2);
  }
  const bits = crypto.createPublicKey({ key: signer.publicJwk(), format: 'jwk' }).asymmetricKeyDetails.modulusLength;
  report.kid = signer.kid;
  report.modulusBits = bits;
  report.extraKids = signer.extraPublicKeys().map((k) => k.thumbprint);
  line(true, 'GetPublicKey', `RSA-${bits}, kid ${signer.kid}`);
  for (const extra of signer.extraPublicKeys()) line(true, 'GetPublicKey (rotation key)', `${extra.keyId}/${extra.keyVersionId} kid ${extra.thumbprint}`);

  // 2. Sign a sample through KMS (the signer verifies it locally before returning).
  let token;
  try {
    const iat = Math.floor(Date.now() / 1000);
    token = await signer.sign(
      { alg: 'RS256', typ: 'JWT', kid: signer.kid },
      { iss: SAMPLE_CLAIM, aud: SAMPLE_CLAIM, sub: SAMPLE_CLAIM, iat, exp: iat + 60, jti: crypto.randomUUID() },
    );
    line(true, 'AsymmetricSign', `RSA_PKCS1_SHA_256 signature verified with the KMS public key (sign count ${signer.signCount()})`);
  } catch (e) {
    line(false, 'AsymmetricSign', e.publicMessage || e.message);
    return finish(2);
  }

  // 3. The key set we would publish, and the sample against it.
  const pinnedSource = args.pinned || env.DDC_AUTH_JWKS_PINNED || '';
  let pinned;
  try {
    pinned = pinnedSource ? parsePinned(pinnedSource) : [];
  } catch (e) {
    line(false, 'DDC_AUTH_JWKS_PINNED', e.message);
    return finish(2);
  }
  const jwks = publicJwks(signer);
  let failed = false;
  if (!pinned.length) {
    line(false, 'pinned', `DDC_AUTH_JWKS_PINNED is empty; set DDC_AUTH_JWKS_PINNED=${[signer.kid, ...report.extraKids].join(',')}`);
    failed = true;
  } else {
    const local = checkJwksText(JSON.stringify(jwks), { pinned });
    if (local.ok) line(true, 'key set', `${jwks.keys.length} key(s), all pinned, public members only`);
    else {
      for (const e of local.errors) line(false, 'key set', e);
      failed = true;
    }
  }
  try {
    await verifyAgainst(token, jwks, signer.kid);
    line(true, 'verify (KMS key set)', 'jose RS256 verification passed');
  } catch (e) {
    line(false, 'verify (KMS key set)', e.message);
    failed = true;
  }

  // 4. The published key set.
  if (args.jwks) {
    let text;
    try {
      text = await loadJwksText(args.jwks, {});
    } catch (e) {
      line(false, 'published JWKS', `cannot load ${args.jwks}: ${e.message}`);
      return finish(1);
    }
    const published = checkJwksText(text, { pinned: pinned.length ? pinned : [signer.kid] });
    if (published.ok) line(true, 'published JWKS', `${args.jwks} passes the publish-safety check`);
    else {
      for (const e of published.errors) line(false, 'published JWKS', e);
      failed = true;
    }
    try {
      await verifyAgainst(token, JSON.parse(text), signer.kid);
      line(true, 'verify (published JWKS)', 'the KMS-signed sample verifies against the published key set');
    } catch (e) {
      line(false, 'verify (published JWKS)', e.message);
      failed = true;
    }
  }

  if (args.printJwks && !args.json) out(JSON.stringify(jwks, null, 2));
  if (args.printJwks) report.jwks = jwks;
  if (!args.json) out(failed ? 'RESULT: FAIL' : `RESULT: OK — DDC_AUTH_JWKS_PINNED must contain ${signer.kid}`);
  return finish(failed ? 1 : 0);
}

module.exports = { main, parseArgs, SAMPLE_CLAIM };

if (require.main === module) {
  main().then(
    ({ code }) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`nativeAuthKmsCheck: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
