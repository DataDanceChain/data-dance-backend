/**
 * Self-serve SSO client registration switch: SSO_DEVELOPER_REGISTRATION = off | on.
 *
 *   off  the default, also when unset or blank. POST /api/developer/sso/clients answers
 *        403 registration_closed before any database access, so it writes nothing. Clients that
 *        already exist keep working: sign-in, the token exchange and the partner API never consult
 *        this switch.
 *   on   anyone may register a client, as before this switch existed (rate-limited per IP).
 *
 * Read once, at boot (initDeveloperRegistration, called from server.js). Changing the environment
 * of a running process changes nothing until it restarts. Any other value refuses to start in
 * production; elsewhere it is one warning and reads as off, the closed side.
 */

const VALUES = Object.freeze(['off', 'on']);

/** Pure: what the environment asks for. `problem` is set for a value that is neither off nor on. */
function readDeveloperRegistration(env = process.env) {
  const raw = String(env.SSO_DEVELOPER_REGISTRATION ?? '').trim();
  const value = raw.toLowerCase();
  if (!value) return { open: false, problem: null };
  if (VALUES.includes(value)) return { open: value === 'on', problem: null };
  return { open: false, problem: `SSO_DEVELOPER_REGISTRATION must be "off" or "on" (got "${raw}")` };
}

function defaultLog() {
  // Required here, not at the top: building a logger opens the log files, and this module is
  // otherwise free of side effects.
  return require('../utils/logger').createLogger('developerRegistration');
}

let snapshot = null;

/**
 * Boot: read the switch once and keep it until the process restarts. Throws in production when the
 * value is neither off nor on, so the process refuses to start; elsewhere warns and reads it as off.
 */
function initDeveloperRegistration({ env = process.env, log } = {}) {
  const { open, problem } = readDeveloperRegistration(env);
  if (problem) {
    if (env.NODE_ENV === 'production') throw new Error(`${problem}; refusing to start`);
    (log || defaultLog()).warn('developer_registration.invalid_value', `${problem}; reading it as "off"`);
  }
  snapshot = Object.freeze({ open });
  return snapshot;
}

/** Whether self-serve registration is open. Read from process.env on first use if boot did not get to it. */
function developerRegistrationOpen() {
  if (!snapshot) snapshot = Object.freeze({ open: readDeveloperRegistration().open });
  return snapshot.open;
}

module.exports = {
  readDeveloperRegistration,
  initDeveloperRegistration,
  developerRegistrationOpen,
};
