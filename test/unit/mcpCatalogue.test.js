const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const { installMockPrisma } = require('../helpers/mockPrisma');

installMockPrisma();

Object.assign(process.env, {
  LOG_LEVEL: 'error',
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
});

const mcpRoutes = require('../../src/routes/mcpRoutes');

const app = express();
app.use('/mcp', mcpRoutes);

describe('GET /mcp', () => {
  it('includes the protected-resource fields Codex reads from the MCP URL itself', async () => {
    const res = await request(app).get('/mcp').set('Accept', 'application/json');
    assert.equal(res.status, 200);
    assert.equal(res.body.resource, 'https://api.test.local/mcp');
    assert.deepEqual(res.body.authorization_servers, ['https://api.test.local']);
    assert.ok(res.body.scopes_supported.includes('life_capsule'));
    assert.equal(res.body.bearer_methods_supported[0], 'header');
    assert.equal(res.body.endpoint, 'https://api.test.local/mcp');
    assert.equal(res.body.transport, 'streamable-http');
  });
});
