/**
 * distributionService: the referral lookup in distributeUplineRewards logs ids only, never the
 * inviter record it loads (id, name, e-mail).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../src/services/distributionService.js'), 'utf8');

describe('distributeUplineRewards referral log', () => {
  it('does not serialise the referral row or its inviter into a log line', () => {
    assert.doesNotMatch(source, /JSON\.stringify\(\s*referral\s*\)/);
    assert.doesNotMatch(source, /logger\.\w+\([^)]*referral\.inviter\b/);
  });

  it('logs the lookup with ids only', () => {
    const line = source.split('\n').find((l) => l.includes("'Referral lookup'"));
    assert.ok(line, 'the referral lookup log line is present');
    assert.match(line, /inviteeId: currentUserId/);
    assert.match(line, /inviterId: referral\?\.inviterId \?\? null/);
    assert.doesNotMatch(line, /email|name/);
  });
});
