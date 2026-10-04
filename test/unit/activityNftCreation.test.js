/**
 * POST /api/activities/new: activity NFT creation is switched off (ACTIVITY_NFT_ENABLED, default off)
 * and answers 503 ACTIVITY_NFT_UNAVAILABLE.
 *
 * Before this change every call failed with 500 after its upload had been stored, returned the
 * internal error.message to the client, and (with a signer key) left an ethers event listener on the
 * shared provider for the life of the process. These tests drive the real activity router (only
 * authentication is stubbed) with real multer writing to a temp directory. Every database, provider,
 * wallet, contract and event-listener call is recorded, never sent: no network, no database.
 */
const { describe, it, before, after, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const request = require('supertest');

const { listenLoopback } = require('../helpers/loopbackServer');

const SRC = path.join(__dirname, '../../src');

function installIntoCache(specifier, exportsValue) {
  const filename = require.resolve(specifier);
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
}

// --- Database: every model call is recorded; results and failures are set per test. -------------
const dbCalls = [];
const dbResults = {};
const dbFailures = {};
class RecordingPrismaClient {
  constructor() {
    const model = (name) => new Proxy({}, {
      get: (_, method) => (typeof method !== 'string' || method === 'then' ? undefined : async () => {
        const key = `${name}.${method}`;
        dbCalls.push(key);
        if (dbFailures[key]) throw dbFailures[key];
        return dbResults[key] ?? null;
      }),
    });
    return new Proxy({}, { get: (_, name) => (typeof name !== 'string' || name === 'then' ? undefined : model(name)) });
  }
}
installIntoCache('@prisma/client', { PrismaClient: RecordingPrismaClient });

// --- Authentication: a signed-in user; the real protect is covered by its own tests. --------------
const USER = { id: '3f2b8c1e-5d4a-4e2b-9c1d-7a6b5c4d3e2f', isOrganization: true };
installIntoCache(path.join(SRC, 'middlewares/authMiddleware.js'), {
  protect: (req, res, next) => {
    req.user = { ...USER };
    next();
  },
});

// --- Logger: records what the server would log. --------------------------------------------------
const logs = [];
installIntoCache(path.join(SRC, 'utils/logger.js'), {
  createLogger: (module) => Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [level, (message, meta) => logs.push({ module, level, message, meta })]),
  ),
});

// --- Chain: same ethers module with provider, wallet and contract replaced by recorders. ----------
const realEthers = require('ethers');
const chain = { providers: [], wallets: 0, contracts: 0, rpc: [], subscriptions: [] };
class RecordingProvider {
  constructor() {
    chain.providers.push(this);
  }

  async getBalance() {
    chain.rpc.push('getBalance');
    return 0n; // lets pre-fix code run on to the factory call and its listener
  }

  async on(event) {
    chain.subscriptions.push(event);
    return this;
  }
}
class RecordingWallet extends realEthers.Wallet {
  constructor(...args) {
    super(...args);
    chain.wallets += 1;
  }
}
class RecordingContract extends realEthers.Contract {
  constructor(...args) {
    super(...args);
    chain.contracts += 1;
  }
}
require.cache[require.resolve('ethers')].exports = Object.create(realEthers, {
  JsonRpcProvider: { value: RecordingProvider, enumerable: true },
  Wallet: { value: RecordingWallet, enumerable: true },
  Contract: { value: RecordingContract, enumerable: true },
});

const web3Utils = require('../../src/utils/web3Utils');
const activityController = require('../../src/controllers/activityController');
const activityRoutes = require('../../src/routes/activityRoutes');
const { isActivityNftEnabled } = require('../../src/constants/activityNftFeature');

const UNAVAILABLE = {
  success: false,
  code: 'ACTIVITY_NFT_UNAVAILABLE',
  message: 'Activity creation is temporarily unavailable',
};
// Generated per run; a fresh key, never one of the repository's old ones, never printed.
const KEY = `0x${crypto.randomBytes(32).toString('hex')}`;
const OWNER = new realEthers.Wallet(KEY).address;
const SENTINEL = `SENTINEL-${crypto.randomBytes(6).toString('hex')}`;
const ENV_NAMES = ['ACTIVITY_NFT_ENABLED', 'CHAIN_SIGNER_PRIVATE_KEY', 'CHAIN_RPC_URL', 'CHAIN_ID', 'DDC_RPC_URL', 'DDC_CHAIN_ID'];

let uploadDir;
let uploadCalls = 0;
let server;
let savedEnv;
let listenerSpies = [];

