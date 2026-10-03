/**
 * 2026 monthly revenue example on top of existing test data.
 *
 * Does not delete pack imports, merchants, or other users. Re-runs replace only
 * rows tagged [revenue-book-2026] and accounts @book.datadance.test.
 *
 * Unit economics, per valid record, varied so the book is not a flat formula:
 *   buyer pays about $10 (some even dollars, some with cents)
 *   contributor data cost $3–$5
 *   referral node about $3 on a first acquisition
 *   first-acquisition gross margin around 20%, different each month
 *   a second cut of the same category is a reauthorization: the contributor
 *   is paid again, the referral node is not, and that order's margin is 50–70%
 *
 * Purchase orders are not one-per-industry every month. Some months a vertical
 * is quiet, and busy months split the same vertical across two orders.
 * Each contributor has one reward-eligible upload and one, two, or three extra
 * data-pack rows.
 * On 2026-09-30, $2,000 of issued points are redeemed as 137 Amazon and Apple
 * gift cards across 8 Amazon orders. That redemption is not a second cost, and
 * it does not cash out the whole month.
 *
 *   node scripts/seedRevenueBook2026.js --dry-run
 *   node scripts/seedRevenueBook2026.js
 */

const crypto = require('crypto');
const { GIFT_CARD_BATCH, GIFT_CARD_PURCHASES, purchaseTotal, assertGiftCardBatch } = require('./revenueBookGiftCards');

const SEED_TAG = '[revenue-book-2026]';
const EMAIL_DOMAIN = '@book.datadance.test';
const BUYER_EMAIL = 'test-buyer@datadance.io';
const SELLER_EMAIL = 'official@datadance.io';
const POINTS_USD = 0.01;

// Buyer price, data cost, and referral share in cents. Even amounts sit next to
// amounts with cents so a month does not land on one repeating margin.
const SALE_CENTS = [1000, 850, 1200, 960, 1000, 1100, 750, 1050, 1000, 800, 1250, 999, 900, 1000, 880, 1150, 970, 1000, 1080, 1061];
const DATA_CENTS = [500, 450, 380, 500, 420, 500, 350, 480, 500, 400, 460, 500, 320, 500, 440, 500, 390, 475, 500, 455];
const REFERRAL_CENTS = [300, 250, 300, 350, 300, 280, 300, 300, 400, 300, 200, 300, 320, 300, 300, 250, 300, 350, 300, 300];
const SHOP_CENTS = [1999, 2400, 3650, 1287, 4580, 12800, 990, 6418, 1575, 8800, 763, 20000, 3340, 1642, 4999];

// industry is an index into INDUSTRIES. opened/paid are days in that month.
// Counts are valid records, chosen so no month is a round hundred and no two
// months have the same number of purchase orders.
const MONTHS = [
  {
    key: '2026-04', label: 'April 2026', year: 2026, month: 4, guide: 13000,
    orders: [
      { industry: 0, count: 784, opened: 7, paid: 11 },
      { industry: 1, count: 468, opened: 19, paid: 24 },
    ],
  },
  {
    key: '2026-05', label: 'May 2026', year: 2026, month: 5, guide: 20000,
    orders: [
      { industry: 0, count: 486, opened: 4, paid: 8 },
      { industry: 0, count: 311, opened: 13, paid: 18 },
      { industry: 1, count: 437, opened: 6, paid: 11 },
      { industry: 2, count: 392, opened: 16, paid: 21 },
      { industry: 3, count: 268, opened: 23, paid: 28 },
    ],
  },
  {
    key: '2026-06', label: 'June 2026', year: 2026, month: 6, guide: 38000,
    orders: [
      { industry: 0, count: 973, opened: 3, paid: 7 },
      { industry: 0, count: 418, opened: 11, paid: 15 },
      { industry: 1, count: 641, opened: 5, paid: 9 },
      { industry: 1, count: 352, opened: 18, paid: 22 },
      { industry: 2, count: 807, opened: 8, paid: 14 },
      { industry: 3, count: 446, opened: 21, paid: 26 },
    ],
  },
  {
    key: '2026-07', label: 'July 2026', year: 2026, month: 7, guide: 36000,
    orders: [
      { industry: 0, count: 1584, opened: 6, paid: 12 },
      { industry: 1, count: 1107, opened: 14, paid: 19 },
      { industry: 2, count: 836, opened: 22, paid: 27 },
    ],
  },
  {
    key: '2026-08', label: 'August 2026', year: 2026, month: 8, guide: 90000,
    orders: [
      { industry: 0, count: 2104, opened: 3, paid: 6 },
      { industry: 0, count: 1287, opened: 9, paid: 13 },
      { industry: 1, count: 1540, opened: 5, paid: 8 },
      { industry: 1, count: 876, opened: 12, paid: 17 },
      { industry: 2, count: 1103, opened: 16, paid: 20 },
      { industry: 3, count: 942, opened: 19, paid: 24 },
      { industry: 3, count: 1034, opened: 25, paid: 28 },
    ],
  },
  {
    key: '2026-09', label: 'September 2026', year: 2026, month: 9, guide: 120000,
    orders: [
      { industry: 0, count: 2408, opened: 2, paid: 6 },
      { industry: 0, count: 1807, opened: 8, paid: 11 },
      { industry: 1, count: 1694, opened: 4, paid: 9 },
      { industry: 1, count: 1109, opened: 13, paid: 16 },
      { industry: 2, count: 1544, opened: 7, paid: 12 },
      { industry: 2, count: 907, opened: 15, paid: 19 },
      { industry: 3, count: 1218, opened: 18, paid: 23 },
      { industry: 3, count: 886, opened: 24, paid: 29 },
    ],
  },
];

