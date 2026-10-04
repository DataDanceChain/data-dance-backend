#!/usr/bin/env node
/**
 * Publish-safety check for the native-login issuer JWKS (design §5 item 3, §6 F1, check H3).
 *
 * Whatever sits in the JWKS that the Web3Auth connection reads can derive EVERY native wallet, so the
 * published file must hold exactly what the operator approved and nothing more:
 *   - top level is `{ "keys": [ ... ] }` and nothing else, with at least one key;
 *   - every key has exactly the public members kty, n, e, kid, alg, use — any private member
 *     (d, p, q, dp, dq, qi, oth, k) or any other member (x5c, key_ops, ...) is a violation;
 *   - kty RSA, alg RS256, use sig, e = AQAB, modulus >= 2048 bits;
 *   - kid equals the key's RFC 7638 SHA-256 thumbprint (a kid is only a label; the thumbprint is the key);
 *   - the thumbprint is in the pinned list (DDC_AUTH_JWKS_PINNED or --pinned) and never the committed
 *     legacy `auth-key-1` key from keys/jwks.json (its private half is public in this repo);
 *   - no key appears twice.
 *   - the raw text repeats no member name in any object and names no private member anywhere: JSON.parse
 *     keeps only the last copy of a repeated name, so the earlier copies (a whole private JWK, say)
 *     would still be published while the parsed object looks clean.
 * With --exact, every pinned thumbprint must also be present (use after a rotation settles).
 *
 * Usage:
 *   node scripts/nativeAuthJwksCheck.js [<file|url>] [--pinned=<tp,tp>] [--exact] [--json]
 *   node scripts/nativeAuthJwksCheck.js --watch [<url>] [--interval=300] [--pinned=...]
 *
 * With no source the devnet GitHub Pages URL is used. URLs must be https (plain http only for
 * loopback, for the local /.well-known/ddc-auth/jwks.json route); redirects are refused so the check
 * sees the file the nodes see. Watch mode re-checks every interval, prints one line per run, and says
 * when the published bytes change; a violation or fetch failure is printed to stderr and the watch
 * keeps going. Output names members and thumbprints only, never member values.
 *
 * Exit codes (single run): 0 ok, 1 violations, 2 usage or fetch error.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEVNET_JWKS_URL = 'https://datadancechain.github.io/ddc-login-jwks/devnet/jwks.json';

const PUBLIC_MEMBERS = Object.freeze(['kty', 'n', 'e', 'kid', 'alg', 'use']);
// RFC 7518 §6.3.2 (RSA), §6.4 (symmetric `k`); `oth` is the multi-prime list.
const PRIVATE_MEMBERS = Object.freeze(['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k']);

// RFC 7638 thumbprint of the committed `auth-key-1` (keys/jwks.json). Hard-coded as well as read from
// the file so the refusal survives the file's removal (question 5).
const COMMITTED_AUTH_KEY_1_THUMBPRINT = 'PLLnYY27q1SnU7rXrZ6VmLwfxoa3CcswLranj-VLSvs';
const COMMITTED_JWKS_PATH = path.join(__dirname, '..', 'keys', 'jwks.json');

const MIN_MODULUS_BITS = 2048;
const MAX_JWKS_BYTES = 64 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const THUMBPRINT_RE = /^[A-Za-z0-9_-]{43}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
// Backstop for the raw-text scan: a private member name written literally anywhere in the bytes.
const RAW_PRIVATE_MEMBER_RE = /"(?:d|p|q|dp|dq|qi|oth|k)"\s*:/;
const SAFE_NAME_RE = /^[A-Za-z0-9_$-]{1,24}$/;

/** A member name for a message: short identifier-like names verbatim, anything else only by length. */
function safeName(name) {
  return SAFE_NAME_RE.test(name) ? name : `(a ${String(name).length}-character name)`;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** RFC 7638 SHA-256 thumbprint (base64url) of an RSA JWK. Only e, kty, n are hashed. */
function rfc7638Thumbprint(jwk) {
  if (!isPlainObject(jwk) || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') {
    throw new Error('thumbprint needs an RSA JWK with string n and e');
  }
  const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
  return crypto.createHash('sha256').update(canonical).digest('base64url');
}

/** The published form of a key: public members only, kid = thumbprint, RS256, sig. */
function publicJwk(jwk) {
  const kid = rfc7638Thumbprint(jwk);
  return { kty: 'RSA', n: jwk.n, e: jwk.e, kid, alg: 'RS256', use: 'sig' };
}

/** Thumbprints that must never be published: auth-key-1, from the constant and from keys/jwks.json. */
function forbiddenThumbprints({ committedJwksPath = COMMITTED_JWKS_PATH } = {}) {
  const out = new Set([COMMITTED_AUTH_KEY_1_THUMBPRINT]);
  try {
    const committed = JSON.parse(fs.readFileSync(committedJwksPath, 'utf8'));
    for (const key of committed.keys || []) {
      try {
        out.add(rfc7638Thumbprint(key));
      } catch {
        // not an RSA key; nothing to forbid
      }
    }
  } catch {
    // file removed or unreadable: the constant still applies
  }
  return out;
}

function parsePinned(value) {
  const list = (Array.isArray(value) ? value : String(value || '').split(','))
    .map((item) => String(item).trim())
    .filter(Boolean);
  const bad = list.filter((item) => !THUMBPRINT_RE.test(item));
  if (bad.length) throw new Error(`pinned list has ${bad.length} value(s) that are not RFC 7638 SHA-256 thumbprints`);
  return list;
}

function modulusBits(n) {
  const bytes = Buffer.from(n, 'base64url');
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i += 1;
  if (i === bytes.length) return 0;
  return (bytes.length - i - 1) * 8 + (32 - Math.clz32(bytes[i]));
}

/**
 * Checks a parsed JWKS document. Returns { ok, errors, notes, keys:[{index, kid, thumbprint}] }.
 * Messages name members and thumbprints only.
 */
function checkJwks(doc, { pinned, forbidden = forbiddenThumbprints(), exact = false } = {}) {
  const pinnedList = parsePinned(pinned);
  if (pinnedList.length === 0) throw new Error('no pinned thumbprints given (DDC_AUTH_JWKS_PINNED or --pinned)');
  const pinnedSet = new Set(pinnedList);
  const errors = [];
  const notes = [];
  const keys = [];

  if (!isPlainObject(doc)) {
    return { ok: false, errors: ['document is not a JSON object'], notes, keys };
  }
  const extraTop = Object.keys(doc).filter((member) => member !== 'keys');
  if (extraTop.length) errors.push(`top level has members other than "keys": ${extraTop.map(safeName).join(', ')}`);
  if (!Array.isArray(doc.keys)) {
    errors.push('"keys" is not an array');
    return { ok: false, errors, notes, keys };
  }
  if (doc.keys.length === 0) errors.push('"keys" is empty');

  const seenThumbprints = new Set();
  const seenKids = new Set();
  doc.keys.forEach((key, index) => {
    const at = `keys[${index}]`;
    if (!isPlainObject(key)) {
      errors.push(`${at} is not an object`);
      return;
    }
    const members = Object.keys(key);
    const privateHere = members.filter((member) => PRIVATE_MEMBERS.includes(member));
    if (privateHere.length) errors.push(`${at} has PRIVATE member(s): ${privateHere.join(', ')}`);
    const unexpected = members.filter((member) => !PUBLIC_MEMBERS.includes(member) && !PRIVATE_MEMBERS.includes(member));
    if (unexpected.length) errors.push(`${at} has unexpected member(s): ${unexpected.map(safeName).join(', ')}`);
    const missing = PUBLIC_MEMBERS.filter((member) => !(member in key));
    if (missing.length) errors.push(`${at} is missing member(s): ${missing.join(', ')}`);
    const nonString = PUBLIC_MEMBERS.filter((member) => member in key && typeof key[member] !== 'string');
    if (nonString.length) errors.push(`${at} has non-string member(s): ${nonString.join(', ')}`);

    if (key.kty !== 'RSA') errors.push(`${at} kty is not RSA`);
    if (key.alg !== 'RS256') errors.push(`${at} alg is not RS256`);
    if (key.use !== 'sig') errors.push(`${at} use is not sig`);
    if (typeof key.e === 'string' && key.e !== 'AQAB') errors.push(`${at} e is not AQAB (65537)`);

    let thumbprint = null;
    if (key.kty === 'RSA' && typeof key.n === 'string' && typeof key.e === 'string') {
      if (!B64URL_RE.test(key.n) || !B64URL_RE.test(key.e)) {
        errors.push(`${at} n or e is not base64url`);
      } else {
        const bits = modulusBits(key.n);
        if (bits < MIN_MODULUS_BITS) errors.push(`${at} modulus is ${bits} bits (minimum ${MIN_MODULUS_BITS})`);
        thumbprint = rfc7638Thumbprint(key);
      }
    }

    const label = thumbprint || '(no thumbprint)';
    if (thumbprint) {
      if (key.kid !== thumbprint) errors.push(`${at} kid does not equal its RFC 7638 thumbprint ${thumbprint}`);
      if (!pinnedSet.has(thumbprint)) errors.push(`${at} thumbprint ${thumbprint} is not pinned`);
      if (forbidden.has(thumbprint)) errors.push(`${at} is the committed auth-key-1 key (its private half is public)`);
      if (seenThumbprints.has(thumbprint)) errors.push(`${at} duplicates thumbprint ${thumbprint}`);
      seenThumbprints.add(thumbprint);
    }
    if (key.kid === 'auth-key-1') errors.push(`${at} uses the committed kid auth-key-1`);
    if (typeof key.kid === 'string') {
      if (seenKids.has(key.kid)) errors.push(`${at} duplicates a kid`);
      seenKids.add(key.kid);
    }
    keys.push({ index, kid: typeof key.kid === 'string' ? key.kid : null, thumbprint: label });
  });

  const absent = pinnedList.filter((tp) => !seenThumbprints.has(tp));
  if (absent.length) {
    const message = `pinned but not published: ${absent.join(', ')}`;
    if (exact) errors.push(message);
    else notes.push(message);
  }
  return { ok: errors.length === 0, errors, notes, keys };
}

/**
 * Walks the raw text of a document that JSON.parse has accepted and lists every member name with the
 * object it belongs to. Names are decoded with JSON.parse, so an escaped "\u0064" counts as "d".
 * Returns [{ objectId, where, name }]; `where` is a display path such as "keys[0]" built from safe names.
 */
function rawMembers(text) {
  const members = [];
  const stack = [];
  let nextObjectId = 0;
  const childWhere = () => {
    const top = stack[stack.length - 1];
    if (!top) return 'top level';
    const parent = top.where === 'top level' ? '' : top.where;
    if (top.type === 'array') return `${parent}[${top.index}]`;
    const name = safeName(top.name);
    return parent ? `${parent}.${name}` : name;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top && top.type === 'object' && top.expectName) {
        const name = JSON.parse(text.slice(i, j + 1));
        members.push({ objectId: top.id, where: top.where, name });
        top.name = name;
        top.expectName = false;
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      stack.push({ type: 'object', id: nextObjectId, where: childWhere(), expectName: true, name: null });
      nextObjectId += 1;
    } else if (ch === '[') {
      stack.push({ type: 'array', where: childWhere(), index: 0 });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',') {
      const top = stack[stack.length - 1];
      if (top && top.type === 'object') top.expectName = true;
      else if (top) top.index += 1;
    }
    i += 1;
  }
  return members;
}

