const app = require('./app');
const dotenv = require('dotenv');
const { assertPartnerConfig, assertFinancialGradeConfig } = require('./constants/partnerClient');

// 加载环境变量
dotenv.config();

// Partner (TGE) SSO: refuse to boot half-configured. Throws with every problem listed; the
// summary never contains secrets.
const partnerSso = assertPartnerConfig();
console.log(
  partnerSso.enabled
    ? `Partner SSO enabled [${partnerSso.environment}] client=${partnerSso.clientId} redirectUris=${partnerSso.redirectUriCount} statusFields=${partnerSso.statusFields.join(',') || '(none)'} verifiedSession=${partnerSso.requireVerifiedSession} rotationOpen=${partnerSso.rotationOpen}`
    : 'Partner SSO disabled',
);

// Money path: SSO_TGE_ENABLED=true also requires the deployment shape around it to be the
// hardened one (production, enforced ID-token verification with an explicit connection
// allow-list, separate session key, https issuer and consent origin). Same rule as above —
// refuse to start rather than serve it half-hardened. No secret values in the summary.
const moneyPath = assertFinancialGradeConfig();
if (moneyPath.enforced) {
  console.log(
    `Partner SSO money-path assertions OK: nodeEnv=${moneyPath.nodeEnv} web3authVerify=${moneyPath.verifyMode} ` +
      `legacyFallback=${moneyPath.legacyFallback} allowedVerifiers=${moneyPath.allowedVerifierCount} ` +
      `sessionSecretSeparate=${moneyPath.sessionSecretSeparate} issuer=${moneyPath.publicBaseUrl} ` +
      `consentOrigin=${moneyPath.appPublicUrl} publicClientRegistration=${moneyPath.publicRegistration ? 'open' : 'closed'}`,
  );
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