// One bump per month, different endings, so columns do not share a cent signature.
const MONTH_CENTS = [
  { sale: 37, data: 14, referral: 22 },
  { sale: 18, data: 73, referral: 8 },
  { sale: 64, data: 6, referral: 47 },
  { sale: 9, data: 41, referral: 16 },
  { sale: 52, data: 28, referral: 63 },
  { sale: 81, data: 55, referral: 31 },
];

const INDUSTRIES = [
  {
    key: 'ecommerce',
    code: 'ECOM',
    label: 'E-commerce',
    nodes: 6,
    giftCard: 'amazon',
    valid: { source: 'amazon', type: 'order', host: 'www.amazon.com', title: 'Amazon orders' },
    extras: [
      { source: 'shein', type: 'order', host: 'm.shein.com', title: 'SHEIN orders' },
      { source: 'walmart', type: 'order', host: 'www.walmart.com', title: 'Walmart orders' },
    ],
    titles: ['Storage bins', 'USB-C cable', 'Cotton sheet set', 'Desk lamp', 'Water bottle', 'Notebook set'],
  },
  {
    key: 'hotel_travel',
    code: 'TRAVEL',
    label: 'Hotel and travel',
    nodes: 5,
    giftCard: 'apple',
    valid: { source: 'booking', type: 'stay', host: 'www.booking.com', title: 'Booking stays' },
    extras: [
      { source: 'airbnb', type: 'stay', host: 'www.airbnb.com', title: 'Airbnb stays' },
      { source: 'expedia', type: 'stay', host: 'www.expedia.com', title: 'Expedia trips' },
    ],
    titles: ['City hotel, 2 nights', 'Airport hotel, 1 night', 'Seaside apartment, 3 nights', 'Business hotel, 1 night'],
  },
  {
    key: 'automotive',
    code: 'AUTO',
    label: 'Automotive',
    nodes: 3,
    giftCard: 'apple',
    valid: { source: 'ebay', type: 'order', host: 'www.ebay.com', title: 'eBay auto-parts orders' },
    extras: [
      { source: 'amazon', type: 'order', host: 'www.amazon.com', title: 'Amazon auto parts' },
      { source: 'walmart', type: 'order', host: 'www.walmart.com', title: 'Walmart auto parts' },
    ],
    titles: ['Cabin air filter', 'Brake pad set', 'Motor oil 5L', 'Wiper blades', 'Floor mats'],
  },
  {
    key: 'building_materials',
    code: 'BUILD',
    label: 'Building materials',
    nodes: 4,
    giftCard: 'apple',
    valid: { source: 'ikea', type: 'order', host: 'www.ikea.com', title: 'IKEA purchases' },
    extras: [
      { source: 'amazon', type: 'order', host: 'www.amazon.com', title: 'Amazon building supplies' },
      { source: 'generic', type: 'order', host: 'supply.example', title: 'Building-supply orders' },
    ],
    titles: ['Interior paint 4L', 'Ceramic floor tile', 'Pine board 2m', 'Wall primer', 'Door hinge set'],
  },
];

const GIFT_CARDS = {
  amazon: {
    email: 'amazon-giftcards-overseas@datadance.io',
    name: 'Amazon gift card desk (overseas)',
    asset: 'AMAZON_GIFT_CARD',
    vendor: 'Amazon gift cards, purchased overseas',
    paymentNumber: 'PAY-RB-20260930-AMZN',
    reference: 'AMZN-GC-OS-20260930',
  },
  apple: {
    email: 'apple-giftcards-overseas@datadance.io',
    name: 'Apple gift card desk (overseas)',
    asset: 'APPLE_GIFT_CARD',
    vendor: 'Apple App Store and iTunes gift cards, purchased overseas',
    paymentNumber: 'PAY-RB-20260930-APPL',
    reference: 'APPL-GC-OS-20260930',
  },
};

function usd(cents) {
  return Math.round(cents) / 100;
}

function money(cents) {
  return usd(cents).toFixed(2);
}

function pickCents(table, serial, shift) {
  return table[(serial + shift) % table.length];
}

// Applied to every fourth record so a month moves without every line changing by the same amount.
const MONTH_NUDGE = [
  { sale: 0, data: 0, referral: 0 },
  { sale: 80, data: -20, referral: 0 },
  { sale: -60, data: 30, referral: 20 },
  { sale: 40, data: -30, referral: -20 },
  { sale: -40, data: 20, referral: 30 },
  { sale: 50, data: 0, referral: -20 },
];

function nudged(base, serial, delta, min, max) {
  if (!delta || serial % 4 !== 0) return base;
  return Math.min(max, Math.max(min, base + delta));
}

// Zero keeps a round dollar. The other values leave a few cents so totals are not all .00.
const ODD_CENTS = [0, 0, 7, 0, 13, 18, 0, 4, 27, 0, 9, 41, 0, 6, 22, 0, 15, 33, 0, 8];

function withCents(base, serial, shift, min, max) {
  const extra = ODD_CENTS[(serial + shift) % ODD_CENTS.length];
  return Math.min(max, Math.max(min, base + extra));
}

function placeRemainder(contributors, field, wantMod, min, max, onChange) {
  const total = contributors.reduce((sum, row) => sum + row[field], 0);
  const delta = (wantMod - (total % 100) + 100) % 100;
  if (delta === 0) return total;
  for (const change of [delta, delta - 100]) {
    if (change === 0) continue;
    const row = contributors.find((item) => {
      const next = item[field] + change;
      return next >= min && next <= max;
    });
    if (!row) continue;
    const previous = row[field];
    row[field] = previous + change;
    if (onChange) onChange(row, previous, row[field]);
    return total + change;
  }
  throw new Error(`could not place a cent remainder on ${field}`);
}

function pickNode(nodes, serial) {
  const weights = [6, 4, 5, 2, 3, 1].slice(0, nodes.length);
  const span = weights.reduce((sum, value) => sum + value, 0);
  let bucket = serial % span;
  for (let index = 0; index < weights.length; index += 1) {
    if (bucket < weights[index]) return nodes[index];
    bucket -= weights[index];
  }
  return nodes[0];
}

