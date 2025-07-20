const crypto = require('crypto');

// Test the hash generation and source ID extraction locally
function generateContentHash(payload) {
  const normalized = normalizeObject(payload);
  const content = JSON.stringify(normalized);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function normalizeObject(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  const normalized = {};
  const sortedKeys = Object.keys(obj)
    .filter(key => obj[key] !== null && obj[key] !== undefined && obj[key] !== '')
    .sort();

  for (const key of sortedKeys) {
    const value = obj[key];
    if (typeof value === 'string') {
      normalized[key] = value.trim().toLowerCase();
    } else if (typeof value === 'number') {
      normalized[key] = Number(value);
    } else if (typeof value === 'object') {
      normalized[key] = normalizeObject(value);
    } else {
      normalized[key] = value;
    }
  }

  return normalized;
}

function extractSourceId(source, payload) {
  if (source === 'amazon') {
    return payload.orderid || payload.orderId || null;
  } else if (source === 'luma') {
    return payload.eventId || 
           payload.taskId || 
           payload.id ||
           null;
  }
  return null;
}

// Test cases
console.log('🧪 Testing duplicate detection logic...\n');

const testPayload1 = {
  orderid: "123-1234567-1234567",
  title: "Test Product 1",
  price: 29.99,
  currency: "USD"
};

const testPayload2 = {
  orderid: "123-1234567-1234567", // Same order ID
  title: "Test Product 1",
  price: 29.99,
  currency: "USD"
};

const testPayload3 = {
  orderid: "123-1234567-1234568", // Different order ID
  title: "Test Product 1", // Same title
  price: 29.99,
  currency: "USD"
};

console.log('Payload 1:');
console.log('  sourceId:', extractSourceId('amazon', testPayload1));
console.log('  contentHash:', generateContentHash(testPayload1));

console.log('\nPayload 2 (same order ID):');
console.log('  sourceId:', extractSourceId('amazon', testPayload2));
console.log('  contentHash:', generateContentHash(testPayload2));
console.log('  sourceId match:', extractSourceId('amazon', testPayload1) === extractSourceId('amazon', testPayload2));
console.log('  contentHash match:', generateContentHash(testPayload1) === generateContentHash(testPayload2));

console.log('\nPayload 3 (same content, different order ID):');
console.log('  sourceId:', extractSourceId('amazon', testPayload3));
console.log('  contentHash:', generateContentHash(testPayload3));
console.log('  sourceId match:', extractSourceId('amazon', testPayload1) === extractSourceId('amazon', testPayload3));
console.log('  contentHash match:', generateContentHash(testPayload1) === generateContentHash(testPayload3));

// Test with timestamps (which might be causing issues)
const testPayload4 = {
  ...testPayload1,
  timestamp: new Date().toISOString()
};

const testPayload5 = {
  ...testPayload1,
  timestamp: new Date(Date.now() + 1000).toISOString() // 1 second later
};

console.log('\n🕐 Testing with timestamps:');
console.log('Payload 4 hash:', generateContentHash(testPayload4));
console.log('Payload 5 hash:', generateContentHash(testPayload5));
console.log('Hash match with timestamps:', generateContentHash(testPayload4) === generateContentHash(testPayload5));

console.log('\n📊 Normalized objects:');
console.log('Payload 1 normalized:', JSON.stringify(normalizeObject(testPayload1), null, 2));
console.log('Payload 4 normalized:', JSON.stringify(normalizeObject(testPayload4), null, 2));