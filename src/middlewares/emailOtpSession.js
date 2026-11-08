/**
 * A temporary email-code session may use the app and the Planet hand-off.
 * It may not change the password, bind or replace a wallet, or link X.
 */
function rejectEmailOtpSession(req, res, next) {
  if (req.authClaims && req.authClaims.amr === 'email_otp') {
    return res.status(403).json({
      status: 'fail',
      code: 'EMAIL_OTP_SESSION_RESTRICTED',
      message: 'This email sign-in cannot change the account. Use the usual sign-in for that.',
    });
  }
  return next();
}

module.exports = { rejectEmailOtpSession };