/**
 * Rules the parsed object cannot show (design §6 F1): no member name repeated within one object, and
 * no private member name anywhere in the bytes. `text` must already be valid JSON. Messages name
 * members only, never values.
 */
function rawTextErrors(text) {
  const errors = [];
  const seen = new Map();
  let privateSeen = false;
  for (const { objectId, where, name } of rawMembers(text)) {
    if (!seen.has(objectId)) seen.set(objectId, new Set());
    const names = seen.get(objectId);
    if (names.has(name)) {
      errors.push(`${where} repeats member ${safeName(name)} (JSON.parse would hide the earlier copy, which is still published)`);
    }
    names.add(name);
    if (PRIVATE_MEMBERS.includes(name)) {
      privateSeen = true;
      errors.push(`${where} has PRIVATE member(s) in the raw text: ${name}`);
    }
  }
  if (!privateSeen && RAW_PRIVATE_MEMBER_RE.test(text)) errors.push('raw text contains a private member name (d, p, q, dp, dq, qi, oth or k)');
  return errors;
}

/**
 * Checks JWKS text as published: parses it, applies the raw-text rules, then the rules on the parsed
 * object. Returns the checkJwks result shape; raw-text errors come first.
 */
function checkJwksText(text, { pinned, exact = false, forbidden } = {}) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['body is not valid JSON'], notes: [], keys: [] };
  }
  const raw = rawTextErrors(text);
  const parsed = checkJwks(doc, { pinned, exact, forbidden });
  const errors = [...raw, ...parsed.errors];
  return { ...parsed, ok: errors.length === 0, errors };
}

