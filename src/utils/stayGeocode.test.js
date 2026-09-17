const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { cityFromFeature, titleCase } = require('./stayGeocode');

describe('cityFromFeature', () => {
  it('reads the city from a reverse-geocode feature', () => {
    const hit = cityFromFeature({
      text: 'Gion',
      place_type: ['neighborhood'],
      center: [135.778, 35.003],
      context: [
        { id: 'place.1', text: 'Kyoto' },
        { id: 'country.1', text: 'Japan' },
      ],
    });
    assert.deepEqual(hit, {
      label: 'Kyoto',
      country: 'Japan',
      lat: 35.003,
      lng: 135.778,
    });
  });

  it('uses the feature text when it is already a place', () => {
    const hit = cityFromFeature({
      text: 'Lisbon',
      place_type: ['place'],
      center: [-9.1393, 38.7223],
      context: [{ id: 'country.1', text: 'Portugal' }],
    });
    assert.equal(hit.label, 'Lisbon');
    assert.equal(hit.country, 'Portugal');
  });
});

describe('titleCase', () => {
  it('title-cases a leftover query', () => {
    assert.equal(titleCase('hong kong'), 'Hong Kong');
  });
});
