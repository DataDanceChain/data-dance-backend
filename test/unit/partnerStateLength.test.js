/**
 * Contract ddc-sso-tge v0.2.1, /oauth/authorize `state`: minLength 22 (≥ 128 bits of entropy),
 * maxLength 512 — for the PARTNER (confidential TGE) client. A short state is refused with a
 * redirect back to the (already validated) redirect_uri carrying error=invalid_request (T09.1).
 * MCP public clients are outside this contract and keep today's behaviour (state optional, any length).
 */
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { installMockPrisma } = require('../helpers/mockPrisma');

const prisma = installMockPrisma();

const REDIRECT = 'https://tge.example.com/oauth/callback';
const MCP_REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
Object.assign(process.env, {
  SSO_ENVIRONMENT: 'test',
  SSO_TGE_ENABLED: 'true',
  SSO_TGE_CLIENT_ID: 'tge-test',
  SSO_TGE_CLIENT_SECRET_SHA256: crypto.createHash('sha256').update('tge-secret-dev').digest('hex'),
  SSO_TGE_REDIRECT_URIS: REDIRECT,
  PUBLIC_BASE_URL: 'https://api.test.local',
  APP_PUBLIC_URL: 'https://app.test.local',
});

const { startAuthorization, OAuthError } = require('../../src/services/oauthService');

const challenge = crypto.createHash('sha256').update('v'.repeat(43)).digest('base64url');
const req = { get: () => '' };
const partner = (state) => ({ response_type: 'code', client_id: 'tge-test', redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256' });
const mcp = (state) => ({ response_type: 'code', client_id: 'ddc_oauth_mcp1', redirect_uri: MCP_REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256' });

async function refusal(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected startAuthorization to refuse');
}

describe('partner state length (contract minLength 22)', () => {
  beforeEach(async () => {
    prisma.reset();
    await prisma.oAuthClient.create({
      data: { clientId: 'ddc_oauth_mcp1', clientName: 'Claude', redirectUris: [MCP_REDIRECT], tokenEndpointAuthMethod: 'none', clientUri: '' },
    });
  });

  for (const state of ['abc', 'x'.repeat(21)]) {
    it(`partner state of ${state.length} characters → redirect back with invalid_request, no request stored`, async () => {
      const err = await refusal(startAuthorization(req, partner(state)));
      assert.ok(err instanceof OAuthError);
      assert.equal(err.error, 'invalid_request');
      assert.equal(err.redirectable, true);
      const back = new URL(err.redirectTo);
      assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
      assert.equal(back.searchParams.get('error'), 'invalid_request');
      assert.equal(back.searchParams.get('state'), state);
      assert.equal(prisma.oAuthAuthorization.rows.length, 0);
    });
  }

  it('partner state of exactly 22 characters is accepted', async () => {
    const url = await startAuthorization(req, partner('s'.repeat(22)));
    assert.match(url, /^https:\/\/app\.test\.local\/oauth\/consent\?request=/);
  });

  it('MCP public clients are unchanged: a short state, or none, is still accepted', async () => {
    assert.match(await startAuthorization(req, mcp('abc')), /\/oauth\/consent\?request=/);
    assert.match(await startAuthorization(req, mcp(undefined)), /\/oauth\/consent\?request=/);
  });
});
