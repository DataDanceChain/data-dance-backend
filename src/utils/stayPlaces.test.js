const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { lookupCity, findCityInText } = require('../constants/cityCoordinates');
const { extractPlaceFromTitle, placeFromStayPayload, queryStayPlace } = require('./stayPlaces');

describe('city lookup', () => {
  it('matches exact cities and aliases', () => {
    assert.equal(lookupCity('Tokyo')?.label, 'Tokyo');
    assert.equal(lookupCity('Hong Kong')?.country, 'Hong Kong');
    assert.equal(lookupCity('纽约')?.label, 'New York');
  });

  it('finds a city inside a listing title', () => {
    assert.equal(findCityInText('Entire home in Kyoto')?.label, 'Kyoto');
    assert.equal(findCityInText('Hotel Arts Barcelona')?.label, 'Barcelona');
    assert.equal(findCityInText('上海外滩公寓')?.label, 'Shanghai');
  });
});

describe('placeFromStayPayload', () => {
  it('reads an explicit city first', () => {
    assert.equal(placeFromStayPayload({ city: 'Osaka', title: 'Stay in Tokyo' }), 'Osaka');
  });

  it('parses Airbnb-style titles when city was stripped', () => {
    assert.equal(extractPlaceFromTitle('Quiet room in Lisbon'), 'Lisbon');
    assert.equal(
      placeFromStayPayload({ title: 'Entire rental unit in Paris', listingTitle: 'Entire rental unit in Paris' }),
      'Paris',
    );
  });

  it('reads Booking trip location from nested payload', () => {
    assert.equal(
      placeFromStayPayload({ title: 'Hotel Arts', trip: { location: 'Barcelona' } }),
      'Barcelona',
    );
  });

  it('does not invent a city from a generic hotel name', () => {
    assert.equal(extractPlaceFromTitle('Park Hyatt'), '');
    assert.equal(placeFromStayPayload({ title: 'Park Hyatt' }), '');
  });

  it('does not treat an Airbnb listing nickname as a city', () => {
    assert.equal(placeFromStayPayload({ title: 'Cozy studio', location: 'Cozy studio' }), '');
    assert.equal(queryStayPlace({ title: 'Cozy studio', location: 'Cozy studio' }), null);
  });

  it('prefers coordinates, then address, then a named city', () => {
    assert.deepEqual(queryStayPlace({ lat: 35.0116, lng: 135.7681, title: 'Cozy studio' }), {
      kind: 'coords',
      lat: 35.0116,
      lng: 135.7681,
      query: '135.7681,35.0116',
    });
    assert.deepEqual(queryStayPlace({ address: '123 Gion, Kyoto', title: 'Cozy studio' }), {
      kind: 'address',
      query: '123 Gion, Kyoto',
    });
    assert.equal(queryStayPlace({ listing: { localizedCity: 'Kyoto' }, title: 'Cozy studio' })?.query, 'Kyoto');
    assert.equal(queryStayPlace({ listing: { coordinate: { latitude: 38.72, longitude: -9.14 } } })?.kind, 'coords');
  });
});
