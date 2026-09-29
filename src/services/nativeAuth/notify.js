/**
 * Link / unlink notices (design §3.8, F2, F19): every change to an account's sign-in methods is
 * mailed to the account's strong e-mail addresses, so a stolen session that somehow passed the
 * step-up still cannot change the methods silently.
 *
 *   renderIdentityNotice({ kind, provider, methodEmailMasked, locale, at, context })
 *       → { locale, subject, text, html }
 *   strongEmailsOf({ user, identities, cfg }) → lower-cased addresses, deduplicated
 *   sendIdentityNotices({ to, kind, provider, methodEmailMasked, locale, at, context, loginRef })
 *
 * Transport: the sign-in code mail's (src/utils/email.js getTransporter({ purpose: 'login' }),
 * sender DDC_AUTH_EMAIL_FROM falling back to SMTP_FROM, 10 s timeout). A notice never fails the
 * request that caused it: a failed send is logged (masked address, never the address itself) and
 * the change stands.
 *
 * Mail content rules (as the code mail): plain text + HTML, no links, no images, no tracking; the
 * request context is reduced to a fixed browser/OS name and a country name (the raw User-Agent is
 * never copied into the mail); the method's own address is masked.
 */
const { getTransporter, LOGIN_CODE_SEND_TIMEOUT_MS } = require('../../utils/email');
const { normalizeAuthLocale, describeUserAgent, countryName } = require('../../i18n/authEmail');
const { maskEmail } = require('../../utils/emailMask');
const { logger } = require('./config');
const accounts = require('./accounts');

const NOTICE_KINDS = Object.freeze(['linked', 'unlinked']);

const PROVIDER_NAMES = Object.freeze({
  email: { en: 'E-mail code', zh: '邮箱验证码', 'zh-TW': '電子郵件驗證碼', ja: 'メールコード', ko: '이메일 코드' },
  google: { en: 'Google', zh: 'Google', 'zh-TW': 'Google', ja: 'Google', ko: 'Google' },
  apple: { en: 'Apple', zh: 'Apple', 'zh-TW': 'Apple', ja: 'Apple', ko: 'Apple' },
  x: { en: 'X', zh: 'X', 'zh-TW': 'X', ja: 'X', ko: 'X' },
});

