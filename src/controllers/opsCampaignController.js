const prisma = require('../utils/prisma');
const fs = require('node:fs/promises');
const {
  campaignSsoClientIds,
  parseDraft,
  applyCopyFields,
  assertPublishable,
  findScheduleConflict,
  conflictMessage,
  toPublicCard,
} = require('../utils/campaignRules');
const { drawRaffle } = require('../services/campaignEffects');
const { noteCreated } = require('../services/opsAudit');
const { listHandoffClientIds } = require('../services/ssoDeveloperClient');
const { translateCampaignCopy } = require('../services/campaignTranslate');

function actorOf(req) {
  return req.opsAdmin?.username || 'ops';
}

function fail(res, status, message) {
  return res.status(status).json({ status: 'fail', message });
}

async function writeEvent(campaignId, actor, action, fromStatus, toStatus, note, db = prisma) {
  await db.campaignEvent.create({
    data: { campaignId, actor, action, fromStatus, toStatus, note: note || null },
  });
}

/** parseDraft options: the SSO client ids an EXTERNAL card may name, read once per request. */
async function draftOptions() {
  return { ssoClientIds: campaignSsoClientIds(await listHandoffClientIds()) };
}

function serialize(row) {
  return {
    ...row,
    publicCard: toPublicCard(row),
  };
}

