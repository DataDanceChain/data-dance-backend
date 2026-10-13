/**
 * FIRST_ACTION_BONUS drafts keep their bonus type through schedule / live. The ops transition calls
 * parseDraft({ ...storedRow, ...req.body }), and req.body.action is the transition ('schedule',
 * 'live'), so the bonus type must come from the stored config.action there.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseDraft } = require('../../src/utils/campaignRules');

function storedRow(config = { action: 'first_distillation', points: 50 }) {
  return {
    slug: 'first-distill-bonus',
    template: 'FIRST_ACTION_BONUS',
    titleEn: 'First distillation bonus',
    blurbEn: 'Distill your Life Capsule once and earn points.',
    startsAt: '2026-10-01T00:00:00.000Z',
    endsAt: '2026-11-01T00:00:00.000Z',
    purpose: 'Encourage the first distillation',
    legalText: 'One bonus per account while the campaign runs.',
    config,
  };
}

describe('parseDraft: FIRST_ACTION_BONUS through schedule and live', () => {
  for (const transition of ['schedule', 'live']) {
    it(`keeps config.action on ${transition}`, () => {
      const parsed = parseDraft({ ...storedRow(), action: transition });
      assert.equal(parsed.error, undefined, parsed.error);
      assert.equal(parsed.data.config.action, 'first_distillation');
      assert.equal(parsed.data.config.points, 50);
    });
  }

  it('a create request naming the bonus type in body.action still works', () => {
    const parsed = parseDraft({ ...storedRow({}), action: 'first_distillation', points: 20 });
    assert.equal(parsed.error, undefined, parsed.error);
    assert.deepEqual([parsed.data.config.action, parsed.data.config.points], ['first_distillation', 20]);
  });

  it('a stored config without an action still errors on a transition', () => {
    assert.equal(parseDraft({ ...storedRow({ points: 50 }), action: 'live' }).error, 'Choose a first-action type');
    assert.equal(parseDraft({ ...storedRow({ points: 50 }), action: 'schedule' }).error, 'Choose a first-action type');
  });

  it('an unknown bonus type in config still errors', () => {
    assert.equal(
      parseDraft({ ...storedRow({ action: 'first_upload', points: 50 }), action: 'live' }).error,
      'Choose a first-action type',
    );
  });
});
