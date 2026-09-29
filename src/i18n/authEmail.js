/**
 * The sign-in code e-mail (design §3.3, F19) in en, zh, zh-TW, ja and ko.
 *
 *   renderLoginCodeEmail({ code, locale, ttlMinutes, context }) → { locale, subject, text, html }
 *
 * Rules:
 * - The code is never in the subject (lock screens and notification previews show subjects).
 * - The body carries the code, its lifetime, the anti-phishing line (the code is asked for only on
 *   app.datadance.ai or in the DataDance app), and where the request came from: browser and OS
 *   from a fixed list of names recognised in the User-Agent (the raw header is never copied into
 *   the mail, so a requester cannot write text into someone else's inbox) and the country from
 *   Cloudflare's two-letter header.
 * - Plain text and HTML, no links, no images, no tracking.
 */

const AUTH_EMAIL_LOCALES = Object.freeze(['en', 'zh', 'zh-TW', 'ja', 'ko']);

const STRINGS = Object.freeze({
  en: {
    subject: 'Your DataDance sign-in code',
    intro: 'Use this code to sign in to DataDance:',
    expires: (m) => `The code expires in ${m} minutes and can be used once.`,
    warning: 'DataDance will only ask for this code on app.datadance.ai or in the DataDance app. Never enter it anywhere else.',
    requested: 'Requested from:',
    device: (browser, os) => (browser && os ? `${browser} on ${os}` : browser || os),
    location: 'Location:',
    ignore: 'If you did not ask for this code, you can ignore this e-mail. Nobody can sign in without it.',
    team: 'The DataDance team',
  },
  zh: {
    subject: '你的 DataDance 登录验证码',
    intro: '请使用以下验证码登录 DataDance：',
    expires: (m) => `验证码 ${m} 分钟内有效，仅可使用一次。`,
    warning: 'DataDance 只会在 app.datadance.ai 或 DataDance App 中要求你输入此验证码。请勿在其他任何地方输入。',
    requested: '请求来源：',
    device: (browser, os) => (browser && os ? `${os} 上的 ${browser}` : browser || os),
    location: '所在地区：',
    ignore: '如果这不是你本人的操作，请忽略此邮件。没有此验证码，任何人都无法登录。',
    team: 'DataDance 团队',
  },
  'zh-TW': {
    subject: '你的 DataDance 登入驗證碼',
    intro: '請使用以下驗證碼登入 DataDance：',
    expires: (m) => `驗證碼 ${m} 分鐘內有效，僅能使用一次。`,
    warning: 'DataDance 只會在 app.datadance.ai 或 DataDance App 中要求你輸入此驗證碼。請勿在其他任何地方輸入。',
    requested: '請求來源：',
    device: (browser, os) => (browser && os ? `${os} 上的 ${browser}` : browser || os),
    location: '所在地區：',
    ignore: '如果這不是你本人的操作，請忽略此郵件。沒有此驗證碼，任何人都無法登入。',
    team: 'DataDance 團隊',
  },
  ja: {
    subject: 'DataDance のサインインコード',
    intro: 'DataDance にサインインするには、次のコードを入力してください：',
    expires: (m) => `このコードの有効期限は ${m} 分で、1 回だけ使用できます。`,
    warning: 'DataDance がこのコードの入力を求めるのは app.datadance.ai または DataDance アプリの中だけです。それ以外の場所には絶対に入力しないでください。',
    requested: 'リクエスト元：',
    device: (browser, os) => (browser && os ? `${os} の ${browser}` : browser || os),
    location: '地域：',
    ignore: 'このコードに心当たりがない場合は、このメールを無視してください。このコードがなければ誰もサインインできません。',
    team: 'DataDance チーム',
  },
  ko: {
    subject: 'DataDance 로그인 코드',
    intro: 'DataDance에 로그인하려면 아래 코드를 입력하세요:',
    expires: (m) => `이 코드는 ${m}분 동안 유효하며 한 번만 사용할 수 있습니다.`,
    warning: 'DataDance는 app.datadance.ai 또는 DataDance 앱에서만 이 코드를 요청합니다. 다른 곳에는 절대 입력하지 마세요.',
    requested: '요청 기기:',
    device: (browser, os) => (browser && os ? `${os}의 ${browser}` : browser || os),
    location: '위치:',
    ignore: '직접 요청하지 않았다면 이 이메일을 무시하세요. 이 코드 없이는 누구도 로그인할 수 없습니다.',
    team: 'DataDance 팀',
  },
});

