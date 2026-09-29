/**
 * Server-side proof of the native wallet address (design §3.7 step 3, invariant I5, F21).
 *
 * The Web3Auth nodes are asked which address the native connection derives for the opaque
 * w3aSubject (torus.js getPublicAddress). /complete binds a wallet only when that address equals
 * the one that signed the proof. The check is ALWAYS enforced: there is no configuration that
 * skips it, and every failure (timeout, node error, malformed answer) fails closed with 503
 * W3A_LOOKUP_UNAVAILABLE. The only skip is in complete.js, when NativeWalletBinding already holds
 * this exact (connection, subject, address).
 *
 * Node details come from @toruslabs/fnd-base fetchLocalConfig — the same local table
 * @web3auth/single-factor-auth 9.5.0 connect() uses for sapphire networks (not the NodeDetailManager
 * named in the design; BE0 spike finding), and Torus is constructed the way SFA constructs it
 * ({clientId, network, enableOneKey:true}), so the lookup and the client's derivation agree.
 *
 * The torus packages are required lazily, on the first lookup, so nothing is loaded while native
 * login is off. torus.js's own logger is disabled by the library and never enabled here (it would
 * print the verifierId). Nothing here logs the subject, and errors from the library are reduced to
 * an outcome enum before logging (their messages quote node responses).
 *
 * Tests inject the network layer with setLookupDepsForTests(); no unit test reaches a node.
 */
const { getAddress } = require('ethers');
const { logger } = require('./config');
const { NativeAuthError } = require('../../controllers/nativeAuth/respond');

const LOOKUP_TIMEOUT_MS = 8000;

let injectedDeps = null;
let loadedDeps = null;
const torusClients = new Map();

/** { Torus, fetchLocalConfig, keyType } from the pinned packages (see package.json). */
function loadDeps() {
  if (injectedDeps) return injectedDeps;
  if (!loadedDeps) {
    const torusModule = require('@toruslabs/torus.js');
    const fnd = require('@toruslabs/fnd-base');
    const constants = require('@toruslabs/constants');
    loadedDeps = {
      Torus: torusModule.Torus || torusModule.default,
      fetchLocalConfig: fnd.fetchLocalConfig,
      keyType: constants.KEY_TYPE.SECP256K1,
    };
  }
  return loadedDeps;
}

/** Tests only: replace the torus packages with a fake (null restores the real ones). */
function setLookupDepsForTests(deps) {
  injectedDeps = deps || null;
  torusClients.clear();
}

function torusFor(deps, clientId, network) {
  const key = `${network}\u0000${clientId}`;
  if (!torusClients.has(key)) {
    torusClients.set(key, new deps.Torus({ clientId, network, enableOneKey: true }));
  }
  return torusClients.get(key);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('lookup timed out');
        err.lookupOutcome = 'timeout';
        reject(err);
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function unavailable() {
  return new NativeAuthError('W3A_LOOKUP_UNAVAILABLE', {
    message: 'The wallet service is temporarily unavailable. Please try again.',
  });
}

/**
 * The checksummed address the native connection derives for `subject` (the w3aSubject).
 * Throws NativeAuthError W3A_LOOKUP_UNAVAILABLE on any failure. `loginRef` only labels the log.
 */
async function lookupWalletAddress({ connection, subject, network, clientId, loginRef, timeoutMs = LOOKUP_TIMEOUT_MS }) {
  const started = Date.now();
  const done = (outcome, level = 'info') => {
    const meta = { loginRef, ms: Date.now() - started, outcome, network };
    if (level === 'error') logger.error('native_auth.wallet_lookup_unavailable', meta);
    else logger.info('native_auth.wallet_lookup', meta);
  };
  if (!connection || !subject || !network || !clientId) {
    done('misconfigured', 'error');
    throw unavailable();
  }
  let result;
  try {
    const deps = loadDeps();
    const nodeDetails = deps.fetchLocalConfig(network, deps.keyType);
    if (!nodeDetails || !Array.isArray(nodeDetails.torusNodeEndpoints) || !nodeDetails.torusNodeEndpoints.length) {
      const err = new Error('no node details');
      err.lookupOutcome = 'no_node_details';
      throw err;
    }
    const torus = torusFor(deps, clientId, network);
    result = await withTimeout(
      torus.getPublicAddress(nodeDetails.torusNodeEndpoints, nodeDetails.torusNodePub, { verifier: connection, verifierId: subject }),
      timeoutMs,
    );
  } catch (err) {
    done(err && err.lookupOutcome ? err.lookupOutcome : 'node_error', 'error');
    throw unavailable();
  }
  const raw = result && result.finalKeyData && result.finalKeyData.walletAddress;
  let address;
  try {
    address = getAddress(String(raw));
  } catch {
    done('malformed', 'error');
    throw unavailable();
  }
  done('ok');
  return address;
}

module.exports = {
  LOOKUP_TIMEOUT_MS,
  lookupWalletAddress,
  setLookupDepsForTests,
};