function extraCountFor(serial, monthIndex) {
  const roll = (serial + monthIndex * 3) % 10;
  const oneExtraUntil = [4, 2, 3, 5, 1, 3][monthIndex];
  const twoExtraUntil = [8, 7, 4, 9, 5, 8][monthIndex];
  if (roll < oneExtraUntil) return 1;
  if (roll < twoExtraUntil) return 2;
  return 3;
}

function placeMonthRemainder(orders, field, wantMod, min, max, onChange) {
  const total = orders.reduce((sum, order) => sum + order[field], 0);
  const delta = (wantMod - (total % 100) + 100) % 100;
  if (delta === 0) return total;
  const host = [...orders].reverse().find((order) => order.contributors.length > 0);
  const others = total - host[field];
  const hostWant = (wantMod - (others % 100) + 100) % 100;
  host[field] = placeRemainder(host.contributors, field, hostWant, min, max, onChange);
  return others + host[field];
}

function at(year, month, day, hour = 2) {
  return new Date(Date.UTC(year, month - 1, day, hour, 15, 0));
}

function pad(value, width) {
  return String(value).padStart(width, '0');
}

function amazonOrderId(serial) {
  const digits = String(serial).padStart(17, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3, 10)}-${digits.slice(10)}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function finishOrder(order) {
  order.revenue = usd(order.saleCents);
  order.dataCost = usd(order.dataCents);
  order.referralCost = usd(order.referralCents);
  order.margin = usd(order.saleCents - order.dataCents - order.referralCents);
}

function buildPlan() {
  const referrers = [];
  const referrerByIndustry = {};
  for (const industry of INDUSTRIES) {
    referrerByIndustry[industry.key] = [];
    for (let node = 1; node <= industry.nodes; node += 1) {
      const row = {
        id: crypto.randomUUID(),
        email: `rb26.node.${industry.key}.${node}${EMAIL_DOMAIN}`,
        name: `${industry.label} referral node ${node}`,
        industryKey: industry.key,
        node,
        inviteeCount: 0,
        points: 0,
      };
      referrers.push(row);
      referrerByIndustry[industry.key].push(row);
    }
  }

  const months = [];
  let serial = 0;
  MONTHS.forEach((month, monthIndex) => {
    const seen = {};
    const orders = month.orders.map((spec) => {
      const industry = INDUSTRIES[spec.industry];
      seen[industry.key] = (seen[industry.key] || 0) + 1;
      const suffix = seen[industry.key] === 1 ? industry.code : `${industry.code}-${seen[industry.key]}`;
      const contributors = [];
      let saleCents = 0;
      let dataCents = 0;
      let referralCents = 0;
      let extraRecords = 0;
      for (let i = 0; i < spec.count; i += 1) {
        const shift = monthIndex * 3 + seen[industry.key];
        const nudge = MONTH_NUDGE[monthIndex];
        const sale = withCents(nudged(pickCents(SALE_CENTS, serial, shift), serial, nudge.sale, 600, 1800), serial, 1, 600, 1800);
        const data = withCents(nudged(pickCents(DATA_CENTS, serial, shift + 1), serial, nudge.data, 300, 500), serial, 4, 300, 500);
        const referral = withCents(nudged(pickCents(REFERRAL_CENTS, serial, shift + 2), serial, nudge.referral, 200, 400), serial, 7, 200, 400);
        const node = pickNode(referrerByIndustry[industry.key], serial);
        const extraCount = extraCountFor(serial, monthIndex);
        node.inviteeCount += 1;
        node.points += referral;
        const localIndex = i + 1;
        contributors.push({
          id: crypto.randomUUID(),
          email: `rb26.${industry.key}.${month.key}.${suffix.toLowerCase()}.${pad(localIndex, 5)}${EMAIL_DOMAIN}`,
          name: `${industry.label} contributor ${suffix} ${pad(localIndex, 5)}`,
          industryKey: industry.key,
          monthKey: month.key,
          year: month.year,
          month: month.month,
          serial,
          localIndex,
          extraCount,
          saleCents: sale,
          dataCents: data,
          referralCents: referral,
          dataUsd: usd(data),
          referralUsd: usd(referral),
          points: data,
          referrerId: node.id,
          referrerEmail: node.email,
          day: 2 + ((serial * 7 + spec.opened) % 26),
        });
        saleCents += sale;
        dataCents += data;
        referralCents += referral;
        extraRecords += extraCount;
        serial += 1;
      }
      const order = {
        ...industry,
        suffix,
        count: spec.count,
        opened: spec.opened,
        paid: spec.paid,
        saleCents,
        dataCents,
        referralCents,
        extraRecords,
        contributors,
      };
      finishOrder(order);
      return order;
    });

    const cents = MONTH_CENTS[monthIndex];
    const saleCents = placeMonthRemainder(orders, 'saleCents', cents.sale, 600, 1800);
    const dataCents = placeMonthRemainder(orders, 'dataCents', cents.data, 300, 500, (row) => {
      row.points = row.dataCents;
      row.dataUsd = usd(row.dataCents);
    });
    const referralCents = placeMonthRemainder(orders, 'referralCents', cents.referral, 200, 400, (row, previous, next) => {
      const node = referrerByIndustry[row.industryKey].find((item) => item.id === row.referrerId);
      node.points += next - previous;
      row.referralUsd = usd(next);
    });
    for (const order of orders) finishOrder(order);

    const revenue = usd(saleCents);
    const units = orders.reduce((sum, order) => sum + order.count, 0);
    const guideGap = Math.abs(revenue - month.guide) / month.guide;
    if (guideGap > 0.08) {
      throw new Error(`${month.key} revenue ${revenue} is too far from ${month.guide}`);
    }
    const marginPct = (saleCents - dataCents - referralCents) / saleCents;
    if (marginPct < 0.17 || marginPct > 0.28) {
      throw new Error(`${month.key} margin ${(marginPct * 100).toFixed(1)}% is outside 17–28%`);
    }
    months.push({
      ...month,
      units,
      extraRecords: orders.reduce((sum, order) => sum + order.extraRecords, 0),
      saleCents,
      dataCents,
      referralCents,
      revenue,
      dataCost: usd(dataCents),
      referralCost: usd(referralCents),
      margin: usd(saleCents - dataCents - referralCents),
      orders,
    });
  });

  const orderCounts = months.map((month) => month.orders.length);
  if (new Set(orderCounts).size !== months.length) {
    throw new Error(`purchase-order counts repeat: ${orderCounts.join(', ')}`);
  }
  if (months.some((month) => month.units % 100 === 0)) {
    throw new Error('a month still has a round hundred of valid records');
  }
  for (const field of ['saleCents', 'dataCents', 'referralCents']) {
    const mods = months.map((month) => month[field] % 100);
    if (mods.some((mod) => mod === 0) || new Set(mods).size !== mods.length) {
      throw new Error(`${field} endings repeat or land on .00: ${mods.join(', ')}`);
    }
  }
  for (const node of referrers) {
    if (node.inviteeCount < 1) throw new Error(`${node.email} never referred anyone`);
  }
  const people = months.reduce((sum, month) => sum + month.units, 0);
  const extras = months.reduce((sum, month) => sum + month.extraRecords, 0);
  if (extras % people === 0) throw new Error('other records are an even multiple of contributors');
  const margins = months.map((month) => ((month.margin / month.revenue) * 100).toFixed(1));
  if (new Set(margins).size < 4) throw new Error('monthly margins are too uniform');

  // A "-2" order is a further authorization of a category already collected.
  // The contributor is paid. The referral node is not paid a second time.
  for (const month of months) {
    for (const order of month.orders) {
      if (!String(order.suffix).endsWith('-2')) continue;
      order.licence = 'reauthorization';
      for (const row of order.contributors) {
        const node = referrerByIndustry[row.industryKey].find((item) => item.id === row.referrerId);
        node.points -= row.referralCents;
        row.referralCents = 0;
        row.referralUsd = 0;
      }
      order.referralCents = 0;
      finishOrder(order);
      const pct = order.margin / order.revenue;
      if (pct < 0.5 || pct > 0.7) {
        throw new Error(`${month.key} ${order.suffix} reauthorization margin ${(pct * 100).toFixed(1)}% is outside 50–70%`);
      }
    }
    month.referralCents = month.orders.reduce((sum, order) => sum + order.referralCents, 0);
    month.saleCents = month.orders.reduce((sum, order) => sum + order.saleCents, 0);
    month.dataCents = month.orders.reduce((sum, order) => sum + order.dataCents, 0);
    month.revenue = usd(month.saleCents);
    month.dataCost = usd(month.dataCents);
    month.referralCost = usd(month.referralCents);
    month.margin = usd(month.saleCents - month.dataCents - month.referralCents);
  }

  const giftCards = assertGiftCardBatch();
  return { referrers, months, giftCards, serial };
}

