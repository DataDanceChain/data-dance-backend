const { PrismaClient } = require('@prisma/client');
const {
  CORE_SOURCES,
  ACCEPTED_SOURCES,
} = require('../src/constants/crawlerSources');
const { parseDraft, assertPublishable } = require('../src/utils/campaignRules');

const prisma = new PrismaClient();

const LAUNCH_START = '2026-09-30T00:00:00.000Z';
const LAUNCH_END = '2026-10-06T23:59:59.000Z';
const APPLY_START = '2026-09-12T00:00:00.000Z';
const APPLY_END = '2026-09-29T23:59:59.000Z';
const BF_START = '2026-11-27T00:00:00.000Z';
const BF_END = '2026-11-30T23:59:59.000Z';

const NEW_SOURCES = ACCEPTED_SOURCES.filter(
  (site) => site && site !== 'generic' && !CORE_SOURCES.includes(site),
);

const LEGAL_LAUNCH =
  'Launch Week bonuses apply only during the published window. Points extras stack on top of the usual award for a qualifying action. A redeem discount changes the points price shown in Wallet; it does not create cash value. DataDance may end a campaign early if abuse is detected.';
const LEGAL_APPLY =
  'Applying does not guarantee a tester seat. Ops reviews answers and may approve or reject. Perks described on the page are copy only and are not an on-chain or legal entitlement.';
const LEGAL_RAFFLE =
  'Raffle tickets come from the published formula only. Point prizes are credited automatically after the draw. Manual prizes such as USDT or gift cards are fulfilled by ops and are not a cash equivalent stored in Wallet.';
const LEGAL_BF =
  'Amazon point multiplier applies only to qualifying Amazon uploads during the published window. It does not change the usual upload rules.';
const LEGAL_STAY =
  'Stay bonuses apply only to the published sources and check-in window. Cancelled or failed stays do not count. Invite points use the special stay invite link on the campaign page. DataDance may end a campaign early if abuse is detected.';
const LEGAL_TOURISM =
  'World Tourism Day map is a view of stays you already uploaded. Lighting a city does not create extra points by itself. Upload bonuses follow the published stay campaign. The map may omit a stay if the city cannot be read.';

function base(overrides) {
  return {
    timezone: 'UTC',
    purpose: overrides.purpose,
    legalText: overrides.legalText,
    ...overrides,
  };
}

