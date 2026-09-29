/**
 * Google ID-token verification for native login (design §3.4, §2.5, F4, F22).
 *
 * The client obtains a Google ID token (GIS on the web, Google Sign-In / Credential Manager in the
 * App) with nonce = sha256hex(raw nonce from POST /nonce) and submits it with the raw nonce. The
 * token is accepted only when ALL of these hold:
 *
 *   signature  RS256 over a key in Google's published JWKS (https://www.googleapis.com/oauth2/v3/certs)
 *   iss        accounts.google.com or https://accounts.google.com
 *   aud        exactly one of our client ids (DDC_AUTH_GOOGLE_CLIENT_IDS: web first, iOS second)
 *   azp        one of our client ids (DDC_AUTH_GOOGLE_AZP_IDS: web, iOS, Android), and consistent
 *              with aud per platform: web → aud=azp=web id; iOS → aud=azp=iOS id (or aud=web id
 *              when the App names the web id as server client); Android → aud=web id, azp=Android
 *              id. So when azp ≠ aud, aud must be the web id.
 *   exp        not expired (60 s tolerance)
 *   sub        present
 *   nonce      equals sha256hex(raw) of a live nonce issued for purpose 'google'; consumed here
 *
 * With no client ids configured the method is unavailable (the caller answers METHOD_DISABLED).
 *
 * The verified identity is handed to identify.createLoginAttempt (BE6) as
 * { provider:'google', subject: sub, email: lower(email), emailVerified: email_verified===true, hd }.
 * The link grade (accounts.linkGrade, F4) makes it strong only when email_verified is true AND the
 * address is @gmail.com or the token carries `hd`; otherwise weak (never a link source).
 */
const jose = require('jose');
const flowState = require('./flowState');
const { IdpRejection, remoteJwks, assertTokenShape, toNativeError } = require('./idpErrors');

const PROVIDER = 'google';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = Object.freeze(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_TOLERANCE_SEC = 60;
const MAX_SUBJECT_LENGTH = 255;

/** Google sign-in is usable only with our client ids configured (empty = unavailable). */
function googleAvailable(cfg) {
  return Boolean(cfg && cfg.google && cfg.google.clientIds.length && cfg.google.azpIds.length);
}

/** The accepted (aud, azp) pairs, per platform, from the configured ids. */
function assertAudienceAndAzp(payload, cfg) {
  const { aud, azp } = payload;
  // jose already required one of our ids in aud; Google issues a single string audience.
  if (typeof aud !== 'string' || !cfg.google.clientIds.includes(aud)) throw new IdpRejection('audience');
  if (typeof azp !== 'string' || !cfg.google.azpIds.includes(azp)) throw new IdpRejection('azp');
  const webClientId = cfg.google.clientIds[0];
  if (azp !== aud && aud !== webClientId) throw new IdpRejection('azp');
}

function googleIdentity(payload) {
  const email = typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim().toLowerCase() : null;
  const hd = typeof payload.hd === 'string' && payload.hd.trim() ? payload.hd.trim().toLowerCase() : undefined;
  const profile = {};
  if (typeof payload.name === 'string' && payload.name.trim()) profile.name = payload.name.trim();
  if (typeof payload.picture === 'string' && /^https:\/\//i.test(payload.picture)) profile.avatar = payload.picture;
  return {
    provider: PROVIDER,
    subject: payload.sub,
    email,
    emailVerified: payload.email_verified === true,
    ...(hd ? { hd } : {}),
    profile,
  };
}

/**
 * Verify a Google credential and consume its nonce. Returns the identity for createLoginAttempt;
 * throws NativeAuthError IDP_TOKEN_INVALID {reason} | IDP_NONCE_INVALID | IDP_UNAVAILABLE.
 *
 * `keySet` (tests) replaces Google's remote JWKS; `db`/`now` go to the nonce store.
 */
async function verifyGoogleCredential({ credential, nonce, cfg, keySet, db, now = new Date(), log } = {}) {
  try {
    assertTokenShape(credential);
    const { payload } = await jose.jwtVerify(credential, keySet || remoteJwks(GOOGLE_JWKS_URL), {
      algorithms: ['RS256'],
      issuer: [...GOOGLE_ISSUERS],
      audience: [...cfg.google.clientIds],
      clockTolerance: CLOCK_TOLERANCE_SEC,
      requiredClaims: ['exp', 'sub'],
      currentDate: now,
    });
    assertAudienceAndAzp(payload, cfg);
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
    return googleIdentity(payload);
  } catch (err) {
    throw toNativeError(PROVIDER, err, log);
  }
}

module.exports = {
  PROVIDER,
  GOOGLE_JWKS_URL,
  GOOGLE_ISSUERS,
  CLOCK_TOLERANCE_SEC,
  googleAvailable,
  googleIdentity,
  verifyGoogleCredential,
};
