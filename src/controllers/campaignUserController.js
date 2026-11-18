const prisma = require('../utils/prisma');
const { toPublicCard, stripText } = require('../utils/campaignRules');
const { pickQuestion } = require('../utils/campaignI18n');
const { getTourismMap } = require('../services/tourismMapService');
const {
  listActiveRows,
  upsertRaffleTickets,
} = require('../services/campaignEffects');
const { wheelState, spinWheel, claimSpin, recordShare } = require('../services/wheelService');
const { calendarState, openDay, claimGift } = require('../services/calendarService');

function fail(res, status, message) {
  return res.status(status).json({ status: 'fail', message });
}

function applyQuestions(config, language) {
  return [1, 2, 3].map((index) => ({
    key: `q${index}`,
    text: pickQuestion(config, index, language),
  }));
}

exports.getApply = async (req, res) => {
  try {
    const campaign = (await listActiveRows(null, new Date(), 'APPLY_COHORT'))[0] || null;
    if (!campaign) return res.json({ status: 'success', data: { campaign: null, application: null, remaining: 0 } });
    const [application, approved, pending] = await Promise.all([
      prisma.campaignApplication.findUnique({
        where: { campaignId_userId: { campaignId: campaign.id, userId: req.user.id } },
      }),
      prisma.campaignApplication.count({ where: { campaignId: campaign.id, status: 'approved' } }),
      prisma.campaignApplication.count({ where: { campaignId: campaign.id, status: 'pending' } }),
    ]);
    const seatCap = Number(campaign.config?.seatCap) || 0;
    return res.json({
      status: 'success',
      data: {
        campaign: {
          ...toPublicCard(campaign),
          remaining: Math.max(0, seatCap - approved),
          pending,
          questions: applyQuestions(campaign.config || {}, req.query.lang || req.user?.language),
        },
        application,
      },
    });
  } catch (error) {
    console.error('Apply get error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.submitApply = async (req, res) => {
  try {
    const campaign = (await listActiveRows(null, new Date(), 'APPLY_COHORT'))[0] || null;
    if (!campaign) return fail(res, 404, 'No open application');
    const existing = await prisma.campaignApplication.findUnique({
      where: { campaignId_userId: { campaignId: campaign.id, userId: req.user.id } },
    });
    if (existing) return fail(res, 409, 'You already applied');
    const approved = await prisma.campaignApplication.count({
      where: { campaignId: campaign.id, status: 'approved' },
    });
    const seatCap = Number(campaign.config?.seatCap) || 0;
    if (approved >= seatCap) return fail(res, 409, 'This cohort is full');
    const answers = {
      q1: stripText(req.body?.q1 || req.body?.answers?.q1, 400),
      q2: stripText(req.body?.q2 || req.body?.answers?.q2, 400),
      q3: stripText(req.body?.q3 || req.body?.answers?.q3, 400),
    };
    if (!answers.q1 || !answers.q2 || !answers.q3) return fail(res, 400, 'Answer all three questions');
    const application = await prisma.campaignApplication.create({
      data: {
        campaignId: campaign.id,
        userId: req.user.id,
        answers,
        status: 'pending',
      },
    });
    return res.json({ status: 'success', data: { application } });
  } catch (error) {
    if (error.code === 'P2002') return fail(res, 409, 'You already applied');
    console.error('Apply submit error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

exports.getRaffle = async (req, res) => {
  try {
    const campaign = (await listActiveRows(null, new Date(), 'RAFFLE'))[0] || null;
    if (!campaign) return res.json({ status: 'success', data: { campaign: null, tickets: 0, wins: [] } });
    const { tickets } = await upsertRaffleTickets(req.user.id, campaign);
    const wins = await prisma.campaignRaffleWin.findMany({
      where: { campaignId: campaign.id, userId: req.user.id },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({
      status: 'success',
      data: {
        campaign: toPublicCard(campaign),
        tickets,
        wins,
      },
    });
  } catch (error) {
    console.error('Raffle get error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};

function wheelError(res, error) {
  if (error.status) return fail(res, error.status, error.message);
  console.error('Wheel error:', error);
  return res.status(500).json({ status: 'error', message: 'Server error' });
}

exports.getWheel = async (req, res) => {
  try {
    return res.json({ status: 'success', data: await wheelState(req.user.id) });
  } catch (error) {
    return wheelError(res, error);
  }
};

exports.spinWheel = async (req, res) => {
  try {
    return res.json({ status: 'success', data: await spinWheel(req.user.id, new Date(), { all: req.body?.all === true }) });
  } catch (error) {
    return wheelError(res, error);
  }
};

exports.shareWheel = async (req, res) => {
  try {
    return res.json({ status: 'success', data: await recordShare(req.user.id) });
  } catch (error) {
    return wheelError(res, error);
  }
};

exports.claimWheel = async (req, res) => {
  try {
    return res.json({ status: 'success', data: await claimSpin(req.user.id, req.params.spinId, req.body || {}) });
  } catch (error) {
    return wheelError(res, error);
  }
};

exports.getCalendar = async (req, res) => {
  try {
    return res.json({ status: 'success', data: await calendarState(req.user.id) });
  } catch (error) {
    return wheelError(res, error);
  }
};

exports.openCalendarDay = async (req, res) => {
  try {
    return res.json({ status: 'success', data: await openDay(req.user.id, req.params.day) });
  } catch (error) {
    return wheelError(res, error);
  }
};

exports.claimCalendarGift = async (req, res) => {
  try {
    return res.json({ status: 'success', data: await claimGift(req.user.id, req.params.openId, req.body || {}) });
  } catch (error) {
    return wheelError(res, error);
  }
};

exports.getTourismMap = async (req, res) => {
  try {
    const data = await getTourismMap(req.user.id);
    return res.json({ status: 'success', data });
  } catch (error) {
    console.error('Tourism map get error:', error);
    return res.status(500).json({ status: 'error', message: 'Server error' });
  }
};