const DRAFTS = [
  base({
    slug: 'summer-travel-2026-stay',
    internalName: 'Summer Travel stay bonus',
    titleEn: 'Summer Travel Bonus',
    titleZh: '夏日出行奖励',
    blurbEn: 'Connect Booking or Airbnb and earn double points on 2026 summer stays.',
    blurbZh: '连接 Booking 或 Airbnb，2026 年夏季住宿双倍积分。',
    pillEn: 'Ends Sep 30',
    pillZh: '截至 9 月 30 日',
    template: 'STAY_BONUS',
    startsAt: '2026-08-03T07:00:00.000Z',
    endsAt: '2026-10-01T06:59:59.999Z',
    sites: ['airbnb', 'booking'],
    stayStartDate: '2026-06-01',
    stayEndDate: '2026-08-31',
    bonusPerItem: 10,
    pointsPerOrder: 20,
    inviterPoints: 300,
    inviteePoints: 100,
    purpose: 'Configurable stay sources and bonuses for the 2026 Summer Travel campaign.',
    legalText: LEGAL_STAY,
  }),
  base({
    slug: 'world-tourism-day-2026-home',
    internalName: 'World Tourism Day map card',
    titleEn: 'Light up your summer',
    titleZh: '点亮你的夏天',
    blurbEn: 'Your bookings tell the story of where your summer took you.',
    blurbZh: '你的住宿记录，就是这个夏天走过的路。',
    pillEn: 'Sep 27',
    pillZh: '9月27日',
    template: 'HOME_CARD',
    startsAt: '2026-09-11T16:00:00.000Z',
    endsAt: '2026-10-01T06:59:59.999Z',
    ctaKind: 'ROUTE',
    ctaValue: '/user/tourism-map',
    shareTextEn: 'I lit my summer map on DataDance.',
    shareTextZh: '我在 DataDance 点亮了夏天的地图。',
    purpose: 'World Tourism Day entry to the summer stay map built from uploaded travel records.',
    legalText: LEGAL_TOURISM,
  }),
  base({
    slug: 'launch-week-2026-new-sources',
    internalName: 'Launch Week new sources 2x',
    titleEn: 'New sources, double points',
    titleZh: '新数据源双倍积分',
    blurbEn: 'Upload from the new shop, travel, life, or social sources this week and earn 2× points.',
    blurbZh: '本周从新增的购物、出行、生活或社交站点上传，积分翻倍。',
    pillEn: 'Launch week',
    pillZh: '上线周',
    template: 'CONNECT_BOOST',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    sites: NEW_SOURCES,
    multiplier: 2,
    purpose: 'Reward first use of newly supported Connect sources during Wallet launch week.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'launch-week-2026-first-distill',
    internalName: 'Launch Week first distillation +20',
    titleEn: 'First distillation bonus',
    titleZh: '首次蒸馏奖励',
    blurbEn: 'Finish your first AI distillation this week and get +20 points.',
    blurbZh: '本周完成第一次 AI 蒸馏，额外 +20 积分。',
    pillEn: '+20',
    pillZh: '+20',
    template: 'FIRST_ACTION_BONUS',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    action: 'first_distillation',
    points: 20,
    purpose: 'Get new users through AI distillation during Wallet launch week.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'launch-week-2026-referral',
    internalName: 'Launch Week referral +150 extra',
    titleEn: 'Invite bonus this week',
    titleZh: '本周邀请加成',
    blurbEn: 'Valid invites earn the usual 150 plus 150 extra this week.',
    blurbZh: '有效邀请在常规 150 之外，本周再加 150。',
    pillEn: '300 pts',
    pillZh: '300 积分',
    template: 'REFERRAL_BOOST',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    extraInviterPoints: 150,
    extraInviteePoints: 0,
    purpose: 'Raise valid-invite rewards during Wallet launch week.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'launch-week-2026-redeem',
    internalName: 'Launch Week redeem 5% off',
    titleEn: 'Launch week redeem sale',
    titleZh: '上线周兑换折扣',
    blurbEn: 'Rewards cost 5% fewer points this week.',
    blurbZh: '本周兑换奖励所需积分打 95 折。',
    pillEn: '5% off',
    pillZh: '95 折',
    template: 'REDEEM_SALE',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    percentOff: 5,
    purpose: 'Lower redeem point prices during Wallet launch week.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'launch-week-2026-home-sources',
    internalName: 'Launch Week card · new sources',
    titleEn: 'New sources pay double',
    titleZh: '新数据源双倍积分',
    blurbEn: 'Open Connect and upload from a newly supported site.',
    blurbZh: '打开连接，从新增站点上传。',
    pillEn: '2×',
    pillZh: '2×',
    template: 'HOME_CARD',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    ctaKind: 'ROUTE',
    ctaValue: '/user/index',
    purpose: 'Surface the launch-week Connect boost on Earn.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'launch-week-2026-home-distill',
    internalName: 'Launch Week card · distillation',
    titleEn: 'Try AI distillation',
    titleZh: '试试 AI 蒸馏',
    blurbEn: 'First successful distillation this week: +20 points.',
    blurbZh: '本周首次蒸馏成功：+20 积分。',
    pillEn: '+20',
    pillZh: '+20',
    template: 'HOME_CARD',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    ctaKind: 'ROUTE',
    ctaValue: '/user/life-capsule',
    purpose: 'Surface the first-distillation bonus on Earn.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'launch-week-2026-home-invite',
    internalName: 'Launch Week card · invite',
    titleEn: 'Invites pay 300 this week',
    titleZh: '本周邀请得 300',
    blurbEn: 'Share your code. Valid invites earn 150 extra on top of the usual 150.',
    blurbZh: '分享邀请码。有效邀请在常规 150 上再加 150。',
    pillEn: '300 pts',
    pillZh: '300 积分',
    template: 'HOME_CARD',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    ctaKind: 'ROUTE',
    ctaValue: '/user/referral',
    purpose: 'Surface the launch-week referral boost on Earn.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'launch-week-2026-home-redeem',
    internalName: 'Launch Week card · redeem',
    titleEn: 'Redeem at 95%',
    titleZh: '兑换 95 折',
    blurbEn: 'Rewards cost fewer points until launch week ends.',
    blurbZh: '上线周结束前，兑换所需积分更少。',
    pillEn: '5% off',
    pillZh: '95 折',
    template: 'HOME_CARD',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    ctaKind: 'ROUTE',
    ctaValue: '/user/points',
    purpose: 'Surface the launch-week redeem sale on Earn.',
    legalText: LEGAL_LAUNCH,
  }),
  base({
    slug: 'black-friday-2026-amazon',
    internalName: 'Black Friday Amazon 2x',
    titleEn: 'Amazon points, doubled',
    titleZh: 'Amazon 积分翻倍',
    blurbEn: 'Qualifying Amazon uploads earn 2× points for Black Friday week.',
    blurbZh: '黑五期间，符合条件的 Amazon 上传积分翻倍。',
    pillEn: '2× Amazon',
    pillZh: 'Amazon 2×',
    template: 'CONNECT_BOOST',
    startsAt: BF_START,
    endsAt: BF_END,
    sites: ['amazon'],
    multiplier: 2,
    purpose: 'Amazon point multiplier for Black Friday and Cyber Monday.',
    legalText: LEGAL_BF,
  }),
  base({
    slug: 'black-friday-2026-home',
    internalName: 'Black Friday card · Amazon',
    titleEn: 'Amazon pays double',
    titleZh: 'Amazon 双倍积分',
    blurbEn: 'Connect Amazon this weekend for 2× points.',
    blurbZh: '这个周末连接 Amazon，积分 2×。',
    pillEn: 'Black Friday',
    pillZh: '黑五',
    template: 'HOME_CARD',
    startsAt: BF_START,
    endsAt: BF_END,
    ctaKind: 'CONNECT',
    ctaValue: 'amazon',
    purpose: 'Surface the Amazon Black Friday boost on Earn.',
    legalText: LEGAL_BF,
  }),
  base({
    slug: 'wallet-launch-2026-testers',
    internalName: 'Wallet launch tester apply',
    titleEn: 'Become a launch tester',
    titleZh: '成为上线测试员',
    blurbEn: '50 seats. Tell us one friction, one favourite change, and one fix you want before launch.',
    blurbZh: '50 个名额。告诉我们一处不顺手、一个最喜欢的变化，以及上线前最希望改掉的一点。',
    pillEn: '50 seats',
    pillZh: '50 席',
    template: 'APPLY_COHORT',
    startsAt: APPLY_START,
    endsAt: APPLY_END,
    seatCap: 50,
    question1En: 'Find one bug or something that feels awkward.',
    question1Zh: '找到一个 Bug，或一处用起来不顺手的地方。',
    question2En: 'What is your favourite change in the new Wallet?',
    question2Zh: '新版 Wallet 里你最喜欢的一个变化是什么？',
    question3En: 'What should we fix before launch day?',
    question3Zh: '上线前最希望我们改掉什么？',
    perkNoteEn: 'Approved testers get Early User recognition and a points thank-you. Web3 identity perks are announced later.',
    perkNoteZh: '通过的测试员会获得 Early User 身份说明和积分感谢。Web3 身份权益稍后公布。',
    purpose: 'Recruit 50 Wallet launch testers with a short written application.',
    legalText: LEGAL_APPLY,
  }),
  base({
    slug: 'launch-week-2026-raffle',
    internalName: 'Launch Week raffle',
    titleEn: 'Launch week raffle',
    titleZh: '上线周抽奖',
    blurbEn: 'One ticket for being here, plus one per valid invite, up to five. Ops draws the prizes.',
    blurbZh: '参与即 1 次，每次有效邀请再 +1，最多 5 次。由运营开奖。',
    pillEn: 'Up to 5',
    pillZh: '最多 5 次',
    template: 'RAFFLE',
    startsAt: LAUNCH_START,
    endsAt: LAUNCH_END,
    baseTickets: 1,
    ticketOnValidInvite: 1,
    maxTickets: 5,
    prizes: [
      { kind: 'POINTS', points: 100, count: 20, labelEn: '100 bonus points', labelZh: '100 积分' },
      { kind: 'MANUAL', points: 0, count: 5, labelEn: 'Gift card / USDT (ops fulfill)', labelZh: '礼品卡 / USDT（运营兑付）' },
    ],
    purpose: 'Launch-week raffle with invite tickets. Point prizes auto-credit; cash-like prizes are fulfilled by ops.',
    legalText: LEGAL_RAFFLE,
  }),
];