function printPlan(plan) {
  console.log('Revenue book 2026 (existing test data is left in place)');
  console.log('month        orders   guide     revenue   records    other   data_cost   referral    margin  margin_%');
  for (const month of plan.months) {
    const pct = ((month.margin / month.revenue) * 100).toFixed(1);
    console.log(
      `${month.key}  ${String(month.orders.length).padStart(4)}  ${money(month.guide * 100).padStart(10)}  ${money(month.saleCents).padStart(10)}  ${String(month.units).padStart(7)}  ${String(month.extraRecords).padStart(7)}  ${money(month.dataCents).padStart(10)}  ${money(month.referralCents).padStart(9)}  ${money(month.saleCents - month.dataCents - month.referralCents).padStart(8)}  ${pct}%`,
    );
    for (const order of month.orders) {
      console.log(`           ${order.suffix.padEnd(8)} $${money(order.saleCents)}   data $${money(order.dataCents)}   referral $${money(order.referralCents)}   records ${order.count}`);
    }
  }
  for (const purchase of GIFT_CARD_PURCHASES) {
    const lines = purchase.lines.map((line) => `${line.brand} $${line.face} x ${line.qty}`).join(', ');
    console.log(`Gift card ${purchase.reference} $${purchaseTotal(purchase)}  ${lines}`);
  }
  const nodeLine = INDUSTRIES.map((industry) => {
    const nodes = plan.referrers.filter((row) => row.industryKey === industry.key);
    const invites = nodes.map((row) => row.inviteeCount).sort((left, right) => left - right);
    return `${industry.code} ${nodes.length} nodes (${invites[0]}-${invites[invites.length - 1]} invitees)`;
  }).join('; ');
  console.log(`Contributors ${plan.serial}  referral nodes ${plan.referrers.length}`);
  console.log(nodeLine);
}

function channelPayload(channel, sourceId, title, shopPrice, day, monthKey) {
  const date = `${monthKey}-${pad(day, 2)}`;
  const price = shopPrice.toFixed(2);
  if (channel.source === 'amazon') {
    return { orderId: sourceId, title, price, currency: 'USD', orderDate: date };
  }
  if (channel.source === 'booking') {
    return { bookingId: sourceId, hotelName: title, title, price, currency: 'USD', checkIn: date };
  }
  if (channel.source === 'airbnb') {
    return { tripId: sourceId, listingTitle: title, title, price, currency: 'USD', startDate: date };
  }
  return { orderId: sourceId, title, price, currency: 'USD', date };
}

