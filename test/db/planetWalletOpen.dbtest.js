// Real row-lock and transaction regression. Run only against the migrated disposable database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { listenLoopback } = require('../helpers/loopbackServer');

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/[^/?]*test[^/?]*(\?|$)/.test(url)) throw new Error('A disposable TEST_DATABASE_URL is required');
const run = crypto.randomUUID();
const clientId = `planet-${run}`;
const callback = 'https://dataplanet.cc/pages/oauth/callback';
Object.assign(process.env, {
  DATABASE_URL: url, PUBLIC_BASE_URL: 'https://api.test.local', APP_PUBLIC_URL: 'https://wallet.test.local',
  SSO_ENVIRONMENT: 'test', SSO_TGE_ENABLED: 'true', SSO_WALLET_PLANET_CLIENT_ID: clientId,
  SSO_TGE_AUTO_APPROVE: 'app,web', LOG_LEVEL: 'error',
  JWT_SECRET: crypto.randomUUID(), SSO_SESSION_SECRET: crypto.randomUUID(),
});

const prisma = require('../../src/utils/prisma');
const app = express();
app.use(express.json());
app.use('/api/sso', require('../../src/routes/ssoRoutes'));
app.use('/', require('../../src/routes/oauthRoutes'));

test('one Wallet Open elects and approves one PKCE request across concurrent HTTP requests on Postgres', async () => {
  const server = await listenLoopback(app);
  try {
    await prisma.user.create({ data: { id: run, email: `${run}@example.test`, referralCode: run, authType: 'web3auth' } });
    await prisma.ssoDeveloperClient.create({ data: {
      clientId, clientName: 'Planet fixture', contactEmail: `${run}@example.test`, kind: 'partner',
      secretHash: crypto.randomBytes(32).toString('hex'), redirectUris: [callback],
      initiateLoginUri: 'https://dataplanet.cc/pages/oauth/start', enabled: true,
    } });
    const jwtToken = jwt.sign({ id: run, ver: 2 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const minted = await request(server).post('/api/sso/app-ticket').set('Authorization', `Bearer ${jwtToken}`)
      .send({ client_id: clientId }).expect(200);
    const exchange = await request(server).post('/api/sso/ticket/exchange')
      .send({ ticket: minted.body.data.ticket }).expect(200);
    const { wallet_open_id: openId, session_token: session } = exchange.body.data;
    assert.match(openId, /^[A-Za-z0-9_-]{43}$/);
    const cookie = exchange.headers['set-cookie'][0].split(';')[0];
    const start = async (handle) => {
      const response = await request(server).get('/oauth/authorize').set('Cookie', cookie).query({
        client_id: clientId, redirect_uri: callback, response_type: 'code', scope: 'sso:identity sso:wallet',
        state: crypto.randomUUID(), code_challenge_method: 'S256',
        code_challenge: crypto.randomBytes(32).toString('base64url'), ...(handle ? { wallet_open_id: handle } : {}),
      }).expect(302);
      return new URL(response.headers.location).searchParams.get('request');
    };
    const decide = (requestId, auto) => request(server).post('/api/oauth/consent')
      .set('Authorization', `Bearer ${session}`).set('Cookie', cookie).send({ requestId, auto, allow: true });
    const ids = await Promise.all(Array.from({ length: 4 }, () => start(openId)));
    const ticket = await prisma.ssoTicket.findFirstOrThrow({ where: { clientId, userId: run } });
    assert.ok(ids.includes(ticket.walletOpenAuthorizationId));
    const losers = ids.filter(id => id !== ticket.walletOpenAuthorizationId);
    assert.equal(losers.length, 3);
    for (const id of losers) await decide(id, true).expect(403);
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => decide(ticket.walletOpenAuthorizationId, true)));
    assert.equal(outcomes.filter(res => res.status === 200).length, 1);
    assert.ok(outcomes.every(res => [200, 400, 403].includes(res.status)));
    assert.equal((await prisma.ssoTicket.findUniqueOrThrow({ where: { id: ticket.id } })).walletOpenHash, null);
    assert.equal(await prisma.oAuthAuthorization.count({ where: { clientId, codeHash: { not: null } } }), 1);
    const directId = await start();
    await decide(directId, true).expect(403);
    await decide(directId, false).expect(200);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await prisma.oAuthAuthorization.deleteMany({ where: { clientId } });
    await prisma.user.deleteMany({ where: { id: run } });
    await prisma.ssoDeveloperClient.deleteMany({ where: { clientId } });
    await prisma.$disconnect();
  }
});
