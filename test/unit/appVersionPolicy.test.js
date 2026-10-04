/**
 * GET /api/app/version-policy — the public forced-update gate.
 *
 *   { ios: { minVersion, storeUrl }, android: { minVersion, downloadUrl } }
 *
 * Built from APP_MIN_VERSION_IOS / APP_MIN_VERSION_ANDROID / APP_STORE_URL_IOS /
 * APP_DOWNLOAD_URL_ANDROID, validated once at boot. iOS has a default store URL; Android has NO
 * default download URL, and an Android minimum without one is ignored. The mount order on the real
 * app is covered in appMountOrder.test.js; here the router is mounted on its own so the contract,
 * the validation and the rate limit can be exercised directly.
 */
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

process.env.LOG_LEVEL = 'error';

const { listenLoopback } = require('../helpers/loopbackServer');
const {
  DEFAULT_IOS_STORE_URL,
  buildVersionPolicy,
  initVersionPolicy,
  getVersionPolicy,
} = require('../../src/constants/appVersionPolicy');
const appRoutes = require('../../src/routes/appRoutes');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

const ANDROID_URL = 'https://downloads.example.test/datadance-wallet-2.2.0.apk';

/** Collects what boot would log. */
function captureLog() {
  const warnings = [];
  return { warnings, warn: (event, meta) => warnings.push({ event, meta }), info() {} };
}

describe('defaults', () => {
  it('iOS: our App Store listing. Android: no URL at all. An unset minimum is null', () => {
    assert.equal(DEFAULT_IOS_STORE_URL, 'https://apps.apple.com/app/id6743675282');
    const { policy, problems } = buildVersionPolicy({});
    assert.deepEqual(policy, {
      ios: { minVersion: null, storeUrl: 'https://apps.apple.com/app/id6743675282' },
      android: { minVersion: null, downloadUrl: null },
    });
    assert.deepEqual(problems, []);
  });

  it('there is no Android default: the downloads directory is not a page to send anyone to', () => {
    const { policy } = buildVersionPolicy({});
    assert.strictEqual(policy.android.downloadUrl, null);
    assert.ok(!JSON.stringify(policy).includes('app.datadance.ai/downloads'), 'the 403 directory must not be served');
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
    assert.strictEqual(policy.android.downloadUrl, null);
    assert.deepEqual(problems, []);
  });
});

describe('configured values', () => {
  it('flow through to the matching platform (trimmed)', () => {
    const { policy, problems } = buildVersionPolicy({
      APP_MIN_VERSION_IOS: ' 2.1.0 ',
      APP_MIN_VERSION_ANDROID: '1.5',
      APP_STORE_URL_IOS: 'https://apps.apple.com/app/id1234567890',
      APP_DOWNLOAD_URL_ANDROID: ` ${ANDROID_URL} `,
    });
    assert.deepEqual(policy, {
      ios: { minVersion: '2.1.0', storeUrl: 'https://apps.apple.com/app/id1234567890' },
      android: { minVersion: '1.5', downloadUrl: ANDROID_URL },
    });
    assert.deepEqual(problems, []);
  });

  it('the two platforms are independent', () => {
    const { policy, problems } = buildVersionPolicy({ APP_MIN_VERSION_ANDROID: '3.0.0', APP_DOWNLOAD_URL_ANDROID: ANDROID_URL });
    assert.equal(policy.ios.minVersion, null);
    assert.equal(policy.android.minVersion, '3.0.0');
    assert.deepEqual(problems, []);
  });

  it('a download URL alone is served; with no minimum the App still never blocks', () => {
    const { policy, problems } = buildVersionPolicy({ APP_DOWNLOAD_URL_ANDROID: ANDROID_URL });
    assert.deepEqual(policy.android, { minVersion: null, downloadUrl: ANDROID_URL });
    assert.deepEqual(problems, []);
  });

  it('accepts 2 to 4 dot-separated numbers', () => {
    for (const good of ['0.1', '1.0', '2.1', '2.0.1', '10.20.30', '1.2.3.4', '2.0.1.15', '999999999.0']) {
      const { policy, problems } = buildVersionPolicy({
        APP_MIN_VERSION_IOS: good,
        APP_MIN_VERSION_ANDROID: good,
        APP_DOWNLOAD_URL_ANDROID: ANDROID_URL,
      });
      assert.equal(policy.ios.minVersion, good, good);
      assert.equal(policy.android.minVersion, good, good);
      assert.deepEqual(problems, [], good);
    }
  });
});