function contributorRecords(contributor, industry) {
  const channels = [industry.valid];
  for (let extra = 0; extra < contributor.extraCount; extra += 1) {
    channels.push(industry.extras[extra % industry.extras.length]);
  }
  return channels.map((channel, index) => {
    const billable = index === 0;
    const day = Math.min(28, Math.max(2, contributor.day + index - 1));
    const sourceId = channel.source === 'amazon'
      ? amazonOrderId(contributor.serial * 4 + index + 1)
      : `RB26-${contributor.serial}-${index}`;
    const title = industry.titles[(contributor.serial + index) % industry.titles.length];
    const shopPrice = usd(pickCents(SHOP_CENTS, contributor.serial, index));
    const when = at(contributor.year, contributor.month, day, billable ? 4 : 1);
    const metadata = {
      revenueBook: '2026',
      billable,
      industry: industry.key,
      host: channel.host,
      cleaned: true,
    };
    if (!billable) {
      metadata.importSource = 'data-pack';
      metadata.importBatch = 'revenue-book-2026';
    }
    return {
      id: crypto.randomUUID(),
      taskId: crypto.randomUUID(),
      source: channel.source,
      type: channel.type,
      taskTitle: channel.title,
      sourceId,
      payload: channelPayload(channel, sourceId, title, shopPrice, day, contributor.monthKey),
      metadata,
      when,
      billable,
    };
  });
}

function priceLines(industry, monthLabel) {
  const groups = new Map();
  for (const row of industry.contributors) {
    const group = groups.get(row.saleCents) || { cents: row.saleCents, count: 0 };
    group.count += 1;
    groups.set(row.saleCents, group);
  }
  return [...groups.values()]
    .sort((left, right) => left.cents - right.cents)
    .map((group) => ({
      description: `${industry.label} valid records at $${money(group.cents)}, ${monthLabel}`,
      category: 'dataset',
      quantity: group.count,
      unit: 'records',
      unitPrice: usd(group.cents),
      total: usd(group.cents * group.count),
    }));
}

async function inChunks(items, size, worker) {
  for (let offset = 0; offset < items.length; offset += size) {
    await worker(items.slice(offset, offset + size), offset);
  }
}

async function clearPrevious(prisma) {
  const likeTag = `%${SEED_TAG}%`;
  const likeEmail = `%${EMAIL_DOMAIN}`;
  await prisma.$executeRaw`
    DELETE FROM "OrganizationTransaction"
    WHERE id IN (
      SELECT "organizationTransactionId" FROM "Payment"
      WHERE notes LIKE ${likeTag}
         OR "orderId" IN (SELECT id FROM "PurchaseOrder" WHERE notes LIKE ${likeTag})
    )
  `;
  await prisma.$executeRaw`
    DELETE FROM "Payment"
    WHERE notes LIKE ${likeTag}
       OR "orderId" IN (SELECT id FROM "PurchaseOrder" WHERE notes LIKE ${likeTag})
  `;
  await prisma.$executeRaw`
    DELETE FROM "InvoiceLineItem"
    WHERE "invoiceId" IN (
      SELECT id FROM "Invoice"
      WHERE "orderId" IN (SELECT id FROM "PurchaseOrder" WHERE notes LIKE ${likeTag})
    )
  `;
  await prisma.$executeRaw`
    DELETE FROM "Invoice"
    WHERE "orderId" IN (SELECT id FROM "PurchaseOrder" WHERE notes LIKE ${likeTag})
  `;
  const orders = await prisma.$executeRaw`
    DELETE FROM "PurchaseOrder" WHERE notes LIKE ${likeTag}
  `;
  await prisma.$executeRaw`
    DELETE FROM "Point"
    WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE ${likeEmail})
  `;
  await prisma.$executeRaw`
    DELETE FROM "CrawlerData"
    WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE ${likeEmail})
  `;
  await prisma.$executeRaw`
    DELETE FROM "CrawlerTask"
    WHERE "userId" IN (SELECT id FROM "User" WHERE email LIKE ${likeEmail})
  `;
  await prisma.$executeRaw`
    DELETE FROM "Referral"
    WHERE "inviteeId" IN (SELECT id FROM "User" WHERE email LIKE ${likeEmail})
       OR "inviterId" IN (SELECT id FROM "User" WHERE email LIKE ${likeEmail})
  `;
  const accounts = await prisma.$executeRaw`
    DELETE FROM "User" WHERE email LIKE ${likeEmail}
  `;
  console.log(`Cleared previous revenue book: ${orders} orders, ${accounts} accounts`);
}

function partySnapshot(entity, user) {
  if (entity) {
    return {
      userId: user.id,
      companyName: entity.companyName,
      taxId: entity.taxId || '',
      address: entity.address || '',
      country: entity.country || '',
      email: entity.email || user.email,
      bankName: entity.bankName || '',
      bankAccount: entity.bankAccount || '',
      currency: entity.currency || 'USD',
    };
  }
  return {
    userId: user.id,
    companyName: user.name || user.email,
    taxId: '',
    address: '',
    country: '',
    email: user.email,
    bankName: '',
    bankAccount: '',
    currency: 'USD',
  };
}

function referralCode() {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(6);
  let code = '';
  for (let i = 0; i < 6; i += 1) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

async function ensureDesk(prisma, desk, passwordHash) {
  const existing = await prisma.user.findUnique({ where: { email: desk.email } });
  if (existing) return existing;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.user.create({
        data: {
          email: desk.email,
          name: desk.name,
          description: `${SEED_TAG} Test settlement desk for overseas gift-card purchases. Not the card issuer.`,
          password: passwordHash,
          authType: 'traditional',
          userType: 'organization',
          isOrganization: true,
          referralCode: referralCode(),
          profile: { create: { language: 'en' } },
        },
      });
    } catch (error) {
      if (attempt === 4 || !String(error.message || '').includes('referralCode')) throw error;
    }
  }
  throw new Error(`could not create ${desk.email}`);
}

