/**
 * The referral-network SQL on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL pointing at a
 * throwaway database that `prisma migrate deploy` has built — its name must contain "test").
 *
 * What only the database can prove: the two recursive CTEs TERMINATE on rings (2-cycle, 3-cycle, a
 * ring above the user), never list the requesting user, raise the `cycle` anomaly, honour the
 * `createdAt <= as_of` snapshot (including a row inserted between two pages), and agree with the
 * direct-invitee count. Fixture rows use a per-run id prefix and are deleted afterwards.
 * Raw SQL only, so the test does not depend on the generated client's model set.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';

const prisma = require('../../src/utils/prisma');
const net = require('../../src/services/referralNetwork');
const { countDirectInvitees } = require('../../src/utils/referralUtils');

const RUN = `nt${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60_000);

async function user(name) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "User"(id, email, "referralCode", "updatedAt") VALUES ($1, $2, $3, now())',
    id(name), `${id(name)}@example.test`, id(name).toUpperCase(),
  );
}
async function edge(inviter, invitee, minutes) {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "Referral"(id, "inviterId", "inviteeId", code, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, now())',
    id(`e-${inviter}-${invitee}`), id(inviter), id(invitee), 'X', at(minutes),
  );
}

const strip = (body) => JSON.parse(JSON.stringify(body).split(`${RUN}-`).join(''));

describe('referral network SQL on Postgres', () => {
  before(async () => {
    for (const n of ['a', 'b', 'c', 'd', 'e', 'x1', 'x2', 'x3', 'p', 'q', 'r', 's', 't', 'z', 'u', 'm', 'n', 'late']) await user(n);
    // chain a→b→c→d→e with a branch b→x1..x3
    await edge('a', 'b', 1); await edge('b', 'c', 2); await edge('c', 'd', 3); await edge('d', 'e', 4);
    await edge('b', 'x1', 5); await edge('b', 'x2', 6); await edge('b', 'x3', 7);
    // 2-ring p↔q
    await edge('p', 'q', 10); await edge('q', 'p', 11);
    // 3-ring r→s→t→r with a tail t→z
    await edge('r', 's', 20); await edge('s', 't', 21); await edge('t', 'r', 22); await edge('t', 'z', 23);
    // a ring ABOVE u: m→u, m↔n
    await edge('m', 'u', 30); await edge('m', 'n', 31); await edge('n', 'm', 32);
  });

  after(async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "Referral" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
  });

  const NOW = at(1000);
  const build = (who, q = {}) => net.buildReferralNetwork(id(who), q, { now: NOW });

  it('chain + branch: upline nearest first, levels/total, level 1 = countDirectInvitees', async () => {
    const e = strip(await build('e'));
    assert.deepEqual(e.upline.map((u) => [u.sub, u.depth]), [['d', 1], ['c', 2], ['b', 3], ['a', 4]]);
    const a = strip(await build('a'));
    assert.equal(a.downline.total, 7);
    assert.deepEqual(a.downline.levels, [{ depth: 1, count: 1 }, { depth: 2, count: 4 }, { depth: 3, count: 1 }, { depth: 4, count: 1 }]);
    assert.equal(a.downline.levels[0].count, await countDirectInvitees(id('a')));
    assert.equal('anomalies' in a, false);
    for (const n of a.downline.nodes) assert.deepEqual(Object.keys(n).sort(), ['depth', 'invited_at', 'inviter_sub', 'sub']);
  });

  it('2-ring p↔q terminates, never lists p, flags the cycle', async () => {
    const p = strip(await build('p'));
    assert.deepEqual(p.anomalies, ['cycle']);
    assert.deepEqual(p.upline.map((x) => x.sub), ['q']);
    assert.deepEqual(p.downline.nodes.map((x) => x.sub), ['q']);
  });

  it('3-ring r→s→t→r stops at the first repeat and keeps the tail', async () => {
    const r = strip(await build('r'));
    assert.deepEqual(r.anomalies, ['cycle']);
    assert.deepEqual(r.upline.map((x) => [x.sub, x.depth]), [['t', 1], ['s', 2]]);
    assert.deepEqual(r.downline.nodes.map((x) => [x.sub, x.depth]), [['s', 1], ['t', 2], ['z', 3]]);
    assert.equal(r.downline.levels[0].count, await countDirectInvitees(id('r')));
  });

  it('a ring above the user: the upline stops at the repeat; u is on no ring itself', async () => {
    const u = strip(await build('u'));
    assert.deepEqual(u.anomalies, ['cycle']);
    assert.deepEqual(u.upline.map((x) => x.sub), ['m', 'n']);
    assert.equal(u.downline.total, 0);
  });

  it('snapshot: ?as_of cuts by createdAt, and a row inserted between pages is neither returned nor counted', async () => {
    const early = strip(await build('a', { as_of: at(2.5).toISOString() }));
    assert.deepEqual(early.downline.nodes.map((x) => x.sub), ['b', 'c']);
    const first = await build('a', { limit: '2' });
    // someone joins a's downline (directly under a, i.e. at depth 1 — behind the cursor) after page 1
    assert.equal(first.as_of, NOW.toISOString());
    await edge('a', 'late', 1000 + 1 / 60);
    const pages = [first];
    let body = first;
    while (body.downline.next_cursor) {
      body = await build('a', { limit: '2', cursor: body.downline.next_cursor });
      pages.push(body);
    }
    const subs = pages.flatMap((pg) => pg.downline.nodes.map((n) => n.sub));
    assert.equal(subs.length, first.downline.total);
    assert.equal(new Set(subs).size, subs.length);
    assert.ok(!subs.includes(id('late')));
    for (const pg of pages) assert.equal(pg.downline.total, first.downline.total);
    await prisma.$executeRawUnsafe('DELETE FROM "Referral" WHERE id = $1', id('e-a-late'));
  });
});
