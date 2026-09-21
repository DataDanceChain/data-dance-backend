const app = require('./app');
const dotenv = require('dotenv');
const { assertPartnerConfig } = require('./constants/partnerClient');

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

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
