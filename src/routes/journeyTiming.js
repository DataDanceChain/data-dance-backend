'use strict';

const express = require('express');
const { corsOrigins } = require('../constants/corsOrigins');

const stages = new Set([
  'login_start', 'login_action', 'provider_return', 'account_ready', 'wallet_ready', 'login_failed',
  'provider_start', 'otp_send_start', 'otp_send_done', 'otp_verify_start', 'otp_verify_done',
  'login_cancelled', 'login_timeout', 'login_backgrounded', 'login_redirect_done', 'login_incomplete',
  'login_account_request_start', 'login_account_response',
  'open_tap', 'popup_reserved', 'ticket_ready', 'launch_requested', 'handoff_navigation', 'handoff_response', 'handoff_script_fetch', 'handoff_script_loaded',
  'handoff_ready', 'exchange_start', 'exchange_done', 'open_failed',
]);
const platforms = new Set(['ios', 'android', 'web']);
const flowId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const requiredKeys = ['at', 'flow', 'platform', 'stage'];
const channels = new Set(['google', 'apple', 'x', 'email_otp', 'web3auth_email', 'other', 'unknown']);
const visibilities = new Set(['visible', 'hidden', 'unknown']);
const failureStages = new Set(['login_failed', 'login_timeout', 'login_incomplete', 'login_cancelled']);
const failureReasons = new Set(['cancelled', 'timeout', 'connection', 'incomplete', 'provider', 'identity', 'account',
  'unexpected', 'invalidEmail', 'invalidCode', 'unavailable', 'rateLimit', 'offline']);
const failurePhases = new Set(['provider', 'identity', 'account', 'return', 'otp_send', 'otp_verify']);
const allowedKeys = new Set([...requiredKeys, 'channel', 'visibility', 'release', 'reason', 'phase']);

function validEvent(event, now) {
  return event !== null && typeof event === 'object' &&
    requiredKeys.every(key => Object.hasOwn(event, key)) && Object.keys(event).every(key => allowedKeys.has(key)) &&
    (!Object.hasOwn(event, 'channel') || channels.has(event.channel)) &&
    (!Object.hasOwn(event, 'visibility') || visibilities.has(event.visibility)) &&
    (!Object.hasOwn(event, 'release') || (typeof event.release === 'string' && /^[0-9a-f]{7,40}$/.test(event.release))) &&
    typeof event.flow === 'string' && flowId.test(event.flow) &&
    ((!Object.hasOwn(event, 'reason') && !Object.hasOwn(event, 'phase')) ||
      (failureStages.has(event.stage) && failureReasons.has(event.reason) && failurePhases.has(event.phase))) &&
    stages.has(event.stage) && platforms.has(event.platform) &&
    Number.isSafeInteger(event.at) && event.at >= now - 20 * 60_000 && event.at <= now + 120_000;
}

// Keep the original monitor's strict event shape. Optional diagnostics are bounded
// side records linked to the same anonymous terminal, outside the event array.
function timingLog(events) {
  const loginFailures = [];
  const timingEvents = events.map(event => {
    if (!event.reason) return event;
    const { reason, phase, ...timing } = event;
    loginFailures.push({ flow: event.flow, stage: event.stage, at: event.at, phase, reason });
    return timing;
  });
  return loginFailures.length ? { events: timingEvents, loginFailures } : { events };
}

function journeyTiming(record, env = process.env) {
  const router = express.Router();
  const origins = new Set([...corsOrigins(env), 'datadance://localhost', 'https://localhost']);
  const parseText = express.text({ type: 'text/plain', limit: '4kb', inflate: false });
  // This budget is only for optional measurements. Bound memory and log volume
  // even when callers do not have a Wallet session yet.
  let window = -1;
  let count = 0;
  const perPeer = new Map();
  router.post('/', (req, res) => {
    const origin = req.get('origin');
    res.set('Cache-Control', 'no-store');
    if (!origins.has(origin)) return res.sendStatus(403);
    res.set('Access-Control-Allow-Origin', origin).vary('Origin');
    if (!req.is('text/plain')) return res.sendStatus(415);
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== window) {
      window = minute;
      perPeer.clear();
      count = 0;
    }
    const peerCount = perPeer.get(req.ip) || 0;
    if (peerCount >= 120 || count >= 600) return res.sendStatus(429);
    perPeer.set(req.ip, peerCount + 1);
    count++;
    parseText(req, res, error => {
      if (error) return res.sendStatus(error.status === 413 ? 413 : 400);
      let events;
      try { events = JSON.parse(req.body); } catch { return res.sendStatus(400); }
      const now = Date.now();
      if (!Array.isArray(events) || !events.length || events.length > 12 ||
          !events.every(event => validEvent(event, now))) return res.sendStatus(400);
      record(events);
      return res.status(204).end();
    });
  });
  return router;
}

module.exports = { journeyTiming, timingLog };
