const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isOwnAccountRecord } = require('../../src/utils/ownOrderRecord');
const { validateDataItem } = require('../../src/services/crawlerService');
const { reviewAccountRecords } = require('../../src/services/orderQualityGemini');

function row(source, payload, sourceUrl) {
  return {
    source,
    type: 'order',
    payload,
    metadata: { sourceUrl },
  };
}

describe('own account records', () => {
  it('rejects a public StockX product card', () => {
    const item = row(
      'stockx',
      {
        title: 'Air Jordan 4 Retro OG Bred 2026',
        productTitle: 'Air Jordan 4 Retro OG Bred 2026',
        href: 'https://stockx.com/air-jordan-4-retro-og-bred-2026',
        price: '210',
        date: '',
      },
      'https://stockx.com/brands/crocs',
    );
    assert.equal(isOwnAccountRecord(item), false);
    assert.ok(validateDataItem(item).errors.includes('Only the signed-in account\'s own orders, trips, or bookings are counted'));
  });

  it('rejects a product slug even on the orders page', () => {
    const item = row(
      'stockx',
      { title: 'Air Jordan 4', orderId: 'air-jordan-4-retro-og-bred-2026' },
      'https://stockx.com/orders',
    );
    assert.equal(isOwnAccountRecord(item), false);
  });

  it('accepts an order id captured on the account orders page', () => {
    const item = row(
      'adidas',
      { title: 'Samba OG', orderId: 'ADI-100045', date: 'Nov 2, 2026', status: 'Delivered' },
      'https://www.adidas.com/us/my-account/orders',
    );
    assert.equal(isOwnAccountRecord(item), true);
    assert.equal(validateDataItem(item).errors.length, 0);
  });

  it('rejects an order whose page is a different shop', () => {
    const item = row(
      'adidas',
      { title: 'Samba OG', orderId: 'ADI-100045' },
      'https://stockx.com/orders',
    );
    assert.equal(isOwnAccountRecord(item), false);
  });

  it('keeps social posts on their own rule', () => {
    assert.equal(
      isOwnAccountRecord(row('instagram', { title: 'Sunset' }, 'https://www.instagram.com/maya/')),
      true,
    );
  });
});

describe('Gemini order review', () => {
  it('writes only the rows Gemini accepts', async () => {
    const order = row('stockx', { title: 'Samba', orderId: 'SX-100045' }, 'https://stockx.com/orders');
    const other = row('nike', { title: 'Pegasus', orderId: 'NK-88' }, 'https://www.nike.com/orders');
    order.originalIndex = 0;
    other.originalIndex = 1;
    const result = await reviewAccountRecords([order, other], async () => ({
      accept: ['r0'],
      reject: [{ id: 'r1', reason: 'product listing' }],
    }));
    assert.deepEqual(result.accepted, [order]);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].item, other);
    assert.equal(result.rejected[0].reason, 'product listing');
  });

  it('writes nothing when the quality check fails', async () => {
    const order = row('stockx', { title: 'Samba', orderId: 'SX-100045' }, 'https://stockx.com/orders');
    const result = await reviewAccountRecords([order], async () => {
      throw new Error('down');
    });
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0].reason, 'quality check unavailable');
  });

  it('reviews Amazon orders and leaves social posts on their own rule', async () => {
    const amazon = row('amazon', { orderid: '123-1234567-1234567', title: 'Mug' }, 'https://www.amazon.com/your-orders/orders');
    const social = row('instagram', { title: 'Sunset', href: 'https://www.instagram.com/p/ABC123def/' }, 'https://www.instagram.com/jane/');
    let seen = 0;
    const result = await reviewAccountRecords([amazon, social], async (prompt) => {
      seen += 1;
      assert.match(prompt, /r0/);
      assert.doesNotMatch(prompt, /Sunset/);
      return { accept: [], reject: [{ id: 'r0', reason: 'not an order' }] };
    });
    assert.equal(seen, 1);
    assert.deepEqual(result.accepted, [social]);
    assert.equal(result.rejected[0].item, amazon);
  });

  it('rejects a made-up Amazon id, a public Airbnb title, and a Luma event page', () => {
    assert.equal(isOwnAccountRecord(row('amazon', { orderid: '111-1', title: 'Mug' }, 'https://www.amazon.com/your-orders/orders')), false);
    assert.equal(isOwnAccountRecord(row('amazon', { orderid: '123-1234567-1234567', title: 'Mug' }, 'https://www.amazon.com/')), false);
    assert.equal(isOwnAccountRecord(row('amazon', { orderid: '123-1234567-1234567', title: 'Mug' }, 'https://www.amazon.com/your-orders/orders')), true);
    assert.equal(isOwnAccountRecord(row('airbnb', { title: 'Cozy loft', tripId: 'Cozy loft' }, 'https://www.airbnb.com/trips/v1')), false);
    assert.equal(isOwnAccountRecord(row('airbnb', { title: 'Cozy loft', tripId: 'HM8Q2X3K' }, 'https://www.airbnb.com/trips/v1')), true);
    assert.equal(isOwnAccountRecord(row('luma', { title: 'Meetup', eventId: 'https://lu.ma/meetup' }, 'https://lu.ma/meetup')), false);
    assert.equal(isOwnAccountRecord(row('luma', { title: 'Meetup', eventId: 'evt-1001' }, 'https://lu.ma/home?period=past')), true);
  });
});
