const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { randomUUID } = require('node:crypto');
const { journeyTiming, timingLog } = require('../../src/routes/journeyTiming');

function fixture() {
  const logged = [];
  const app = express();
  app.use('/api/app/journey-timing', journeyTiming(batch => logged.push(batch), { NODE_ENV: 'production' }));
  const send = (body, origin = 'https://app.datadance.ai', type = 'text/plain') =>
    request(app).post('/api/app/journey-timing').set('Origin', origin).set('Content-Type', type).send(body);
  return { send, logged };
}

test('same flow can span browser documents, uploads no account data and needs no cookie', async () => {
  const { send, logged } = fixture();
  const flow = randomUUID(), at = Date.now() - 2000;
  const batch = ['launch_requested', 'handoff_navigation', 'exchange_start'].map((stage, i) =>
    ({ flow, stage, at: at + i * 800, platform: 'web' }));
  await send(JSON.stringify(batch)).expect(204);
  assert.deepEqual(logged, [batch]);
});

test('malformed, sensitive, stale, oversized and unapproved samples never reach logs', async () => {
  const { send, logged } = fixture();
  const e = { flow: randomUUID(), at: Date.now(), stage: 'login_start', platform: 'android' };
  for (const invalid of [{ ...e, account: 'test' }, { ...e, stage: 'anything' },
    { ...e, flow: 'invalid' }, { ...e, at: 1 }, null]) await send(JSON.stringify([invalid])).expect(400);
  await send('[').expect(400);
  await send(JSON.stringify(Array(13).fill(e))).expect(400);
  await send('x'.repeat(4500)).expect(413);
  await send(JSON.stringify([e]), 'https://unrelated.invalid').expect(403);
  await send(JSON.stringify([e]), 'https://app.datadance.ai', 'application/json').expect(415);
  assert.deepEqual(logged, []);
});

test('old and classified clients can share a batch, with strictly bounded diagnostic labels', async () => {
  const { send, logged } = fixture();
  const start = { flow: randomUUID(), at: Date.now(), stage: 'login_start', platform: 'web' };
  const event = { ...start, stage: 'provider_start', channel: 'google', visibility: 'visible', release: '1021904' };
  await send(JSON.stringify([start, event])).expect(204);
  assert.deepEqual(logged, [[start, event]]);
  for (const unsafe of [
    { channel: 'person@example.test' }, { release: 'refs/heads/private' }, { visibility: null },
    { reason: 'arbitrary exception contents' }, { callback: 'https://example.test/' },
  ]) await send(JSON.stringify([start, { ...event, ...unsafe }])).expect(400);
  assert.equal(logged.length, 1);
});

test('accepts bounded failure phase and reason only as a complete pair on failed login terminals', async () => {
  const { send, logged } = fixture();
  const event = { flow: randomUUID(), at: Date.now(), stage: 'login_timeout', platform: 'web',
    channel: 'email_otp', phase: 'otp_send', reason: 'timeout' };
  await send(JSON.stringify([event])).expect(204);
  for (const change of [{ phase: undefined }, { reason: undefined }, { stage: 'wallet_ready' },
    { reason: 'private provider error' }, { phase: 'https://example.test/?token=private' }]) {
    await send(JSON.stringify([{ ...event, ...change }])).expect(400);
  }
  assert.deepEqual(logged, [[event]]);
  const { phase, reason, ...legacyEvent } = event;
  assert.deepEqual(timingLog(logged[0]), { events: [legacyEvent], loginFailures: [
    { flow: event.flow, at: event.at, stage: event.stage, phase, reason },
  ] });
  assert.deepEqual(timingLog([legacyEvent]), { events: [legacyEvent] });
});