const storedUploads = () => fs.readdirSync(uploadDir);
const chainActivity = () => ({
  providers: chain.providers.length,
  wallets: chain.wallets,
  contracts: chain.contracts,
  rpc: chain.rpc.length,
  subscriptions: chain.subscriptions.length,
  contractListeners: listenerSpies.reduce((sum, spy) => sum + spy.mock.callCount(), 0),
});
const NO_CHAIN_ACTIVITY = { providers: 0, wallets: 0, contracts: 0, rpc: 0, subscriptions: 0, contractListeners: 0 };

const validFields = {
  title: 'Launch party',
  description: 'An activity',
  startDate: '2026-11-01T00:00:00.000Z',
  endDate: '2026-11-02T00:00:00.000Z',
  type: 'MEMBERSHIP',
  categories: '[]',
  tags: '[]',
};

// The merchant portal's multipart call (ActivityForm), with both image fields.
function postMultipart() {
  let req = request(server).post('/api/activities/new');
  for (const [name, value] of Object.entries(validFields)) req = req.field(name, value);
  return req
    .attach('banner', Buffer.from('banner-bytes'), 'banner.png')
    .attach('nft', Buffer.from('nft-bytes'), 'nft.png');
}

// The merchant portal's JSON call (PromotionForm).
function postJson(body = { ...validFields, isPromoted: true, dataNfts: [] }) {
  return request(server).post('/api/activities/new').send(body);
}

