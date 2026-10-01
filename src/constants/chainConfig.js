/**
 * Chain signer and chain settings, read from the environment. Nothing here, and nothing in
 * src/utils/web3Utils.js, may carry a key: the repository is public.
 *
 *   CHAIN_SIGNER_PRIVATE_KEY  Signs the transactions the API sends itself. No default and no
 *                             fallback (it is NOT BACKEND_WALLET_PRIVATE_KEY, which commerce
 *                             attestation still prefers): unset means "on-chain signing is off".
 *                             64 hex characters, optional 0x prefix.
 *   CHAIN_RPC_URL             JSON-RPC endpoint. Falls back to DDC_RPC_URL, then to the endpoint the
 *                             API has always used in production (DataDance chain dev-exp-alpha).
 *   CHAIN_ID                  Chain id that endpoint must serve. Falls back to DDC_CHAIN_ID, then 44508.
 *
 * DDC_RPC_URL / DDC_CHAIN_ID are the pair the rest of the backend already reads (commerce
 * attestation, DDC NFT metadata, the balance lookup). Falling back to them means one setting moves
 * every chain reader, and CHAIN_RPC_URL / CHAIN_ID only override this module. They are a fallback
 * rather than the only names because those readers do not share one set of defaults: web3Service
 * has none (ethers' own http://localhost:8545, no chain id) where the other two default to
 * dev-exp-alpha / 44508, and they parse the id differently, so adopting the DDC_* names outright
 * would not make them one thing. Set a pair in full, the URL and the id together.
 *
 * The defaults are today's production values and do NOT depend on NODE_ENV. Partner SSO forces
 * NODE_ENV=production on every deployment, test ones included, so NODE_ENV cannot tell two
 * environments apart; the variables above can. A developer who wants a local node sets the URL
 * (and the id) explicitly.
 *
 * A missing or malformed signer key never stops the API from booting: boot logs one warning that
 * names the variable, and every signing call then fails with an error that names it. The key never
 * appears in a message or a log line, and neither does the RPC URL in this module's own errors or
 * in the boot log (which carries the RPC host only). That does NOT extend to ethers: its errors
 * (SERVER_ERROR and the like) carry the full RPC URL in their message, and some callers return
 * error.message to the client (createActivity does, in its 500 body). So the RPC URL must never
 * carry a credential: no user:password@, no API key in the path or the query.
 */

const DEFAULT_CHAIN_RPC_URL = 'https://dev-exp-alpha.datadance.ai/eth/rpc';
const DEFAULT_CHAIN_ID = 44508;

const SIGNER_KEY_ENV = 'CHAIN_SIGNER_PRIVATE_KEY';
// The first name that holds a value wins; then the other; then the default.
const RPC_URL_ENVS = Object.freeze(['CHAIN_RPC_URL', 'DDC_RPC_URL']);
const CHAIN_ID_ENVS = Object.freeze(['CHAIN_ID', 'DDC_CHAIN_ID']);

const KEY_PATTERN = /^(?:0x)?([0-9a-fA-F]{64})$/;
// A positive integer that is still exact as a JS number.
const CHAIN_ID_PATTERN = /^[1-9]\d{0,14}$/;

function clean(value) {
  return String(value ?? '').trim();
}

/** `variable` names the setting at fault, so a boot warning and a caller can both say which one. */
function configError(code, message, variable) {
  return Object.assign(new Error(message), { code, statusCode: 503, variable });
}

/** The first of `names` that holds a non-blank value, as { name, value }; value is '' when none does. */
function firstSet(env, names) {
  for (const name of names) {
    const value = clean(env[name]);
    if (value) return { name, value };
  }
  return { name: names[0], value: '' };
}

function signerUnconfiguredError() {
  return configError(
    'chain_signer_unconfigured',
    `${SIGNER_KEY_ENV} is not set: on-chain signing is disabled until it is configured`,
    SIGNER_KEY_ENV,
  );
}

function signerInvalidError() {
  return configError(
    'chain_signer_invalid',
    `${SIGNER_KEY_ENV} is not a valid private key (expected 64 hex characters, optional 0x prefix)`,
    SIGNER_KEY_ENV,
  );
}

/**
 * CHAIN_RPC_URL, else DDC_RPC_URL, else the production default. Throws when the value that is set
 * is anything but http(s); an invalid CHAIN_RPC_URL is an error, never a silent fall-through to
 * DDC_RPC_URL. The message names the variable that holds the bad value, never the value.
 */
function chainRpcUrl(env = process.env) {
  const { name, value } = firstSet(env, RPC_URL_ENVS);
  if (!value) return DEFAULT_CHAIN_RPC_URL;
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    throw configError('chain_rpc_url_invalid', `${name} must be an http(s) URL`, name);
  }
  return value;
}

/** CHAIN_ID, else DDC_CHAIN_ID, else 44508. Throws, naming the variable at fault, unless it is a positive integer. */
function chainId(env = process.env) {
  const { name, value } = firstSet(env, CHAIN_ID_ENVS);
  if (!value) return DEFAULT_CHAIN_ID;
  if (!CHAIN_ID_PATTERN.test(value)) {
    throw configError('chain_id_invalid', `${name} must be a positive integer`, name);
  }
  return Number(value);
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
  const note = (error) => problems.push({ variable: error.variable, code: error.code, message: error.message });

  let rpcHost = null;
  try {
    rpcHost = new URL(chainRpcUrl(env)).host;
  } catch (error) {
    note(error);
  }

  let id = null;
  try {
    id = chainId(env);
  } catch (error) {
    note(error);
  }

  let signer = 'ok';
  let signerAddress = null;
  try {
    signerAddress = createSignerWallet(null, env).address;
  } catch (error) {
    signer = error.code === 'chain_signer_unconfigured' ? 'missing' : 'invalid';
    note(error);
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
