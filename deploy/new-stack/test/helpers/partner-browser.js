// partner-browser.js <url> <secret-file> <password-file> <wrong-password-file> <expect.json> <screenshot-dir>
// Local test helper (run-local-tests.sh section 14; touches no server). Drives headless Chromium through playwright-core
// (resolved through NODE_PATH) against the partner info page that nginx serves with the 30-nginx.sh /partner-info/
// location: the filled values, the unlock flow (empty, wrong, right password; secret.json unreachable), copy and hide,
// phone width in dark mode, every request the page makes, and the page with JavaScript disabled: no field is offered,
// and even with the box forced visible, or a <form> injected around the field, no request carries the password (with
// the served CSP form-action 'none' blocks the submit; without the CSP the submit goes out, but the field has no name).
// Prints PASS/FAIL lines and never the secret, a password or page text that could hold one (values are compared here,
// only verdicts and lengths are printed). Exit 1 on any FAIL.
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
  const csp = h['content-security-policy'] || '';
  check(h['cache-control'] === 'no-store' && h['x-frame-options'] === 'DENY' && h['referrer-policy'] === 'no-referrer'
        && h['x-robots-tag'] === 'noindex, nofollow' && h['x-content-type-options'] === 'nosniff'
        && /frame-ancestors 'none'/.test(csp) && /form-action 'none'/.test(csp) && /base-uri 'none'/.test(csp) && !/fonts\.g/.test(csp),
        "response headers: no-store, DENY, no-referrer, noindex, nosniff, CSP with form-action 'none' and base-uri 'none', no Google Fonts");
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

  // 4. JavaScript disabled. The password must not be able to leave by a native submit: no field is offered at all, and
  // even when one is forced into view or a <form> is wrapped around it, no request carries the password.
  const withPw = (list) => list.filter((r) => r.url.includes(password) || r.post.includes(password) || r.url.includes(encodeURIComponent(password)));
  const noJs = async (label, opts) => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 900 }, javaScriptEnabled: false });
    const reqs = [];
    const logs = [];
    if (opts.stripCsp) {
      await c.route((u) => u.pathname.startsWith('/partner-info/'), async (route) => {
        const r = await route.fetch();
        const hd = { ...r.headers() };
        delete hd['content-security-policy'];
        await route.fulfill({ response: r, headers: hd });
      });
    }
    const p = await c.newPage();
    p.on('request', (r) => reqs.push({ url: r.url(), post: r.postData() || '', nav: r.isNavigationRequest() }));
    p.on('console', (m) => logs.push(m.text()));
    await p.goto(url, { waitUntil: 'load' });
    const loaded = reqs.length;
    if (opts.firstLook) {
      check(await p.isHidden('#unlock'), 'JS off: the unlock box is hidden: no password field is offered');
      // (Playwright's text engine skips <noscript>, so a CSS locator: with scripting off its <p> is a rendered element)
      const note = p.locator('noscript p.msg.bad');
      check((await note.isVisible()) && (await note.textContent()).includes('需要开启 JavaScript'), 'JS off: the page says that JavaScript is needed');
      check((await p.locator('form').count()) === 0 && (await p.getAttribute('#unlock-pw', 'name')) === null && (await p.getAttribute('#unlock-btn', 'type')) === 'button',
            'JS off: no <form> on the page, the password field has no name, the button is type=button');
      await p.screenshot({ path: path.join(shots, 'desktop-nojs.png'), fullPage: true });
    }
    // DevTools evaluation still works with page scripts disabled: show the box, and optionally wrap it in a form
    // without method or action (a native submit would GET the current URL with every named field).
    await p.evaluate((wrap) => {
      const box = document.getElementById('unlock');
      box.hidden = false;
      if (wrap) { const f = document.createElement('form'); box.parentNode.insertBefore(f, box); f.appendChild(box); }
    }, !!opts.wrapForm);
    await p.fill('#unlock-pw', password);
    // keyboard.press: unlike page.press it does not wait for a navigation (the blocked one would never finish)
    await p.focus('#unlock-pw');
    await p.keyboard.press('Enter');
    if (!opts.wrapForm) await p.click('#unlock-btn');
    for (let i = 0; i < 25 && !(opts.expectNav && reqs.slice(loaded).some((r) => r.nav)); i++) await p.waitForTimeout(200);
    const after = reqs.slice(loaded);
    const leaked = withPw(reqs);
    const navs = after.filter((r) => r.nav);
    const cspSeen = logs.some((t) => /form-action/.test(t));
    await c.close();
    return { after, leaked, navs, cspSeen };
  };
  let r = await noJs('as served', { firstLook: true });
  check(r.leaked.length === 0 && r.after.length === 0,
        'JS off, the box forced visible, the password typed, Enter and the button pressed: no request at all (' + r.after.length + '), none with the password');
  r = await noJs('form, CSP', { wrapForm: true });
  check(r.leaked.length === 0 && r.after.length === 0,
        "JS off, a <form> without method/action injected around the field, Enter: the served CSP (form-action 'none') blocks the submit: no request (" + r.after.length + '), none with the password' + (r.cspSeen ? '; Chromium logged the form-action refusal' : ''));
  r = await noJs('form, no CSP', { wrapForm: true, stripCsp: true, expectNav: true });
  check(r.navs.length >= 1 && r.leaked.length === 0,
        'JS off, the same <form>, the CSP stripped: the native submit goes out (' + r.navs.length + ' navigation, ' + r.navs.map((x) => new URL(x.url).pathname + new URL(x.url).search).join(' ') + ') and carries no password: the field has no name');
  await browser.close();

  // 5. every request (JS on): the page's own origin only; nothing from Google Fonts or any other origin
  const net = requests.filter((u) => !u.startsWith('data:'));
  const foreign = net.filter((u) => new URL(u).origin !== origin);
  check(foreign.length === 0, net.length + ' requests: ' + (net.length - foreign.length) + ' to the page origin, ' + foreign.length + ' elsewhere');
  const paths = [...new Set(net.filter((u) => new URL(u).origin === origin).map((u) => new URL(u).pathname))].sort();
  check(same(paths, ['/partner-info/', '/partner-info/secret.json']), 'same-origin paths: ' + paths.join(' '));
  check(problems.length === 0, 'no console error or warning, no page error' + (problems.length ? ': ' + problems.join(' | ') : ''));
}

main().then(
  () => { console.log('browser: fails=' + fails); process.exit(fails ? 1 : 0); },
  (e) => { console.log('FAIL browser: stopped: ' + String(e && e.message ? e.message : e).split('\n')[0].slice(0, 200)); process.exit(1); },
);
