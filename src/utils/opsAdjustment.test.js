const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { describeOpsAdjustment, opsAdjustmentSourceId } = require('./opsAdjustment');

describe('ops adjustment ledger note', () => {
  it('keeps a Chinese reason and the operator', () => {
    const sourceId = opsAdjustmentSourceId('補償重複發放', 'staff.name', 1700000000000);
    assert.equal(describeOpsAdjustment(sourceId).note, '補償重複發放');
    assert.equal(describeOpsAdjustment(sourceId).actor, 'staff.name');
  });

  it('reads an older row that only kept a slug', () => {
    assert.deepEqual(describeOpsAdjustment('ops-manual-1-fix__staffname'), {
      actor: 'staffname',
      note: 'fix',
    });
    assert.deepEqual(describeOpsAdjustment('ops-manual-1-adjustment__staffname'), {
      actor: 'staffname',
      note: '',
    });
  });
});
