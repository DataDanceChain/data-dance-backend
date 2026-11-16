const { SHOP_SOURCES, TRAVEL_SOURCES, LIFE_SOURCES, SOCIAL_SOURCES } = require('../constants/crawlerSources');

const CALENDAR_DAYS = 25;
const CALENDAR_SITES = [
  ...SHOP_SOURCES.filter((site) => site !== 'generic'),
  'amazon',
  'airbnb',
  'booking',
  'luma',
  ...TRAVEL_SOURCES,
  ...LIFE_SOURCES,
];

function digital(day, asset, labelEn, labelZh, labelZhTw, labelJa, labelKo) {
  return {
    day,
    kind: 'DIGITAL',
    points: 0,
    asset,
    labelEn,
    labelZh,
    labelZhTw,
    labelJa,
    labelKo,
  };
}

function points(day, amount) {
  return {
    day,
    kind: 'POINTS',
    points: amount,
    asset: '',
    labelEn: `${amount} Points`,
    labelZh: `${amount} 积分`,
    labelZhTw: `${amount} 積分`,
    labelJa: `${amount} ポイント`,
    labelKo: `${amount} 포인트`,
  };
}

/** Documented December 2026 grid. Point days total 410. Social sources are not included. */
const CHRISTMAS_DAYS = [
  points(1, 10),
  points(2, 10),
  digital(3, '/christmas/pfp.svg', 'Christmas PFP', '圣诞头像', '聖誕頭像', 'クリスマスアイコン', '크리스마스 프로필'),
  points(4, 10),
  points(5, 10),
  points(6, 10),
  digital(7, '/christmas/stickers.svg', 'Christmas Sticker Pack', '圣诞表情包', '聖誕表情包', 'クリスマススタンプ', '크리스마스 스티커'),
  points(8, 10),
  points(9, 10),
  points(10, 50),
  points(11, 10),
  digital(12, '/christmas/wallpaper.svg', 'Christmas Wallpaper', '圣诞壁纸', '聖誕桌布', 'クリスマス壁紙', '크리스마스 배경화면'),
  points(13, 10),
  points(14, 10),
  points(15, 10),
  points(16, 10),
  digital(17, '/christmas/badge.svg', 'Christmas Badge', '圣诞徽章', '聖誕徽章', 'クリスマスバッジ', '크리스마스 배지'),
  points(18, 10),
  points(19, 10),
  points(20, 50),
  points(21, 10),
  points(22, 10),
  points(23, 150),
  digital(24, '/christmas/stamp.svg', 'Christmas Commemorative Stamp', '圣诞邮票', '聖誕郵票', 'クリスマス記念スタンプ', '크리스마스 기념 스탬프'),
  {
    day: 25,
    kind: 'GIFT_CARD',
    points: 0,
    asset: '',
    labelEn: '$5 Amazon Gift Card',
    labelZh: '$5 亚马逊礼品卡',
    labelZhTw: '$5 亞馬遜禮品卡',
    labelJa: 'Amazonギフトカード $5',
    labelKo: '아마존 기프트 카드 $5',
  },
];

function utcDayStart(date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** 1 on the campaign's first UTC day. Dates before the start are 0 or negative. */
function dayNumber(date, startsAt) {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime()) || Number.isNaN(date.getTime())) return 0;
  return Math.floor((utcDayStart(date) - utcDayStart(start)) / 86400000) + 1;
}

/**
 * past + opened → revealed
 * unlocked and still inside the claim window → unwrap
 * the live UTC day with no upload → upload
 * otherwise a past day → missed
 * a later day → future
 */
function cellState({ day, unlocked, opened, today, accepting }) {
  if (!today || day > today) return 'future';
  if (opened) return 'revealed';
  if (unlocked && accepting) return 'unwrap';
  if (day === today) return 'upload';
  return 'missed';
}

function calendarSites(config) {
  const listed = Array.isArray(config?.sites) ? config.sites.map((site) => String(site).toLowerCase()) : [];
  const sites = listed.filter((site) => site && site !== 'generic' && !SOCIAL_SOURCES.includes(site));
  return sites.length ? sites : CALENDAR_SITES;
}

module.exports = {
  CALENDAR_DAYS,
  CALENDAR_SITES,
  CHRISTMAS_DAYS,
  dayNumber,
  cellState,
  calendarSites,
};
