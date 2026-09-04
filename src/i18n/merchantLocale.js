const LOCALES = ['en', 'zh', 'zh-TW', 'ja'];

function resolveLocale(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'en';
  const first = raw.split(',')[0].split(';')[0].trim();
  const lower = first.toLowerCase();
  if (lower === 'zh-tw' || lower === 'zh-hant' || lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant')) {
    return 'zh-TW';
  }
  if (lower === 'zh' || lower.startsWith('zh-cn') || lower.startsWith('zh-sg') || lower.startsWith('zh-hans')) {
    return 'zh';
  }
  if (lower.startsWith('ja')) return 'ja';
  if (LOCALES.includes(first)) return first;
  return 'en';
}

const LABELS = {
  en: {
    'order-id': 'Order ID',
    email: 'Email',
    'buyer-email': 'Buyer email',
    name: 'Name',
    title: 'Product',
    product: 'Product',
    phone: 'Phone',
    'ship-address': 'Shipping address',
    address: 'Address',
    'ship-city': 'City',
    city: 'City',
    'ship-state': 'State / region',
    state: 'State / region',
    'ship-postal-code': 'Postal code',
    'postal-code': 'Postal code',
    'ship-country': 'Country',
    country: 'Country',
    quantity: 'Quantity',
    price: 'Price',
    sku: 'SKU',
    recordId: 'Record ID',
    source: 'Source',
  },
  zh: {
    'order-id': '订单号',
    email: '邮箱',
    'buyer-email': '买家邮箱',
    name: '姓名',
    title: '商品',
    product: '商品',
    phone: '电话',
    'ship-address': '收件地址',
    address: '地址',
    'ship-city': '城市',
    city: '城市',
    'ship-state': '州 / 省',
    state: '州 / 省',
    'ship-postal-code': '邮编',
    'postal-code': '邮编',
    'ship-country': '国家 / 地区',
    country: '国家 / 地区',
    quantity: '数量',
    price: '价格',
    sku: 'SKU',
    recordId: '记录编号',
    source: '来源',
  },
  'zh-TW': {
    'order-id': '訂單編號',
    email: '電郵',
    'buyer-email': '買家電郵',
    name: '姓名',
    title: '商品',
    product: '商品',
    phone: '電話',
    'ship-address': '收件地址',
    address: '地址',
    'ship-city': '城市',
    city: '城市',
    'ship-state': '州 / 省',
    state: '州 / 省',
    'ship-postal-code': '郵遞區號',
    'postal-code': '郵遞區號',
    'ship-country': '國家 / 地區',
    country: '國家 / 地區',
    quantity: '數量',
    price: '價格',
    sku: 'SKU',
    recordId: '記錄編號',
    source: '來源',
  },
  ja: {
    'order-id': '注文番号',
    email: 'メール',
    'buyer-email': '購入者メール',
    name: '氏名',
    title: '商品',
    product: '商品',
    phone: '電話番号',
    'ship-address': '配送先住所',
    address: '住所',
    'ship-city': '市区町村',
    city: '市区町村',
    'ship-state': '都道府県',
    state: '都道府県',
    'ship-postal-code': '郵便番号',
    'postal-code': '郵便番号',
    'ship-country': '国 / 地域',
    country: '国 / 地域',
    quantity: '数量',
    price: '価格',
    sku: 'SKU',
    recordId: 'レコードID',
    source: 'ソース',
  },
};

const ALIASES = {
  'order-id': ['order-id', 'order_id', 'orderid', 'order id', '订单号', '訂單編號', '注文番号'],
  email: ['email', 'e-mail', 'mail', '邮箱', '电子邮箱', '電子郵件', '電郵', 'メール'],
  'buyer-email': ['buyer-email', 'buyer_email', 'buyeremail', 'buyer email'],
  name: ['name', 'full_name', 'fullname', 'customer_name', 'buyer_name', '姓名', '名称', '名前', '氏名'],
  title: ['title', 'product_name', 'item', '商品名称', '商品名', '商品'],
  product: ['product'],
  phone: ['phone', 'mobile', 'tel', 'telephone', 'phone_number', '手机', '电话', '電話', '電話番号'],
  'ship-address': ['ship-address', 'ship_address', 'shipping_address', '收件地址', '配送先住所'],
  address: ['address', '地址', '住所'],
  'ship-city': ['ship-city', 'ship_city', 'shipping_city'],
  city: ['city', '城市', '市区町村'],
  'ship-state': ['ship-state', 'ship_state', 'shipping_state'],
  state: ['state', 'region', 'province', '州', '省', '都道府県'],
  'ship-postal-code': ['ship-postal-code', 'ship_postal_code', 'shipping_postal_code'],
  'postal-code': ['postal-code', 'postal_code', 'zip', 'zipcode', '邮编', '郵遞區號', '郵便番号'],
  'ship-country': ['ship-country', 'ship_country', 'shipping_country'],
  country: ['country', '国家', '國家', '国'],
  quantity: ['quantity', 'qty', '数量', '數量'],
  price: ['price', 'amount', '价格', '價格', '価格'],
  sku: ['sku', 'asin'],
  recordId: ['recordid', 'record_id', 'record-id', '记录编号', '記錄編號', 'レコードid'],
  source: ['source', '来源', '來源', 'ソース'],
};

