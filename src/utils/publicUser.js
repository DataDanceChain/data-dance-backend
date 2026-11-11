const { withDisplayReferralCode } = require('./referralCodeFormat');

function publicUser(user) {
  const { password, privateKey, xAccessToken, xRefreshToken, loginEmail, ...rest } = user;
  return withDisplayReferralCode(rest);
}

module.exports = { publicUser };
