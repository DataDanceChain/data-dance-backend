/**
 * Manual point changes from the admin member page.
 *
 * The ledger row is a `Point` with source OPS_ADJUSTMENT. There is no note column, so the
 * reason and the operator ride in `sourceId`:
 *
 *   ops-manual-<timestamp>__<operator>__<encodeURIComponent(reason)>
 *
 * Older rows are `ops-manual-<timestamp>-<slug>__<operator>`. The slug dropped anything that
 * was not a letter or digit, so a Chinese reason survived only as "adjustment".
 */

function opsAdjustmentSourceId(reason, admin, now = Date.now()) {
  const who = String(admin || 'ops').replace(/__/g, '-').slice(0, 80);
  const note = encodeURIComponent(String(reason || '').trim().slice(0, 200));
  return `ops-manual-${now}__${who}__${note}`;
}

function describeOpsAdjustment(sourceId) {
  const raw = String(sourceId || '');
  const parts = raw.split('__');
  const actor = parts[1] || '';
  if (parts.length >= 3) {
    const encoded = parts.slice(2).join('__');
    try {
      return { actor, note: decodeURIComponent(encoded) };
    } catch {
      return { actor, note: encoded };
    }
  }
  const slug = (parts[0] || '').replace(/^ops-manual-\d+-?/, '');
  return { actor, note: slug && slug !== 'adjustment' ? slug : '' };
}

module.exports = { opsAdjustmentSourceId, describeOpsAdjustment };
