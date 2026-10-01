/**
 * GET /api/app/version-policy — the public forced-update gate.
 *
 *   { ios: { minVersion, storeUrl }, android: { minVersion, downloadUrl } }
 *
 * Built from APP_MIN_VERSION_IOS / APP_MIN_VERSION_ANDROID / APP_STORE_URL_IOS /
 * APP_DOWNLOAD_URL_ANDROID, validated once at boot. The mount order on the real app is covered in
 * appMountOrder.test.js; here the router is mounted on its own so the contract, the validation and
 * the rate limit can be exercised directly.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

process.env.LOG_LEVEL = 'error';

const { listenLoopback } = require('../helpers/loopbackServer');
const {
  DEFAULT_IOS_STORE_URL,
  DEFAULT_ANDROID_DOWNLOAD_URL,
  buildVersionPolicy,
  initVersionPolicy,
  getVersionPolicy,
} = require('../../src/constants/appVersionPolicy');
const appRoutes = require('../../src/routes/appRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

/** Collects what boot would log. */
function captureLog() {
  const warnings = [];
  return { warnings, warn: (event, meta) => warnings.push({ event, meta }), info() {} };
}

describe('defaults', () => {
  it('are the App Store listing and the APK page; an unset minimum is null', () => {
    assert.equal(DEFAULT_IOS_STORE_URL, 'https://apps.apple.com/app/id6743675282');
    assert.equal(DEFAULT_ANDROID_DOWNLOAD_URL, 'https://app.datadance.ai/downloads/');
    const { policy, problems } = buildVersionPolicy({});
    assert.deepEqual(policy, {
      ios: { minVersion: null, storeUrl: 'https://apps.apple.com/app/id6743675282' },
      android: { minVersion: null, downloadUrl: 'https://app.datadance.ai/downloads/' },
    });
    assert.deepEqual(problems, []);
  });

  it('blank values count as unset and are not warned about', () => {
    const { policy, problems } = buildVersionPolicy({
      APP_MIN_VERSION_IOS: '',
      APP_MIN_VERSION_ANDROID: '   ',
      APP_STORE_URL_IOS: '',
      APP_DOWNLOAD_URL_ANDROID: ' ',
    });
    assert.equal(policy.ios.minVersion, null);
    assert.equal(policy.android.minVersion, null);
    assert.equal(policy.ios.storeUrl, DEFAULT_IOS_STORE_URL);
    assert.equal(policy.android.downloadUrl, DEFAULT_ANDROID_DOWNLOAD_URL);
    assert.deepEqual(problems, []);
  });
});

describe('configured values', () => {
  it('flow through to the matching platform (trimmed)', () => {
    const { policy, problems } = buildVersionPolicy({
      APP_MIN_VERSION_IOS: ' 2.1.0 ',
      APP_MIN_VERSION_ANDROID: '1.5',
      APP_STORE_URL_IOS: 'https://apps.apple.com/app/id1234567890',
      APP_DOWNLOAD_URL_ANDROID: 'https://downloads.example.test/wallet.apk',
    });
    assert.deepEqual(policy, {
      ios: { minVersion: '2.1.0', storeUrl: 'https://apps.apple.com/app/id1234567890' },
      android: { minVersion: '1.5', downloadUrl: 'https://downloads.example.test/wallet.apk' },
    });
    assert.deepEqual(problems, []);
  });

  it('the two platforms are independent', () => {
    const { policy } = buildVersionPolicy({ APP_MIN_VERSION_ANDROID: '3.0.0' });
    assert.equal(policy.ios.minVersion, null);
    assert.equal(policy.android.minVersion, '3.0.0');
  });

  it('accepts 2 to 4 dot-separated numbers', () => {
    for (const good of ['0.1', '1.0', '2.1', '2.0.1', '10.20.30', '1.2.3.4', '2.0.1.15', '999999999.0']) {
      const { policy, problems } = buildVersionPolicy({ APP_MIN_VERSION_IOS: good, APP_MIN_VERSION_ANDROID: good });
      assert.equal(policy.ios.minVersion, good, good);
      assert.equal(policy.android.minVersion, good, good);
      assert.deepEqual(problems, [], good);
    }
  });
});

