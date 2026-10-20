/** Test-only actual API child. Real Prisma queries; verified Wallet authentication is synthetic. */
'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const network = require('./opsFixtureNetwork');
const database = new URL(process.env.DATABASE_URL || 'http://invalid');
if (process.env.NODE_ENV !== 'test' || !/^[a-f0-9]{12}$/.test(process.env.OPS_FIXTURE_RUN || '') || database.hostname !== '127.0.0.1' || database.pathname !== `/ddc_ops_browser_${process.env.OPS_FIXTURE_RUN}_test`) throw new Error('Refusing non-disposable fixture database');
const jwt = require('jsonwebtoken');
const express = require('express');
const prisma = require('../../src/utils/prisma');
const { grantRole } = require('../../src/services/userRoles');
const { requestIdMiddleware } = require('../../src/middlewares/requestIdMiddleware');
const { corsOrigins } = require('../../src/constants/corsOrigins');
let server, closed = false;
async function close() {
  if (closed) return; closed = true;
  if (server) { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); }
  await prisma.$disconnect(); process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, close);
(async () => {
  const run = process.env.OPS_FIXTURE_RUN;
  const users = {};
  for (const [name, role] of Object.entries({ admin: 'ddc_admin', operator: 'operator', developer: 'developer', trusted: 'trusted_developer' })) {
    const id = `fixture-${run}-${name}`;
    const user = await prisma.user.create({ data: { id, name: `Synthetic ${name}`, email: `${name}-${run}@example.test`, referralCode: `F${run}${name}`, authType: 'web3auth', web3authVerifier: 'synthetic', web3authVerifierId: `synthetic-${name}` } });
    await grantRole({ userId: id, role, reason: 'Synthetic browser fixture enrollment', actor: { kind: 'system', userId: null, label: 'synthetic-fixture', role: 'system' }, surface: 'script' });
    const iatMs = Date.now();
    users[name] = { id, email: user.email, walletToken: jwt.sign({ id, ver: 2, iatMs, iat: Math.floor(iatMs / 1000) }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
  }
  const clients = {};
  for (const name of ['developer', 'trusted']) {
    const clientId = `fixture-${run}-${name}-app`; clients[name] = clientId;
    await prisma.ssoDeveloperClient.create({ data: { clientId, clientName: `Synthetic ${name} app`, ownerUserId: users[name].id, contactEmail: users[name].email, kind: 'developer', enabled: true, secretHash: crypto.createHash('sha256').update('synthetic-never-used-client-secret').digest('hex'), redirectUris: ['https://client.example.test/callback'], initiateLoginUri: 'https://client.example.test/login/ddc' } });
  }
  await prisma.identityConflict.create({ data: { reason: 'SYNTHETIC_FIXTURE_CONFLICT', route: 'create', candidateUserId: users.developer.id, verifier: 'synthetic' } });
  const app = express();
  app.use(require('cors')({ origin: corsOrigins(), credentials: true, allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'], exposedHeaders: ['X-Request-Id'] }));
  app.use(express.json()); app.use(requestIdMiddleware);
  app.use('/api/ops', require('../../src/routes/opsAdminRoutes'));
  app.use('/api/developer/sso', require('../../src/routes/developerSsoRoutes'));
  app.use('/api/sso', require('../../src/routes/ssoRoutes'));
  app.use(require('../../src/routes/oauthRoutes'));
  app.use(require('../../src/middlewares/errorMiddleware').errorHandler);
  server = await new Promise((resolve, reject) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); s.once('error', reject); });
  const apiOrigin = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = apiOrigin;
  const runtime = { apiOrigin, users, clients, jwtSecret: process.env.JWT_SECRET, databaseUrl: process.env.DATABASE_URL,
    credentials: { shared: { username: process.env.OPS_ADMIN_USERNAME, password: process.env.OPS_ADMIN_PASSWORD }, demo: { username: process.env.OPS_DEMO_USERNAME, password: process.env.OPS_DEMO_PASSWORD } },
    container: process.env.OPS_FIXTURE_CONTAINER, fixtureRun: run, synthetic: true, network: { deniedAtReady: network.deniedCount() },
    proofBoundary: 'Real ops/console HTTP and PostgreSQL; verified Wallet session seeded, not Web3Auth/provider sign-in.' };
  const file = process.env.OPS_FIXTURE_RUNTIME;
  if (fs.existsSync(file)) throw new Error('Refusing to overwrite runtime readiness file');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(runtime), { mode: 0o600, flag: 'wx' }); fs.renameSync(`${file}.tmp`, file);
  process.send({ type: 'ready', apiOrigin });
})().catch((error) => {
  process.send({ type: 'error', name: error.name, code: error.code || null, module: error.code === 'MODULE_NOT_FOUND' ? (/Cannot find module '([^']+)'/.exec(error.message) || [])[1] || null : null, location: String(error.stack || '').split('\n')[1] || null });
  prisma.$disconnect().finally(() => process.exit(1));
});
