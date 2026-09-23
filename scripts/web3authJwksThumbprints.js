#!/usr/bin/env node
/**
 * Hardening G4 — prints the RFC 7638 SHA-256 thumbprint of every key in the two Web3Auth JWKS
 * sets, i.e. the values WEB3AUTH_JWKS_PINNED_THUMBPRINTS takes.
 *
 *   node scripts/web3authJwksThumbprints.js
 *
 * Reads WEB3AUTH_JWKS_URL (social / e-mail logins) and WEB3AUTH_EXTERNAL_JWKS_URL (external
 * wallets) from the environment and falls back to the same defaults as the server
 * (src/services/web3authIdentity.js). Both are public, read-only endpoints: no login, no secret,
 * nothing written. One line per key:
 *
 *   kid=<kid> alg=<alg> thumbprint=<base64url> jwks=<url>
 *
 * The thumbprint is computed from the key material only (EC: crv, kty, x, y; RSA: e, kty, n) —
 * never from `kid` — exactly as the server computes it for the key that verified a token, so a
 * value printed here matches the `thumbprint` of a `jwks_key_not_pinned` log line for that key.
 *
 * This shows what the endpoint serves RIGHT NOW, which is exactly what someone in the network
 * path would control. Check every key before you pin it (runbook: README "Web3Auth signing-key
 * pins", docs/TGE_SSO.md §14): fetch again from a different network, compare with what Web3Auth
 * publishes, and never pin a key only because it appeared in a failing-login log line.
 *
 * Exit code 1 when any JWKS could not be read (the keys that could be read are still printed).
 */
const jose = require('jose');

// Mirrors web3authIdentity.DEFAULTS (asserted equal in test/unit/web3authJwksPin.test.js). Not
// imported: that module asserts the whole login configuration when it is loaded.
const DEFAULT_JWKS_URLS = Object.freeze({
  WEB3AUTH_JWKS_URL: 'https://api-auth.web3auth.io/jwks',
  WEB3AUTH_EXTERNAL_JWKS_URL: 'https://authjs.web3auth.io/jwks',
});
const FETCH_TIMEOUT_MS = 10_000;

/** The two JWKS URLs to read, env first (blank = default), in the order the server lists them. */
function jwksUrls(env = process.env) {
  return Object.keys(DEFAULT_JWKS_URLS).map((name) => {
    const value = String(env[name] || '').trim();
    return { name, url: value || DEFAULT_JWKS_URLS[name] };
  });
}

/**
 * GET a JWKS the way the server's jose client does: no redirects followed, 200 required, JSON
 * with a `keys` array.
 */
async function fetchJwks(url, { fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const response = await fetchImpl(url, {
    method: 'GET',
    redirect: 'manual',
    headers: { accept: 'application/json, application/jwk-set+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status !== 200) throw new Error(`HTTP ${response.status} (expected 200, redirects are not followed)`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('response is not JSON');
  }
  if (!body || !Array.isArray(body.keys)) throw new Error('response has no "keys" array');
  return body;
}

/** One row per key: `{ kid, alg, thumbprint | error, jwksUrl }`. A bad key never hides the rest. */
async function describeJwks(jwks, jwksUrl) {
  const rows = [];
  for (const jwk of jwks.keys) {
    const row = {
      kid: jwk && typeof jwk.kid === 'string' ? jwk.kid : null,
      alg: jwk && typeof jwk.alg === 'string' ? jwk.alg : null,
      thumbprint: null,
      error: null,
      jwksUrl,
    };
    try {
      row.thumbprint = await jose.calculateJwkThumbprint(jwk, 'sha256');
    } catch (err) {
      row.error = err.message;
    }
    rows.push(row);
  }
  return rows;
}

function formatRow(row) {
  const value = row.thumbprint || `ERROR(${row.error})`;
  return `kid=${row.kid ?? '-'} alg=${row.alg ?? '-'} thumbprint=${value} jwks=${row.jwksUrl}`;
}

/**
 * Reads every JWKS and writes the report. Returns the process exit code.
 * `out` / `err` are line writers (tests pass arrays' push).
 */
async function run({ env = process.env, fetchImpl, out = console.log, err = console.error } = {}) {
  const rows = [];
  let failed = 0;
  for (const { name, url } of jwksUrls(env)) {
    try {
      rows.push(...(await describeJwks(await fetchJwks(url, { fetchImpl }), url)));
    } catch (error) {
      failed += 1;
      err(`${name}: could not read ${url}: ${error.message}`);
    }
  }
  for (const row of rows) out(formatRow(row));

  const pins = [...new Set(rows.filter((r) => r.thumbprint).map((r) => r.thumbprint))];
  out(`# ${rows.length} key(s) from ${jwksUrls(env).length - failed} JWKS set(s); ${pins.length} distinct thumbprint(s).`);
  out('# Verify every key first (README "Web3Auth signing-key pins"). Then, to pin all of them:');
  out(`# WEB3AUTH_JWKS_PINNED_THUMBPRINTS=${pins.join(',')}`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  run()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error('web3authJwksThumbprints failed:', error.message);
      process.exitCode = 1;
    });
}

module.exports = { DEFAULT_JWKS_URLS, jwksUrls, fetchJwks, describeJwks, formatRow, run };
