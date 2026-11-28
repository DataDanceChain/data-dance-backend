const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trackFamily } = require('../../deploy/api-cutover/first-handoff');

const cleared = { ingressVerified: true, directConnections: 0, unresolvedLegacyWrites: 0 };

test('active traffic stays admitted and a complete quiet window transfers ownership only once', () => {
  let now = 0, commits = 0;
  const group = trackFamily({ lifetimeMs: 10, initialOwner: 'legacy', now: () => now,
    commitOwner: () => { commits++; return true; } });
  now = 50;
  const pending = group.admit();
  group.startObservation(cleared);
  now += 11;
  const active = group.admit();
  assert.equal(active.owner, 'legacy');
  active.finish(true);
  pending.finish(true);
  now += 10;
  const boundary = group.admit();
  assert.equal(boundary.owner, 'legacy');
  boundary.finish(true);
  now += 11;
  assert.equal(group.admit().owner, 'shared');
  assert.equal(group.admit().owner, 'shared');
  assert.equal(commits, 1);
});
test('ambiguous upstream completion invalidates observation; shared owner survives restart', () => {
  let now = 0;
  const config = { lifetimeMs: 10, now: () => now, commitOwner: () => true };
  const before = trackFamily({ ...config, initialOwner: 'legacy' });
  before.startObservation(cleared);
  before.admit().finish(false);
  now += 20;
  assert.equal(before.admit().owner, 'legacy');
  assert.equal(trackFamily({ ...config, initialOwner: 'shared' }).admit().owner, 'shared');
});

test('unknown legacy work or a surviving old connection cannot start the clock', () => {
  let now = 0;
  const group = trackFamily({ lifetimeMs: 10, initialOwner: 'legacy', now: () => now, commitOwner: () => true });
  for (const proof of [undefined, {}, { ...cleared, ingressVerified: false },
    { ...cleared, directConnections: 1 }, { ...cleared, unresolvedLegacyWrites: null },
    { ...cleared, unresolvedLegacyWrites: 1 }]) {
    assert.equal(group.startObservation(proof), false);
    now += 20;
    const current = group.admit();
    assert.equal(current.owner, 'legacy');
    current.finish(true);
  }
  const outstanding = group.admit();
  assert.equal(group.startObservation(cleared), true);
  group.invalidateObservation();
  now += 20;
  assert.equal(group.startObservation(cleared), true);
  now += 20;
  const concurrent = group.admit();
  assert.equal(concurrent.owner, 'legacy');
  concurrent.finish(true);
  outstanding.finish(true);
  now += 11;
  assert.equal(group.admit().owner, 'shared');
});
