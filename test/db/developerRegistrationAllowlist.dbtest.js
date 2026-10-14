/**
 * SSO_DEVELOPER_REGISTRATION=allowlist on REAL Postgres (`npm run test:db`; needs TEST_DATABASE_URL
 * pointing at a throwaway, migrated database whose name contains "test").
 *
 * Through the real route (src/routes/developerSsoRoutes.js) and the real login check
 * (authMiddleware.protect, which reads the account row from Postgres): a listed account with a
 * verified login e-mail registers exactly one client, stored as a `developer` row it owns with only
 * the secret's hash; an unlisted account, and a listed one whose e-mail is not a verified login
 * e-mail, get the off answer and write nothing. Fixture users and clients carry a per-run prefix and
 * are deleted afterwards.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('TEST_DATABASE_URL is required for test:db (a throwaway, migrated database)');
if (!/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('TEST_DATABASE_URL must name a database containing "test" — refusing to write fixtures anywhere else');
process.env.DATABASE_URL = url;
process.env.LOG_LEVEL = 'error';
const JWT_SECRET = `developer-allowlist-db-${crypto.randomBytes(8).toString('hex')}`;
process.env.JWT_SECRET = JWT_SECRET;
process.env.PUBLIC_BASE_URL = 'https://api.test.local';

const prisma = require('../../src/utils/prisma');
const developerSsoRoutes = require('../../src/routes/developerSsoRoutes');
const { initDeveloperRegistration } = require('../../src/constants/developerRegistration');
const { sha256Hex } = require('../../src/constants/partnerClient');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');
const { listenLoopback } = require('../helpers/loopbackServer');

const RUN = `dr${crypto.randomBytes(3).toString('hex')}`;
const id = (name) => `${RUN}-${name}`;
const emailOf = (name) => `${RUN}-${name}@example.test`;
const GOOGLE = 'web3auth-google-sapphire-mainnet';
const X_LOGIN = 'web3auth-auth0-twitter-sapphire-mainnet';
const REDIRECT = 'https://partner.example.com/callback';
const CLOSED = {
  error: 'registration_closed',
  error_description: 'Self-serve client registration is closed. Contact DataDance to register a client.',
};

const app = express();
app.use(express.json());
app.use('/api/developer/sso', developerSsoRoutes);

let server;
const signedIn = (name) => `Bearer ${jwt.sign({ id: id(name), ver: 2 }, JWT_SECRET, { expiresIn: '5m' })}`;
const register = (name, body) => request(server).post('/api/developer/sso/clients').set('Authorization', signedIn(name)).send(body);
const registration = (name) => ({ client_name: `Client ${RUN} ${name}`, contact_email: emailOf(`${name}-contact`), redirect_uris: [REDIRECT] });

async function user(name, { email = emailOf(name), verifier = GOOGLE, verifierId = email } = {}) {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "User"(id, email, "referralCode", "authType", "web3authVerifier", "web3authVerifierId", "web3authLinkedAt", "updatedAt")
     VALUES ($1, $2, $3, 'web3auth', $4, $5, now(), now())`,
    id(name), email, id(name).toUpperCase(), verifier, verifierId,
  );
}

const clientsOwnedBy = (name) => prisma.ssoDeveloperClient.findMany({ where: { ownerUserId: id(name) } });
const clientsWithContact = (name) => prisma.ssoDeveloperClient.count({ where: { contactEmail: emailOf(`${name}-contact`) } });

describe('developer registration by allowlist, on Postgres', () => {
  before(async () => {
    clearRateLimitStore();
    // Listed, signed in through a connection that verifies the address, whose verifier id is that address.
    await user('listed', { email: emailOf('Listed').replace(RUN, RUN.toUpperCase()), verifierId: emailOf('listed') });
    // Signed in the same way, but not on the list.
    await user('unlisted');
    // On the list, but linked to a connection that does not verify the address.
    await user('listed-x', { verifier: X_LOGIN, verifierId: 'twitter|987654' });
    // On the list, but a legacy row whose e-mail column is not the identity its connection proved.
    await user('listed-legacy', { verifierId: 'someone.else@example.net' });
    initDeveloperRegistration({
      env: {
        SSO_DEVELOPER_REGISTRATION: 'allowlist',
        // Mixed case and spaces: the comparison is trimmed and case-insensitive.
        SSO_DEVELOPER_ALLOWED_EMAILS: ` ${emailOf('listed').toUpperCase()} , ${emailOf('listed-x')},${emailOf('listed-legacy')} `,
        WEB3AUTH_EMAIL_TRUSTED_VERIFIERS: GOOGLE,
      },
    });
    server = await listenLoopback(app);
  });

  after(async () => {
    initDeveloperRegistration({ env: {} });
    await prisma.$executeRawUnsafe('DELETE FROM "SsoDeveloperClient" WHERE "ownerUserId" LIKE $1', `${RUN}-%`);
    await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id LIKE $1', `${RUN}-%`);
    await prisma.$disconnect();
    await new Promise((resolve) => server.close(resolve));
  });

  it('a listed account with a verified login e-mail registers one developer client, which it owns', async () => {
    const res = await register('listed', registration('listed'));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(res.body.client_id, /^sso_[A-Za-z0-9_-]+$/);
    assert.match(res.body.client_secret, /^ddc_sso_secret_/);
    assert.deepEqual(res.body.scopes, ['sso:identity', 'sso:status', 'sso:email', 'sso:wallet']);

    const rows = await clientsOwnedBy('listed');
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row.clientId, res.body.client_id);
    assert.equal(row.kind, 'developer', 'never a partner row');
    assert.equal(row.enabled, true);
    assert.equal(row.contactEmail, emailOf('listed-contact'));
    assert.deepEqual(row.redirectUris, [REDIRECT]);
    assert.equal(row.secretHash, sha256Hex(res.body.client_secret));
    assert.equal(JSON.stringify(row).includes(res.body.client_secret), false, 'only the hash is stored');
  });

  it('an unlisted account gets the off answer and writes nothing, even naming a listed address in the body', async () => {
    const res = await register('unlisted', { ...registration('unlisted'), contact_email: emailOf('listed') });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, CLOSED);
    assert.equal((await clientsOwnedBy('unlisted')).length, 0);
    assert.equal(await prisma.ssoDeveloperClient.count({ where: { contactEmail: emailOf('listed') } }), 0, 'no row under the named address');
    assert.equal(await clientsWithContact('unlisted'), 0);
  });

  it('a listed e-mail that is not a verified login e-mail gets the same answer and writes nothing', async () => {
    for (const name of ['listed-x', 'listed-legacy']) {
      const res = await register(name, registration(name));
      assert.equal(res.status, 403, name);
      assert.deepEqual(res.body, CLOSED, name);
      assert.equal((await clientsOwnedBy(name)).length, 0, name);
      assert.equal(await clientsWithContact(name), 0, name);
    }
  });
});
