/**
 * Account resolution for native login (design §3.6): which DDC account a verified upstream
 * identity signs in to. resolveNativeIdentity() WRITES NOTHING — it is run at identify and again
 * at /complete, and only /complete's transaction writes (complete.js).
 *
 * The identity every method hands over (BE3 e-mail OTP, BE4 Google/Apple, BE5 X):
 *
 *   { provider: 'email'|'google'|'apple'|'x',
 *     subject,                 // email: the normalised address; google/apple: `sub`; x: the X user id
 *     email?,                  // lower-cased; null when the provider released none
 *     emailVerified?,          // the provider asserted it (OTP: always true)
 *     hd?,                     // Google Workspace domain
 *     isPrivateRelay?,         // Apple relay address
 *     profile?: { name?, avatar?, xUsername? } }   // display only, never identity
 *
 * Link grades (F4, D8): our OTP is strong; Google is strong only with email_verified === true AND
 * (a @gmail.com address OR an `hd` claim); Apple is weak; X has none. Only a strong identity may
 * auto-link, and only to a target that is strong too (a strong AuthIdentity, or a legacy
 * e-mail-passwordless / Gmail pair). An unverified row holding the address never blocks and is
 * never merged (F5, D10): the native user gets a separate account ("shadow").
 *
 * User.xid is never trusted for linking (F12): X links only through the legacy Web3Auth X pair.
 */
const crypto = require('crypto');
const { logger } = require('./config');
const { NativeAuthError } = require('../../controllers/nativeAuth/respond');

const PROVIDERS = Object.freeze(['email', 'google', 'apple', 'x']);
const GRADES = Object.freeze(['strong', 'weak', 'none']);
/** AuthIdentity.provider of an old Web3Auth pair recorded by a rebind or the mainnet migration. */
const LEGACY_PROVIDER = 'web3auth_legacy';
const OPEN_ATTEMPT_STATES = Object.freeze(['identified', 'completing']);

/** resolution → Identified.account.linkedBy */
const LINKED_BY = Object.freeze({
  existing: 'identity',
  link_legacy_x: 'legacy_x',
  link_verified_email: 'verified_email',
  link_legacy_email: 'legacy_email',
  shadow_email: 'new',
  create: 'new',
});
/** resolution → AuthIdentity.linkedVia for the identity row /complete writes */
const LINKED_VIA = Object.freeze({
  link_legacy_x: 'legacy_x',
  link_verified_email: 'verified_email',
  link_legacy_email: 'legacy_email',
  shadow_email: 'created',
  create: 'created',
});
const NEW_ACCOUNT_RESOLUTIONS = Object.freeze(['create', 'shadow_email']);

function defaultDb() {
  return require('../../utils/prisma');
}

