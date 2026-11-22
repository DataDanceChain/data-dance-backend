const express = require('express');
const { register, login } = require('../controllers/authController');
const {
  observeEmailOtp, sendEmailCode, verifyEmailCode, sendRecoveryEmailCode, verifyRecoveryEmailCode,
} = require('../controllers/emailOtpController');
const { sendEmailBindCode, verifyEmailBindCode } = require('../controllers/emailBindController');
const { protect } = require('../middlewares/authMiddleware');
const { rejectEmailOtpSession } = require('../middlewares/emailOtpSession');
const { rateLimiters } = require('../middlewares/rateLimitMiddleware');
const { registerUsageLog } = require('../middlewares/registerUsageLog');
const router = express.Router();

// 注册路由 — the public e-mail + password sign-up (decision 43 A: throttled and logged, not closed).
// The usage log runs first so a rate-limited call is still one log line; then every attempt is
// counted per IP and per e-mail; `auth` (failures only, shared with /login) stays as it was.
router.post('/register', registerUsageLog, rateLimiters.registerIp, rateLimiters.registerEmail, rateLimiters.auth, register);

// 登录路由
router.post('/login', rateLimiters.auth, login);

// Temporary email-code sign-in. Closed unless EMAIL_OTP_LOGIN=true.
router.post('/email-code/send', observeEmailOtp('send'), rateLimiters.emailOtpSend, sendEmailCode);
router.post('/email-code/verify', observeEmailOtp('verify'), rateLimiters.emailOtpVerify, verifyEmailCode);

// A recovery code can sign in to an existing mailbox. It cannot register a replacement account.
router.post('/email-code/recovery/send', observeEmailOtp('recovery_send'), rateLimiters.emailOtpSend, sendRecoveryEmailCode);
router.post('/email-code/recovery/verify', observeEmailOtp('recovery_verify'), rateLimiters.emailOtpVerify, verifyRecoveryEmailCode);

// Bind a mailbox the user typed. The Web3Auth session is required. A code session cannot
// use this to change the address it just signed in with.
router.post('/email-bind/send', protect, rejectEmailOtpSession, rateLimiters.emailBindSend, sendEmailBindCode);
router.post('/email-bind/verify', protect, rejectEmailOtpSession, rateLimiters.emailBindVerify, verifyEmailBindCode);

// X binding handled via Web3Auth adapter — no direct custom routes

module.exports = router;