describe('an Android minimum needs a download URL', () => {
  const BOTH = ['APP_MIN_VERSION_ANDROID', 'APP_DOWNLOAD_URL_ANDROID'];

  it('minimum without a URL: minVersion null, downloadUrl null, ONE warning naming both variables', () => {
    for (const env of [
      { APP_MIN_VERSION_ANDROID: '2.2.0' },
      { APP_MIN_VERSION_ANDROID: '2.2.0', APP_DOWNLOAD_URL_ANDROID: '' },
      { APP_MIN_VERSION_ANDROID: '2.2.0', APP_DOWNLOAD_URL_ANDROID: '   ' },
    ]) {
      const { policy, problems } = buildVersionPolicy(env);
      assert.deepEqual(policy.android, { minVersion: null, downloadUrl: null }, 'fails open');
      assert.equal(problems.length, 1, 'one warning');
      assert.deepEqual(problems[0].variables, BOTH);
      assert.ok(BOTH.every((name) => problems[0].detail.includes(name)), 'the message names both variables');
      assert.match(problems[0].detail, /not set/);
    }
  });

  it('minimum with a URL that is not https: the same single warning, not two', () => {
    for (const bad of ['http://downloads.example.test/a.apk', 'ftp://downloads.example.test/a.apk', 'not a url', 'javascript:alert(1)', '//downloads.example.test/a.apk']) {
      const { policy, problems } = buildVersionPolicy({ APP_MIN_VERSION_ANDROID: '2.2.0', APP_DOWNLOAD_URL_ANDROID: bad });
      assert.deepEqual(policy.android, { minVersion: null, downloadUrl: null }, bad);
      assert.equal(problems.length, 1, `${bad}: one warning`);
      assert.deepEqual(problems[0].variables, BOTH);
      assert.match(problems[0].detail, /not an https URL/);
      assert.ok(!JSON.stringify(problems).includes(bad), 'the URL is not echoed');
    }
  });

  it('only the Android minimum is dropped: iOS keeps its own', () => {
    const { policy, problems } = buildVersionPolicy({ APP_MIN_VERSION_IOS: '2.1.0', APP_MIN_VERSION_ANDROID: '2.2.0' });
    assert.equal(policy.ios.minVersion, '2.1.0');
    assert.equal(policy.android.minVersion, null);
    assert.equal(problems.length, 1);
  });

  it('boot logs exactly one warning for it', () => {
    const log = captureLog();
    const policy = initVersionPolicy({ env: { APP_MIN_VERSION_ANDROID: '2.2.0' }, log });
    assert.equal(log.warnings.length, 1);
    assert.equal(log.warnings[0].event, 'app_version_policy.invalid_value');
    assert.deepEqual(log.warnings[0].meta.variables, BOTH);
    assert.deepEqual(policy.android, { minVersion: null, downloadUrl: null });
  });

  it('an invalid minimum is its own problem and is not reported a second time as a missing URL', () => {
    const { policy, problems } = buildVersionPolicy({ APP_MIN_VERSION_ANDROID: 'v2.2' });
    assert.equal(policy.android.minVersion, null);
    assert.equal(problems.length, 1);
    assert.deepEqual(problems[0].variables, ['APP_MIN_VERSION_ANDROID']);
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
        const { policy, problems } = buildVersionPolicy({ [platform[0]]: bad, APP_DOWNLOAD_URL_ANDROID: ANDROID_URL });
        assert.equal(policy[platform[1]].minVersion, null, `${JSON.stringify(bad)} must become null`);
        assert.equal(problems.length, 1, `${JSON.stringify(bad)}: one problem`);
        assert.deepEqual(problems[0].variables, [platform[0]]);
        assert.ok(problems[0].detail.includes(platform[0]));
      }
    });
  }

  it('a long junk value is capped in the warning', () => {
    const { problems } = buildVersionPolicy({ APP_MIN_VERSION_IOS: 'x'.repeat(500) });
    assert.ok(problems[0].value.length <= 40, 'the echoed value is capped');
  });
});

