/** Common stay cities so the tourism map can light pins without a geocode round-trip. */
const CITY_COORDINATES = {
  tokyo: { label: 'Tokyo', country: 'Japan', lat: 35.6762, lng: 139.6503 },
  osaka: { label: 'Osaka', country: 'Japan', lat: 34.6937, lng: 135.5023 },
  kyoto: { label: 'Kyoto', country: 'Japan', lat: 35.0116, lng: 135.7681 },
  seoul: { label: 'Seoul', country: 'South Korea', lat: 37.5665, lng: 126.978 },
  busan: { label: 'Busan', country: 'South Korea', lat: 35.1796, lng: 129.0756 },
  beijing: { label: 'Beijing', country: 'China', lat: 39.9042, lng: 116.4074 },
  shanghai: { label: 'Shanghai', country: 'China', lat: 31.2304, lng: 121.4737 },
  hongkong: { label: 'Hong Kong', country: 'Hong Kong', lat: 22.3193, lng: 114.1694 },
  taipei: { label: 'Taipei', country: 'Taiwan', lat: 25.033, lng: 121.5654 },
  singapore: { label: 'Singapore', country: 'Singapore', lat: 1.3521, lng: 103.8198 },
  bangkok: { label: 'Bangkok', country: 'Thailand', lat: 13.7563, lng: 100.5018 },
  phuket: { label: 'Phuket', country: 'Thailand', lat: 7.8804, lng: 98.3923 },
  'chiang mai': { label: 'Chiang Mai', country: 'Thailand', lat: 18.7883, lng: 98.9853 },
  bali: { label: 'Bali', country: 'Indonesia', lat: -8.4095, lng: 115.1889 },
  jakarta: { label: 'Jakarta', country: 'Indonesia', lat: -6.2088, lng: 106.8456 },
  'kuala lumpur': { label: 'Kuala Lumpur', country: 'Malaysia', lat: 3.139, lng: 101.6869 },
  manila: { label: 'Manila', country: 'Philippines', lat: 14.5995, lng: 120.9842 },
  hanoi: { label: 'Hanoi', country: 'Vietnam', lat: 21.0278, lng: 105.8342 },
  'ho chi minh': { label: 'Ho Chi Minh City', country: 'Vietnam', lat: 10.8231, lng: 106.6297 },
  saigon: { label: 'Ho Chi Minh City', country: 'Vietnam', lat: 10.8231, lng: 106.6297 },
  sydney: { label: 'Sydney', country: 'Australia', lat: -33.8688, lng: 151.2093 },
  melbourne: { label: 'Melbourne', country: 'Australia', lat: -37.8136, lng: 144.9631 },
  auckland: { label: 'Auckland', country: 'New Zealand', lat: -36.8509, lng: 174.7645 },
  'los angeles': { label: 'Los Angeles', country: 'United States', lat: 34.0522, lng: -118.2437 },
  la: { label: 'Los Angeles', country: 'United States', lat: 34.0522, lng: -118.2437 },
  'san francisco': { label: 'San Francisco', country: 'United States', lat: 37.7749, lng: -122.4194 },
  'new york': { label: 'New York', country: 'United States', lat: 40.7128, lng: -74.006 },
  nyc: { label: 'New York', country: 'United States', lat: 40.7128, lng: -74.006 },
  miami: { label: 'Miami', country: 'United States', lat: 25.7617, lng: -80.1918 },
  chicago: { label: 'Chicago', country: 'United States', lat: 41.8781, lng: -87.6298 },
  seattle: { label: 'Seattle', country: 'United States', lat: 47.6062, lng: -122.3321 },
  'las vegas': { label: 'Las Vegas', country: 'United States', lat: 36.1699, lng: -115.1398 },
  honolulu: { label: 'Honolulu', country: 'United States', lat: 21.3069, lng: -157.8583 },
  hawaii: { label: 'Honolulu', country: 'United States', lat: 21.3069, lng: -157.8583 },
  toronto: { label: 'Toronto', country: 'Canada', lat: 43.6532, lng: -79.3832 },
  vancouver: { label: 'Vancouver', country: 'Canada', lat: 49.2827, lng: -123.1207 },
  'mexico city': { label: 'Mexico City', country: 'Mexico', lat: 19.4326, lng: -99.1332 },
  london: { label: 'London', country: 'United Kingdom', lat: 51.5074, lng: -0.1278 },
  paris: { label: 'Paris', country: 'France', lat: 48.8566, lng: 2.3522 },
  rome: { label: 'Rome', country: 'Italy', lat: 41.9028, lng: 12.4964 },
  milan: { label: 'Milan', country: 'Italy', lat: 45.4642, lng: 9.19 },
  florence: { label: 'Florence', country: 'Italy', lat: 43.7696, lng: 11.2558 },
  venice: { label: 'Venice', country: 'Italy', lat: 45.4408, lng: 12.3155 },
  barcelona: { label: 'Barcelona', country: 'Spain', lat: 41.3874, lng: 2.1686 },
  madrid: { label: 'Madrid', country: 'Spain', lat: 40.4168, lng: -3.7038 },
  lisbon: { label: 'Lisbon', country: 'Portugal', lat: 38.7223, lng: -9.1393 },
  amsterdam: { label: 'Amsterdam', country: 'Netherlands', lat: 52.3676, lng: 4.9041 },
  berlin: { label: 'Berlin', country: 'Germany', lat: 52.52, lng: 13.405 },
  munich: { label: 'Munich', country: 'Germany', lat: 48.1351, lng: 11.582 },
  vienna: { label: 'Vienna', country: 'Austria', lat: 48.2082, lng: 16.3738 },
  prague: { label: 'Prague', country: 'Czechia', lat: 50.0755, lng: 14.4378 },
  budapest: { label: 'Budapest', country: 'Hungary', lat: 47.4979, lng: 19.0402 },
  athens: { label: 'Athens', country: 'Greece', lat: 37.9838, lng: 23.7275 },
  istanbul: { label: 'Istanbul', country: 'Turkey', lat: 41.0082, lng: 28.9784 },
  dubai: { label: 'Dubai', country: 'United Arab Emirates', lat: 25.2048, lng: 55.2708 },
  'abu dhabi': { label: 'Abu Dhabi', country: 'United Arab Emirates', lat: 24.4539, lng: 54.3773 },
  doha: { label: 'Doha', country: 'Qatar', lat: 25.2854, lng: 51.531 },
  cairo: { label: 'Cairo', country: 'Egypt', lat: 30.0444, lng: 31.2357 },
  marrakech: { label: 'Marrakech', country: 'Morocco', lat: 31.6295, lng: -7.9811 },
  'cape town': { label: 'Cape Town', country: 'South Africa', lat: -33.9249, lng: 18.4241 },
  nairobi: { label: 'Nairobi', country: 'Kenya', lat: -1.2921, lng: 36.8219 },
  'rio de janeiro': { label: 'Rio de Janeiro', country: 'Brazil', lat: -22.9068, lng: -43.1729 },
  'sao paulo': { label: 'São Paulo', country: 'Brazil', lat: -23.5558, lng: -46.6396 },
  'buenos aires': { label: 'Buenos Aires', country: 'Argentina', lat: -34.6037, lng: -58.3816 },
  lima: { label: 'Lima', country: 'Peru', lat: -12.0464, lng: -77.0428 },
  cusco: { label: 'Cusco', country: 'Peru', lat: -13.5319, lng: -71.9675 },
  'mexico': { label: 'Mexico City', country: 'Mexico', lat: 19.4326, lng: -99.1332 },
};

