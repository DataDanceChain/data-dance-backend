const prisma = require('../utils/prisma');
const {
  KINDS,
  publicUrl,
  normalizeSlug,
  validSlug,
  cleanText,
  normalizeTarget,
  referrerHost,
} = require('./trackedLinkPolicy');

const DEDUPE_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function httpError(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

function present(link, counts = {}) {
  return {
    id: link.id,
    slug: link.slug,
    name: link.name,
    kind: link.kind,
    title: link.title,
    body: link.body,
    buttonLabel: link.buttonLabel,
    targetUrl: link.targetUrl,
    active: link.active,
    publicUrl: publicUrl(link.slug),
    opens: counts.opens || 0,
    people: counts.people || 0,
    continues: counts.continues || 0,
    createdAt: link.createdAt,
    updatedAt: link.updatedAt,
  };
}

function presentPublic(link) {
  return {
    slug: link.slug,
    kind: link.kind,
    title: link.title,
    body: link.body,
    buttonLabel: link.buttonLabel,
    targetUrl: link.targetUrl,
  };
}

async function countMap(linkIds) {
  if (!linkIds.length) return new Map();
  const [events, visitors] = await Promise.all([
    prisma.trackedLinkHit.groupBy({
      by: ['linkId', 'event'],
      where: { linkId: { in: linkIds } },
      _count: { _all: true },
    }),
    prisma.trackedLinkHit.groupBy({
      by: ['linkId', 'visitorId'],
      where: { linkId: { in: linkIds }, event: 'open' },
    }),
  ]);
  const map = new Map();
  for (const id of linkIds) map.set(id, { opens: 0, continues: 0, people: 0 });
  for (const row of events) {
    const bucket = map.get(row.linkId);
    if (!bucket) continue;
    if (row.event === 'open') bucket.opens = row._count._all;
    if (row.event === 'continue') bucket.continues = row._count._all;
  }
  for (const row of visitors) {
    const bucket = map.get(row.linkId);
    if (bucket) bucket.people += 1;
  }
  return map;
}

function readInput(body, { partial = false } = {}) {
  const kind = body.kind === undefined && partial ? undefined : String(body.kind || '').trim();
  if (kind !== undefined && !KINDS.has(kind)) {
    throw httpError(400, 'invalid_kind', 'Choose an app download, a page, or a redirect');
  }
  const data = {};
  if (!partial || body.name !== undefined) {
    data.name = cleanText(body.name, 80);
    if (!data.name) throw httpError(400, 'invalid_name', 'A name is required');
  }
  if (!partial || body.title !== undefined) {
    data.title = cleanText(body.title, 80);
    if (!data.title) throw httpError(400, 'invalid_title', 'A title is required');
  }
  if (!partial || body.body !== undefined) data.body = cleanText(body.body, 400);
  if (!partial || body.buttonLabel !== undefined) data.buttonLabel = cleanText(body.buttonLabel, 40);
  if (kind !== undefined) data.kind = kind;
  if (body.active !== undefined) data.active = Boolean(body.active);
  return data;
}

async function listLinks() {
  const links = await prisma.trackedLink.findMany({ orderBy: { createdAt: 'desc' } });
  const counts = await countMap(links.map((link) => link.id));
  return links.map((link) => present(link, counts.get(link.id)));
}

async function createLink(body) {
  const slug = normalizeSlug(body.slug);
  if (!validSlug(slug)) {
    throw httpError(400, 'invalid_slug', 'Use a short slug: letters, numbers, and hyphens');
  }
  const data = readInput(body);
  const target = normalizeTarget(data.kind, body.targetUrl);
  if (target.error) throw httpError(400, 'invalid_target', target.error);
  try {
    const link = await prisma.trackedLink.create({
      data: { ...data, slug, targetUrl: target.url, body: data.body || '', buttonLabel: data.buttonLabel || '' },
    });
    return present(link);
  } catch (error) {
    if (error.code === 'P2002') throw httpError(409, 'slug_taken', 'That slug is already used');
    throw error;
  }
}

async function updateLink(id, body) {
  const existing = await prisma.trackedLink.findUnique({ where: { id } });
  if (!existing) throw httpError(404, 'link_not_found', 'Link not found');
  const data = readInput(body, { partial: true });
  const kind = data.kind || existing.kind;
  if (body.targetUrl !== undefined || data.kind) {
    const target = normalizeTarget(kind, body.targetUrl !== undefined ? body.targetUrl : existing.targetUrl);
    if (target.error) throw httpError(400, 'invalid_target', target.error);
    data.targetUrl = target.url;
  }
  const link = await prisma.trackedLink.update({ where: { id }, data });
  const counts = await countMap([id]);
  return present(link, counts.get(id));
}

async function linkStats(id) {
  const link = await prisma.trackedLink.findUnique({ where: { id } });
  if (!link) throw httpError(404, 'link_not_found', 'Link not found');
  const since = new Date(Date.now() - 14 * DAY_MS);
  const hits = await prisma.trackedLinkHit.findMany({
    where: { linkId: id, createdAt: { gte: since } },
    select: { event: true, visitorId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });
  const days = new Map();
  for (const hit of hits) {
    const day = hit.createdAt.toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, { day, opens: 0, people: new Set(), continues: 0 });
    const bucket = days.get(day);
    if (hit.event === 'open') {
      bucket.opens += 1;
      bucket.people.add(hit.visitorId);
    } else if (hit.event === 'continue') {
      bucket.continues += 1;
    }
  }
  const counts = await countMap([id]);
  return {
    ...present(link, counts.get(id)),
    days: [...days.values()].map((bucket) => ({
      day: bucket.day,
      opens: bucket.opens,
      people: bucket.people.size,
      continues: bucket.continues,
    })),
  };
}

async function publicLink(slug) {
  const link = await prisma.trackedLink.findUnique({ where: { slug: normalizeSlug(slug) } });
  if (!link || !link.active) return null;
  return presentPublic(link);
}

async function recordHit(slug, { visitorId, event, dest, referrer }) {
  const link = await prisma.trackedLink.findUnique({ where: { slug: normalizeSlug(slug) } });
  if (!link || !link.active) throw httpError(404, 'link_not_found', 'Link not found');
  const visitor = cleanText(visitorId, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(visitor)) {
    throw httpError(400, 'invalid_visitor', 'A visitor id is required');
  }
  if (event !== 'open' && event !== 'continue') {
    throw httpError(400, 'invalid_event', 'Event must be open or continue');
  }
  const since = new Date(Date.now() - DEDUPE_MS);
  const recent = await prisma.trackedLinkHit.findFirst({
    where: { linkId: link.id, visitorId: visitor, event, createdAt: { gte: since } },
    select: { id: true },
  });
  if (recent) return { counted: false };
  await prisma.trackedLinkHit.create({
    data: {
      linkId: link.id,
      visitorId: visitor,
      event,
      dest: cleanText(dest, 32) || null,
      referrerHost: referrerHost(referrer),
    },
  });
  return { counted: true };
}

module.exports = {
  listLinks,
  createLink,
  updateLink,
  linkStats,
  publicLink,
  recordHit,
};