/**
 * One of AUTH_EMAIL_LOCALES for a client locale tag: zh-TW/zh-HK/zh-MO/zh-Hant → zh-TW, other
 * zh → zh, ja → ja, ko → ko, anything else → en.
 */
function normalizeAuthLocale(locale) {
  const tag = String(locale || '').trim().replace(/_/g, '-').toLowerCase();
  if (!tag) return 'en';
  const [lang, ...rest] = tag.split('-');
  if (lang === 'zh') return rest.some((part) => ['tw', 'hk', 'mo', 'hant'].includes(part)) ? 'zh-TW' : 'zh';
  if (lang === 'ja' || lang === 'ko') return lang;
  return 'en';
}

// Order matters: the first match wins (Edge and Opera also say Chrome; Chrome also says Safari).
const BROWSERS = [
  [/MicroMessenger\//i, 'WeChat'],
  [/EdgA?\/|EdgiOS\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Version\/[\d.]+.*Safari\//, 'Safari'],
];
const SYSTEMS = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows NT/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

/** { browser, os } from a User-Agent, each a fixed name or ''. Never echoes the header. */
function describeUserAgent(userAgent) {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 512) : '';
  const pick = (list) => (list.find(([pattern]) => pattern.test(ua)) || [null, ''])[1];
  return { browser: pick(BROWSERS), os: pick(SYSTEMS) };
}

/** Localised country name for a Cloudflare CF-IPCountry value; '' for absent, XX (unknown) or T1 (Tor). */
function countryName(code, locale) {
  const value = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value) || value === 'XX' || value === 'T1') return '';
  try {
    const name = new Intl.DisplayNames([locale, 'en'], { type: 'region' }).of(value);
    return name && name !== value ? name : value;
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

/**
 * Render the mail. `code` must be the 6-digit string; `context` is { userAgent?, country? } straight
 * from the request (sanitised here). `ttlMinutes` is rounded up.
 */
function renderLoginCodeEmail({ code, locale, ttlMinutes, context = {} }) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new Error('renderLoginCodeEmail: code must be 6 digits');
  const lang = normalizeAuthLocale(locale);
  const s = STRINGS[lang];
  const minutes = Math.max(1, Math.ceil(Number(ttlMinutes) || 10));
  const { browser, os } = describeUserAgent(context.userAgent);
  const device = s.device(browser, os) || '';
  const country = countryName(context.country, lang);

  // Full-width colons (zh, zh-TW, ja) take no space after them.
  const line = (label, value) => `${label}${/：$/.test(label) ? '' : ' '}${value}`;
  const contextLines = [];
  if (device) contextLines.push(line(s.requested, device));
  if (country) contextLines.push(line(s.location, country));

  const text = [
    s.intro,
    '',
    `    ${code}`,
    '',
    s.expires(minutes),
    '',
    s.warning,
    ...(contextLines.length ? ['', ...contextLines] : []),
    '',
    s.ignore,
    '',
    s.team,
  ].join('\n');

  const p = (content, style = '') => `<p style="margin:0 0 16px;${style}">${content}</p>`;
  const html = [
    '<!doctype html>',
    `<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(s.subject)}</title></head>`,
    '<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'Helvetica Neue\',Arial,sans-serif;color:#1d1d1f;">',
    '<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">',
    p(escapeHtml(s.intro), 'font-size:16px;'),
    `<p style="margin:0 0 16px;font-size:32px;font-weight:600;letter-spacing:8px;font-family:'SF Mono',Menlo,Consolas,monospace;">${escapeHtml(code)}</p>`,
    p(escapeHtml(s.expires(minutes)), 'font-size:14px;color:#424245;'),
    p(`<strong>${escapeHtml(s.warning)}</strong>`, 'font-size:14px;'),
    ...contextLines.map((text) => p(escapeHtml(text), 'font-size:13px;color:#6e6e73;margin-bottom:4px;')),
    p(escapeHtml(s.ignore), 'font-size:13px;color:#6e6e73;margin-top:16px;'),
    p(escapeHtml(s.team), 'font-size:13px;color:#6e6e73;margin-bottom:0;'),
    '</div></body></html>',
  ].join('');

  return { locale: lang, subject: s.subject, text, html };
}

module.exports = {
  AUTH_EMAIL_LOCALES,
  STRINGS,
  normalizeAuthLocale,
  describeUserAgent,
  countryName,
  renderLoginCodeEmail,
};