const ALIAS_TO_KEY = {};
for (const [key, aliases] of Object.entries(ALIASES)) {
  for (const alias of aliases) {
    ALIAS_TO_KEY[alias.toLowerCase()] = key;
  }
  ALIAS_TO_KEY[key.toLowerCase()] = key;
}

function canonicalKey(header) {
  const raw = String(header || '').trim();
  if (!raw) return '';
  return ALIAS_TO_KEY[raw.toLowerCase()] || raw;
}

function localizeHeader(header, locale) {
  const key = canonicalKey(header);
  const table = LABELS[locale] || LABELS.en;
  if (table[key]) return table[key];
  if (LABELS.en[key]) return LABELS.en[key];
  return String(header);
}

function localizeHeaders(headers, locale) {
  const used = new Set();
  return (headers || []).map((header) => {
    let label = localizeHeader(header, locale);
    if (used.has(label)) label = `${label} (${header})`;
    used.add(label);
    return label;
  });
}

const LICENCE_TERMS = {
  en: [
    'Use is limited to analysis and product research.',
    'Direct marketing to people in the pack is not allowed.',
    'Do not resell, sublicense, or republish the identifiable rows.',
    'A later withdrawal can shrink what you may download next time.',
  ],
  zh: [
    '仅可用于分析与产品研究。',
    '不得向数据包中的人士进行直销。',
    '不得转售、再许可或公开可识别行。',
    '当事人日后撤回同意，可能减少你下次可下载的内容。',
  ],
  'zh-TW': [
    '僅可用於分析與產品研究。',
    '不得向資料包中的人士進行直銷。',
    '不得轉售、再授權或公開可識別列。',
    '當事人日後撤回同意，可能減少你下次可下載的內容。',
  ],
  ja: [
    '分析および製品調査に限り利用できます。',
    'パック内の個人へのダイレクトマーケティングはできません。',
    '識別可能な行の転売、再ライセンス、再公開はできません。',
    '本人が後から同意を撤回すると、次回ダウンロードできる内容が減ることがあります。',
  ],
};

const CSV_NOTICE = {
  en: (version, buyer, purchaseId) => [
    `# DataDance buyer licence ${version}`,
    `# buyer=${buyer}; purchase=${purchaseId}; purpose=analysis-and-research; direct-marketing=no`,
  ],
  zh: (version, buyer, purchaseId) => [
    `# DataDance 买方许可 ${version}`,
    `# 买方=${buyer}; 采购=${purchaseId}; 用途=分析与研究; 直销=否`,
  ],
  'zh-TW': (version, buyer, purchaseId) => [
    `# DataDance 買方許可 ${version}`,
    `# 買方=${buyer}; 採購=${purchaseId}; 用途=分析與研究; 直銷=否`,
  ],
  ja: (version, buyer, purchaseId) => [
    `# DataDance バイヤーライセンス ${version}`,
    `# バイヤー=${buyer}; 購入=${purchaseId}; 目的=分析・調査; ダイレクトマーケティング=不可`,
  ],
};

function licenceTerms(locale) {
  return LICENCE_TERMS[locale] || LICENCE_TERMS.en;
}

function csvNotice({ locale, version, buyer, purchaseId }) {
  const build = CSV_NOTICE[locale] || CSV_NOTICE.en;
  return build(version, buyer, purchaseId).join('\n');
}

module.exports = {
  LOCALES,
  resolveLocale,
  localizeHeader,
  localizeHeaders,
  licenceTerms,
  csvNotice,
};
