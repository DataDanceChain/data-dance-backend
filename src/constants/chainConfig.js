/**
 * Chain signer and chain settings, read from the environment. Nothing here, and nothing in
 * src/utils/web3Utils.js, may carry a key: the repository is public.
 *
 *   CHAIN_SIGNER_PRIVATE_KEY  Signs the transactions the API sends itself. No default and no
 *                             fallback: unset means "on-chain signing is off". 64 hex characters,
 *                             optional 0x prefix.
 *   CHAIN_RPC_URL             JSON-RPC endpoint. Default: the endpoint the API has always used in
 *                             production (DataDance chain dev-exp-alpha).
 *   CHAIN_ID                  Chain id that endpoint must serve. Default 44508.
 *
 * The defaults are today's production values and do NOT depend on NODE_ENV. Partner SSO forces
 * NODE_ENV=production on every deployment, test ones included, so NODE_ENV cannot tell two
 * environments apart; the variables above can. A developer who wants a local node sets
 * CHAIN_RPC_URL (and CHAIN_ID) explicitly.
 *
 * A missing or malformed signer key never stops the API from booting: boot logs one warning that
 * names the variable, and every signing call then fails with an error that names it. Neither the
 * key nor any part of the RPC URL (providers embed API keys in it) is ever put in a message or a
 * log line: errors say what is wrong, never what the value was.
 */

const DEFAULT_CHAIN_RPC_URL = 'https://dev-exp-alpha.datadance.ai/eth/rpc';
const DEFAULT_CHAIN_ID = 44508;

const SIGNER_KEY_ENV = 'CHAIN_SIGNER_PRIVATE_KEY';
const RPC_URL_ENV = 'CHAIN_RPC_URL';
const CHAIN_ID_ENV = 'CHAIN_ID';

const KEY_PATTERN = /^(?:0x)?([0-9a-fA-F]{64})$/;
// A positive integer that is still exact as a JS number.
const CHAIN_ID_PATTERN = /^[1-9]\d{0,14}$/;

function clean(value) {
  return String(value ?? '').trim();
}

function configError(code, message) {
  return Object.assign(new Error(message), { code, statusCode: 503 });
}

function signerUnconfiguredError() {
  return configError(
    'chain_signer_unconfigured',
    `${SIGNER_KEY_ENV} is not set: on-chain signing is disabled until it is configured`,
  );
}

function signerInvalidError() {
  return configError(
    'chain_signer_invalid',
    `${SIGNER_KEY_ENV} is not a valid private key (expected 64 hex characters, optional 0x prefix)`,
  );
}

/** CHAIN_RPC_URL, or the production default when unset. Throws when set to anything but http(s). */
function chainRpcUrl(env = process.env) {
  const raw = clean(env[RPC_URL_ENV]);
  if (!raw) return DEFAULT_CHAIN_RPC_URL;
  let parsed = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw configError('chain_rpc_url_invalid', `${RPC_URL_ENV} must be an http(s) URL`);
  }
  return raw;
}

/** CHAIN_ID, or 44508 when unset. Throws when set to anything but a positive integer. */
function chainId(env = process.env) {
  const raw = clean(env[CHAIN_ID_ENV]);
  if (!raw) return DEFAULT_CHAIN_ID;
  if (!CHAIN_ID_PATTERN.test(raw)) {
    throw configError('chain_id_invalid', `${CHAIN_ID_ENV} must be a positive integer`);
  }
  return Number(raw);
}

/**
 * The signer key as 0x-prefixed hex. Throws chain_signer_unconfigured when unset and
 * chain_signer_invalid when malformed; the message names CHAIN_SIGNER_PRIVATE_KEY and never
 * contains the value.
 */
function chainSignerKey(env = process.env) {
  const raw = clean(env[SIGNER_KEY_ENV]);
  if (!raw) throw signerUnconfiguredError();
  const match = KEY_PATTERN.exec(raw);
  if (!match) throw signerInvalidError();
  return `0x${match[1]}`;
}

/**
 * An ethers Wallet for the configured key, connected to `provider` (or to none).
 * Right-looking hex that is still not a usable secp256k1 key (all zeros, above the curve order)
 * is reported as chain_signer_invalid too, without ethers' own message.
 */
function createSignerWallet(provider, env = process.env) {
  const key = chainSignerKey(env);
  const { Wallet } = require('ethers');
  try {
    return new Wallet(key, provider || null);
  } catch {
    throw signerInvalidError();
  }
}

/**
 * Everything boot wants to know about the chain settings; never throws and never returns the key
 * or the RPC URL, only the RPC host and the signer's public address.
 *
 * @returns {{ rpcHost: string|null, chainId: number|null,
 *             signer: 'ok'|'missing'|'invalid', signerAddress: string|null,
 *             problems: Array<{ variable: string, code: string, message: string }> }}
 */
function inspectChainConfig(env = process.env) {
  const problems = [];
  const note = (variable, error) => problems.push({ variable, code: error.code, message: error.message });

  let rpcHost = null;
  try {
    rpcHost = new URL(chainRpcUrl(env)).host;
  } catch (error) {
    note(RPC_URL_ENV, error);
  }

  let id = null;
  try {
    id = chainId(env);
  } catch (error) {
    note(CHAIN_ID_ENV, error);
  }

  let signer = 'ok';
  let signerAddress = null;
  try {
    signerAddress = createSignerWallet(null, env).address;
  } catch (error) {
    signer = error.code === 'chain_signer_unconfigured' ? 'missing' : 'invalid';
    note(SIGNER_KEY_ENV, error);
  }

  return { rpcHost, chainId: id, signer, signerAddress, problems };
}

function defaultLog() {
  // Required here, not at the top: building a logger opens the log files, and this module is
  // otherwise free of side effects.
  return require('../utils/logger').createLogger('chainConfig');
}

/**
 * Boot check. Logs ONE warning per problem found (a missing signer key is one warning naming
 * CHAIN_SIGNER_PRIVATE_KEY, nothing else), and when all is well one info line with the signer's
 * public address, so whoever deploys can confirm which key was loaded without ever seeing it.
 * Never throws: the API boots either way.
 *
 * @param {{ env?: object, log?: { warn: Function, info: Function } }} [options]
 */
function warnIfChainSignerUnavailable({ env = process.env, log } = {}) {
  const report = inspectChainConfig(env);
  const sink = log || defaultLog();
  for (const problem of report.problems) {
    sink.warn(`chain.${problem.code.replace(/^chain_/, '')}`, { variable: problem.variable, detail: problem.message });
  }
  if (report.problems.length === 0) {
    sink.info('chain.signer_configured', {
      signerAddress: report.signerAddress,
      chainId: report.chainId,
      rpcHost: report.rpcHost,
    });
  }
  return report;
}

module.exports = {
  DEFAULT_CHAIN_RPC_URL,
  DEFAULT_CHAIN_ID,
  SIGNER_KEY_ENV,
  chainRpcUrl,
  chainId,
  chainSignerKey,
  createSignerWallet,
  inspectChainConfig,
  warnIfChainSignerUnavailable,
};