exports.translate = async (req, res) => {
  try {
    const data = await translateCampaignCopy(req.body || {});
    if (req.auditGeneric) await req.auditGeneric(prisma);
    return res.json({ status: 'success', data });
  } catch (error) {
    if (error.code === 'NO_GEMINI') return fail(res, 503, error.message);
    if (error.code === 'BAD_TRANSLATE' || error.code === 'GEMINI_FAILED') {
      const blocked = /location is not supported/i.test(error.message || '');
      return fail(
        res,
        error.code === 'BAD_TRANSLATE' ? 400 : 502,
        blocked
          ? 'Gemini is blocked from this server region. Use a supported egress, or paste the other languages by hand.'
          : error.message,
      );
    }
    console.error('Ops campaign translate error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.list = async (req, res) => {
  try {
    const items = await prisma.campaign.findMany({
      orderBy: { updatedAt: 'desc' },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 12 } },
    });
    return res.json({ status: 'success', data: { items: items.map(serialize) } });
  } catch (error) {
    console.error('Ops campaign list error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.get = async (req, res) => {
  try {
    const row = await prisma.campaign.findUnique({
      where: { id: req.params.id },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 30 } },
    });
    if (!row) return fail(res, 404, 'Campaign not found');
    return res.json({ status: 'success', data: serialize(row) });
  } catch (error) {
    console.error('Ops campaign get error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.create = async (req, res) => {
  try {
    const parsed = parseDraft(req.body, await draftOptions());
    if (parsed.error) return fail(res, 400, parsed.error);
    const actor = actorOf(req);
    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.campaign.create({
        data: {
          ...parsed.data,
          status: 'DRAFT',
          createdBy: actor,
          updatedBy: actor,
        },
      });
      await writeEvent(saved.id, actor, 'create', null, 'DRAFT', null, tx);
      if (req.auditGeneric) await req.auditGeneric(tx, saved.id);
      return saved;
    });
    noteCreated(req, row.id);
    return res.json({ status: 'success', data: serialize(row) });
  } catch (error) {
    if (error.code === 'P2002') return fail(res, 409, 'Slug already exists');
    console.error('Ops campaign create error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.update = async (req, res) => {
  try {
    const existing = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!existing) return fail(res, 404, 'Campaign not found');
    if (existing.status === 'LIVE' || existing.status === 'ENDED') {
      const patched = applyCopyFields(existing, req.body || {});
      if (patched.error) return fail(res, 400, patched.error);
      const actor = actorOf(req);
      const row = await prisma.$transaction(async (tx) => {
        const saved = await tx.campaign.update({
          where: { id: existing.id },
          data: { ...patched.data, updatedBy: actor },
        });
        await writeEvent(saved.id, actor, 'update-copy', existing.status, existing.status, null, tx);
        if (req.auditGeneric) await req.auditGeneric(tx);
        return saved;
      });
      return res.json({ status: 'success', data: serialize(row) });
    }
    const parsed = parseDraft(
      {
        ...(req.body || {}),
        i18n: req.body?.i18n || req.body?.config?.i18n || existing.config?.i18n,
        // The admin form has no SSO field, so a save that omits it keeps the stored id instead of
        // silently dropping the SSO hand-off; an explicit "" still clears it.
        ssoClientId:
          req.body?.ssoClientId ?? req.body?.config?.ssoClientId ?? existing.config?.ssoClientId,
      },
      await draftOptions(),
    );
    if (parsed.error) return fail(res, 400, parsed.error);
    if (parsed.data.slug !== existing.slug) {
      return fail(res, 400, 'Slug cannot be changed after create');
    }
    if (parsed.data.template !== existing.template) {
      return fail(res, 400, 'Template cannot be changed after create');
    }
    const actor = actorOf(req);
    let legalVersion = existing.legalVersion;
    if (existing.publishedAt && parsed.data.legalText !== existing.legalText) {
      legalVersion += 1;
    }
    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.campaign.update({
        where: { id: existing.id },
        data: {
          ...parsed.data,
          legalVersion,
          updatedBy: actor,
        },
      });
      await writeEvent(saved.id, actor, 'update', existing.status, existing.status, null, tx);
      if (req.auditGeneric) await req.auditGeneric(tx);
      return saved;
    });
    return res.json({ status: 'success', data: serialize(row) });
  } catch (error) {
    if (error.code === 'P2002') return fail(res, 409, 'Slug already exists');
    console.error('Ops campaign update error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.transition = async (req, res) => {
  try {
    const existing = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!existing) return fail(res, 404, 'Campaign not found');
    const action = String(req.body?.action || '').trim();
    const actor = actorOf(req);
    const now = new Date();

    let nextStatus = existing.status;
    const extra = {};

    if (action === 'schedule') {
      if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') {
        return fail(res, 409, 'Only drafts can be scheduled');
      }
      const parsed = parseDraft({ ...existing, ...req.body, slug: existing.slug }, await draftOptions());
      if (parsed.error) return fail(res, 400, parsed.error);
      const publishError = assertPublishable(parsed.data);
      if (publishError) return fail(res, 400, publishError);
      if (parsed.data.endsAt <= now) return fail(res, 400, 'End time is already in the past');
      const scheduledConflict = findScheduleConflict(
        await prisma.campaign.findMany({ where: { status: { in: ['LIVE', 'SCHEDULED'] } } }),
        parsed.data,
        existing.id,
      );
      if (scheduledConflict) return fail(res, 409, conflictMessage(scheduledConflict, parsed.data));
      nextStatus = 'SCHEDULED';
      Object.assign(extra, parsed.data, { updatedBy: actor });
    } else if (action === 'live') {
      if (existing.status !== 'DRAFT' && existing.status !== 'SCHEDULED') {
        return fail(res, 409, 'Only drafts or scheduled campaigns can go live');
      }
      const parsed = parseDraft({ ...existing, ...req.body, slug: existing.slug }, await draftOptions());
      if (parsed.error) return fail(res, 400, parsed.error);
      const publishError = assertPublishable(parsed.data);
      if (publishError) return fail(res, 400, publishError);
      if (parsed.data.endsAt <= now) return fail(res, 400, 'End time is already in the past');
      if (parsed.data.startsAt > now) {
        parsed.data.startsAt = now;
      }
      const liveConflict = findScheduleConflict(
        await prisma.campaign.findMany({ where: { status: { in: ['LIVE', 'SCHEDULED'] } } }),
        parsed.data,
        existing.id,
      );
      if (liveConflict) return fail(res, 409, conflictMessage(liveConflict, parsed.data));
      nextStatus = 'LIVE';
      Object.assign(extra, parsed.data, {
        updatedBy: actor,
        publishedBy: actor,
        publishedAt: existing.publishedAt || now,
      });
    } else if (action === 'end') {
      if (existing.status !== 'LIVE' && existing.status !== 'SCHEDULED') {
        return fail(res, 409, 'Only scheduled or live campaigns can be ended');
      }
      nextStatus = 'ENDED';
      extra.updatedBy = actor;
    } else if (action === 'reopen') {
      if (existing.status !== 'ENDED' && existing.status !== 'SCHEDULED') {
        return fail(res, 409, 'Only scheduled or ended campaigns can return to draft');
      }
      nextStatus = 'DRAFT';
      extra.updatedBy = actor;
    } else {
      return fail(res, 400, 'Unknown action');
    }

    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.campaign.update({
        where: { id: existing.id },
        data: { ...extra, status: nextStatus },
      });
      await writeEvent(saved.id, actor, action, existing.status, nextStatus, null, tx);
      if (req.auditGeneric) await req.auditGeneric(tx);
      return saved;
    });
    return res.json({ status: 'success', data: serialize(row) });
  } catch (error) {
    console.error('Ops campaign transition error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.listApplications = async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return fail(res, 404, 'Campaign not found');
    if (campaign.template !== 'APPLY_COHORT') return fail(res, 400, 'Not an apply campaign');
    const items = await prisma.campaignApplication.findMany({
      where: { campaignId: campaign.id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { id: true, email: true, name: true } } },
    });
    const approved = items.filter((item) => item.status === 'approved').length;
    return res.json({
      status: 'success',
      data: {
        items,
        approved,
        seatCap: Number(campaign.config?.seatCap) || 0,
      },
    });
  } catch (error) {
    console.error('Ops applications list error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.resolveApplication = async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return fail(res, 404, 'Campaign not found');
    if (campaign.template !== 'APPLY_COHORT') return fail(res, 400, 'Not an apply campaign');
    const status = String(req.body?.status || '').trim();
    if (status !== 'approved' && status !== 'rejected') return fail(res, 400, 'Status must be approved or rejected');
    const application = await prisma.campaignApplication.findFirst({
      where: { id: req.params.appId, campaignId: campaign.id },
    });
    if (!application) return fail(res, 404, 'Application not found');
    if (status === 'approved') {
      const approved = await prisma.campaignApplication.count({
        where: { campaignId: campaign.id, status: 'approved' },
      });
      const seatCap = Number(campaign.config?.seatCap) || 0;
      if (application.status !== 'approved' && approved >= seatCap) {
        return fail(res, 409, 'Seat cap already reached');
      }
    }
    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.campaignApplication.update({
        where: { id: application.id },
        data: { status, opsNote: stripNote(req.body?.note) },
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      await writeEvent(campaign.id, actorOf(req), `apply_${status}`, campaign.status, campaign.status, saved.user.email, tx);
      if (req.auditGeneric) await req.auditGeneric(tx);
      return saved;
    });
    return res.json({ status: 'success', data: row });
  } catch (error) {
    console.error('Ops application resolve error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

function stripNote(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400) || null;
}

exports.raffleState = async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return fail(res, 404, 'Campaign not found');
    if (campaign.template !== 'RAFFLE') return fail(res, 400, 'Not a raffle');
    const [tickets, wins] = await Promise.all([
      prisma.campaignRaffleTicket.findMany({
        where: { campaignId: campaign.id, tickets: { gt: 0 } },
        orderBy: { tickets: 'desc' },
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
      prisma.campaignRaffleWin.findMany({
        where: { campaignId: campaign.id },
        orderBy: [{ prizeIndex: 'asc' }, { createdAt: 'asc' }],
        include: { user: { select: { id: true, email: true, name: true } } },
      }),
    ]);
    return res.json({
      status: 'success',
      data: {
        tickets,
        wins,
        ticketHolders: tickets.length,
        ticketTotal: tickets.reduce((sum, row) => sum + row.tickets, 0),
      },
    });
  } catch (error) {
    console.error('Ops raffle state error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.drawRaffle = async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return fail(res, 404, 'Campaign not found');
    if (campaign.template !== 'RAFFLE') return fail(res, 400, 'Not a raffle');
    const result = await drawRaffle(campaign, actorOf(req), { audit: req.auditChange });
    if (result.error) return fail(res, 400, result.error);
    return res.json({ status: 'success', data: { created: result.created } });
  } catch (error) {
    console.error('Ops raffle draw error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.uploadCover = async (req, res) => {
  try {
    if (!req.file || !req.file.filename) {
      return fail(res, 400, 'Choose a JPG, PNG, WebP, or GIF image');
    }
    const origin = String(process.env.PUBLIC_BASE_URL || 'https://api.datadance.ai').replace(/\/$/, '');
    const pathName = `/assets/campaigns/${req.file.filename}`;
    noteCreated(req, pathName, 'campaign_cover');
    if (req.auditGeneric) await req.auditGeneric(prisma);
    return res.json({
      status: 'success',
      data: {
        url: `${origin}${pathName}`,
        path: pathName,
      },
    });
  } catch (error) {
    // The upload middleware has already written the file. A failed audit must not hand out its
    // URL; remove it on ordinary failure. A crash between file creation and audit is not atomic.
    if (req.file && req.file.path) {
      try {
        await fs.unlink(req.file.path);
      } catch (cleanupError) {
        if (cleanupError.code !== 'ENOENT') console.error('Ops cover cleanup failed', { code: cleanupError.code });
      }
    }
    console.error('Ops campaign cover upload error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.fulfillRaffleWin = async (req, res) => {
  try {
    const campaign = await prisma.campaign.findUnique({ where: { id: req.params.id } });
    if (!campaign) return fail(res, 404, 'Campaign not found');
    const win = await prisma.campaignRaffleWin.findFirst({
      where: { id: req.params.winId, campaignId: campaign.id },
    });
    if (!win) return fail(res, 404, 'Win not found');
    const row = await prisma.$transaction(async (tx) => {
      const saved = await tx.campaignRaffleWin.update({
        where: { id: win.id },
        data: { fulfilled: true },
        include: { user: { select: { id: true, email: true, name: true } } },
      });
      await writeEvent(campaign.id, actorOf(req), 'raffle_fulfill', campaign.status, campaign.status, saved.user.email, tx);
      if (req.auditGeneric) await req.auditGeneric(tx);
      return saved;
    });
    return res.json({ status: 'success', data: row });
  } catch (error) {
    console.error('Ops raffle fulfill error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
