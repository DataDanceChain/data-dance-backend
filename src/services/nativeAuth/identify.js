/**
 * Identify → login attempt (stub; filled by work package BE6, which owns this file after merge).
 *
 * Contract for the implementation:
 *   createLoginAttempt({ identity, intent, method, req, bearerUser }) resolves the account
 *   (accounts.resolveNativeIdentity, writes nothing), runs guardAccount, and creates one
 *   AuthLoginAttempt with loginSecretHash = stateHmac('login', loginSecret). For intent 'login' it
 *   mints the first Web3Auth JWT through issuer.issueW3aToken({ subject: w3aSubject, loginRef,
 *   count: 1 }) and builds walletProof with proofMessage.createWalletProof; for intent 'link' it
 *   mints nothing and returns only { loginId, loginSecret, expiresAt, account }.
 *   issuer.issueW3aToken is called only from here and from POST /token.
 *
 * Until then every caller gets a 501 NOT_IMPLEMENTED error (the routes are 404 anyway while
 * DDC_AUTH_ENABLED is off).
 */
function notImplemented(name) {
  const err = new Error(`nativeAuth.identify.${name} is not implemented yet`);
  err.statusCode = 501;
  err.code = 'NOT_IMPLEMENTED';
  return err;
}

async function createLoginAttempt() {
  throw notImplemented('createLoginAttempt');
}

module.exports = { createLoginAttempt };
