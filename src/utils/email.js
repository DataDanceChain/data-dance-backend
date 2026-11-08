const nodemailer = require('nodemailer');
const { appPublicUrl } = require('../constants/lifeContext');

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

// Create a transporter only if all required env vars are present
const smtpPort = parseInt(process.env.SMTP_PORT, 10);
const smtpSecure = process.env.SMTP_SECURE === 'true';
const transporter = missingEnvVars.length === 0 ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: smtpPort,
  secure: smtpSecure,
  // Port 587 speaks STARTTLS. Require it so the password is not offered in cleartext.
  requireTLS: !smtpSecure && smtpPort === 587,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
}) : null;

/**
 * 发送推广活动邮件
 * @param {string} to 收件人邮箱
 * @param {Object} promotionInfo 推广活动信息
 * @returns {Promise<void>}
 */
const sendPromotionEmail = async (to, promotionInfo) => {
  const { promotionTitle, promotionDescription, startDate, endDate } = promotionInfo;
  // FRONTEND_URL is the CORS allow-list and may be a comma-separated list; the link needs ONE
  // origin. appPublicUrl() is the app's public URL: APP_PUBLIC_URL, else FRONTEND_URL's first entry.

  const mailOptions = {
    from: process.env.SMTP_FROM,
    to,
    subject: `New Promotion: ${promotionTitle}`,
    html: `
      <h1>${promotionTitle}</h1>
      <p>${promotionDescription}</p>
      <p>Start Date: ${new Date(startDate).toLocaleDateString()}</p>
      <p>End Date: ${new Date(endDate).toLocaleDateString()}</p>
      <p>Click here to view more details: <a href="${appPublicUrl()}/activities">View Promotion</a></p>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
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
 * One-time login code. The code is the message body and must not be logged by the caller.
 * @param {string} to
 * @param {string} code
 */
const sendLoginCodeEmail = async (to, code) => {
  if (!transporter) {
    const error = new Error('Email is not configured');
    error.code = 'EMAIL_DISABLED';
    throw error;
  }
  await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject: 'Your DataDance login code',
    text: `Your DataDance login code is ${code}.\n\nIt expires in 10 minutes. If you did not ask for this, you can ignore this email.\n`,
    html: `<p>Your DataDance login code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not ask for this, you can ignore this email.</p>`,
  });
};

module.exports = {
  sendPromotionEmail,
  sendBulkPromotionEmails,
  sendLoginCodeEmail,
}; 