function isLoopbackHost(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

/** Reads a response body, giving up as soon as it passes MAX_JWKS_BYTES (declared or counted). */
async function readCappedBody(res) {
  const tooLarge = () => new Error(`body larger than ${MAX_JWKS_BYTES} bytes`);
  const declared = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(declared) && declared > MAX_JWKS_BYTES) throw tooLarge();
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_JWKS_BYTES) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_JWKS_BYTES) throw tooLarge();
  return text;
}

/** Fetches a JWKS body. https only (http for loopback), no redirects, size-capped. */
async function fetchJwksText(url, { timeoutMs = FETCH_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('source is not a valid URL');
  }
  if (!(parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname)))) {
    throw new Error('JWKS URL must be https (plain http only for loopback)');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(parsed.href, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    return await readCappedBody(res);
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`timed out after ${timeoutMs} ms`);
    throw new Error(`fetch failed: ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function loadJwksText(source, options) {
  if (/^https?:\/\//i.test(source)) return fetchJwksText(source, options);
  const stat = fs.statSync(source);
  if (stat.size > MAX_JWKS_BYTES) throw new Error(`file larger than ${MAX_JWKS_BYTES} bytes`);
  return fs.readFileSync(source, 'utf8');
}

/** Loads and checks one source. Never throws; fetch/parse problems come back as { fetchError }. */
async function checkSource(source, { pinned, exact = false, forbidden, ...loadOptions } = {}) {
  let text;
  try {
    text = await loadJwksText(source, loadOptions);
  } catch (err) {
    return { ok: false, fetchError: err.message, errors: [], notes: [], keys: [], sha256: null };
  }
  const sha256 = crypto.createHash('sha256').update(text).digest('hex');
  return { ...checkJwksText(text, { pinned, exact, forbidden }), sha256 };
}

function formatResult(result, source) {
  const lines = [];
  if (result.fetchError) {
    lines.push(`FETCH_FAILED ${source}: ${result.fetchError}`);
    return lines;
  }
  lines.push(`${result.ok ? 'OK' : 'VIOLATION'} ${source} sha256=${result.sha256 ? result.sha256.slice(0, 16) : '-'}`);
  for (const key of result.keys) lines.push(`  key[${key.index}] thumbprint=${key.thumbprint}`);
  for (const error of result.errors) lines.push(`  error: ${error}`);
  for (const note of result.notes) lines.push(`  note: ${note}`);
  return lines;
}

/**
 * Re-checks `source` every `intervalMs`. `maxRuns` (tests) stops the loop; otherwise it runs until the
 * process is stopped. Reports through `report(line, isProblem)`.
 */
async function watchJwks({
  source,
  pinned,
  exact = false,
  forbidden,
  intervalMs = 300_000,
  maxRuns = Infinity,
  report = (line, isProblem) => (isProblem ? process.stderr : process.stdout).write(`${line}\n`),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => new Date(),
  ...loadOptions
}) {
  let lastSha = null;
  let last = null;
  for (let run = 0; run < maxRuns; run += 1) {
    if (run > 0) await sleep(intervalMs);
    last = await checkSource(source, { pinned, exact, forbidden, ...loadOptions });
    const stamp = now().toISOString();
    if (last.sha256 && lastSha && last.sha256 !== lastSha) {
      report(`${stamp} CHANGED published bytes ${lastSha.slice(0, 16)} -> ${last.sha256.slice(0, 16)}`, !last.ok);
    }
    if (last.sha256) lastSha = last.sha256;
    for (const line of formatResult(last, source)) report(`${stamp} ${line}`, !last.ok);
  }
  return last;
}

function parseArgs(argv) {
  const args = { source: null, pinned: process.env.DDC_AUTH_JWKS_PINNED || '', exact: false, json: false, watch: false, intervalSec: 300 };
  for (const arg of argv) {
    if (arg === '--exact') args.exact = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--watch') args.watch = true;
    else if (arg.startsWith('--pinned=')) args.pinned = arg.slice('--pinned='.length);
    else if (arg.startsWith('--interval=')) args.intervalSec = Number.parseInt(arg.slice('--interval='.length), 10);
    else if (arg === '-h' || arg === '--help') args.help = true;
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`);
    else if (args.source) throw new Error('only one source');
    else args.source = arg;
  }
  if (!Number.isFinite(args.intervalSec) || args.intervalSec < 30) throw new Error('--interval must be >= 30 seconds');
  if (!args.source) args.source = DEVNET_JWKS_URL;
  return args;
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
    if (args.help) {
      process.stdout.write('usage: nativeAuthJwksCheck.js [<file|url>] [--pinned=tp,...] [--exact] [--json] [--watch] [--interval=300]\n');
      return 0;
    }
    if (!parsePinned(args.pinned).length) throw new Error('no pinned thumbprints (set DDC_AUTH_JWKS_PINNED or pass --pinned=)');
  } catch (err) {
    process.stderr.write(`nativeAuthJwksCheck: ${err.message}\n`);
    return 2;
  }
  if (args.watch) {
    await watchJwks({ source: args.source, pinned: args.pinned, exact: args.exact, intervalMs: args.intervalSec * 1000 });
    return 0;
  }
  const result = await checkSource(args.source, { pinned: args.pinned, exact: args.exact });
  if (args.json) process.stdout.write(`${JSON.stringify({ source: args.source, ...result })}\n`);
  else {
    const out = result.ok ? process.stdout : process.stderr;
    for (const line of formatResult(result, args.source)) out.write(`${line}\n`);
  }
  if (result.fetchError) return 2;
  return result.ok ? 0 : 1;
}

module.exports = {
  DEVNET_JWKS_URL,
  PUBLIC_MEMBERS,
  PRIVATE_MEMBERS,
  COMMITTED_AUTH_KEY_1_THUMBPRINT,
  rfc7638Thumbprint,
  publicJwk,
  forbiddenThumbprints,
  parsePinned,
  modulusBits,
  checkJwks,
  rawTextErrors,
  checkJwksText,
  fetchJwksText,
  loadJwksText,
  checkSource,
  watchJwks,
  formatResult,
  main,
};

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`nativeAuthJwksCheck: ${err.message}\n`);
      process.exitCode = 2;
    },
  );
}
