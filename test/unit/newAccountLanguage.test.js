/**
 * A new account's profile language is English, the product default: e-mail sign-up
 * (authController.register), the seed data and the test-user script. The database and the
 * referral services are stand-ins that record what would be created.
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

process.env.LOG_LEVEL = 'error';

const ROOT = path.join(__dirname, '../..');
const stubPath = (filename, exportsValue) => {
  require.cache[filename] = { id: filename, filename, loaded: true, exports: exportsValue, children: [] };
};
const stub = (rel, exportsValue) => stubPath(require.resolve(path.join(ROOT, rel)), exportsValue);

const created = [];
function fakePrisma() {
  return new Proxy(
    {},
    {
      get(target, model) {
        if (model === '$disconnect') return async () => {};
        if (model === 'then') return undefined;
        return {
          findUnique: async () => null,
          findFirst: async () => null,
          create: async ({ data }) => {
            created.push({ model, data });
            return { id: `${String(model)}-${created.length}`, ...data };
          },
        };
      },
    },
  );
}

stub('src/utils/prisma.js', fakePrisma());
stubPath(require.resolve('@prisma/client', { paths: [path.join(ROOT, 'scripts')] }), {
  PrismaClient: function PrismaClient() {
    return fakePrisma();
  },
  Prisma: {},
});
stub('src/utils/referralUtils.js', {
  generateReferralCode: () => 'ABC234',
  generateUniqueReferralCode: async () => 'ABC234',
  findUserByReferralCode: async () => null,
});
stub('src/services/referralService.js', {});
stub('src/utils/stayBonus.js', { assertReferralCampaignUsable: async () => {} });
stub('src/utils/jwtUtils.js', { generateToken: () => 'token' });

const profileLanguages = () =>
  created.filter((row) => row.model === 'user').map((row) => row.data.profile?.create?.language);

async function settle() {
  for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe('new accounts default to English', () => {
  before(() => {
    created.length = 0;
  });

  it('e-mail sign-up creates the profile in English', async () => {
    created.length = 0;
    const { register } = require(path.join(ROOT, 'src/controllers/authController.js'));
    const res = {
      statusCode: 0,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json() {
        return this;
      },
    };
    await register({ body: { email: 'new@example.com', password: 'Sup3r-secret-pass', name: 'New Person' } }, res);
    assert.equal(res.statusCode, 201);
    assert.deepEqual(profileLanguages(), ['en']);
  });

  it('seed data and the test-user script create the profile in English', async () => {
    const log = console.log;
    const error = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      created.length = 0;
      require(path.join(ROOT, 'src/utils/seedData.js'));
      await settle();
      assert.deepEqual(profileLanguages(), ['en']);

      created.length = 0;
      require(path.join(ROOT, 'scripts/createTestUser.js'));
      await settle();
      assert.deepEqual(profileLanguages(), ['en']);
    } finally {
      console.log = log;
      console.error = error;
    }
  });
});
