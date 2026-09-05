/**
 * Connect upload sources the Wallet app can extract or catalog-upload.
 * Core platforms have dedicated parsers. Shop / social / travel / life
 * catalog sources use the generic visible-record extract and title-backed
 * identity (host + orderId / title / date). Do not collapse catalog ids
 * into amazon.
 */

const CORE_SOURCES = ['amazon', 'luma', 'airbnb', 'booking'];

const SHOP_SOURCE_DEFS = [
  { source: 'shein', title: 'SHEIN Orders', origin: 'https://m.shein.com', path: '/user/orders' },
  { source: 'temu', title: 'Temu Orders', origin: 'https://www.temu.com', path: '/bgt_order.html' },
  { source: 'shopee', title: 'Shopee Purchases', origin: 'https://shopee.com', path: '/user/purchase/' },
  { source: 'aliexpress', title: 'AliExpress Orders', origin: 'https://www.aliexpress.com', path: '/p/order/index.html' },
  { source: 'ebay', title: 'eBay Purchases', origin: 'https://www.ebay.com', path: '/mye/myebay/purchase' },
  { source: 'etsy', title: 'Etsy Purchases', origin: 'https://www.etsy.com', path: '/your/purchases' },
  { source: 'walmart', title: 'Walmart Orders', origin: 'https://www.walmart.com', path: '/orders' },
  { source: 'shopify', title: 'Shopify Orders', origin: 'https://admin.shopify.com', path: '/orders' },
  { source: 'stripe', title: 'Stripe Payments', origin: 'https://dashboard.stripe.com', path: '/payments' },
  { source: 'target', title: 'Target Orders', origin: 'https://www.target.com', path: '/orders' },
  { source: 'nike', title: 'Nike Orders', origin: 'https://www.nike.com', path: '/orders' },
  { source: 'adidas', title: 'adidas Orders', origin: 'https://www.adidas.com', path: '/us/my-account/orders' },
  { source: 'zara', title: 'Zara Orders', origin: 'https://www.zara.com', path: '/us/en/user/order' },
  { source: 'ikea', title: 'IKEA Purchases', origin: 'https://www.ikea.com', path: '/us/en/purchases/' },
  { source: 'uniqlo', title: 'Uniqlo Orders', origin: 'https://www.uniqlo.com', path: '/us/en/member/purchase-history' },
  { source: 'zalando', title: 'Zalando Orders', origin: 'https://www.zalando.com', path: '/myaccount/orders/' },
  { source: 'apple', title: 'Apple Store Orders', origin: 'https://www.apple.com', path: '/shop/order/list' },
  { source: 'puma', title: 'PUMA Orders', origin: 'https://us.puma.com', path: '/us/en/account/orders' },
  { source: 'vinted', title: 'Vinted Purchases', origin: 'https://www.vinted.com', path: '/my_orders' },
  { source: 'stockx', title: 'StockX Orders', origin: 'https://stockx.com', path: '/orders' },
  { source: 'farfetch', title: 'FARFETCH Orders', origin: 'https://www.farfetch.com', path: '/orders' },
  { source: 'macys', title: "Macy's Orders", origin: 'https://www.macys.com', path: '/account/orders' },
  { source: 'newbalance', title: 'New Balance Orders', origin: 'https://www.newbalance.com', path: '/orders.html' },
  { source: 'rakuten', title: 'Rakuten Orders', origin: 'https://www.rakuten.com', path: '/my-account/orders' },
  { source: 'mercari', title: 'Mercari Purchases', origin: 'https://www.mercari.com', path: '/mypage/purchases' },
  { source: 'sephora', title: 'Sephora Orders', origin: 'https://www.sephora.com', path: '/purchase-history' },
  { source: 'bestbuy', title: 'Best Buy Orders', origin: 'https://www.bestbuy.com', path: '/profile/ss/orders' },
  { source: 'generic', title: 'Shop Orders', origin: '', path: '' },
];

const SOCIAL_SOURCE_DEFS = [
  { source: 'x', title: 'X Posts', origin: 'https://x.com', path: '/home' },
  { source: 'instagram', title: 'Instagram Posts', origin: 'https://www.instagram.com', path: '/' },
  { source: 'facebook', title: 'Facebook Activity', origin: 'https://www.facebook.com', path: '/me' },
  { source: 'linkedin', title: 'LinkedIn Activity', origin: 'https://www.linkedin.com', path: '/in/me/' },
  { source: 'tiktok', title: 'TikTok Posts', origin: 'https://www.tiktok.com', path: '/profile' },
  { source: 'reddit', title: 'Reddit Posts', origin: 'https://www.reddit.com', path: '/user/me/submitted/' },
  { source: 'youtube', title: 'YouTube Activity', origin: 'https://www.youtube.com', path: '/feed/you' },
  { source: 'threads', title: 'Threads Posts', origin: 'https://www.threads.net', path: '/' },
  { source: 'pinterest', title: 'Pinterest Pins', origin: 'https://www.pinterest.com', path: '/_created/' },
  { source: 'discord', title: 'Discord Activity', origin: 'https://discord.com', path: '/channels/@me' },
  { source: 'twitch', title: 'Twitch Activity', origin: 'https://www.twitch.tv', path: '/' },
];

const TRAVEL_SOURCE_DEFS = [
  { source: 'expedia', title: 'Expedia Trips', origin: 'https://www.expedia.com', path: '/trips' },
  { source: 'agoda', title: 'Agoda Bookings', origin: 'https://www.agoda.com', path: '/account/bookings.html' },
  { source: 'trip', title: 'Trip.com Bookings', origin: 'https://www.trip.com', path: '/trips' },
  { source: 'hotels', title: 'Hotels.com Stays', origin: 'https://www.hotels.com', path: '/trips' },
  { source: 'tripadvisor', title: 'Tripadvisor Trips', origin: 'https://www.tripadvisor.com', path: '/Trips' },
];