function fakeRes() {
  const res = { statusCode: 200, body: undefined };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

before(async () => {
  uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-nft-upload-'));
  const upload = multer({ storage: multer.diskStorage({ destination: uploadDir }) });
  const app = express();
  app.use(express.json());
  app.set('upload', {
    any: (...args) => {
      uploadCalls += 1;
      return upload.any(...args);
    },
  });
  app.use('/api/activities', activityRoutes);
  server = await listenLoopback(app);
});

after(() => {
  server.close();
  fs.rmSync(uploadDir, { recursive: true, force: true });
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  // Never a real endpoint, even if something got past the recorders.
  process.env.CHAIN_RPC_URL = 'http://127.0.0.1:9';
  process.env.CHAIN_ID = '44508';
  dbCalls.length = 0;
  logs.length = 0;
  chain.providers.length = 0;
  chain.rpc.length = 0;
  chain.subscriptions.length = 0;
  chain.wallets = 0;
  chain.contracts = 0;
  uploadCalls = 0;
  for (const key of Object.keys(dbResults)) delete dbResults[key];
  for (const key of Object.keys(dbFailures)) delete dbFailures[key];
  // The creator exists and has a wallet, so pre-fix code would get as far as the factory call.
  dbResults['user.findUnique'] = { id: USER.id, walletAddress: OWNER };
  for (const name of fs.readdirSync(uploadDir)) fs.rmSync(path.join(uploadDir, name), { force: true });
  listenerSpies = ['on', 'once', 'addListener'].map((name) =>
    mock.method(realEthers.BaseContract.prototype, name, async function recorded() { return this; }));
  mock.method(console, 'log', () => {});
  mock.method(console, 'error', () => {});
});

afterEach(() => {
  mock.restoreAll();
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function assertRefusedUntouched(res, label) {
  assert.equal(res.status, 503, `${label}: status`);
  assert.deepEqual(res.body, UNAVAILABLE, `${label}: body`);
  assert.deepEqual(dbCalls, [], `${label}: no database call`);
  assert.deepEqual(chainActivity(), NO_CHAIN_ACTIVITY, `${label}: no chain call, provider, wallet, contract or listener`);
  assert.equal(uploadCalls, 0, `${label}: the upload middleware never ran`);
  assert.deepEqual(storedUploads(), [], `${label}: no uploaded file was stored`);
}

describe('ACTIVITY_NFT_ENABLED', () => {
  it('is off unless it is "true" (any case, surrounding spaces ignored)', () => {
    for (const value of ['true', 'TRUE', ' True ']) {
      assert.equal(isActivityNftEnabled({ ACTIVITY_NFT_ENABLED: value }), true, JSON.stringify(value));
    }
    // Values that contain "true" but are not "true" must stay off (an `includes` check would pass them).
    for (const value of [undefined, '', 'false', '0', '1', 'yes', 'on', 'enabled', 'untrue', 'true1', '"true"', 'true false']) {
      assert.equal(isActivityNftEnabled({ ACTIVITY_NFT_ENABLED: value }), false, JSON.stringify(value));
    }
    assert.equal(isActivityNftEnabled({}), false, 'unset');
  });

  it('is documented in env.example, off', () => {
    const text = fs.readFileSync(path.join(__dirname, '../../env.example'), 'utf8');
    assert.match(text, /^ACTIVITY_NFT_ENABLED="false"$/m);
  });
});

describe('POST /api/activities/new with the flag off (the default)', () => {
  for (const [setting, value] of [['unset', undefined], ['"false"', 'false'], ['"1"', '1'], ['"yes"', 'yes']]) {
    it(`answers 503 before any upload, database or chain work (${setting})`, async () => {
      if (value !== undefined) process.env.ACTIVITY_NFT_ENABLED = value;
      // A signer key is set so that pre-fix code would have reached the factory and its listener.
      process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
      assertRefusedUntouched(await postMultipart(), 'multipart');
      assertRefusedUntouched(await postJson(), 'json');
    });
  }

  it('logs the reason server-side, at info', async () => {
    await postJson();
    const refused = logs.filter((entry) => entry.message === 'activity.create_refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].level, 'info');
    assert.equal(refused[0].meta.reason, 'ACTIVITY_NFT_ENABLED is off');
    assert.equal(refused[0].meta.userId, USER.id);
  });

  it('answers 503 even to a request that would fail validation', async () => {
    assertRefusedUntouched(await postJson({}), 'empty body');
  });
});

describe('POST /api/activities/new with the flag on', () => {
  for (const value of ['true', ' TRUE ']) {
    it(`still answers 503, registers no listener and builds no provider (${JSON.stringify(value)})`, async () => {
      process.env.ACTIVITY_NFT_ENABLED = value;
      process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
      assertRefusedUntouched(await postMultipart(), 'multipart');
      assertRefusedUntouched(await postJson(), 'json');
      assertRefusedUntouched(await postJson({}), 'empty body');
    });
  }

  it('fails closed: an availability check that throws is a 503 too, its message kept in the log', async () => {
    process.env.ACTIVITY_NFT_ENABLED = 'true';
    mock.method(web3Utils, 'activityNftUnavailableReason', () => {
      throw new Error(`config unreadable ${SENTINEL}`);
    });
    assertRefusedUntouched(await postJson(), 'json');
    const refused = logs.filter((entry) => entry.message === 'activity.create_refused');
    assert.equal(refused.length, 1);
    assert.match(refused[0].meta.reason, new RegExp(SENTINEL));
  });

  it('logs why at warn: the chain layer cannot create the contract', async () => {
    process.env.ACTIVITY_NFT_ENABLED = 'true';
    await postJson();
    const refused = logs.filter((entry) => entry.message === 'activity.create_refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].level, 'warn');
    assert.equal(refused[0].meta.reason, web3Utils.activityNftUnavailableReason());
    assert.match(refused[0].meta.reason, /verified interface/);
  });
});

describe('createActivity on its own (mounted without the route gate)', () => {
  it('refuses first with the flag off: no database or chain call', async () => {
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
    const res = fakeRes();
    await activityController.createActivity({ body: { ...validFields }, files: [], user: { ...USER } }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, UNAVAILABLE);
    assert.deepEqual(dbCalls, []);
    assert.deepEqual(chainActivity(), NO_CHAIN_ACTIVITY);
  });

  it('refuses first with the flag on: no database or chain call', async () => {
    process.env.ACTIVITY_NFT_ENABLED = 'true';
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
    const res = fakeRes();
    await activityController.createActivity({ body: { ...validFields }, files: [], user: { ...USER } }, res);
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.body, UNAVAILABLE);
    assert.deepEqual(dbCalls, []);
    assert.deepEqual(chainActivity(), NO_CHAIN_ACTIVITY);
  });

  it('if the gate were opened while the contract call still refuses: 503, no listener, no activity row', async () => {
    process.env.ACTIVITY_NFT_ENABLED = 'true';
    process.env.CHAIN_SIGNER_PRIVATE_KEY = KEY;
    mock.method(web3Utils, 'activityNftUnavailableReason', () => null);
    const res = await postJson();
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, UNAVAILABLE);
    assert.deepEqual(dbCalls, ['user.findUnique'], 'only the creator lookup ran; no activity was written');
    assert.deepEqual(chainActivity(), NO_CHAIN_ACTIVITY);
    const refused = logs.filter((entry) => entry.message === 'activity.create_refused');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].level, 'warn');
    assert.match(refused[0].meta.reason, /activity NFT creation is unavailable/);
  });
});

describe('error responses never carry the internal error.message', () => {
  function assertGeneric(res, expected, secrets) {
    assert.equal(res.statusCode ?? res.status, 500);
    assert.deepEqual(res.body, expected);
    const text = JSON.stringify(res.body);
    for (const secret of secrets) assert.ok(!text.includes(secret), `the body leaks ${secret.slice(0, 12)}…`);
  }
  function assertLoggedDetail(message, error) {
    const entry = logs.find((logged) => logged.message === message);
    assert.ok(entry, `${message} was logged`);
    assert.equal(entry.level, 'error');
    assert.ok(entry.meta.error === error, 'the error itself is logged server-side');
  }
  const CREATE_FAILED = { success: false, code: 'SERVER_ERROR', message: '创建活动失败' };
  const SERVER_ERROR = { status: 'error', code: 'SERVER_ERROR', message: 'Server error' };

  // From here on the gate is opened by hand, to reach createActivity's own error handler.
  function openGate() {
    process.env.ACTIVITY_NFT_ENABLED = 'true';
    mock.method(web3Utils, 'activityNftUnavailableReason', () => null);
  }

  it('createActivity: an ethers error (it names the RPC URL) stays in the server log', async () => {
    openGate();
    const rpcError = Object.assign(new Error(`could not coalesce error (https://rpc.example.test/${SENTINEL}) code=SERVER_ERROR`), {
      code: 'SERVER_ERROR',
      shortMessage: SENTINEL,
    });
    mock.method(web3Utils, 'createActivityNFTContract', async () => {
      throw rpcError;
    });
    const res = await postJson();
    assertGeneric(res, CREATE_FAILED, [SENTINEL, 'rpc.example.test', 'coalesce']);
    assertLoggedDetail('activity.create_failed', rpcError);
  });

  it('createActivity: a missing signer key is not named to the client', async () => {
    openGate();
    let signerError = null;
    mock.method(web3Utils, 'createActivityNFTContract', async () => {
      try {
        web3Utils.getBackendWallet();
      } catch (error) {
        signerError = error;
        throw error;
      }
    });
    const res = await postJson();
    assert.ok(signerError && signerError.message.includes('CHAIN_SIGNER_PRIVATE_KEY'), 'the real error names the variable');
    assertGeneric(res, CREATE_FAILED, ['CHAIN_SIGNER_PRIVATE_KEY', signerError.message]);
    assertLoggedDetail('activity.create_failed', signerError);
  });

  it('createActivity: a database error and malformed JSON fields stay in the server log', async () => {
    openGate();
    const dbError = new Error(`Invalid prisma.user.findUnique() invocation: ${SENTINEL}`);
    dbFailures['user.findUnique'] = dbError;
    assertGeneric(await postJson(), CREATE_FAILED, [SENTINEL, 'prisma']);
    assertLoggedDetail('activity.create_failed', dbError);

    delete dbFailures['user.findUnique'];
    logs.length = 0;
    const res = await postJson({ ...validFields, categories: `{${SENTINEL}` });
    assertGeneric(res, CREATE_FAILED, [SENTINEL, 'JSON', 'Unexpected']);
    const entry = logs.find((logged) => logged.message === 'activity.create_failed');
    assert.ok(entry && entry.meta.error instanceof SyntaxError, 'the parse error is logged server-side');
  });

  it('POST /:id/tags (setActivityTags)', async () => {
    const dbError = new Error(`Invalid prisma.activity.findUnique() invocation: ${SENTINEL}`);
    dbFailures['activity.findUnique'] = dbError;
    const res = await request(server).post('/api/activities/a-1/tags').send({ tags: ['t-1'] });
    assertGeneric(res, SERVER_ERROR, [SENTINEL, 'prisma']);
    assertLoggedDetail('activity.set_tags_failed', dbError);
  });

  it('GET /categories (getCategories)', async () => {
    const dbError = new Error(`Invalid prisma.activityCategory.findMany() invocation: ${SENTINEL}`);
    dbFailures['activityCategory.findMany'] = dbError;
    const res = await request(server).get('/api/activities/categories');
    assertGeneric(res, SERVER_ERROR, [SENTINEL, 'prisma']);
    assertLoggedDetail('activity.categories_failed', dbError);
  });

  it('getActivity (exported, not routed)', async () => {
    const dbError = new Error(`Invalid prisma.activity.findUnique() invocation: ${SENTINEL}`);
    dbFailures['activity.findUnique'] = dbError;
    const res = fakeRes();
    await activityController.getActivity({ params: { id: 'a-1' }, user: { ...USER } }, res);
    assertGeneric(res, SERVER_ERROR, [SENTINEL, 'prisma']);
    assertLoggedDetail('activity.get_failed', dbError);
  });
});
