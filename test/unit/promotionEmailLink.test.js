/**
 * The promotion e-mail links to ONE app origin. FRONTEND_URL is the CORS allow-list and is often a
 * comma-separated list; pasting it whole into the href produced
 * "https://app.datadance.ai,https://business.datadance.ai/activities", a broken link.
 */
const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const SAVED = { ...process.env };
Object.assign(process.env, {
  SMTP_HOST: 'smtp.test.local',
  SMTP_PORT: '587',
  SMTP_USER: 'mailer',
  SMTP_PASS: 'not-a-real-password',
  SMTP_FROM: 'DataDance <noreply@test.local>',
});

// Capture what would be sent instead of opening an SMTP connection.
const sent = [];
const nodemailerPath = require.resolve('nodemailer');
require.cache[nodemailerPath] = {
  id: nodemailerPath,
  filename: nodemailerPath,
  loaded: true,
  exports: { createTransport: () => ({ sendMail: async (options) => { sent.push(options); } }) },
};

const originalLog = console.log;
console.log = () => {};
const { sendPromotionEmail } = require('../../src/utils/email');

const INFO = { promotionTitle: 'Autumn', promotionDescription: 'Desc', startDate: '2026-10-01', endDate: '2026-10-31' };

function hrefOf(html) {
  const match = html.match(/href="([^"]*)"/);
  return match && match[1];
}

after(() => {
  console.log = originalLog;
  delete require.cache[nodemailerPath];
  for (const key of Object.keys(process.env)) if (!(key in SAVED)) delete process.env[key];
  Object.assign(process.env, SAVED);
});

describe('sendPromotionEmail link', () => {
  beforeEach(() => {
    sent.length = 0;
    delete process.env.APP_PUBLIC_URL;
    delete process.env.FRONTEND_URL;
  });

  it('uses the first entry of a comma-separated FRONTEND_URL', async () => {
    process.env.FRONTEND_URL = 'https://app.datadance.ai, https://business.datadance.ai,https://admin.datadance.ai';
    await sendPromotionEmail('buyer@example.com', INFO);
    assert.equal(sent.length, 1);
    assert.equal(hrefOf(sent[0].html), 'https://app.datadance.ai/activities');
  });

  it('a single FRONTEND_URL with a trailing slash gives no double slash', async () => {
    process.env.FRONTEND_URL = 'https://app.datadance.ai/';
    await sendPromotionEmail('buyer@example.com', INFO);
    assert.equal(hrefOf(sent[0].html), 'https://app.datadance.ai/activities');
  });

  it('APP_PUBLIC_URL wins over FRONTEND_URL, like every other app link', async () => {
    process.env.APP_PUBLIC_URL = 'https://test-app.datadance.ai';
    process.env.FRONTEND_URL = 'https://app.datadance.ai,https://business.datadance.ai';
    await sendPromotionEmail('buyer@example.com', INFO);
    assert.equal(hrefOf(sent[0].html), 'https://test-app.datadance.ai/activities');
  });

  it('falls back to the production app when neither is set, never "undefined"', async () => {
    await sendPromotionEmail('buyer@example.com', INFO);
    assert.equal(hrefOf(sent[0].html), 'https://app.datadance.ai/activities');
    assert.equal(sent[0].html.includes('undefined'), false);
  });
});
