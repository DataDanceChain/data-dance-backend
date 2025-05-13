const nodemailer = require('nodemailer');

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
const transporter = missingEnvVars.length === 0 ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === 'true',
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

module.exports = {
  sendPromotionEmail,
  sendBulkPromotionEmails
}; 