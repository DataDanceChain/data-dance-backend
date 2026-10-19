/**
 * Every /api/ops route declares exactly one permission, and the server enforces it per role
 * (admin issue #2). Walks the real router, then sends real requests through the application.
 */
const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { installOpsApp, listenLoopback, seedUser, grant, bearer, tokens } = require('../helpers/opsApp');

const { prisma, app } = installOpsApp();
const opsRouter = require('../../src/routes/opsAdminRoutes');
const { requireOps } = require('../../src/middlewares/opsAuthMiddleware');
const { permissionsFor, PERMISSIONS } = require('../../src/constants/opsRoles');
const { clearRateLimitStore } = require('../../src/middlewares/rateLimitMiddleware');

let server;
before(async () => { server = await listenLoopback(app); });
after(() => new Promise((resolve) => server.close(resolve)));

const PUBLIC_ROUTES = ['post /auth/login', 'post /auth/code', 'post /auth/exchange'];

function routeLayers() {
  return opsRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => {
      const method = Object.keys(layer.route.methods)[0];
      const permissions = layer.route.stack.map((s) => s.handle.opsPermission).filter(Boolean);
      return { key: `${method} ${layer.route.path}`, method, path: layer.route.path, permissions };
    });
}

/** The permission each route must carry, from the contract's table. */
function expectedPermission(method, path) {
  if (path === '/roles' || path === '/audit') return 'ops.admin';
  if (path === '/identity-conflicts') return 'ops.support';
  if (path === '/sso/planet-manager') return 'ops.admin';
  if (/^\/users\/:userId\/(roles|disable|enable)/.test(path)) return 'ops.admin';
  if (path.startsWith('/disbursements/') && method !== 'get') return 'ops.payouts';
  return method === 'get' ? 'ops.read' : 'ops.write';
}

describe('the router declares one permission per route', () => {
  it('every route has exactly one permission, except the three sign-in routes, which come first', () => {
    const layers = routeLayers();
    assert.ok(layers.length > 50, `found ${layers.length} routes`);
    for (const layer of layers) {
      if (PUBLIC_ROUTES.includes(layer.key)) {
        assert.equal(layer.permissions.length, 0, layer.key);
        continue;
      }
      assert.equal(layer.permissions.length, 1, `${layer.key} has ${layer.permissions.length} permissions`);
      assert.ok(PERMISSIONS.includes(layer.permissions[0]), layer.key);
    }
    const firstGuarded = opsRouter.stack.findIndex((layer) => !layer.route);
    const publicIndexes = opsRouter.stack
      .map((layer, index) => (layer.route && PUBLIC_ROUTES.includes(`${Object.keys(layer.route.methods)[0]} ${layer.route.path}`) ? index : -1))
      .filter((index) => index >= 0);
    assert.equal(publicIndexes.length, 3);
    assert.ok(publicIndexes.every((index) => index < firstGuarded), 'sign-in routes are mounted before protectOps');
  });

  it('each route carries the permission of the contract table', () => {
    for (const layer of routeLayers()) {
      if (PUBLIC_ROUTES.includes(layer.key)) continue;
      assert.equal(layer.permissions[0], expectedPermission(layer.method, layer.path), layer.key);
    }
  });

  it('the exported route list matches the router', () => {
    const fromList = opsRouter.opsRoutes.map((r) => `${r.method} ${r.path}:${r.permission}`).sort();
    const fromStack = routeLayers()
      .filter((layer) => !PUBLIC_ROUTES.includes(layer.key))
      .map((layer) => `${layer.key}:${layer.permissions[0]}`)
      .sort();
    assert.deepEqual(fromList, fromStack);
  });

  it('a missing or unknown permission throws when the route is declared', () => {
    assert.throws(() => requireOps(undefined), /Unknown ops permission/);
    assert.throws(() => requireOps('ops.everything'), /Unknown ops permission/);
  });
});

