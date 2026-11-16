const { PrismaClient } = require('@prisma/client');
const {
  CORE_SOURCES,
  ACCEPTED_SOURCES,
  SHOP_SOURCES,
  SOCIAL_SOURCES,
} = require('../src/constants/crawlerSources');
const { parseDraft, assertPublishable } = require('../src/utils/campaignRules');
const { THANKSGIVING_PRIZES } = require('../src/utils/wheelRules');

const prisma = new PrismaClient();

const LAUNCH_START = '2026-09-30T00:00:00.000Z';
const LAUNCH_END = '2026-10-06T23:59:59.000Z';
const APPLY_START = '2026-09-12T00:00:00.000Z';
const APPLY_END = '2026-09-29T23:59:59.000Z';
const BF_START = '2026-11-01T00:00:00.000Z';
const BF_END = '2026-11-02T00:00:00.000Z';
const TG_START = '2026-11-26T00:00:00.000Z';
const TG_PLAY_END = '2026-11-30T23:59:59.000Z';
const TG_CLAIM_END = '2026-12-01T23:59:59.000Z';
const XMAS_START = '2026-12-01T00:00:00.000Z';
const XMAS_PLAY_END = '2026-12-25T23:59:59.000Z';
const XMAS_CLAIM_END = '2026-12-26T23:59:59.000Z';
const TG_SHOP_SITES = [...SHOP_SOURCES.filter((site) => site !== 'generic'), 'amazon'];
const TG_SOCIAL_SITES = SOCIAL_SOURCES.filter((site) => site !== 'discord');
const LEGAL_TG =
  'Play runs 26–30 November 2026 (UTC). Qualifying shopping uploads earn 2× points during play. Each person can win one gift card or USDT. Points are added to My Points when the wheel stops. Gift cards and USDT must be claimed by 1 December 2026, 23:59 UTC, or they are forfeited. Gift cards are US-region and cannot be exchanged. DataDance may withhold a prize for fraud, duplicate accounts, or manipulation, and sends claimed prizes within 7 business days after play ends.';
const LEGAL_XMAS =
  'The calendar runs 1–25 December 2026 (UTC). One qualifying shop, travel, or life upload unlocks that UTC day. Social uploads do not count, and a missed day cannot be unlocked later. Points are added to My Points when you unwrap the day. Unlocked gifts can still be unwrapped on 26 December 2026, through 23:59 UTC. The $5 Amazon gift card is for Amazon.com in the US, cannot be exchanged, and is emailed within 7 business days after the event ends. DataDance may withhold a reward for fraud, duplicate accounts, or manipulation. Questions: contact@datadance.ai.';

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
    purpose: 'Retired Amazon-only boost. Thanksgiving covers every shop, including Amazon.',
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
    purpose: 'Retired Amazon-only Black Friday card. The Thanksgiving wheel is the Earn card.',
    legalText: LEGAL_BF,
  }),
  base({
    slug: 'thanksgiving-2026-shop',
    internalName: 'Thanksgiving shop 2x',
    titleEn: 'Shopping points, doubled',
    titleZh: '购物积分翻倍',
    titleZhTw: '購物積分翻倍',
    titleJa: 'ショッピングポイント 2倍',
    titleKo: '쇼핑 포인트 2배',
    blurbEn: 'Qualifying shopping uploads earn 2× points through November 30.',
    blurbZh: '11 月 30 日前，符合条件的购物上传积分翻倍。',
    blurbZhTw: '11 月 30 日前，符合條件的購物上傳積分翻倍。',
    blurbJa: '11月30日まで、対象の買い物アップロードはポイント2倍。',
    blurbKo: '11월 30일까지 해당하는 쇼핑 업로드는 포인트 2배.',
    pillEn: '2×',
    pillZh: '2×',
    template: 'CONNECT_BOOST',
    startsAt: TG_START,
    endsAt: TG_PLAY_END,
    sites: TG_SHOP_SITES,
    multiplier: 2,
    purpose: '2× points on shop uploads, including Amazon, for Thanksgiving and Black Friday.',
    legalText: LEGAL_TG,
  }),
  base({
    slug: 'thanksgiving-2026',
    internalName: 'Thanksgiving × Black Friday wheel',
    titleEn: 'Thanksgiving × Black Friday',
    titleZh: '感恩节 × 黑五',
    titleZhTw: '感恩節 × 黑五',
    titleJa: 'サンクスギビング × ブラックフライデー',
    titleKo: '추수감사절 × 블랙프라이데이',
    blurbEn: '$500 prize pool and unlimited 2× points.',
    blurbZh: '500 美元奖池，购物积分不限次数 2 倍。',
    blurbZhTw: '500 美元獎池，購物積分不限次數 2 倍。',
    blurbJa: '賞品総額 $500、ショッピングポイントは何度でも 2倍。',
    blurbKo: '총 상금 $500, 쇼핑 포인트는 무제한 2배.',
    pillEn: 'Claim',
    pillZh: '兑奖',
    pillZhTw: '兌獎',
    pillJa: '受け取り',
    pillKo: '수령',
    template: 'WHEEL',
    startsAt: TG_START,
    endsAt: TG_CLAIM_END,
    playEndsAt: TG_PLAY_END,
    shopPer: 5,
    socialPer: 10,
    socialMaxDraws: 5,
    shopSites: TG_SHOP_SITES,
    socialSites: TG_SOCIAL_SITES,
    prizes: THANKSGIVING_PRIZES,
    purpose: 'Thanksgiving and Black Friday wheel. Points credit on spin. Gift cards and USDT are claimed by December 1.',
    legalText: LEGAL_TG,
  }),
  base({
    slug: 'christmas-2026',
    internalName: 'Christmas advent calendar',
    titleEn: 'Christmas Advent Calendar',
    titleZh: '圣诞倒数日历',
    titleZhTw: '聖誕倒數日曆',
    titleJa: 'クリスマスアドベントカレンダー',
    titleKo: '크리스마스 어드벤트 캘린더',
    blurbEn: 'Upload. Unlock. Unwrap. One record opens today’s gift.',
    blurbZh: '上传、解锁、拆开。一条记录打开今天的礼物。',
    blurbZhTw: '上傳、解鎖、拆開。一筆記錄打開今天的禮物。',
    blurbJa: 'アップロードして、今日のギフトを開けよう。',
    blurbKo: '올리고, 열고, 오늘의 선물을 확인하세요.',
    pillEn: 'Day 1 / 25',
    pillZh: '第 1 / 25 天',
    pillZhTw: '第 1 / 25 天',
    pillJa: '1日目 / 25',
    pillKo: '1 / 25일',
    template: 'CALENDAR',
    startsAt: XMAS_START,
    endsAt: XMAS_CLAIM_END,
    playEndsAt: XMAS_PLAY_END,
    purpose: 'December 2026 advent calendar. One shop, travel, or life upload unlocks that UTC day. Points are granted when the gift is unwrapped.',
    legalText: LEGAL_XMAS,
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
  'thanksgiving-2026-shop',
  'thanksgiving-2026',
  'christmas-2026',
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