describe('validation: an update URL that is not https', () => {
  const invalid = ['http://apps.apple.com/app/id1', 'javascript:alert(1)', 'ftp://downloads.example.test/a.apk', 'itms-apps://apps.apple.com/app/id1', 'not a url', '//downloads.example.test/a.apk'];

  it('APP_STORE_URL_IOS falls back to the default, without being echoed', () => {
    for (const bad of invalid) {
      const { policy, problems } = buildVersionPolicy({ APP_STORE_URL_IOS: bad });
      assert.equal(policy.ios.storeUrl, DEFAULT_IOS_STORE_URL, bad);
      assert.equal(problems.length, 1, bad);
      assert.deepEqual(problems[0].variables, ['APP_STORE_URL_IOS']);
      assert.ok(!JSON.stringify(problems).includes(bad), 'the URL is not echoed');
    }
  });

  it('APP_DOWNLOAD_URL_ANDROID is treated as unset (null), with one warning, when no minimum depends on it', () => {
    for (const bad of invalid) {
      const { policy, problems } = buildVersionPolicy({ APP_DOWNLOAD_URL_ANDROID: bad });
      assert.strictEqual(policy.android.downloadUrl, null, bad);
      assert.equal(problems.length, 1, bad);
      assert.deepEqual(problems[0].variables, ['APP_DOWNLOAD_URL_ANDROID']);
      assert.ok(!JSON.stringify(problems).includes(bad), 'the URL is not echoed');
    }
  });
});

describe('boot: initVersionPolicy', () => {
  it('warns once per bad variable, none for good ones, and serves the validated policy', () => {
    const log = captureLog();
    const policy = initVersionPolicy({
      env: {
        APP_MIN_VERSION_IOS: 'v2',
        APP_MIN_VERSION_ANDROID: '2.2.0',
        APP_DOWNLOAD_URL_ANDROID: ANDROID_URL,
        APP_STORE_URL_IOS: 'http://x.test/',
      },
      log,
    });
    assert.deepEqual(log.warnings.map((w) => w.meta.variables.join('+')).sort(), ['APP_MIN_VERSION_IOS', 'APP_STORE_URL_IOS']);
    assert.ok(log.warnings.every((w) => w.event === 'app_version_policy.invalid_value'));
    assert.deepEqual(policy, {
      ios: { minVersion: null, storeUrl: DEFAULT_IOS_STORE_URL },
      android: { minVersion: '2.2.0', downloadUrl: ANDROID_URL },
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
    const saved = { min: process.env.APP_MIN_VERSION_ANDROID, url: process.env.APP_DOWNLOAD_URL_ANDROID };
    process.env.APP_MIN_VERSION_ANDROID = '3.0.0';
    process.env.APP_DOWNLOAD_URL_ANDROID = ANDROID_URL;
    delete require.cache[modulePath];
    try {
      const fresh = require('../../src/constants/appVersionPolicy');
      assert.deepEqual(fresh.getVersionPolicy().android, { minVersion: '3.0.0', downloadUrl: ANDROID_URL });
    } finally {
      for (const [name, value] of [['APP_MIN_VERSION_ANDROID', saved.min], ['APP_DOWNLOAD_URL_ANDROID', saved.url]]) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
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
        APP_DOWNLOAD_URL_ANDROID: ANDROID_URL,
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
      android: { minVersion: null, downloadUrl: ANDROID_URL },
    });
    assert.deepEqual(Object.keys(res.body), ['ios', 'android']);
    assert.deepEqual(Object.keys(res.body.ios), ['minVersion', 'storeUrl']);
    assert.deepEqual(Object.keys(res.body.android), ['minVersion', 'downloadUrl']);
  });

  it('returns null, not a missing key, for everything that is not configured', async () => {
    initVersionPolicy({ env: {}, log: captureLog() });
    const res = await request(server).get('/api/app/version-policy');
    assert.equal(res.status, 200);
    assert.ok(Object.prototype.hasOwnProperty.call(res.body.android, 'minVersion'));
    assert.ok(Object.prototype.hasOwnProperty.call(res.body.android, 'downloadUrl'));
    assert.strictEqual(res.body.android.minVersion, null);
    assert.strictEqual(res.body.android.downloadUrl, null);
    assert.strictEqual(res.body.ios.minVersion, null);
    assert.equal(res.body.ios.storeUrl, DEFAULT_IOS_STORE_URL);
  });

  it('an Android minimum that has no download URL is not served', async () => {
    initVersionPolicy({ env: { APP_MIN_VERSION_ANDROID: '2.2.0' }, log: captureLog() });
    const res = await request(server).get('/api/app/version-policy');
    assert.deepEqual(res.body.android, { minVersion: null, downloadUrl: null });
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