const ALIASES = {
  'hong kong': 'hongkong',
  hk: 'hongkong',
  'los angeles ca': 'los angeles',
  'l.a.': 'la',
  'new york city': 'new york',
  'new york ny': 'new york',
  'ho chi minh city': 'ho chi minh',
  hcmc: 'saigon',
  'kuala lumpur malaysia': 'kuala lumpur',
  东京: 'tokyo',
  大阪: 'osaka',
  京都: 'kyoto',
  首尔: 'seoul',
  首爾: 'seoul',
  北京: 'beijing',
  上海: 'shanghai',
  香港: 'hongkong',
  台北: 'taipei',
  新加坡: 'singapore',
  曼谷: 'bangkok',
  普吉: 'phuket',
  巴厘: 'bali',
  峇里: 'bali',
  吉隆坡: 'kuala lumpur',
  河内: 'hanoi',
  河內: 'hanoi',
  胡志明: 'ho chi minh',
  悉尼: 'sydney',
  墨尔本: 'melbourne',
  墨爾本: 'melbourne',
  洛杉矶: 'los angeles',
  洛杉磯: 'los angeles',
  旧金山: 'san francisco',
  舊金山: 'san francisco',
  三藩市: 'san francisco',
  纽约: 'new york',
  紐約: 'new york',
  迈阿密: 'miami',
  邁阿密: 'miami',
  芝加哥: 'chicago',
  西雅图: 'seattle',
  西雅圖: 'seattle',
  拉斯维加斯: 'las vegas',
  拉斯維加斯: 'las vegas',
  夏威夷: 'hawaii',
  伦敦: 'london',
  倫敦: 'london',
  巴黎: 'paris',
  罗马: 'rome',
  羅馬: 'rome',
  米兰: 'milan',
  米蘭: 'milan',
  佛罗伦萨: 'florence',
  佛羅倫薩: 'florence',
  威尼斯: 'venice',
  巴塞罗那: 'barcelona',
  巴塞隆納: 'barcelona',
  马德里: 'madrid',
  馬德里: 'madrid',
  里斯本: 'lisbon',
  阿姆斯特丹: 'amsterdam',
  柏林: 'berlin',
  慕尼黑: 'munich',
  维也纳: 'vienna',
  維也納: 'vienna',
  布拉格: 'prague',
  布达佩斯: 'budapest',
  布達佩斯: 'budapest',
  雅典: 'athens',
  伊斯坦布尔: 'istanbul',
  伊斯坦布爾: 'istanbul',
  迪拜: 'dubai',
  开罗: 'cairo',
  開羅: 'cairo',
  开普敦: 'cape town',
  開普敦: 'cape town',
};

function normalizePlace(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lookupCityExact(text) {
  const first = text.split(',')[0].trim();
  const key = ALIASES[text] || ALIASES[first] || text;
  return CITY_COORDINATES[key] || CITY_COORDINATES[first] || null;
}

function findCityInText(raw) {
  const text = normalizePlace(raw);
  if (!text) return null;
  const exact = lookupCityExact(text);
  if (exact) return exact;
  const keys = [...Object.keys(CITY_COORDINATES), ...Object.keys(ALIASES)]
    .filter((key) => key.length >= 3 || /[\u4e00-\u9fff]/.test(key))
    .sort((a, b) => b.length - a.length);
  for (const key of keys) {
    const hasCjk = /[\u4e00-\u9fff]/.test(key);
    const hit = hasCjk
      ? text.includes(key)
      : new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(key)}(?:[^a-z0-9]|$)`).test(text);
    if (hit) return CITY_COORDINATES[ALIASES[key] || key] || null;
  }
  return null;
}

function lookupCity(raw) {
  return findCityInText(raw);
}

module.exports = {
  CITY_COORDINATES,
  lookupCity,
  findCityInText,
};
