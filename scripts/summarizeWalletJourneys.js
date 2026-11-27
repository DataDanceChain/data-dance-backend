// Pipe bounded wallet_journey_timing JSON log lines into this script.
// Output contains only counts and distributions, never individual flows.
const readline = require('node:readline');
const from = new Map();
const spans = [
  ['login_start', 'login_action'], ['login_action', 'provider_return'],
  ['provider_return', 'account_ready'], ['account_ready', 'wallet_ready'],
  ['login_action', 'wallet_ready'], ['login_start', 'wallet_ready'],
  ['open_tap', 'popup_reserved'], ['open_tap', 'ticket_ready'],
  ['ticket_ready', 'launch_requested'], ['launch_requested', 'handoff_navigation'],
  ['handoff_navigation', 'handoff_response'], ['handoff_response', 'handoff_ready'],
  ['handoff_response', 'handoff_script_fetch'], ['handoff_script_fetch', 'handoff_script_loaded'],
  ['handoff_script_loaded', 'handoff_ready'], ['handoff_ready', 'exchange_start'], ['exchange_start', 'exchange_done'],
  ['open_tap', 'exchange_done'],
];
async function main() {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let batch;
    try {
      const row = JSON.parse(line);
      if (row.message !== 'wallet_journey_timing' || !Array.isArray(row.events)) continue;
      batch = row.events;
    } catch { continue; }
    for (const { flow, stage, at, platform } of batch) {
      if (typeof flow !== 'string' || !Number.isSafeInteger(at)) continue;
      if (!from.has(flow)) from.set(flow, new Map());
      const events = from.get(flow);
      const prior = events.get(stage);
      // A retry of an identical sample is harmless. Two distinct values for
      // the same stage make that boundary ambiguous.
      if (!prior) events.set(stage, { at, platform });
      else if (prior.at !== at || prior.platform !== platform) prior.ambiguous = true;
    }
  }
  const result = {};
  for (const platform of ['web', 'ios', 'android']) {
    // Use the initiating platform even if it opens a separate browser.
    const flows = [...from.values()].filter(events =>
      (events.get('login_start') || events.get('open_tap'))?.platform === platform);
    if (!flows.length) continue;
    const stages = {};
    for (const [start, end] of spans) {
      const values = [];
      let missingEnd = 0, invalid = 0;
      for (const events of flows) {
        const a = events.get(start), b = events.get(end);
        if (!a) continue;
        if (!b) { missingEnd++; continue; }
        if (a.ambiguous || b.ambiguous || b.at < a.at) { invalid++; continue; }
        values.push(b.at - a.at);
      }
      values.sort((a, b) => a - b);
      const percentile = q => values[Math.ceil(values.length * q) - 1] ?? null;
      stages[start + ' → ' + end] = { samples: values.length, missingEnd, invalid,
        p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1) };
    }
    result[platform] = { flows: flows.length,
      failed: flows.filter(f => f.has('login_failed') || f.has('open_failed')).length, stages };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
main().catch(() => { process.exitCode = 1; });