function concretePath(path) {
  return path.replace(/:[A-Za-z]+/g, (param) => (param === ':role' ? 'operator' : 'missing-id'));
}

const sessions = {};
beforeEach(async () => {
  prisma.reset();
  clearRateLimitStore();
  process.env.OPS_SHARED_LOGIN = 'on';
  const admin = await seedUser(prisma);
  await grant(prisma, admin.id, 'ddc_admin');
  const operator = await seedUser(prisma);
  await grant(prisma, operator.id, 'operator');
  sessions.ddc_admin = bearer(tokens.ops(admin));
  sessions.operator = bearer(tokens.ops(operator));
  sessions.shared = bearer(tokens.shared());
  sessions.demo = bearer(tokens.demo());
});
after(() => { delete process.env.OPS_SHARED_LOGIN; });

function send(method, path, authorization) {
  return request(server)[method](`/api/ops${path}`).set('Authorization', authorization).send({});
}

describe('route x role: a missing permission is refused before the handler runs', () => {
  it('every route refuses every session role that lacks its permission (403)', async () => {
    let checked = 0;
    for (const { method, path, permission } of opsRouter.opsRoutes) {
      for (const role of ['ddc_admin', 'operator', 'shared', 'demo']) {
        const allowed = permissionsFor(role).includes(permission) && (role !== 'demo' || method === 'get');
        if (allowed) continue;
        const res = await send(method, concretePath(path), sessions[role]);
        assert.equal(res.status, 403, `${role} ${method.toUpperCase()} ${path} -> ${res.status}`);
        if (role !== 'demo') assert.equal(res.body.code, 'FORBIDDEN_ROLE', `${role} ${path}`);
        checked += 1;
      }
    }
    assert.ok(checked > 40, `checked ${checked}`);
    assert.equal(prisma.store.opsAuditLog.length, 0, 'a refused request writes no audit row');
  });

  it('an operator is refused on roles, disable/enable, payouts, audit and the Data Planet manager', async () => {
    const refused = [
      ['get', '/roles'],
      ['post', '/users/missing-id/roles'],
      ['post', '/users/missing-id/roles/operator/revoke'],
      ['post', '/users/missing-id/disable'],
      ['post', '/users/missing-id/enable'],
      ['post', '/disbursements/items/missing-id/process'],
      ['post', '/disbursements/redemptions/missing-id/disburse'],
      ['get', '/audit'],
      ['post', '/sso/planet-manager'],
    ];
    for (const [method, path] of refused) {
      const res = await send(method, path, sessions.operator);
      assert.equal(res.status, 403, `${method} ${path}`);
      assert.equal(res.body.code, 'FORBIDDEN_ROLE', `${method} ${path}`);
    }
  });

  it('an operator passes the permission check on campaigns, links, merchants, orders, payments, demands, privacy and points', async () => {
    const allowed = [
      ['get', '/campaigns'],
      ['post', '/campaigns/missing-id/transition'],
      ['post', '/links'],
      ['post', '/merchants/missing-id/credit'],
      ['post', '/orders/missing-id/attest'],
      ['post', '/payments/missing-id/confirm'],
      ['post', '/demands/missing-id/quote'],
      ['post', '/privacy-requests/missing-id'],
      ['post', '/users/missing-id/points'],
      ['get', '/users/search?q=ab'],
      ['get', '/identity-conflicts'],
    ];
    for (const [method, path] of allowed) {
      const res = await send(method, path, sessions.operator);
      assert.ok(![401, 403].includes(res.status), `${method} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
    }
  });

  it('a ddc_admin passes the permission check on the admin routes', async () => {
    for (const [method, path] of [['get', '/roles'], ['get', '/audit'], ['get', '/identity-conflicts'], ['post', '/users/missing-id/disable']]) {
      const res = await send(method, path, sessions.ddc_admin);
      assert.ok(![401, 403].includes(res.status), `${method} ${path} -> ${res.status}`);
    }
  });
});