const LIFE_SOURCE_DEFS = [
  { source: 'uber', title: 'Uber Trips', origin: 'https://riders.uber.com', path: '/trips' },
  { source: 'ubereats', title: 'Uber Eats Orders', origin: 'https://www.ubereats.com', path: '/orders' },
  { source: 'doordash', title: 'DoorDash Orders', origin: 'https://www.doordash.com', path: '/orders' },
  { source: 'deliveroo', title: 'Deliveroo Orders', origin: 'https://deliveroo.com', path: '/orders' },
  { source: 'foodpanda', title: 'foodpanda Orders', origin: 'https://www.foodpanda.com', path: '/orders' },
  { source: 'eventbrite', title: 'Eventbrite Events', origin: 'https://www.eventbrite.com', path: '/u/me/' },
  { source: 'ticketmaster', title: 'Ticketmaster Orders', origin: 'https://www.ticketmaster.com', path: '/user' },
  { source: 'meetup', title: 'Meetup Events', origin: 'https://www.meetup.com', path: '/' },
];

const SOURCE_ALIASES = {
  twitter: 'x',
  'trip.com': 'trip',
  ctrip: 'trip',
};

const SHOP_SOURCES = SHOP_SOURCE_DEFS.map((row) => row.source);
const SOCIAL_SOURCES = SOCIAL_SOURCE_DEFS.map((row) => row.source);
const TRAVEL_SOURCES = TRAVEL_SOURCE_DEFS.map((row) => row.source);
const LIFE_SOURCES = LIFE_SOURCE_DEFS.map((row) => row.source);

const ACCEPTED_SOURCES = [
  ...CORE_SOURCES,
  ...SHOP_SOURCES,
  ...SOCIAL_SOURCES,
  ...TRAVEL_SOURCES,
  ...LIFE_SOURCES,
];

const SHOP_SOURCE_SET = new Set(SHOP_SOURCES);
const SOCIAL_SOURCE_SET = new Set(SOCIAL_SOURCES);
const TRAVEL_SOURCE_SET = new Set(TRAVEL_SOURCES);
const LIFE_SOURCE_SET = new Set(LIFE_SOURCES);
const ACCEPTED_SOURCE_SET = new Set(ACCEPTED_SOURCES);

function normalizeCrawlerSource(source) {
  const raw = String(source || '').trim().toLowerCase();
  if (!raw) return '';
  return SOURCE_ALIASES[raw] || raw;
}

function isAcceptedCrawlerSource(source) {
  return ACCEPTED_SOURCE_SET.has(normalizeCrawlerSource(source));
}

function isShopCrawlerSource(source) {
  return SHOP_SOURCE_SET.has(normalizeCrawlerSource(source));
}

function isSocialCrawlerSource(source) {
  return SOCIAL_SOURCE_SET.has(normalizeCrawlerSource(source));
}

function isTravelCrawlerSource(source) {
  return TRAVEL_SOURCE_SET.has(normalizeCrawlerSource(source));
}

function isLifeCrawlerSource(source) {
  return LIFE_SOURCE_SET.has(normalizeCrawlerSource(source));
}

/** Shop / social / travel / life catalog rows use title-backed identity. */
function isCatalogCrawlerSource(source) {
  const canonical = normalizeCrawlerSource(source);
  return (
    SHOP_SOURCE_SET.has(canonical) ||
    SOCIAL_SOURCE_SET.has(canonical) ||
    TRAVEL_SOURCE_SET.has(canonical) ||
    LIFE_SOURCE_SET.has(canonical)
  );
}

function sourceRuleGroup(source) {
  const canonical = normalizeCrawlerSource(source);
  if (SOCIAL_SOURCE_SET.has(canonical)) return 'social';
  if (TRAVEL_SOURCE_SET.has(canonical)) return 'travel';
  if (LIFE_SOURCE_SET.has(canonical)) return 'life';
  if (SHOP_SOURCE_SET.has(canonical)) return 'shop';
  return canonical;
}

function templatesFromDefs(defs, description) {
  const templates = {};
  for (const def of defs) {
    templates[def.source] = [
      {
        taskId: `${def.source}_orders`,
        title: def.title,
        description,
        source: def.source,
        origin: def.origin,
        path: def.path,
      },
    ];
  }
  return templates;
}

function shopTaskTemplates() {
  return templatesFromDefs(SHOP_SOURCE_DEFS, 'Upload visible order records from this shop');
}

function catalogTaskTemplates() {
  return {
    ...shopTaskTemplates(),
    ...templatesFromDefs(SOCIAL_SOURCE_DEFS, 'Upload visible records from this source'),
    ...templatesFromDefs(TRAVEL_SOURCE_DEFS, 'Upload visible trip records from this source'),
    ...templatesFromDefs(LIFE_SOURCE_DEFS, 'Upload visible activity records from this source'),
  };
}

module.exports = {
  CORE_SOURCES,
  SHOP_SOURCES,
  SOCIAL_SOURCES,
  TRAVEL_SOURCES,
  LIFE_SOURCES,
  ACCEPTED_SOURCES,
  SHOP_SOURCE_DEFS,
  SOCIAL_SOURCE_DEFS,
  TRAVEL_SOURCE_DEFS,
  LIFE_SOURCE_DEFS,
  SOURCE_ALIASES,
  normalizeCrawlerSource,
  isAcceptedCrawlerSource,
  isShopCrawlerSource,
  isSocialCrawlerSource,
  isTravelCrawlerSource,
  isLifeCrawlerSource,
  isCatalogCrawlerSource,
  sourceRuleGroup,
  shopTaskTemplates,
  catalogTaskTemplates,
};
