/**
 * Sign in with Apple identity-token verification for native login (design §3.4, §2.5, F4, D8, D12).
 *
 * iOS signs in natively (aud = the bundle id co.datadance.app); the web uses the Apple JS popup
 * (aud = the Services ID). Android has no Apple in v1. The token is accepted only when ALL hold:
 *
 *   signature  RS256 over a key in Apple's JWKS (https://appleid.apple.com/auth/keys, 5 s timeout)
 *   iss        https://appleid.apple.com
 *   aud        one of DDC_AUTH_APPLE_AUDIENCES (bundle id and Services ID)
 *   exp        not expired (60 s tolerance)
 *   sub        present — the Apple user id is the identity (the e-mail never is)
 *   nonce      equals sha256hex(raw) of a live nonce issued for purpose 'apple'; consumed here
 *
 * With no audiences configured the method is unavailable (the caller answers METHOD_DISABLED).
 *
 * E-mail: `email_verified` may be true or "true"; private relay is `is_private_email` (true or
 * "true") or an @privaterelay.appleid.com address. An Apple identity is NEVER a link source: its
 * grade is weak (accounts.linkGrade), so it never auto-links to an existing account, whatever the
 * address. The name exists only in the client's first-authorization payload (`user`), is not signed
 * by Apple, and is used for display only.
 */
const jose = require('jose');
const flowState = require('./flowState');
const { IdpRejection, remoteJwks, assertTokenShape, toNativeError, truthyClaim } = require('./idpErrors');

const PROVIDER = 'apple';
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';
const CLOCK_TOLERANCE_SEC = 60;
const MAX_SUBJECT_LENGTH = 255;
const RELAY_DOMAIN = '@privaterelay.appleid.com';
const MAX_NAME_PART = 50;

/** Apple sign-in is usable only with our audiences configured (empty = unavailable). */
function appleAvailable(cfg) {
  return Boolean(cfg && cfg.apple && cfg.apple.audiences.length);
}

function namePart(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_NAME_PART) : '';
}

/** Display name from the client's first-authorization payload ({firstName, lastName}); never identity. */
function displayName(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return '';
  return [namePart(user.firstName), namePart(user.lastName)].filter(Boolean).join(' ');
}

function appleIdentity(payload, user) {
  const email = typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim().toLowerCase() : null;
  const isPrivateRelay = truthyClaim(payload.is_private_email) || Boolean(email && email.endsWith(RELAY_DOMAIN));
  const name = displayName(user);
  return {
    provider: PROVIDER,
    subject: payload.sub,
    email,
    emailVerified: truthyClaim(payload.email_verified),
    isPrivateRelay,
    profile: name ? { name } : {},
  };
}

/**
 * Verify an Apple identity token and consume its nonce. Returns the identity for
 * createLoginAttempt; throws NativeAuthError IDP_TOKEN_INVALID {reason} | IDP_NONCE_INVALID |
 * IDP_UNAVAILABLE.
 *
 * `keySet` (tests) replaces Apple's remote JWKS; `db`/`now` go to the nonce store.
 */
async function verifyAppleIdentityToken({ identityToken, nonce, user, cfg, keySet, db, now = new Date(), log } = {}) {
  try {
    assertTokenShape(identityToken);
    const { payload } = await jose.jwtVerify(identityToken, keySet || remoteJwks(APPLE_JWKS_URL), {
      algorithms: ['RS256'],
      issuer: APPLE_ISSUER,
      audience: [...cfg.apple.audiences],
      clockTolerance: CLOCK_TOLERANCE_SEC,
      requiredClaims: ['exp', 'sub'],
      currentDate: now,
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > MAX_SUBJECT_LENGTH) throw new IdpRejection('malformed');
    const nonceOk = await flowState.consumeIdpNonce({
      purpose: PROVIDER,
      rawNonce: nonce,
      tokenNonce: payload.nonce,
      now,
      cfg,
      ...(db ? { db } : {}),
    });
    if (!nonceOk) throw new IdpRejection('nonce');
    return appleIdentity(payload, user);
  } catch (err) {
    throw toNativeError(PROVIDER, err, log);
  }
}

module.exports = {
  PROVIDER,
  APPLE_JWKS_URL,
  APPLE_ISSUER,
  CLOCK_TOLERANCE_SEC,
  RELAY_DOMAIN,
  appleAvailable,
  appleIdentity,
  displayName,
  verifyAppleIdentityToken,
};
