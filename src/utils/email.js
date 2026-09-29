const nodemailer = require('nodemailer');
const { renderLoginCodeEmail } = require('../i18n/authEmail');

// 检查必要的环境变量
const requiredEnvVars = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM'
];

const missingEnvVars = requiredEnvVars.filter(varName => !process.env[varName]);
if (missingEnvVars.length > 0) {
  console.warn('Warning: Missing SMTP environment variables:', missingEnvVars.join(', '));
  console.warn('Email functionality will be disabled');
}

// ---------------------------------------------------------------------------
// Transport
//
// The nodemailer transporter is created lazily, on the first send, from the
// SMTP_* environment at that moment, and re-created when that configuration
// changes. A send without the configuration it needs throws an error with
// code EMAIL_NOT_CONFIGURED at send time; nothing is thrown at load time.
//
// Promotion mail keeps its original requirement (all of SMTP_HOST, SMTP_PORT,
// SMTP_USER, SMTP_PASS, SMTP_FROM). The native sign-in code mail needs only
// SMTP_HOST and SMTP_PORT (authentication only when SMTP_USER is set) so a
// local catcher such as Mailpit (SMTP on 127.0.0.1:1025, no auth) works.
// ---------------------------------------------------------------------------

const LOGIN_CODE_SEND_TIMEOUT_MS = 10000;

function emailNotConfigured(missing) {
  const err = new Error(`Email is not configured (missing ${missing.join(', ')})`);
  err.code = 'EMAIL_NOT_CONFIGURED';
  return err;
}

function smtpSettings(env = process.env) {
  return {
    host: String(env.SMTP_HOST || '').trim(),
    port: parseInt(env.SMTP_PORT),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
  };
}

const cachedTransports = new Map();

/**
 * The transporter for the current SMTP_* configuration, one per purpose.
 * - 'promotion': SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM are required, and the
 *   transporter options are exactly the ones promotion mail always used.
 * - 'login': SMTP_HOST and SMTP_PORT are required; auth only when SMTP_USER is set; connection,
 *   greeting and socket timeouts of LOGIN_CODE_SEND_TIMEOUT_MS.
 */
function getTransporter({ purpose = 'login', env = process.env } = {}) {
  const promotion = purpose === 'promotion';
  const required = promotion ? requiredEnvVars : ['SMTP_HOST', 'SMTP_PORT'];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw emailNotConfigured(missing);
  const settings = smtpSettings(env);
  if (!promotion && (!Number.isInteger(settings.port) || settings.port <= 0)) throw emailNotConfigured(['a numeric SMTP_PORT']);
  const key = JSON.stringify([settings.host, settings.port, settings.secure, settings.user, settings.pass]);
  const cached = cachedTransports.get(purpose);
  if (cached && cached.key === key) return cached.transporter;
  const options = { host: settings.host, port: settings.port, secure: settings.secure };
  if (promotion) {
    options.auth = { user: settings.user, pass: settings.pass };
  } else {
    Object.assign(options, {
      connectionTimeout: LOGIN_CODE_SEND_TIMEOUT_MS,
      greetingTimeout: LOGIN_CODE_SEND_TIMEOUT_MS,
      socketTimeout: LOGIN_CODE_SEND_TIMEOUT_MS,
    });
    if (settings.user) options.auth = { user: settings.user, pass: settings.pass };
  }
  const transporter = nodemailer.createTransport(options);
  cachedTransports.set(purpose, { key, transporter });
  return transporter;
}

/** Tests only: forget the cached transporters. */
function resetEmailTransport() {
  cachedTransports.clear();
}

/**
 * 发送推广活动邮件
 * @param {string} to 收件人邮箱
 * @param {Object} promotionInfo 推广活动信息
 * @returns {Promise<void>}
 */
const sendPromotionEmail = async (to, promotionInfo) => {
  const { promotionTitle, promotionDescription, startDate, endDate } = promotionInfo;

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to,
    subject: `New Promotion: ${promotionTitle}`,
    html: `
      <h1>${promotionTitle}</h1>
      <p>${promotionDescription}</p>
      <p>Start Date: ${new Date(startDate).toLocaleDateString()}</p>
      <p>End Date: ${new Date(endDate).toLocaleDateString()}</p>
      <p>Click here to view more details: <a href="${process.env.FRONTEND_URL}/activities">View Promotion</a></p>
    `
  };

  try {
    await getTransporter({ purpose: 'promotion' }).sendMail(mailOptions);
    console.log(`Promotion email sent to ${to}`);
  } catch (error) {
    console.error('Error sending promotion email:', error);
    throw error;
  }
};

/**
 * 批量发送推广活动邮件
 * @param {Array<Object>} recipients 收件人列表
 * @param {Object} promotionInfo 推广活动信息
 * @returns {Promise<void>}
 */
const sendBulkPromotionEmails = async (recipients, promotionInfo) => {
  const promises = recipients.map(recipient =>
    sendPromotionEmail(recipient.email, promotionInfo)
  );

  try {
    await Promise.all(promises);
    console.log(`Successfully sent promotion emails to ${recipients.length} recipients`);
  } catch (error) {
    console.error('Error sending bulk promotion emails:', error);
    throw error;
  }
};

/**
 * Native sign-in code mail (design §3.3). Subject without the code; plain text + HTML, no links.
 * Sender: DDC_AUTH_EMAIL_FROM (falls back to SMTP_FROM). Rejects within `timeoutMs` (10 s) with
 * code EMAIL_SEND_TIMEOUT; without SMTP configuration with code EMAIL_NOT_CONFIGURED. Logs
 * nothing: the caller logs a masked address, never the code or the recipient.
 *
 * @param {string} to normalised recipient address
 * @param {string} code the 6-digit code
 * @param {string} locale client locale tag (en, zh, zh-TW, ja, ko; anything else → en)
 * @param {{ttlMinutes?: number, userAgent?: string, country?: string}} context
 * @returns {Promise<{messageId?: string, locale: string}>}
 */
async function sendLoginCodeEmail(to, code, locale, context = {}, { timeoutMs = LOGIN_CODE_SEND_TIMEOUT_MS, env = process.env } = {}) {
  const from = String(env.DDC_AUTH_EMAIL_FROM || env.SMTP_FROM || '').trim();
  if (!from) throw emailNotConfigured(['DDC_AUTH_EMAIL_FROM']);
  const transporter = getTransporter({ purpose: 'login', env });
  const mail = renderLoginCodeEmail({ code, locale, ttlMinutes: context.ttlMinutes, context });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Sending the sign-in code timed out');
      err.code = 'EMAIL_SEND_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    const info = await Promise.race([
      transporter.sendMail({
        from,
        to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' },
      }),
      timeout,
    ]);
    return { messageId: info && info.messageId, locale: mail.locale };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  sendPromotionEmail,
  sendBulkPromotionEmails,
  sendLoginCodeEmail,
  getTransporter,
  resetEmailTransport,
  LOGIN_CODE_SEND_TIMEOUT_MS,
};
