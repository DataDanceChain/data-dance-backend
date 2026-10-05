const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

const SECRET = 'tge-secret-dev';
const SECRET_HASH = crypto.createHash('sha256').update(SECRET).digest('hex');
const REDIRECT = 'https://tge.example.com/oauth/callback';
const ISSUER = 'https://api.test.local';

Object.assign(process.env, {
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_NAME: 'Data Planet',
  SSO_TGE_CLIENT_SECRET_SHA256: SECRET_HASH,
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  PUBLIC_BASE_URL: ISSUER,
  APP_PUBLIC_URL: 'https://app.test.local',
});

const { createDeveloperClient, DeveloperClientError } = require('../../src/services/ssoDeveloperClient');
const { resolveClient, startAuthorization } = require('../../src/services/oauthService');
const { verifyClientSecret, sha256Hex } = require('../../src/constants/partnerClient');

const PARTNER_REDIRECT = 'https://partner.example.com/callback';
const CHALLENGE = 'a'.repeat(43);
const STATE = 'b'.repeat(22);

function authorizeQuery(clientId, scope) {
  return {
    client_id: clientId,
    redirect_uri: PARTNER_REDIRECT,
    response_type: 'code',
    state: STATE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    scope,
  };
}

describe('self-serve SSO clients', () => {
  beforeEach(() => {
    prisma.reset();
  });

  it('returns a secret once and stores only its hash', async () => {
    const created = await createDeveloperClient({
      client_name: 'Northwind',
      contact_email: 'Dev@Example.com',
      redirect_uris: [PARTNER_REDIRECT, PARTNER_REDIRECT],
    });
    assert.match(created.clientId, /^sso_[A-Za-z0-9_-]+$/);
    assert.match(created.clientSecret, /^ddc_sso_secret_/);
    assert.deepEqual(created.redirectUris, [PARTNER_REDIRECT]);
    assert.deepEqual(created.scopes, ['sso:identity', 'sso:status', 'sso:email', 'sso:wallet']);
    const row = await prisma.ssoDeveloperClient.findUnique({ where: { clientId: created.clientId } });
    assert.equal(row.secretHash, sha256Hex(created.clientSecret));
    assert.equal(row.contactEmail, 'dev@example.com');
    assert.equal(JSON.stringify(row).includes(created.clientSecret), false);

    const client = await resolveClient(created.clientId);
    assert.equal(client.developer, true);
    assert.equal(client.clientName, 'Northwind');
    assert.equal(verifyClientSecret(client, created.clientSecret), true);
    assert.equal(verifyClientSecret(client, SECRET), false);
  });

  it('rejects a bad redirect and a missing email', async () => {
    await assert.rejects(
      () => createDeveloperClient({
        client_name: 'Northwind',
        contact_email: 'dev@example.com',
        redirect_uris: ['http://example.com/callback'],
      }),
      (error) => error instanceof DeveloperClientError && error.code === 'invalid_redirect_uri',
    );
    await assert.rejects(
      () => createDeveloperClient({
        client_name: 'Northwind',
        contact_email: 'not-an-email',
        redirect_uris: [PARTNER_REDIRECT],
      }),
      (error) => error instanceof DeveloperClientError && error.code === 'invalid_request',
    );
  });

  it('keeps campaign scopes on the env client and allows login scopes on a developer client', async () => {
    const created = await createDeveloperClient({
      client_name: 'Northwind',
      contact_email: 'dev@example.com',
      redirect_uris: [PARTNER_REDIRECT],
    });
    await assert.rejects(
      () => startAuthorization({}, authorizeQuery(created.clientId, 'sso:referral_network')),
      (error) => error.error === 'invalid_scope',
    );
    const consent = await startAuthorization({}, authorizeQuery(created.clientId, 'sso:identity sso:email'));
    assert.match(consent, /^https:\/\/app\.test\.local\/oauth\/consent\?request=/);
    const envConsent = await startAuthorization({}, {
      ...authorizeQuery('tge-test', 'sso:identity'),
      redirect_uri: REDIRECT,
    });
    assert.match(envConsent, /^https:\/\/app\.test\.local\/oauth\/consent\?request=/);
  });
});
