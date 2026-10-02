const app = require('./app');
const dotenv = require('dotenv');
const { assertPartnerConfig, assertFinancialGradeConfig } = require('./constants/partnerClient');
const { assertNativeAuthConfig, summaryLine: nativeAuthSummaryLine } = require('./services/nativeAuth/config');
const { applyPartnerKillSwitch } = require('./services/partnerKillSwitch');

// 加载环境变量
dotenv.config();

// Partner (TGE) SSO: refuse to boot half-configured. Throws with every problem listed; the
// summary never contains secrets.
const partnerSso = assertPartnerConfig();
console.log(
  partnerSso.enabled
    ? `Partner SSO enabled [${partnerSso.environment}] client=${partnerSso.clientId} redirectUris=${partnerSso.redirectUriCount} statusFields=${partnerSso.statusFields.join(',') || '(none)'} verifiedSession=${partnerSso.requireVerifiedSession} autoApprove=${partnerSso.autoApprove} rotationOpen=${partnerSso.rotationOpen}`
    : 'Partner SSO disabled',
);
// Kill switch, boot half: with the partner flow OFF, revoke every outstanding partner token so a
// later re-enable cannot revive one. Asynchronous and never throws — the partner paths are already
// closed while disabled, so nothing waits on it; a failure is logged at error level.
applyPartnerKillSwitch(partnerSso).then((result) => {
  if (!partnerSso.enabled) console.log(`Partner SSO kill switch: revoked ${result.revoked} outstanding partner token(s)${result.error ? ' — REVOKE FAILED, see error log' : ''}`);
});

// Money path: SSO_TGE_ENABLED=true also requires the deployment shape around it to be the
// hardened one (production, enforced ID-token verification with an explicit connection
// allow-list and pinned Web3Auth signing keys, separate session key, https issuer and consent
// origin). Same rule as above — refuse to start rather than serve it half-hardened. No secret
// values in the summary, and the pins only as a count.
const moneyPath = assertFinancialGradeConfig();
if (moneyPath.enforced) {
  console.log(
    `Partner SSO money-path assertions OK: nodeEnv=${moneyPath.nodeEnv} web3authVerify=${moneyPath.verifyMode} ` +
      `legacyFallback=${moneyPath.legacyFallback} allowedVerifiers=${moneyPath.allowedVerifierCount} ` +
      `jwksPinMode=${moneyPath.jwksPinMode} jwksPins=${moneyPath.jwksPinCount} ` +
      `sessionSecretSeparate=${moneyPath.sessionSecretSeparate} issuer=${moneyPath.publicBaseUrl} ` +
      `consentOrigin=${moneyPath.appPublicUrl} publicClientRegistration=${moneyPath.publicRegistration ? 'open' : 'closed'}` +
      (moneyPath.nativeAuth ? ` ${nativeAuthSummaryLine(moneyPath.nativeAuth)}` : ''),
  );
}

// Native login (DDC as the Web3Auth custom-JWT issuer). Off by default and then silent: nothing is
// read and nothing is printed. On: refuse to start while any rule of the design's boot list fails
// (every problem listed at once); the summary carries the public key thumbprint, never a secret.
const nativeAuth = assertNativeAuthConfig();

const PORT = process.env.PORT || 3000;

async function start() {
  // Native login with the KMS signer: before listening, fetch the KMS public key, check it is pinned
  // and not leaked, and sign + verify one throwaway token through KMS. Any failure refuses to start
  // (there is no fallback to a local key). Logs name the key id/version and the kid only.
  if (nativeAuth.enabled && nativeAuth.signer === 'kms') {
    const { prepareSigner } = require('./services/nativeAuth/signer');
    try {
      const kms = await prepareSigner();
      nativeAuth.kid = kms.kid;
      console.log(
        `Native login KMS signer ready: kid=${kms.kid} key=${kms.keyId}/${kms.keyVersionId} region=${kms.region} endpoint=${kms.endpoint}` +
          (kms.extraKids.length ? ` rotationKids=${kms.extraKids.join(',')}` : ''),
      );
    } catch (err) {
      console.error(`Native login (DDC_AUTH_SIGNER=kms) cannot use its KMS key; refusing to start:\n - ${err.publicMessage || err.message}`);
      process.exit(1);
    }
  }
  if (nativeAuth.enabled) console.log(`Native login enabled: ${nativeAuthSummaryLine(nativeAuth)}`);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();
