const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trackFamily } = require('../../deploy/api-cutover/first-handoff');

test('active traffic stays admitted and a complete quiet window transfers ownership only once', () => {
  let now = 0, commits = 0;
  const group = trackFamily({ lifetimeMs: 10, initialOwner: 'legacy', now: () => now,
    commitOwner: () => { commits++; return true; } });
  now = 50;
  const pending = group.admit();
  group.startObservation();
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
  before.startObservation();
  before.admit().finish(false);
  now += 20;
  assert.equal(before.admit().owner, 'legacy');
  assert.equal(trackFamily({ ...config, initialOwner: 'shared' }).admit().owner, 'shared');
});