const STRINGS = Object.freeze({
  en: {
    subject: { linked: 'A sign-in method was added to your DataDance account', unlinked: 'A sign-in method was removed from your DataDance account' },
    intro: { linked: 'A new sign-in method was added to your DataDance account:', unlinked: 'A sign-in method was removed from your DataDance account:' },
    when: 'Time (UTC):',
    requested: 'Changed from:',
    device: (browser, os) => (browser && os ? `${browser} on ${os}` : browser || os),
    location: 'Location:',
    confirmed: 'The change was confirmed with your DataDance wallet.',
    notYou: 'If you did not make this change, sign in to DataDance, open Account security and remove any method you do not recognise, then contact DataDance support.',
    team: 'The DataDance team',
  },
  zh: {
    subject: { linked: '你的 DataDance 账号新增了一种登录方式', unlinked: '你的 DataDance 账号移除了一种登录方式' },
    intro: { linked: '你的 DataDance 账号新增了以下登录方式：', unlinked: '你的 DataDance 账号移除了以下登录方式：' },
    when: '时间（UTC）：',
    requested: '操作来源：',
    device: (browser, os) => (browser && os ? `${os} 上的 ${browser}` : browser || os),
    location: '所在地区：',
    confirmed: '此操作已通过你的 DataDance 钱包确认。',
    notYou: '如果这不是你本人的操作，请登录 DataDance，在“账号安全”中移除你不认识的登录方式，然后联系 DataDance 客服。',
    team: 'DataDance 团队',
  },
  'zh-TW': {
    subject: { linked: '你的 DataDance 帳號新增了一種登入方式', unlinked: '你的 DataDance 帳號移除了一種登入方式' },
    intro: { linked: '你的 DataDance 帳號新增了以下登入方式：', unlinked: '你的 DataDance 帳號移除了以下登入方式：' },
    when: '時間（UTC）：',
    requested: '操作來源：',
    device: (browser, os) => (browser && os ? `${os} 上的 ${browser}` : browser || os),
    location: '所在地區：',
    confirmed: '此操作已透過你的 DataDance 錢包確認。',
    notYou: '如果這不是你本人的操作，請登入 DataDance，在「帳號安全」中移除你不認得的登入方式，然後聯絡 DataDance 客服。',
    team: 'DataDance 團隊',
  },
  ja: {
    subject: { linked: 'DataDance アカウントにサインイン方法が追加されました', unlinked: 'DataDance アカウントからサインイン方法が削除されました' },
    intro: { linked: 'DataDance アカウントに次のサインイン方法が追加されました：', unlinked: 'DataDance アカウントから次のサインイン方法が削除されました：' },
    when: '日時（UTC）：',
    requested: '変更元：',
    device: (browser, os) => (browser && os ? `${os} の ${browser}` : browser || os),
    location: '地域：',
    confirmed: 'この変更は DataDance ウォレットで確認されました。',
    notYou: 'この変更に心当たりがない場合は、DataDance にサインインし、「アカウントのセキュリティ」で見覚えのないサインイン方法を削除してから、DataDance サポートにお問い合わせください。',
    team: 'DataDance チーム',
  },
  ko: {
    subject: { linked: 'DataDance 계정에 로그인 방법이 추가되었습니다', unlinked: 'DataDance 계정에서 로그인 방법이 삭제되었습니다' },
    intro: { linked: 'DataDance 계정에 다음 로그인 방법이 추가되었습니다:', unlinked: 'DataDance 계정에서 다음 로그인 방법이 삭제되었습니다:' },
    when: '시간(UTC):',
    requested: '변경한 기기:',
    device: (browser, os) => (browser && os ? `${os}의 ${browser}` : browser || os),
    location: '위치:',
    confirmed: '이 변경은 DataDance 지갑으로 확인되었습니다.',
    notYou: '직접 변경하지 않았다면 DataDance에 로그인하여 계정 보안에서 알 수 없는 로그인 방법을 삭제한 뒤 DataDance 고객지원에 문의하세요.',
    team: 'DataDance 팀',
  },
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** A deliverable address (not a placeholder such as `email|<id>` or `x|<id>`). */
function isRealEmail(value) {
  const email = lower(value);
  return /^[^\s@|]+@[^\s@|]+\.[^\s@|]+$/.test(email);
}

/** "Google (ab***@gmail.com)" or "X"; the method's own address only ever masked. */
function methodLabel(provider, methodEmailMasked, lang) {
  const names = PROVIDER_NAMES[provider];
  const name = names ? names[lang] || names.en : 'Sign-in method';
  return methodEmailMasked ? `${name} (${methodEmailMasked})` : name;
}

/**
 * The mail for one link / unlink. `at` is a Date; `context` is { userAgent?, country? };
 * `confirmedWithWallet` adds the line saying the wallet signature confirmed it.
 */
function renderIdentityNotice({ kind, provider, methodEmailMasked = null, locale, at = new Date(), context = {}, confirmedWithWallet = false }) {
  if (!NOTICE_KINDS.includes(kind)) throw new Error(`renderIdentityNotice: unknown kind "${kind}"`);
  const lang = normalizeAuthLocale(locale);
  const s = STRINGS[lang];
  const method = methodLabel(provider, methodEmailMasked, lang);
  const when = new Date(at).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  const { browser, os } = describeUserAgent(context.userAgent);
  const device = s.device(browser, os) || '';
  const country = countryName(context.country, lang);

  // Full-width colons (zh, zh-TW, ja) take no space after them.
  const line = (label, value) => `${label}${/：$/.test(label) ? '' : ' '}${value}`;
  const details = [line(s.when, when)];
  if (device) details.push(line(s.requested, device));
  if (country) details.push(line(s.location, country));

  const confirmed = confirmedWithWallet ? [s.confirmed] : [];
  const text = [s.intro[kind], '', `    ${method}`, '', ...details, '', ...confirmed.flatMap((value) => [value, '']), s.notYou, '', s.team].join('\n');

  const p = (content, style = '') => `<p style="margin:0 0 16px;${style}">${content}</p>`;
  const html = [
    '<!doctype html>',
    `<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(s.subject[kind])}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'Helvetica Neue\',Arial,sans-serif;color:#1d1d1f;">',
    '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">',
    p(escapeHtml(s.intro[kind]), 'font-size:16px;'),
    p(`<strong>${escapeHtml(method)}</strong>`, 'font-size:18px;'),
    ...details.map((value) => p(escapeHtml(value), 'font-size:13px;color:#6e6e73;margin-bottom:4px;')),
    ...confirmed.map((value) => p(escapeHtml(value), 'font-size:14px;margin-top:16px;')),
    p(`<strong>${escapeHtml(s.notYou)}</strong>`, 'font-size:14px;'),
    p(escapeHtml(s.team), 'font-size:13px;color:#6e6e73;margin-bottom:0;'),
    '</div></body></html>',
  ].join('');

  return { locale: lang, subject: s.subject[kind], text, html };
}

/**
 * The account's strong addresses (§3.8): every AuthIdentity with emailLinkGrade 'strong', plus
 * User.email when a legacy Web3Auth pair proves it (the e-mail-passwordless pair, or the Gmail
 * Google pair — the same evidence rule 3b of §3.6 links on). Unverified columns never receive
 * notices (a password row's address was typed in by whoever registered it; F5).
 */
function strongEmailsOf({ user, identities = [], cfg }) {
  const out = new Set();
  for (const row of identities) {
    if (row && row.emailLinkGrade === 'strong' && isRealEmail(row.email)) out.add(lower(row.email));
  }
  if (user && isRealEmail(user.email) && cfg && accounts.emailHolderCategory(user, lower(user.email), cfg) === 'b') {
    out.add(lower(user.email));
  }
  return [...out];
}

async function sendOne({ to, mail, env, timeoutMs }) {
  const from = String(env.DDC_AUTH_EMAIL_FROM || env.SMTP_FROM || '').trim();
  if (!from) {
    const err = new Error('Email is not configured (missing DDC_AUTH_EMAIL_FROM)');
    err.code = 'EMAIL_NOT_CONFIGURED';
    throw err;
  }
  const transporter = getTransporter({ purpose: 'login', env });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('Sending the notice timed out');
      err.code = 'EMAIL_SEND_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  try {
    await Promise.race([
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
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Mail the notice to every address in `to`, one message each (recipients never see each other).
 * Never throws. Returns { sent, failed } counts. Logs `native_auth.identity_notice_sent` /
 * `native_auth.identity_notice_failed` (error) with masked addresses only.
 */
async function sendIdentityNotices({ to = [], kind, provider, methodEmailMasked = null, locale, at = new Date(), context = {}, confirmedWithWallet = false, env = process.env, timeoutMs = LOGIN_CODE_SEND_TIMEOUT_MS, identityId } = {}) {
  const recipients = [...new Set(to.filter(isRealEmail).map(lower))];
  if (!recipients.length) {
    logger.warn('native_auth.identity_notice_skipped', { kind, provider, identityId, reason: 'no_strong_email' });
    return { sent: 0, failed: 0 };
  }
  let mail;
  try {
    mail = renderIdentityNotice({ kind, provider, methodEmailMasked, locale, at, context, confirmedWithWallet });
  } catch {
    logger.error('native_auth.identity_notice_failed', { kind, provider, identityId, reason: 'render' });
    return { sent: 0, failed: recipients.length };
  }
  let sent = 0;
  let failed = 0;
  for (const address of recipients) {
    try {
      await sendOne({ to: address, mail, env, timeoutMs });
      sent += 1;
      logger.info('native_auth.identity_notice_sent', { kind, provider, identityId, emailMasked: maskEmail(address) });
    } catch (err) {
      failed += 1;
      logger.error('native_auth.identity_notice_failed', {
        kind,
        provider,
        identityId,
        emailMasked: maskEmail(address),
        reason: (err && err.code) || 'send_failed',
      });
    }
  }
  return { sent, failed };
}

module.exports = {
  NOTICE_KINDS,
  STRINGS,
  PROVIDER_NAMES,
  isRealEmail,
  methodLabel,
  renderIdentityNotice,
  strongEmailsOf,
  sendIdentityNotices,
};
