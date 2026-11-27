const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEmailChallengeState, CODE_TTL_MS, RESEND_INTERVAL_MS } = require('../../src/services/emailChallengeState');

test('a late SMTP acknowledgement cannot restore a consumed or expired code', async () => {
  const state = createEmailChallengeState('login');
  const key = 'mailer@example.test';
  const first = 1000;
  const second = first + RESEND_INTERVAL_MS;
  const latest = state.digest(key, '123456');
  assert.equal(await state.saveDelivered(key, latest, { register: true }, second, second), true);
  assert.equal((await state.check(key, '123456', second, true)).register, true);
  assert.equal(await state.saveDelivered(key, state.digest(key, '234567'), {}, first, second + 1), false);
  assert.equal(await state.check(key, '234567', second + 1, true), null);
  assert.equal(await state.saveDelivered(key, latest, {}, second, second + CODE_TTL_MS), false);
});

test('binding lookup can retry on lookup failure, and only its current issuance can be consumed', async () => {
  const state = createEmailChallengeState('bind');
  const key = 'fixture-user:binding@example.test';
  const time = 1000;
  await state.saveDelivered(key, state.digest(key, '123456'), {}, time, time);
  const checked = await state.check(key, '123456', time, false);
  assert.ok(checked);
  const next = time + RESEND_INTERVAL_MS;
  await state.saveDelivered(key, state.digest(key, '345678'), {}, next, next);
  assert.equal(await state.consumeChecked(key, checked.issuedAt, next), false);
  const current = await state.check(key, '345678', next, false);
  const retry = await state.check(key, '345678', next, false);
  const results = await Promise.all([current, retry].map(entry => state.consumeChecked(key, entry.issuedAt, next)));
  assert.deepEqual(results.sort(), [false, true]);
});

test('a rolling hourly window accepts five sends and releases the oldest at its exact deadline', async () => {
  const state = createEmailChallengeState('login');
  for (let i = 0; i < 5; i++) assert.equal(await state.reserveSend('fixture', i * RESEND_INTERVAL_MS), 0);
  assert.equal(await state.reserveSend('fixture', 5 * RESEND_INTERVAL_MS), 3300);
  assert.equal(await state.reserveSend('fixture', 60 * RESEND_INTERVAL_MS), 0);
});