function lower(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Throws unless `identity` has the shape above. Returns a normalised copy. */
function normalizeIdentity(identity) {
  if (!identity || typeof identity !== 'object') throw new TypeError('identity is required');
  const provider = identity.provider;
  if (!PROVIDERS.includes(provider)) throw new TypeError(`unknown identity provider "${provider}"`);
  const subject = typeof identity.subject === 'string' ? identity.subject.trim() : '';
  if (!subject || subject.length > 320) throw new TypeError('identity.subject is required');
  let email = lower(identity.email) || null;
  // Apple: an address Apple did not verify is not used at all (not even for display or User.email).
  if (provider === 'apple' && identity.emailVerified !== true) email = null;
  const profile = identity.profile && typeof identity.profile === 'object' ? identity.profile : {};
  return {
    provider,
    subject: provider === 'email' ? lower(subject) : subject,
    email,
    emailVerified: provider === 'email' ? true : identity.emailVerified === true,
    hd: typeof identity.hd === 'string' && identity.hd.trim() ? identity.hd.trim().toLowerCase() : null,
    isPrivateRelay: Boolean(identity.isPrivateRelay),
    profile: {
      ...(typeof profile.name === 'string' && profile.name.trim() && { name: profile.name.trim().slice(0, 100) }),
      ...(typeof profile.avatar === 'string' && /^https:\/\//i.test(profile.avatar) && { avatar: profile.avatar.slice(0, 1000) }),
      ...(typeof profile.xUsername === 'string' && profile.xUsername.trim() && { xUsername: profile.xUsername.trim().slice(0, 50) }),
    },
  };
}

/** §3.6 link grade of an incoming identity. */
function linkGrade(identity) {
  switch (identity.provider) {
    case 'email':
      return identity.email ? 'strong' : 'none';
    case 'google':
      if (!identity.email) return 'none';
      return identity.emailVerified === true && (identity.email.endsWith('@gmail.com') || Boolean(identity.hd)) ? 'strong' : 'weak';
    case 'apple':
      return identity.email ? 'weak' : 'none';
    default:
      return 'none';
  }
}

function isOrganization(user) {
  return Boolean(user && (user.userType === 'organization' || user.isOrganization));
}

/** Disabled and organisation accounts never sign in natively (identify, /token, /complete; F21). */
function guardAccount(user) {
  if (!user) return;
  if (user.disabledAt) throw new NativeAuthError('ACCOUNT_DISABLED', { message: 'This account has been disabled' });
  if (isOrganization(user)) throw new NativeAuthError('ORG_NOT_ALLOWED', { message: 'Organization accounts cannot use this sign-in' });
}

function linkRequired(reason, extra = {}) {
  return new NativeAuthError('ACCOUNT_LINK_REQUIRED', {
    message: 'This sign-in cannot be linked to an existing account automatically.',
    data: { reason, ...extra },
  });
}

function startOfUtcDay(now) {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function allowlisted(identity, cfg) {
  const list = cfg.allowlist || [];
  if (identity.provider === 'x' && list.includes(`x:${lower(identity.subject)}`)) return true;
  // Only an address the provider verified may open the gate (an unverified Google e-mail is typed
  // in by the token holder).
  if (!identity.email || identity.emailVerified !== true) return false;
  const domain = identity.email.slice(identity.email.lastIndexOf('@'));
  return list.includes(identity.email) || list.includes(domain);
}

/**
 * The new-account gate (DDC_AUTH_NEW_ACCOUNTS, F16): closed, or an allowlist, plus the daily cap
 * (DDC_AUTH_NEW_ACCOUNTS_PER_DAY) counted over native accounts created since 00:00 UTC.
 */
async function assertNewAccountAllowed({ identity, cfg, db = defaultDb(), now = new Date() }) {
  const closed = () => new NativeAuthError('NEW_ACCOUNTS_CLOSED', { message: 'New accounts cannot be created with this sign-in right now.' });
  if (cfg.newAccounts === 'closed') throw closed();
  if (cfg.newAccounts === 'allowlist' && !allowlisted(identity, cfg)) throw closed();
  if (cfg.newAccounts !== 'open' && cfg.newAccounts !== 'allowlist') throw closed();
  await assertDailyCapAvailable({ cfg, db, now });
}

/**
 * The hard daily cap on native account creation (F16), counted as AuthIdentity rows written with
 * linkedVia 'created' since 00:00 UTC. Checked at identify and again at /complete.
 */
async function assertDailyCapAvailable({ cfg, db = defaultDb(), now = new Date() }) {
  const cap = Number.isFinite(cfg.newAccountsPerDay) ? cfg.newAccountsPerDay : 0;
  const createdToday = await db.authIdentity.count({
    where: { linkedVia: 'created', createdAt: { gte: startOfUtcDay(now) } },
  });
  if (createdToday >= cap) {
    logger.error('native_auth.new_accounts_cap_hit', { cap });
    throw new NativeAuthError('NEW_ACCOUNTS_CLOSED', { message: 'New accounts cannot be created with this sign-in right now.' });
  }
}

/** Rule 2: the legacy Web3Auth X pair (verifier ∈ DDC_AUTH_LEGACY_X_VERIFIERS, 'twitter|<id>'). */
async function findLegacyXUser(identity, cfg, db) {
  const hits = [];
  for (const verifier of cfg.legacy.xVerifiers) {
    const user = await db.user.findUnique({
      where: { web3authVerifier_web3authVerifierId: { web3authVerifier: verifier, web3authVerifierId: `twitter|${identity.subject}` } },
    });
    if (user && !hits.some((u) => u.id === user.id)) hits.push(user);
  }
  return hits;
}

/**
 * Rule 3 category of a user row that holds the e-mail E:
 *   'b' legacy e-mail-passwordless pair (…, E), or legacy Google pair (…, E) with E @gmail.com
 *   'c' any other Web3Auth pair (legacy Apple, non-Gmail Google, external wallet, …)
 *   'd' no Web3Auth pair (password rows, placeholders) — or a native account that holds E only
 *       through a weaker identity: never a target, never a blocker.
 */
function emailHolderCategory(user, email, cfg) {
  const verifier = user.web3authVerifier;
  const verifierId = lower(user.web3authVerifierId);
  if (!verifier) return 'd';
  if (cfg.connectionId && verifier === cfg.connectionId) return 'd';
  if (cfg.legacy.emailVerifiers.includes(verifier) && verifierId === email) return 'b';
  if (cfg.legacy.googleVerifiers.includes(verifier) && verifierId === email && email.endsWith('@gmail.com')) return 'b';
  return 'c';
}

async function findEmailHolders(email, cfg, db) {
  const byId = new Map();
  const rows = await db.user.findMany({ where: { email: { equals: email, mode: 'insensitive' } } });
  for (const row of rows) byId.set(row.id, row);
  // A legacy e-mail pair is the stronger evidence; find it even if the e-mail column differs.
  for (const verifier of [...cfg.legacy.emailVerifiers, ...(email.endsWith('@gmail.com') ? cfg.legacy.googleVerifiers : [])]) {
    const row = await db.user.findUnique({
      where: { web3authVerifier_web3authVerifierId: { web3authVerifier: verifier, web3authVerifierId: email } },
    });
    if (row) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function result(resolution, { user = null, identityRow = null, grade }) {
  return {
    resolution,
    user,
    identityRow,
    grade,
    account: {
      status: NEW_ACCOUNT_RESOLUTIONS.includes(resolution) ? 'new' : 'existing',
      hasWallet: Boolean(user && user.walletAddress),
      linkedBy: LINKED_BY[resolution],
    },
  };
}

/**
 * §3.6 resolution, first match wins. Returns { resolution, user, identityRow, grade, account }.
 * Throws NativeAuthError ACCOUNT_LINK_REQUIRED / NEW_ACCOUNTS_CLOSED / ACCOUNT_DISABLED /
 * ORG_NOT_ALLOWED. Writes nothing.
 *
 * `checkNewAccountGate: false` skips the new-account gate (used by /complete, which re-checks
 * only the daily cap itself). `grade` replaces the computed link grade (the one identify stored).
 */
async function resolveNativeIdentity({ identity: rawIdentity, cfg, db = defaultDb(), now = new Date(), checkNewAccountGate = true, grade: storedGrade }) {
  const identity = normalizeIdentity(rawIdentity);
  // /complete re-resolves from the attempt row, which keeps the grade identify computed (the `hd`
  // claim behind a Workspace grade is not stored).
  const grade = GRADES.includes(storedGrade) ? storedGrade : linkGrade(identity);

  // 1. An identity we already know.
  const identityRow = await db.authIdentity.findUnique({
    where: { provider_subject: { provider: identity.provider, subject: identity.subject } },
  });
  if (identityRow) {
    const user = await db.user.findUnique({ where: { id: identityRow.userId } });
    if (user) {
      guardAccount(user);
      return result('existing', { user, identityRow, grade });
    }
  }

  // 2. X: only the legacy Web3Auth X pair links (never User.xid).
  if (identity.provider === 'x') {
    const hits = await findLegacyXUser(identity, cfg, db);
    if (hits.length > 1) throw linkRequired('ambiguous');
    if (hits.length === 1) {
      guardAccount(hits[0]);
      return result('link_legacy_x', { user: hits[0], grade });
    }
  }

  let resolution = 'create';
  // 3. A strong e-mail.
  if (grade === 'strong' && identity.email) {
    const email = identity.email;
    // a. strong identities of E (weaker rows are never targets, F4b)
    const strongRows = await db.authIdentity.findMany({ where: { email, emailLinkGrade: 'strong' } });
    const strongUserIds = [...new Set(strongRows.map((row) => row.userId))];
    if (strongUserIds.length > 1) throw linkRequired('ambiguous');
    if (strongUserIds.length === 1) {
      const user = await db.user.findUnique({ where: { id: strongUserIds[0] } });
      if (user) {
        guardAccount(user);
        return result('link_verified_email', { user, grade });
      }
    }
    // b–d. rows holding E
    const holders = await findEmailHolders(email, cfg, db);
    const byCategory = { b: [], c: [], d: [] };
    for (const user of holders) byCategory[emailHolderCategory(user, email, cfg)].push(user);
    if (byCategory.b.length > 1) throw linkRequired('ambiguous');
    if (byCategory.b.length === 1) {
      guardAccount(byCategory.b[0]);
      return result('link_legacy_email', { user: byCategory.b[0], grade });
    }
    if (byCategory.c.length) throw linkRequired('legacy_method', { hint: 'sign_in_with_previous_method_then_link' });
    if (byCategory.d.length) resolution = 'shadow_email';
  }

  // 4. A new account (or the separate "shadow" account of rule 3d).
  if (checkNewAccountGate) await assertNewAccountAllowed({ identity, cfg, db, now });
  return result(resolution, { grade });
}

/**
 * The (pendingUserId, w3aSubject) a new login attempt should carry, so that repeating identify
 * (a retry, LOGIN_RACE) keeps deriving the same wallet:
 *   - an account that already has a NativeWalletBinding → its subject;
 *   - otherwise the values of an open attempt for the same account / identity;
 *   - otherwise fresh random UUIDs.
 * The subject is the opaque w3aSubject (F11): never the user id, never logged.
 */
async function pendingSubjects({ identity, userId, db = defaultDb(), now = new Date() }) {
  const open = { state: { in: [...OPEN_ATTEMPT_STATES] }, expiresAt: { gt: now }, intent: 'login', w3aSubject: { not: null } };
  if (userId) {
    const binding = await db.nativeWalletBinding.findUnique({ where: { userId } });
    if (binding) return { pendingUserId: null, w3aSubject: binding.subject };
    const attempt = await db.authLoginAttempt.findFirst({ where: { ...open, userId } });
    return { pendingUserId: null, w3aSubject: attempt ? attempt.w3aSubject : crypto.randomUUID() };
  }
  const attempt = await db.authLoginAttempt.findFirst({
    where: { ...open, provider: identity.provider, subject: identity.subject, userId: null, pendingUserId: { not: null } },
  });
  if (attempt) return { pendingUserId: attempt.pendingUserId, w3aSubject: attempt.w3aSubject };
  return { pendingUserId: crypto.randomUUID(), w3aSubject: crypto.randomUUID() };
}

module.exports = {
  PROVIDERS,
  GRADES,
  LEGACY_PROVIDER,
  LINKED_BY,
  LINKED_VIA,
  NEW_ACCOUNT_RESOLUTIONS,
  normalizeIdentity,
  linkGrade,
  guardAccount,
  assertNewAccountAllowed,
  assertDailyCapAvailable,
  emailHolderCategory,
  resolveNativeIdentity,
  pendingSubjects,
};