async function freshCodes(prisma, count) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const codes = new Set();
  while (codes.size < count + 2000) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i += 1) code += alphabet[bytes[i] % alphabet.length];
    codes.add(code);
  }
  const list = [...codes];
  const taken = new Set();
  await inChunks(list, 5000, async (chunk) => {
    const rows = await prisma.user.findMany({
      where: { referralCode: { in: chunk } },
      select: { referralCode: true },
    });
    for (const row of rows) taken.add(row.referralCode);
  });
  const free = list.filter((code) => !taken.has(code));
  if (free.length < count) throw new Error('could not reserve enough referral codes');
  return free.slice(0, count);
}

async function main() {
  const plan = buildPlan();
  const dryRun = process.argv.includes('--dry-run');
  printPlan(plan);
  if (dryRun) return;

  const { PrismaClient } = require('/app/node_modules/@prisma/client');
  const bcrypt = require('/app/node_modules/bcryptjs');
  const prisma = new PrismaClient();
  const password = `rb-${crypto.randomBytes(6).toString('base64url')}`;
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    await clearPrevious(prisma);
    const [buyer, seller] = await Promise.all([
      prisma.user.findUnique({ where: { email: BUYER_EMAIL } }),
      prisma.user.findUnique({ where: { email: SELLER_EMAIL } }),
    ]);
    if (!buyer) throw new Error(`${BUYER_EMAIL} is missing`);
    if (!seller) throw new Error(`${SELLER_EMAIL} is missing`);
    const [buyerEntity, sellerEntity] = await Promise.all([
      prisma.legalEntity.findUnique({ where: { userId: buyer.id } }),
      prisma.legalEntity.findUnique({ where: { userId: seller.id } }),
    ]);
    const buyerSnap = partySnapshot(buyerEntity, buyer);
    const sellerSnap = partySnapshot(sellerEntity, seller);
    const amazonDesk = await ensureDesk(prisma, GIFT_CARDS.amazon, passwordHash);
    const appleDesk = await ensureDesk(prisma, GIFT_CARDS.apple, passwordHash);
    const desks = { amazon: amazonDesk, apple: appleDesk };

    const codes = await freshCodes(prisma, plan.referrers.length + plan.serial);
    let codeIndex = 0;
    for (const row of plan.referrers) row.code = codes[codeIndex++];
    for (const month of plan.months) {
      for (const order of month.orders) {
        for (const contributor of order.contributors) contributor.code = codes[codeIndex++];
      }
    }

    const opened = at(2026, 4, 1, 1);
    await inChunks(plan.referrers, 500, async (rows) => {
      await prisma.user.createMany({
        data: rows.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          description: `${SEED_TAG} Referral node for ${row.industryKey}. Share is about $3 per valid record, with some even amounts and some with cents.`,
          password: passwordHash,
          authType: 'traditional',
          userType: 'regular',
          isOrganization: false,
          referralCode: row.code,
          totalPoints: row.points,
          createdAt: opened,
          updatedAt: opened,
        })),
      });
    });
    console.log(`Referral nodes ${plan.referrers.length}`);

    const contributors = plan.months.flatMap((month) => month.orders.flatMap((order) => order.contributors));
    await inChunks(contributors, 1000, async (rows, offset) => {
      await prisma.user.createMany({
        data: rows.map((row) => ({
          id: row.id,
          email: row.email,
          name: row.name,
          description: `${SEED_TAG} ${row.industryKey} contributor. One billable upload at $${row.dataUsd}, plus ${row.extraCount} other record${row.extraCount === 1 ? '' : 's'}.`,
          password: passwordHash,
          authType: 'traditional',
          userType: 'regular',
          isOrganization: false,
          referralCode: row.code,
          totalPoints: row.points,
          createdAt: at(row.year, row.month, 1, 1),
          updatedAt: at(row.year, row.month, 1, 1),
        })),
      });
      if (offset % 5000 === 0) console.log(`  contributors ${offset + rows.length}/${contributors.length}`);
    });

    await inChunks(contributors, 2000, async (rows) => {
      await prisma.referral.createMany({
        data: rows.map((row) => ({
          id: crypto.randomUUID(),
          inviterId: row.referrerId,
          inviteeId: row.id,
          code: plan.referrers.find((node) => node.id === row.referrerId).code,
          createdAt: at(row.year, row.month, 1, 2),
          updatedAt: at(row.year, row.month, 1, 2),
        })),
      });
    });
    console.log(`Referrals ${contributors.length}`);

    const referrerById = new Map(plan.referrers.map((row) => [row.id, row]));
    let recordBatches = 0;
    await inChunks(contributors, 400, async (rows) => {
      const tasks = [];
      const records = [];
      const points = [];
      for (const contributor of rows) {
        const industry = INDUSTRIES.find((item) => item.key === contributor.industryKey);
        const uploads = contributorRecords(contributor, industry);
        for (const upload of uploads) {
          tasks.push({
            id: upload.taskId,
            taskId: `${upload.source}_orders`,
            title: upload.taskTitle,
            description: `${SEED_TAG} ${upload.billable ? 'Billable' : 'Additional'} ${upload.source} record`,
            source: upload.source,
            status: 'completed',
            recordCount: 1,
            userId: contributor.id,
            createdAt: upload.when,
            updatedAt: upload.when,
          });
          records.push({
            id: upload.id,
            source: upload.source,
            type: upload.type,
            timestamp: upload.when,
            metadata: upload.metadata,
            payload: upload.payload,
            taskId: upload.taskId,
            userId: contributor.id,
            contentHash: sha256(upload.id),
            sourceId: upload.sourceId,
            createdAt: upload.when,
            updatedAt: upload.when,
          });
        }
        const billable = uploads[0];
        points.push({
          id: crypto.randomUUID(),
          userId: contributor.id,
          amount: contributor.points,
          source: 'revenue_book_data',
          sourceId: billable.id,
          createdAt: billable.when,
          updatedAt: billable.when,
        });
        if (contributor.referralCents > 0) {
          points.push({
            id: crypto.randomUUID(),
            userId: contributor.referrerId,
            amount: contributor.referralCents,
            source: 'revenue_book_referral',
            sourceId: contributor.id,
            createdAt: billable.when,
            updatedAt: billable.when,
          });
        }
      }
      await prisma.crawlerTask.createMany({ data: tasks });
      await prisma.crawlerData.createMany({ data: records });
      await prisma.point.createMany({ data: points });
      recordBatches += rows.length;
      if (recordBatches % 4000 === 0 || recordBatches === contributors.length) {
        console.log(`  uploads ${recordBatches}/${contributors.length}`);
      }
    });

    const septemberPaidAt = at(2026, 9, 30, 2);
    for (const month of plan.months) {
      for (const order of month.orders) {
        const createdAt = at(month.year, month.month, order.opened, 2 + (order.opened % 5));
        const paidAt = at(month.year, month.month, order.paid, 3 + (order.paid % 4));
        const orderId = crypto.randomUUID();
        const invoiceId = crypto.randomUUID();
        const orderNumber = `PO-RB-${month.key.replace('-', '')}-${order.suffix}`;
        const lines = priceLines(order, month.label);
        const note = order.licence === 'reauthorization'
          ? `${SEED_TAG} Reauthorization of already collected data on PO-RB-${month.key.replace('-', '')}-${order.suffix}. Contributor reward $${money(order.dataCents)}. No second referral payment. Gross profit $${money(order.margin)}, margin ${((order.margin / order.revenue) * 100).toFixed(1)}%.`
          : `${SEED_TAG} ${month.label} ${order.label} ${order.suffix}: ${order.count} valid records, mixed prices, total $${money(order.saleCents)}. Data $${money(order.dataCents)}, referral $${money(order.referralCents)}, gross profit $${money(order.saleCents - order.dataCents - order.referralCents)}.`;
        await prisma.purchaseOrder.create({
          data: {
            id: orderId,
            orderNumber,
            buyerId: buyer.id,
            sellerId: seller.id,
            status: 'paid',
            currency: 'USD',
            subtotal: order.revenue,
            taxAmount: 0,
            total: order.revenue,
            paymentTerms: 'Due on receipt',
            notes: note,
            contractStatus: 'none',
            pointsUnitPriceUsd: POINTS_USD,
            serviceFeeAmount: order.margin,
            createdAt,
            updatedAt: paidAt,
            // Local checksum only. scripts/attestRevenueBookOrders.js replaces this
            // with the canonical procurement receipt and a real CommerceAttester tx.
            attestedAt: paidAt,
            attestationHash: sha256(`${orderNumber}|${order.revenue}|${order.count}`),
            attestationPayload: {
              type: 'datadance.procurement.metadata.v1',
              orderNumber,
              currency: 'USD',
              total: order.revenue,
              validRecords: order.count,
              dataCostUsd: order.dataCost,
              referralCostUsd: order.referralCost,
              grossProfitUsd: order.margin,
              datasetBytesExcluded: true,
              note: 'Order metadata only. Upload payloads are not written on chain.',
            },
            lineItems: { create: lines },
          },
        });
        await prisma.invoice.create({
          data: {
            id: invoiceId,
            invoiceNumber: `INV-RB-${month.key.replace('-', '')}-${order.suffix}`,
            orderId,
            buyerId: buyer.id,
            sellerId: seller.id,
            status: 'paid',
            currency: 'USD',
            subtotal: order.revenue,
            taxAmount: 0,
            total: order.revenue,
            paymentTerms: 'Due on receipt',
            issueDate: createdAt,
            dueDate: paidAt,
            paidAt,
            sellerSnapshot: sellerSnap,
            buyerSnapshot: buyerSnap,
            createdAt,
            updatedAt: paidAt,
            lineItems: { create: lines },
          },
        });
        const ledger = await prisma.organizationTransaction.create({
          data: {
            amount: order.revenue,
            type: 'WITHDRAW',
            status: 'COMPLETED',
            description: `${SEED_TAG} ${orderNumber}`,
            userId: buyer.id,
            metadata: { source: 'revenue_book_2026', orderNumber },
            createdAt: paidAt,
            updatedAt: paidAt,
          },
        });
        await prisma.payment.create({
          data: {
            paymentNumber: `PAY-RB-${month.key.replace('-', '')}-${order.suffix}`,
            orderId,
            invoiceId,
            payerId: buyer.id,
            payeeId: seller.id,
            amount: order.revenue,
            currency: 'USD',
            method: 'bank_transfer',
            status: 'confirmed',
            matchStatus: 'matched',
            paidAt,
            reference: `TT-${month.key.replace('-', '')}-${order.suffix}`,
            notes: `${SEED_TAG} Paid ${orderNumber}`,
            organizationTransactionId: ledger.id,
            createdAt: paidAt,
            updatedAt: paidAt,
          },
        });

        const allocations = order.contributors.map((row) => ({
          id: crypto.randomUUID(),
          orderId,
          kind: 'user',
          email: row.email,
          emailNormalized: row.email,
          displayName: row.name,
          role: 'data_contributor',
          points: row.points,
          userId: row.id,
          claimStatus: 'claimable',
          note: `${SEED_TAG} Valid record priced at $${money(row.saleCents)}, data cost $${money(row.dataCents)}`,
          createdAt,
          updatedAt: createdAt,
        }));
        const nodeReferral = new Map();
        for (const row of order.contributors) {
          const current = nodeReferral.get(row.referrerId) || { count: 0, cents: 0 };
          current.count += 1;
          current.cents += row.referralCents;
          nodeReferral.set(row.referrerId, current);
        }
        for (const [referrerId, share] of nodeReferral) {
          if (share.cents <= 0) continue;
          const node = referrerById.get(referrerId);
          allocations.push({
            id: crypto.randomUUID(),
            orderId,
            kind: 'referral',
            email: node.email,
            emailNormalized: node.email,
            displayName: node.name,
            role: 'referrer',
            points: share.cents,
            userId: node.id,
            claimStatus: 'claimable',
            note: `${SEED_TAG} Referral share $${money(share.cents)} across ${share.count} records`,
            createdAt,
            updatedAt: createdAt,
          });
        }
        await inChunks(allocations, 1000, async (chunk) => {
          await prisma.procurementAllocation.createMany({ data: chunk });
        });

        const costItems = [
          {
            orderId,
            kind: 'points_issue',
            description: `${SEED_TAG} Contributor points for ${order.count} valid ${order.label} records`,
            points: order.dataCents,
            unitPriceUsd: POINTS_USD,
            amountUsd: order.dataCost,
            sourceType: 'allocation',
            sourceId: `${orderNumber}-users`,
            createdAt,
            updatedAt: createdAt,
          },
        ];
        if (order.referralCents > 0) {
          costItems.push({
            orderId,
            kind: 'points_issue',
            description: `${SEED_TAG} Referral-node points, about $3 per valid record, mixed amounts`,
            points: order.referralCents,
            unitPriceUsd: POINTS_USD,
            amountUsd: order.referralCost,
            sourceType: 'allocation',
            sourceId: `${orderNumber}-referral`,
            createdAt,
            updatedAt: createdAt,
          });
        }
        await prisma.procurementCostItem.createMany({ data: costItems });
        for (const row of order.contributors) row.orderId = orderId;
        console.log(`  ${orderNumber}  $${order.revenue}  margin $${order.margin}`);
      }
    }

    const redeemPool = plan.months
      .flatMap((month) => month.orders.flatMap((order) => order.contributors))
      .filter((row) => row.points === 500)
      .sort((left, right) => left.email.localeCompare(right.email))
      .slice(0, plan.giftCards.slots.length);
    if (redeemPool.length !== plan.giftCards.slots.length) {
      throw new Error(`need ${plan.giftCards.slots.length} contributors at $5.00, found ${redeemPool.length}`);
    }
    const redemptions = plan.giftCards.slots.map((slot, index) => {
      const person = redeemPool[index];
      const brand = slot.brand === 'apple' ? 'Apple' : 'Amazon';
      return {
        id: crypto.randomUUID(),
        orderId: person.orderId,
        createdById: seller.id,
        email: person.email,
        emailNormalized: person.email,
        userId: person.id,
        points: 500,
        asset: slot.brand === 'apple' ? 'APPLE_GIFT_CARD' : 'AMAZON_GIFT_CARD',
        amount: 5,
        vendor: brand,
        vendorReference: slot.reference,
        status: 'paid',
        paidAt: septemberPaidAt,
        notes: `${SEED_TAG} ${GIFT_CARD_BATCH} Redeemed 500 points ($5.00) toward ${brand} $${slot.face} gift card ${slot.index} of ${slot.qty} on Amazon order ${slot.reference}.`,
        createdAt: septemberPaidAt,
        updatedAt: septemberPaidAt,
      };
    });
    await inChunks(redemptions, 400, async (chunk) => {
      await prisma.pointsRedemption.createMany({ data: chunk });
    });
    for (const purchase of GIFT_CARD_PURCHASES) {
      const amount = purchaseTotal(purchase);
      const lines = purchase.lines
        .map((line) => `${line.brand === 'apple' ? 'Apple' : 'Amazon'} $${line.face} x ${line.qty}`)
        .join('; ');
      const ledger = await prisma.organizationTransaction.create({
        data: {
          amount,
          type: 'WITHDRAW',
          status: 'COMPLETED',
          description: `${SEED_TAG} Gift cards on Amazon order ${purchase.reference}`,
          userId: seller.id,
          metadata: { source: 'revenue_book_2026', batch: GIFT_CARD_BATCH, reference: purchase.reference, lines },
          createdAt: septemberPaidAt,
          updatedAt: septemberPaidAt,
        },
      });
      await prisma.payment.create({
        data: {
          paymentNumber: `PAY-RB-GC-${purchase.reference}`,
          payerId: seller.id,
          payeeId: desks.amazon.id,
          amount,
          currency: 'USD',
          method: 'gift_card',
          status: 'confirmed',
          matchStatus: 'matched',
          paidAt: septemberPaidAt,
          reference: purchase.reference,
          notes: `${SEED_TAG} ${GIFT_CARD_BATCH} Amazon order ${purchase.reference}: ${lines}. Total $${amount}. Redeems issued points. Not a second cost.`,
          organizationTransactionId: ledger.id,
          createdAt: septemberPaidAt,
          updatedAt: septemberPaidAt,
        },
      });
    }

    const [bookUsers, validRows, extraRows, bookOrders] = await Promise.all([
      prisma.user.count({ where: { email: { endsWith: EMAIL_DOMAIN } } }),
      prisma.crawlerData.count({
        where: {
          user: { email: { endsWith: EMAIL_DOMAIN } },
          NOT: { metadata: { path: ['importSource'], equals: 'data-pack' } },
        },
      }),
      prisma.crawlerData.count({
        where: {
          user: { email: { endsWith: EMAIL_DOMAIN } },
          metadata: { path: ['importSource'], equals: 'data-pack' },
        },
      }),
      prisma.purchaseOrder.aggregate({
        where: { notes: { contains: SEED_TAG } },
        _sum: { total: true, serviceFeeAmount: true },
        _count: true,
      }),
    ]);
    console.log('Revenue book written');
    console.log(`  accounts ${bookUsers} (includes ${plan.referrers.length} referral nodes)`);
    console.log(`  billable uploads ${validRows}  other uploads ${extraRows}`);
    console.log(`  orders ${bookOrders._count}  revenue $${bookOrders._sum.total}  gross profit $${bookOrders._sum.serviceFeeAmount}`);
    console.log(`  password for new @book.datadance.test accounts and gift-card desks created this run: ${password}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
