/**
 * Referral network assembly (src/services/referralNetwork.js) — DB-less.
 *
 * The two recursive CTEs are replaced by an in-memory walk with the SAME semantics (edges with
 * createdAt <= as_of; carry the path; stop at the first repeated node, flagged `cycle`). The SQL itself
 * is exercised on real Postgres by test/db/referralNetwork.dbtest.js (`npm run test:db`).
 * Covered here: response shape, the four-field node allow-list, upline order, levels/total, keyset
 * pagination (union = total, no duplicates), the pinned snapshot, `as_of` / `limit` / cursor validation,
 * and the cycle rules (no self, stop at first repeat, `anomalies: ["cycle"]`, warn log).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { installMockPrisma } = require('../helpers/mockPrisma');

installMockPrisma();
process.env.LOG_LEVEL = 'error';

const net = require('../../src/services/referralNetwork');

let edges = [];
const at = (s) => new Date(`2026-09-${String(s).padStart(2, '0')}T00:00:00.000Z`);
const edge = (inviter, invitee, day) => edges.push({ inviterId: inviter, inviteeId: invitee, createdAt: at(day) });

function walk(userId, asOf, dir) {
  const live = edges.filter((e) => e.createdAt <= asOf);
  const out = [];
  const step = (frontier, depth) => {
    for (const f of frontier) {
      const next = dir === 'up'
        ? live.filter((e) => e.inviteeId === f.node).map((e) => ({ node: e.inviterId, from: e.inviteeId, e }))
        : live.filter((e) => e.inviterId === f.node).map((e) => ({ node: e.inviteeId, from: e.inviterId, e }));
      for (const n of next) {
        const cycle = f.path.includes(n.node);
        const path = [...f.path, n.node];
        out.push({ sub: n.node, inviter_sub: dir === 'down' ? n.from : undefined, invited_at: n.e.createdAt, depth, cycle, path });
        if (!cycle) step([{ node: n.node, path }], depth + 1);
      }
    }
  };
  step([{ node: userId, path: [userId] }], 1);
  return out;
}

net.source.loadUpline = async (userId, asOf) => walk(userId, asOf, 'up').sort((a, b) => a.depth - b.depth);
net.source.loadDownline = async (userId, asOf) => walk(userId, asOf, 'down');

const NOW = new Date('2026-09-30T00:00:00.000Z');
const build = (user, query = {}) => net.buildReferralNetwork(user, query, { now: NOW });

async function allPages(user, limit, extraBetweenPages) {
  const pages = [];
  let body = await build(user, { limit: String(limit) });
  pages.push(body);
  while (body.downline.next_cursor) {
    if (extraBetweenPages) extraBetweenPages(pages.length);
    body = await build(user, { limit: String(limit), cursor: body.downline.next_cursor });
    pages.push(body);
  }
  return pages;
}

describe('referral network assembly', () => {
  beforeEach(() => {
    edges = [];
    // five-level chain a→b→c→d→e, a branch under b (b→x1..x7) and one under a (a→y)
    edge('a', 'b', 1); edge('b', 'c', 2); edge('c', 'd', 3); edge('d', 'e', 4);
    for (let i = 1; i <= 7; i++) edge('b', `x${i}`, 5 + i);
    edge('a', 'y', 13);
    edge('root', 'a', 0 + 1); // a's own inviter, for the upline of b/c
  });

  it('shape: exactly the documented keys; every node has exactly four fields', async () => {
    const body = await build('a');
    assert.deepEqual(Object.keys(body).sort(), ['as_of', 'cache_max_age', 'downline', 'sub', 'upline']);
    assert.deepEqual(Object.keys(body.downline).sort(), ['levels', 'next_cursor', 'nodes', 'total']);
    assert.equal(body.cache_max_age, 60);
    for (const n of body.downline.nodes) assert.deepEqual(Object.keys(n).sort(), [...net.NODE_FIELDS].sort(), `node grew a field: ${JSON.stringify(n)}`);
    for (const u of body.upline) assert.deepEqual(Object.keys(u).sort(), [...net.UPLINE_FIELDS].sort());
  });

  it('upline is complete and nearest first', async () => {
    const body = await build('e');
    assert.deepEqual(body.upline.map((u) => [u.sub, u.depth]), [['d', 1], ['c', 2], ['b', 3], ['a', 4], ['root', 5]]);
  });

  it('levels and total describe the whole downline; level 1 = direct invitees', async () => {
    const body = await build('a');
    assert.equal(body.downline.total, 12);
    assert.deepEqual(body.downline.levels, [{ depth: 1, count: 2 }, { depth: 2, count: 8 }, { depth: 3, count: 1 }, { depth: 4, count: 1 }]);
    assert.equal(body.downline.levels[0].count, edges.filter((e) => e.inviterId === 'a').length);
    const byDepth = body.downline.nodes.find((n) => n.sub === 'e');
    assert.deepEqual(byDepth, { sub: 'e', inviter_sub: 'd', depth: 4, invited_at: at(4).toISOString() });
  });

  it('pages in keyset order (depth, invited_at, sub): union = total, no duplicates, levels/total identical on every page', async () => {
    const pages = await allPages('a', 3);
    assert.equal(pages.length, 4);
    const subs = pages.flatMap((p) => p.downline.nodes.map((n) => n.sub));
    assert.equal(subs.length, 12);
    assert.equal(new Set(subs).size, 12);
    for (const p of pages) {
      assert.equal(p.downline.total, 12);
      assert.deepEqual(p.downline.levels, pages[0].downline.levels);
      assert.equal(p.as_of, pages[0].as_of);
    }
    const flat = pages.flatMap((p) => p.downline.nodes);
    for (let i = 1; i < flat.length; i++) {
      const [a, b] = [flat[i - 1], flat[i]];
      assert.ok(a.depth < b.depth || (a.depth === b.depth && (a.invited_at < b.invited_at || (a.invited_at === b.invited_at && a.sub < b.sub))), `order broken at ${i}`);
    }
    assert.equal(pages.at(-1).downline.next_cursor, null);
  });

  it('snapshot: an invitee added between page 1 and page 2 is neither returned nor counted', async () => {
    const first = await build('a', { limit: '3' });
    edges.push({ inviterId: 'a', inviteeId: 'late', createdAt: new Date(Date.parse(first.as_of) + 1) });
    edges.push({ inviterId: 'e', inviteeId: 'late2', createdAt: new Date(Date.parse(first.as_of) + 1) });
    const rest = [];
    let body = await build('a', { limit: '3', cursor: first.downline.next_cursor });
    rest.push(body);
    while (body.downline.next_cursor) {
      body = await build('a', { limit: '3', cursor: body.downline.next_cursor });
      rest.push(body);
    }
    const subs = [first, ...rest].flatMap((p) => p.downline.nodes.map((n) => n.sub));
    assert.equal(subs.length, first.downline.total);
    assert.equal(new Set(subs).size, subs.length);
    assert.ok(!subs.includes('late') && !subs.includes('late2'));
    for (const p of rest) assert.equal(p.downline.total, first.downline.total);
    // a fresh first page, taken later, sees the new members
    const later = await net.buildReferralNetwork('a', {}, { now: new Date(Date.parse(first.as_of) + 60_000) });
    assert.equal(later.downline.total, first.downline.total + 2);
  });

  it('?as_of pins an earlier network; the future and garbage are 400', async () => {
    const past = await build('a', { as_of: '2026-09-03T12:00:00.000Z' });
    assert.equal(past.as_of, '2026-09-03T12:00:00.000Z');
    assert.deepEqual(past.downline.nodes.map((n) => n.sub), ['b', 'c', 'd'], 'only the edges created by the 3rd');
    assert.equal(past.downline.total, 3);
    await assert.rejects(build('a', { as_of: '2026-10-01T00:00:00.000Z' }), (e) => e.status === 400 && /future/.test(e.description));
    await assert.rejects(build('a', { as_of: 'yesterday' }), (e) => e.status === 400);
  });

  it('limit defaults to 500, max 2000; bad values are 400; a cursor is bound to its user and snapshot', async () => {
    assert.equal(net.DEFAULT_LIMIT, 500);
    assert.equal(net.MAX_LIMIT, 2000);
    for (const bad of ['0', '2001', '-1', '1.5', 'abc', '']) {
      await assert.rejects(build('a', { limit: bad }), (e) => e.status === 400, `limit=${bad}`);
    }
    const p1 = await build('a', { limit: '2' });
    await assert.rejects(build('b', { cursor: p1.downline.next_cursor }), (e) => e.status === 400 && /another user/.test(e.description));
    await assert.rejects(build('a', { cursor: 'not-a-cursor' }), (e) => e.status === 400);
    await assert.rejects(build('a', { cursor: p1.downline.next_cursor, as_of: '2026-09-02T00:00:00.000Z' }), (e) => e.status === 400);
  });

  it('no network: empty upline and downline, no anomalies', async () => {
    const body = await build('loner');
    assert.deepEqual(body.upline, []);
    assert.deepEqual(body.downline, { total: 0, levels: [], nodes: [], next_cursor: null });
    assert.equal('anomalies' in body, false);
  });
});

describe('referral network on cyclic data (use-code can bind any code, so rings exist)', () => {
  beforeEach(() => {
    edges = [];
  });

  it('2-ring p↔q: terminates, never lists the user, flags the anomaly', async () => {
    edge('p', 'q', 1); edge('q', 'p', 2);
    const body = await build('p');
    assert.deepEqual(body.anomalies, ['cycle']);
    assert.deepEqual(body.upline.map((u) => u.sub), ['q']);
    assert.deepEqual(body.downline.nodes.map((n) => n.sub), ['q']);
    assert.equal(body.downline.total, 1);
    assert.ok(!JSON.stringify(body.upline).includes('"p"') && !body.downline.nodes.some((n) => n.sub === 'p'));
  });

  it('3-ring r→s→t→r with a tail t→z: stops at the first repeat, keeps the tail', async () => {
    edge('r', 's', 1); edge('s', 't', 2); edge('t', 'r', 3); edge('t', 'z', 4);
    const body = await build('r');
    assert.deepEqual(body.anomalies, ['cycle']);
    assert.deepEqual(body.upline.map((u) => [u.sub, u.depth]), [['t', 1], ['s', 2]]);
    assert.deepEqual(body.downline.nodes.map((n) => [n.sub, n.depth]), [['s', 1], ['t', 2], ['z', 3]]);
    assert.equal(body.downline.levels[0].count, 1);
  });

  it('a ring ABOVE the user (u → p, p↔q): upline stops at the repeat; the user is not on it', async () => {
    edge('p', 'u', 1); edge('p', 'q', 2); edge('q', 'p', 3);
    const body = await build('u');
    assert.deepEqual(body.anomalies, ['cycle']);
    assert.deepEqual(body.upline.map((x) => x.sub), ['p', 'q']);
    assert.equal(body.downline.total, 0);
  });

  it('the hit is logged at warn with ids only', async () => {
    edge('p', 'q', 1); edge('q', 'p', 2);
    const hits = [];
    const original = net.cycleLog.write;
    net.cycleLog.write = (entry) => hits.push(entry);
    try {
      await build('p');
    } finally {
      net.cycleLog.write = original;
    }
    assert.ok(hits.length >= 1);
    for (const meta of hits) {
      assert.deepEqual(Object.keys(meta).sort(), ['closedBy', 'cycleIds', 'direction', 'repeatedId', 'userId']);
      assert.ok(meta.cycleIds.every((id) => ['p', 'q'].includes(id)));
    }
  });
});
