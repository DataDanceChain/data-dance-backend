// partner-browser.js <url> <secret-file> <password-file> <wrong-password-file> <expect.json> <screenshot-dir>
// Local test helper (run-local-tests.sh section 14; touches no server). Drives headless Chromium through playwright-core
// (resolved through NODE_PATH) against the partner info page that nginx serves with the 30-nginx.sh /partner-info/
// location: the filled values, the unlock flow (empty, wrong, right password; secret.json unreachable), copy and hide,
// phone width in dark mode, and every request the page makes. Prints PASS/FAIL lines and never the secret, a password or
// page text that could hold one (values are compared here, only verdicts and lengths are printed). Exit 1 on any FAIL.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const [url, secretFile, pwFile, wrongFile, expectFile, shots] = process.argv.slice(2);
const value = (f) => fs.readFileSync(f, 'utf8').replace(/\r?\n$/, '');
const secret = value(secretFile);
const password = value(pwFile);
const wrong = value(wrongFile);
const expect = JSON.parse(fs.readFileSync(expectFile, 'utf8'));
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const MSG = {
  empty: '请输入密码。',
  password: '密码不正确，请检查后重试。',
  fetch: '加密文件读取失败，请刷新页面后重试。',
};
let fails = 0;
const check = (cond, what) => {
  if (cond) console.log('PASS browser: ' + what);
  else { console.log('FAIL browser: ' + what); fails += 1; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function launch() {
  try { return await chromium.launch({ headless: true }); } catch (e) { /* no bundled Chromium: the installed Chrome */ }
  return chromium.launch({ headless: true, channel: 'chrome' });
}

async function main() {
  fs.mkdirSync(shots, { recursive: true });
  const origin = new URL(url).origin;
  const browser = await launch();
  console.log('browser: ' + browser.version());
  const requests = [];
  const problems = [];
  const watch = (page) => {
    page.on('request', (r) => requests.push(r.url()));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(m.type() + ': ' + m.text().slice(0, 160)); });
    page.on('pageerror', (e) => problems.push('pageerror: ' + String(e.message).slice(0, 160)));
  };
  const until = (page, fn) => page.waitForFunction(fn, null, { timeout: 30000 });
  const msgShown = () => document.getElementById('unlock-msg').textContent !== '' && !document.getElementById('unlock-btn').disabled;

  // 1. desktop, light: values, empty / wrong / right password, copy, hide
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const page = await ctx.newPage();
  watch(page);
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective));
  });
  const res = await page.goto(url, { waitUntil: 'load' });
  const h = res ? res.headers() : {};
  check(res && res.status() === 200, 'the page answers 200');
  check(h['cache-control'] === 'no-store' && h['x-frame-options'] === 'DENY' && h['referrer-policy'] === 'no-referrer'
        && h['x-robots-tag'] === 'noindex, nofollow' && /frame-ancestors 'none'/.test(h['content-security-policy'] || ''),
        'response headers: no-store, DENY, no-referrer, noindex, CSP');
  const inDom = async (p) => (await p.content()).includes(secret);
  check(!(await inDom(page)), 'before unlocking, the secret is nowhere in the DOM');
  const texts = (sel) => page.$$eval(sel, (els) => els.map((e) => e.textContent));
  const copies = await page.$$eval('.copy[data-copy]', (els) => els.map((e) => e.getAttribute('data-copy')));
  check(same(copies, [expect.issuer, expect.client_id, expect.redirects[0]]), 'config block: issuer, client_id and redirect_uri (copy values) exactly as registered');
  check(same(await texts('#registered .kv > div:nth-child(1) .val'), expect.redirects), 'registered redirect URIs listed exactly (' + expect.redirects.length + '; the HTML escaping reads back as the original)');
  check(same(await texts('#registered .kv > div:nth-child(2) .val'), [expect.initiate]), 'start-login address');
  check(same(await texts('#registered .kv > div:nth-child(3) .val'), expect.ips), 'allow-listed IP(s)');

  await page.click('#unlock-btn');
  check((await page.textContent('#unlock-msg')) === MSG.empty, 'empty password: asks for one');
  await page.fill('#unlock-pw', wrong);
  await page.click('#unlock-btn');
  await until(page, msgShown);
  check((await page.textContent('#unlock-msg')) === MSG.password, 'wrong password: the clear error message, no detail');
  check(!(await inDom(page)) && (await page.isHidden('#secret-acts')) && (await page.isVisible('#unlock')), 'wrong password: nothing revealed, the form stays');
  await page.screenshot({ path: path.join(shots, 'desktop-light-wrong-password.png'), fullPage: true });

  await page.fill('#unlock-pw', '  ' + password + ' ');   // pasted with blanks around it: trimmed, as the script refuses blanks at the ends
  await page.press('#unlock-pw', 'Enter');
  await page.waitForSelector('#secret-acts', { state: 'visible', timeout: 30000 });
  check((await page.textContent('#secret-value')) === '"' + secret + '"', 'right password (Enter, blanks around it): reveals exactly the dummy secret (' + secret.length + ' characters)');
  check((await page.inputValue('#unlock-pw')) === '' && (await page.isHidden('#unlock')), 'right password: the field is emptied and the form hidden');
  await page.click('#secret-copy');
  let clip = null;
  try { clip = await page.evaluate(() => navigator.clipboard.readText()); } catch (e) { clip = null; }
  check(clip === secret, 'copy button: exactly the secret on the clipboard');
  await page.screenshot({ path: path.join(shots, 'desktop-light-unlocked.png'), fullPage: true });
  await page.click('#secret-hide');
  check(!(await inDom(page)) && (await page.isVisible('#unlock')) && (await page.isHidden('#secret-acts'))
        && (await page.textContent('#secret-value')) === '"••••••••••••••••"', 'hide: the secret leaves the DOM, the mask and the form are back');
  check((await page.evaluate(() => window.__csp.length)) === 0, 'no Content-Security-Policy violation');
  await ctx.close();

  // 2. secret.json unreachable (its own context: the 404 is the point here, not a page problem)
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const p2 = await ctx2.newPage();
  p2.on('request', (r) => requests.push(r.url()));
  await p2.route('**/secret.json', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
  await p2.goto(url, { waitUntil: 'load' });
  await p2.fill('#unlock-pw', password);
  await p2.click('#unlock-btn');
  await until(p2, msgShown);
  check((await p2.textContent('#unlock-msg')) === MSG.fetch && !(await inDom(p2)), 'secret.json unreachable: its own clear message, nothing revealed');
  await ctx2.close();

  // 3. phone width, dark
  const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const p3 = await ctx3.newPage();
  watch(p3);
  await p3.goto(url, { waitUntil: 'load' });
  check((await p3.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, 'phone width 390 px: no horizontal page scroll');
  check((await p3.evaluate(() => getComputedStyle(document.body).backgroundColor)) === 'rgb(14, 20, 26)', 'dark mode: the dark palette applies');
  await p3.screenshot({ path: path.join(shots, 'phone-dark-locked.png'), fullPage: true });
  await p3.fill('#unlock-pw', password);
  await p3.click('#unlock-btn');
  await p3.waitForSelector('#secret-acts', { state: 'visible', timeout: 30000 });
  check((await p3.textContent('#secret-value')) === '"' + secret + '"', 'phone: the unlock works there too');
  await p3.screenshot({ path: path.join(shots, 'phone-dark-unlocked.png'), fullPage: true });
  await ctx3.close();
  await browser.close();

  // 4. every request: the page's own origin only (Google Fonts would be allowed; the page uses none)
  const net = requests.filter((u) => !u.startsWith('data:'));
  const foreign = net.filter((u) => { const x = new URL(u); return x.origin !== origin && !FONT_HOSTS.has(x.hostname); });
  const fonts = net.filter((u) => FONT_HOSTS.has(new URL(u).hostname)).length;
  check(foreign.length === 0, net.length + ' requests: ' + (net.length - foreign.length - fonts) + ' to the page origin, ' + fonts + ' to Google Fonts, ' + foreign.length + ' elsewhere');
  const paths = [...new Set(net.filter((u) => new URL(u).origin === origin).map((u) => new URL(u).pathname))].sort();
  check(same(paths, ['/partner-info/', '/partner-info/secret.json']), 'same-origin paths: ' + paths.join(' '));
  check(problems.length === 0, 'no console error or warning, no page error' + (problems.length ? ': ' + problems.join(' | ') : ''));
}

main().then(
  () => { console.log('browser: fails=' + fails); process.exit(fails ? 1 : 0); },
  (e) => { console.log('FAIL browser: stopped: ' + String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200)); process.exit(1); },
);