describe('validation: an invalid minimum is treated as null, with one warning naming the variable', () => {
  const invalid = [
    '2', 'v2.1.0', 'V2.1', '2.1.x', '2.1.0-beta', '2.1.0-beta.1', '2.1.0+45', '2..1', '.2.1', '2.1.',
    '1.2.3.4.5', '02.1', '2.01', 'latest', '2,1,0', '2 1 0', '2.1.0 beta', '١.٢', '-1.0', '1.0.0\n2.0.0',
    '9999999999.0',
  ];

  for (const platform of [['APP_MIN_VERSION_IOS', 'ios'], ['APP_MIN_VERSION_ANDROID', 'android']]) {
    it(`${platform[0]}`, () => {
      for (const bad of invalid) {
        const { policy, problems } = buildVersionPolicy({ [platform[0]]: bad });
        assert.equal(policy[platform[1]].minVersion, null, `${JSON.stringify(bad)} must become null`);
        assert.equal(problems.length, 1, `${JSON.stringify(bad)}: one problem`);
        assert.equal(problems[0].variable, platform[0]);
        assert.ok(problems[0].detail.includes(platform[0]));
      }
    });
  }

  it('a long junk value is capped in the warning', () => {
    const { problems } = buildVersionPolicy({ APP_MIN_VERSION_IOS: 'x'.repeat(500) });
    assert.ok(problems[0].value.length <= 40, 'the echoed value is capped');
  });
});

describe('validation: an update URL that is not https falls back to the default, without being echoed', () => {
  const invalid = ['http://apps.apple.com/app/id1', 'javascript:alert(1)', 'ftp://downloads.example.test/a.apk', 'itms-apps://apps.apple.com/app/id1', 'not a url', '//downloads.example.test/a.apk'];

  it('APP_STORE_URL_IOS', () => {
    for (const bad of invalid) {
      const { policy, problems } = buildVersionPolicy({ APP_STORE_URL_IOS: bad });
      assert.equal(policy.ios.storeUrl, DEFAULT_IOS_STORE_URL, bad);
      assert.equal(problems.length, 1, bad);
      assert.equal(problems[0].variable, 'APP_STORE_URL_IOS');
      assert.ok(!JSON.stringify(problems).includes(bad), 'the URL is not echoed');
    }
  });

  it('APP_DOWNLOAD_URL_ANDROID', () => {
    for (const bad of invalid) {
      const { policy, problems } = buildVersionPolicy({ APP_DOWNLOAD_URL_ANDROID: bad });
      assert.equal(policy.android.downloadUrl, DEFAULT_ANDROID_DOWNLOAD_URL, bad);
      assert.equal(problems.length, 1, bad);
      assert.equal(problems[0].variable, 'APP_DOWNLOAD_URL_ANDROID');
    }
  });
});

describe('boot: initVersionPolicy', () => {
  it('warns once per bad variable, none for good ones, and serves the validated policy', () => {
    const log = captureLog();
    const policy = initVersionPolicy({
      env: { APP_MIN_VERSION_IOS: 'v2', APP_MIN_VERSION_ANDROID: '2.2.0', APP_STORE_URL_IOS: 'http://x.test/' },
      log,
    });
    assert.deepEqual(log.warnings.map((w) => w.meta.variable).sort(), ['APP_MIN_VERSION_IOS', 'APP_STORE_URL_IOS']);
    assert.ok(log.warnings.every((w) => w.event === 'app_version_policy.invalid_value'));
    assert.deepEqual(policy, {
      ios: { minVersion: null, storeUrl: DEFAULT_IOS_STORE_URL },
      android: { minVersion: '2.2.0', downloadUrl: DEFAULT_ANDROID_DOWNLOAD_URL },
    });
    assert.ok(getVersionPolicy() === policy, 'the endpoint serves the boot snapshot');
  });

  it('a clean environment logs nothing', () => {
    const log = captureLog();
    initVersionPolicy({ env: { APP_MIN_VERSION_IOS: '2.0.1' }, log });
    assert.deepEqual(log.warnings, []);
  });

  it('the snapshot is fixed at boot and cannot be changed by a caller', () => {
    const env = { APP_MIN_VERSION_IOS: '2.0.1' };
    const policy = initVersionPolicy({ env, log: captureLog() });
    env.APP_MIN_VERSION_IOS = '9.9.9';
    assert.equal(getVersionPolicy().ios.minVersion, '2.0.1', 'later environment changes do not apply without a restart');
    assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.ios) && Object.isFrozen(policy.android));
    assert.throws(() => {
      'use strict';
      policy.ios.minVersion = '9.9.9';
    }, TypeError);
  });

  it('never throws, whatever the environment holds', () => {
    assert.doesNotThrow(() => initVersionPolicy({
      env: { APP_MIN_VERSION_IOS: { a: 1 }, APP_MIN_VERSION_ANDROID: [], APP_STORE_URL_IOS: 5, APP_DOWNLOAD_URL_ANDROID: null },
      log: captureLog(),
    }));
  });

  it('works with the default logger (LOG_LEVEL=error keeps it quiet)', () => {
    assert.doesNotThrow(() => initVersionPolicy({ env: { APP_MIN_VERSION_IOS: 'junk' } }));
  });

  it('builds from process.env on first use when boot did not run (fresh module instance)', () => {
    const modulePath = require.resolve('../../src/constants/appVersionPolicy');
    const previous = process.env.APP_MIN_VERSION_ANDROID;
    process.env.APP_MIN_VERSION_ANDROID = '3.0.0';
    delete require.cache[modulePath];
    try {
      const fresh = require('../../src/constants/appVersionPolicy');
      assert.equal(fresh.getVersionPolicy().android.minVersion, '3.0.0');
    } finally {
      if (previous === undefined) delete process.env.APP_MIN_VERSION_ANDROID;
      else process.env.APP_MIN_VERSION_ANDROID = previous;
      delete require.cache[modulePath];
      require('../../src/constants/appVersionPolicy');
    }
  });
});

