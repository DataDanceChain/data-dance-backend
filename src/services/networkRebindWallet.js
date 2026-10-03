/**
 * What the partner (TGE) API may say about a user's wallet during the Web3Auth network switch.
 *
 * Between `scripts/mainnetSwitch.js --apply` and the user's first login on the new network, a
 * recorded account with walletPolicy `replace` still holds its OLD-network address (the switch
 * never clears a wallet). That address is no longer the user's wallet, so the partner sees the
 * account as unbound (`wallet_bound: false`, `wallet_address: null`) until the re-bind binds the
 * address the new network's token proves. `keep` records (server-held key, external wallet), a
 * wallet bound after the apply, and every account without a pending record are reported exactly
 * as stored.
 *
 * Only while WEB3AUTH_NETWORK_REBIND=on, read straight from the environment so this module does
 * not pull in (and boot-assert) the Web3Auth verifier: the partner routes load without it.
 */
function networkRebindOn(env = process.env) {
  return String(env.WEB3AUTH_NETWORK_REBIND || '').trim().toLowerCase() === 'on';
}

async function isWalletRebindPending(user, { db, env } = {}) {
  if (!user || !user.walletAddress || !networkRebindOn(env)) return false;
  const prisma = db || require('../utils/prisma');
  const record = await prisma.web3AuthNetworkRebind.findUnique({ where: { userId: user.id } });
  return Boolean(
    record &&
      record.status === 'pending' &&
      record.walletPolicy === 'replace' &&
      typeof record.oldAddress === 'string' &&
      record.oldAddress.toLowerCase() === String(user.walletAddress).toLowerCase()
  );
}

/** `user` unchanged, or a copy with `walletAddress: null` while its re-bind is pending. */
async function withPartnerVisibleWallet(user, options = {}) {
  if (!(await isWalletRebindPending(user, options))) return user;
  return { ...user, walletAddress: null };
}

module.exports = { networkRebindOn, isWalletRebindPending, withPartnerVisibleWallet };