const SCHEDULED_SLUGS = new Set([
  'summer-travel-2026-stay',
  'world-tourism-day-2026-home',
  'launch-week-2026-new-sources',
  'launch-week-2026-first-distill',
  'launch-week-2026-referral',
  'launch-week-2026-redeem',
  'launch-week-2026-home-sources',
  'launch-week-2026-home-distill',
  'launch-week-2026-home-invite',
  'launch-week-2026-home-redeem',
  'black-friday-2026-amazon',
  'black-friday-2026-home',
]);

async function upsertOne(body) {
  const parsed = parseDraft(body);
  if (parsed.error) throw new Error(`${body.slug}: ${parsed.error}`);
  const publishError = assertPublishable(parsed.data);
  if (publishError) throw new Error(`${body.slug}: ${publishError}`);
  const existing = await prisma.campaign.findUnique({ where: { slug: parsed.data.slug } });
  const status = SCHEDULED_SLUGS.has(parsed.data.slug) ? 'SCHEDULED' : 'DRAFT';
  if (!existing) {
    const row = await prisma.campaign.create({
      data: {
        ...parsed.data,
        status,
        createdBy: 'ops-seed',
        updatedBy: 'ops-seed',
      },
    });
    await prisma.campaignEvent.create({
      data: { campaignId: row.id, actor: 'ops-seed', action: 'seed', fromStatus: null, toStatus: status },
    });
    return { slug: row.slug, status, action: 'created' };
  }
  if (existing.status === 'LIVE' || existing.status === 'ENDED') {
    return { slug: existing.slug, status: existing.status, action: 'skipped' };
  }
  const row = await prisma.campaign.update({
    where: { id: existing.id },
    data: {
      ...parsed.data,
      status: existing.status === 'DRAFT' ? status : existing.status,
      updatedBy: 'ops-seed',
    },
  });
  return { slug: row.slug, status: row.status, action: 'updated' };
}

async function main() {
  const results = [];
  for (const draft of DRAFTS) {
    results.push(await upsertOne(draft));
  }
  console.log(JSON.stringify({ ok: true, results }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
