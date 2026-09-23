/**
 * Partner (TGE) kill switch, boot-time half (A8b).
 *
 * SSO_TGE_ENABLED=false already closes every partner path while the process runs (authorize,
 * token, /partner/tge/*, app-ticket all refuse a disabled client). What it did NOT do was end the
 * tokens already issued: they are rows that simply stopped being accepted, so switching back on
 * within their 300 s lifetime made them valid again. A boot with the switch OFF therefore revokes
 * all of them. Switching back on then starts from zero outstanding partner tokens.
 *
 * Inherent limit, documented rather than fixed: the switch is an environment variable, so it takes
 * effect only when the API restarts (and the whole API restarts with it). An instant, restart-free
 * switch is a database-row switch — hardening item G11, batch 2.
 *
 * Never throws: a database outage at boot must not keep the API down. The failure is logged at
 * error level (retried first), because until it succeeds a re-enable could revive old tokens.
 */
const { revokeAllPartnerTokens } = require('./mcpTokenService');
const { createLogger } = require('../utils/logger');

const logger = createLogger('partnerKillSwitch');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applyPartnerKillSwitch(partnerSummary, { retries = 5, delayMs = 2000 } = {}) {
  if (partnerSummary && partnerSummary.enabled) return { revoked: 0, skipped: 'enabled' };
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const revoked = await revokeAllPartnerTokens();
      logger.info('partner.kill_switch_revoked_tokens', { revoked, attempt });
      return { revoked };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(delayMs * 2 ** attempt);
    }
  }
  const message = (lastError && lastError.message) || String(lastError);
  logger.error('partner.kill_switch_revoke_failed', {
    error: message,
    consequence: 'partner tokens issued before this boot were NOT revoked; re-enabling within their lifetime (300 s) would revive them',
  });
  return { revoked: 0, error: message };
}

module.exports = { applyPartnerKillSwitch };
