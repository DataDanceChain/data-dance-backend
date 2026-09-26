/**
 * Kill switch (A8b): a boot with SSO_TGE_ENABLED=false revokes every outstanding partner access
 * token, so turning the switch back on cannot revive a token issued before it was turned off
 * (acceptance T17.2 "tokens issued before the switch stay dead"). Found on the local stack: off →
 * on within the 300 s token lifetime and the old token answered 200 again.
 *
 * The switch itself takes effect only at a restart (it is an environment variable) — that part is
 * inherent and documented (T18 manual procedure; a database-row switch is hardening item G11).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();
process.env.LOG_LEVEL = 'error';

const { revokeAllPartnerTokens, PARTNER_SOURCE } = require('../../src/services/mcpTokenService');
const { applyPartnerKillSwitch } = require('../../src/services/partnerKillSwitch');

const future = () => new Date(Date.now() + 300_000);

function seed() {
  prisma.mcpToken.rows.push(
    { id: 't1', userId: 'u1', tokenHash: 'h1', tokenPrefix: 'ddc_tge_', label: 'TGE', source: PARTNER_SOURCE, clientId: 'tge-test', expiresAt: future() },
    { id: 't2', userId: 'u2', tokenHash: 'h2', tokenPrefix: 'ddc_tge_', label: 'TGE', source: PARTNER_SOURCE, clientId: 'tge-test', expiresAt: future() },
    { id: 'm1', userId: 'u1', tokenHash: 'h3', tokenPrefix: 'ddc_mcp_', label: 'Claude', source: 'oauth', clientId: 'ddc_oauth_x', expiresAt: future() },
    { id: 'm2', userId: 'u1', tokenHash: 'h4', tokenPrefix: 'ddc_mcp_', label: 'manual', source: 'manual', clientId: '', expiresAt: null },
  );
}

describe('partner kill switch revokes outstanding partner tokens', () => {
  beforeEach(() => {
    prisma.reset();
    seed();
  });

  it('revokeAllPartnerTokens deletes every partner token and nothing else', async () => {
    const count = await revokeAllPartnerTokens();
    assert.equal(count, 2);
    assert.deepEqual(prisma.mcpToken.rows.map((r) => r.id).sort(), ['m1', 'm2']);
  });

  it('a boot with the switch OFF revokes them', async () => {
    const out = await applyPartnerKillSwitch({ enabled: false }, { retries: 0 });
    assert.deepEqual(out, { revoked: 2 });
    assert.equal(prisma.mcpToken.rows.filter((r) => r.source === PARTNER_SOURCE).length, 0);
  });

  it('a boot with the switch ON leaves live tokens alone', async () => {
    const out = await applyPartnerKillSwitch({ enabled: true }, { retries: 0 });
    assert.deepEqual(out, { revoked: 0, skipped: 'enabled' });
    assert.equal(prisma.mcpToken.rows.length, 4);
  });

  it('a database failure is retried, then reported without crashing the boot', async () => {
    const original = prisma.mcpToken.deleteMany;
    let calls = 0;
    prisma.mcpToken.deleteMany = async (...args) => {
      calls += 1;
      if (calls < 3) throw new Error('connection refused');
      return original.apply(prisma.mcpToken, args);
    };
    try {
      const ok = await applyPartnerKillSwitch({ enabled: false }, { retries: 3, delayMs: 1 });
      assert.deepEqual(ok, { revoked: 2 });
      calls = -100;
      const failed = await applyPartnerKillSwitch({ enabled: false }, { retries: 1, delayMs: 1 });
      assert.equal(failed.revoked, 0);
      assert.match(failed.error, /connection refused/);
    } finally {
      prisma.mcpToken.deleteMany = original;
    }
  });

  it('src/server.js runs it at boot, after the partner config is asserted', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
    const assertAt = src.indexOf('assertPartnerConfig()');
    const killAt = src.indexOf('applyPartnerKillSwitch(partnerSso');
    assert.ok(assertAt > -1 && killAt > assertAt, 'server.js must call applyPartnerKillSwitch(partnerSso, …) after assertPartnerConfig()');
  });
});