describe('GET /api/app/version-policy', () => {
  let server;
  before(async () => {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api/app', appRoutes);
    server = await listenLoopback(app);
  });
  after(() => new Promise((resolve) => server.close(resolve)));

  beforeEach(() => {
    clearRateLimitStore();
    initVersionPolicy({
      env: {
        APP_MIN_VERSION_IOS: '2.1.0',
        APP_STORE_URL_IOS: 'https://apps.apple.com/app/id6743675282',
        APP_DOWNLOAD_URL_ANDROID: 'https://app.datadance.ai/downloads/',
      },
      log: captureLog(),
    });
  });

  it('answers the contract shape with no credentials at all', async () => {
    const res = await request(server).get('/api/app/version-policy');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.headers['content-type'], /application\/json/);
    assert.deepEqual(res.body, {
      ios: { minVersion: '2.1.0', storeUrl: 'https://apps.apple.com/app/id6743675282' },
      android: { minVersion: null, downloadUrl: 'https://app.datadance.ai/downloads/' },
    });
    assert.deepEqual(Object.keys(res.body), ['ios', 'android']);
    assert.deepEqual(Object.keys(res.body.ios), ['minVersion', 'storeUrl']);
    assert.deepEqual(Object.keys(res.body.android), ['minVersion', 'downloadUrl']);
  });

  it('returns null, not a missing key, for a platform with no minimum', async () => {
    const res = await request(server).get('/api/app/version-policy');
    assert.ok(Object.prototype.hasOwnProperty.call(res.body.android, 'minVersion'));
    assert.strictEqual(res.body.android.minVersion, null);
  });

  it('is never cached, so a gate change is seen on the next launch', async () => {
    const res = await request(server).get('/api/app/version-policy');
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('does not look at Authorization: a junk or expired token changes nothing', async () => {
    const res = await request(server).get('/api/app/version-policy').set('Authorization', 'Bearer not-a-real-token');
    assert.equal(res.status, 200);
    assert.equal(res.body.ios.minVersion, '2.1.0');
  });

  it('is read-only: other methods find no handler', async () => {
    for (const method of ['post', 'put', 'patch', 'delete']) {
      const res = await request(server)[method]('/api/app/version-policy').send({});
      assert.equal(res.status, 404, method);
    }
  });

  it('is rate limited per client IP by the shared public limiter (200 a minute)', async () => {
    const first = await request(server).get('/api/app/version-policy').set('X-Forwarded-For', '203.0.113.7');
    assert.equal(first.status, 200);
    assert.equal(first.headers['x-ratelimit-limit'], '200');
    for (let i = 1; i < 200; i++) {
      const res = await request(server).get('/api/app/version-policy').set('X-Forwarded-For', '203.0.113.7');
      assert.equal(res.status, 200, `request ${i + 1}`);
    }
    const blocked = await request(server).get('/api/app/version-policy').set('X-Forwarded-For', '203.0.113.7');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    assert.equal(blocked.body.status, 'error');

    const otherClient = await request(server).get('/api/app/version-policy').set('X-Forwarded-For', '203.0.113.8');
    assert.equal(otherClient.status, 200, 'another IP has its own budget');
  });
});
