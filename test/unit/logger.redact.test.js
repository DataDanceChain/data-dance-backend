const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_LEVEL = 'error';

const {
  createLogger,
  redactUrl,
  redactString,
  redactObject,
  redactFormat,
  maskSecret,
  maskCredential,
  maskEmail,
  maskWalletAddress,
  SENSITIVE_QUERY_KEYS,
} = require('../../src/utils/logger');

const LONG = 'abcdef1234567890XYZ'; // 19 chars
const LONG_MASK = 'abcd…(len=19)';

describe('maskSecret', () => {
  it('keeps the first 4 characters and the length', () => {
    assert.equal(maskSecret(LONG), LONG_MASK);
  });

  it('hides short values entirely', () => {
    assert.equal(maskSecret('abcdef12'), '[redacted]');
    assert.equal(maskSecret('1'), '[redacted]');
  });

  it('hides fully when asked, whatever the length', () => {
    assert.equal(maskSecret(LONG, { full: true }), '[redacted]');
  });

  it('passes null, undefined and empty through', () => {
    assert.equal(maskSecret(null), null);
    assert.equal(maskSecret(undefined), undefined);
    assert.equal(maskSecret(''), '');
  });

  it('is idempotent: an already-masked value stays as it is', () => {
    assert.equal(maskSecret(LONG_MASK), LONG_MASK);
    assert.equal(maskSecret('[redacted]'), '[redacted]');
    assert.equal(maskSecret(maskSecret(LONG)), LONG_MASK);
    assert.equal(redactUrl(redactUrl(`/a?token=${LONG}`)), `/a?token=${LONG_MASK}`);
    assert.deepEqual(redactObject(redactObject({ token: LONG, url: `/a?code=${LONG}` })), { token: LONG_MASK, url: `/a?code=${LONG_MASK}` });
  });

  it('stringifies non-strings before masking', () => {
    assert.equal(maskSecret(1234567890123), '1234…(len=13)');
  });
});

describe('redactUrl', () => {
  it('masks every sensitive query key', () => {
    for (const key of SENSITIVE_QUERY_KEYS) {
      const out = redactUrl(`/x?${key}=${LONG}&keep=1`);
      assert.ok(!out.includes(LONG), `${key} leaked: ${out}`);
      assert.ok(out.includes('keep=1'), `${key} damaged other params: ${out}`);
      assert.ok(out.startsWith(`/x?${key}=`), `${key} name lost: ${out}`);
    }
  });

  it('keeps the first 4 chars + length for tokens, hides password and otp', () => {
    assert.equal(redactUrl(`/a?token=${LONG}`), `/a?token=${LONG_MASK}`);
    assert.equal(redactUrl(`/a?password=${LONG}`), '/a?password=[redacted]');
    assert.equal(redactUrl('/a?otp=123456'), '/a?otp=[redacted]');
  });

  it('masks the example from the runbook', () => {
    assert.equal(redactUrl('/api/campaigns/active?token=abcdef1234'), '/api/campaigns/active?token=abcd…(len=10)');
    assert.equal(redactUrl('/api/campaigns/active?token=abcdef12'), '/api/campaigns/active?token=[redacted]');
  });

  it('leaves paths without a query, empty values and non-sensitive keys alone', () => {
    assert.equal(redactUrl('/api/campaigns/active'), '/api/campaigns/active');
    assert.equal(redactUrl('/a?token='), '/a?token=');
    assert.equal(redactUrl('/a?token'), '/a?token');
    assert.equal(redactUrl('/a?page=2&sort=asc'), '/a?page=2&sort=asc');
    assert.equal(redactUrl('/a?'), '/a?');
  });

  it('is case-insensitive on the key and keeps the original spelling', () => {
    assert.equal(redactUrl(`/a?Access_Token=${LONG}`), `/a?Access_Token=${LONG_MASK}`);
    assert.equal(redactUrl(`/a?IDTOKEN=${LONG}`), `/a?IDTOKEN=${LONG_MASK}`);
  });

  it('handles absolute URLs, encoded values and fragments', () => {
    assert.equal(
      redactUrl(`https://api.example.com/oauth/callback?code=${LONG}&state=xyz#frag`),
      `https://api.example.com/oauth/callback?code=${LONG_MASK}&state=xyz#frag`,
    );
    const out = redactUrl('/a?id_token=eyJhbGciOi%2BJIUzI1NiJ9.eyJz.sig&b=1');
    assert.ok(!out.includes('eyJhbGciOi%2B'), out);
    assert.equal(out, '/a?id_token=eyJh…(len=32)&b=1');
  });

  it('masks a Web3Auth-style JWT and ddc_ prefixed tokens beyond the prefix', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig';
    assert.equal(redactUrl(`/a?idToken=${jwt}`), `/a?idToken=eyJh…(len=${jwt.length})`);
    const out = redactUrl('/mcp?access_token=ddc_tge_0123456789abcdef');
    assert.ok(!out.includes('ddc_tge_'), out);
  });

  it('passes non-strings through untouched', () => {
    assert.equal(redactUrl(undefined), undefined);
    assert.equal(redactUrl(null), null);
    assert.equal(redactUrl(42), 42);
  });
});

describe('redactString', () => {
  it('redacts an embedded query, leaves plain text alone', () => {
    assert.equal(redactString(`redirect to /cb?code=${LONG} failed`), `redirect to /cb?code=${LONG_MASK} failed`);
    assert.equal(redactString('nothing to see'), 'nothing to see');
    assert.equal(
      redactString(`two urls: /a?code=${LONG} and https://x/b?ticket=${LONG}#f`),
      `two urls: /a?code=${LONG_MASK} and https://x/b?ticket=${LONG_MASK}#f`,
    );
    assert.equal(redactString('mytoken=abcdefghijkl'), 'mytoken=abcdefghijkl', 'key must be a whole query key');
    assert.equal(redactString(7), 7);
  });
});

describe('maskEmail / maskWalletAddress / maskCredential', () => {
  it('keeps only the email domain', () => {
    assert.equal(maskEmail('alice.smith@example.com'), '***@example.com');
    assert.equal(maskEmail('not-an-email'), '[redacted]');
    assert.equal(maskEmail(null), null);
  });

  it('keeps first 6 and last 4 of a wallet address', () => {
    assert.equal(maskWalletAddress('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
    assert.equal(maskWalletAddress('0x12'), '[redacted]');
  });

  it('keeps the auth scheme and masks the credential', () => {
    assert.equal(maskCredential(`Bearer ${LONG}`), `Bearer ${LONG_MASK}`);
    assert.equal(maskCredential(`SsoSession ${LONG}`), `SsoSession ${LONG_MASK}`);
    assert.equal(maskCredential(LONG), LONG_MASK);
  });
});

describe('redactObject', () => {
  it('masks sensitive keys at the top level and leaves others', () => {
    const out = redactObject({
      access_token: LONG,
      refresh_token: LONG,
      client_secret: LONG,
      code_verifier: LONG,
      ticket: LONG,
      id_token: LONG,
      idToken: LONG,
      password: LONG,
      otp: '123456',
      authorization: `Bearer ${LONG}`,
      Authorization: `Basic ${LONG}`,
      email: 'bob@datadance.ai',
      walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
      userId: 'user_123',
      status: 200,
      keep: 'this',
    });
    assert.deepEqual(out, {
      access_token: LONG_MASK,
      refresh_token: LONG_MASK,
      client_secret: LONG_MASK,
      code_verifier: LONG_MASK,
      ticket: LONG_MASK,
      id_token: LONG_MASK,
      idToken: LONG_MASK,
      password: '[redacted]',
      otp: '[redacted]',
      authorization: `Bearer ${LONG_MASK}`,
      Authorization: `Basic ${LONG_MASK}`,
      email: '***@datadance.ai',
      walletAddress: '0x1234…5678',
      userId: 'user_123',
      status: 200,
      keep: 'this',
    });
  });

  it('masks nested meta objects and arrays', () => {
    const out = redactObject({
      request: {
        headers: { authorization: `Bearer ${LONG}`, accept: 'application/json' },
        body: { grant_type: 'authorization_code', code: `ddc_code_${LONG}`, code_verifier: LONG },
      },
      tokens: [{ token: LONG }, { refresh_token: LONG }, 'plain'],
      users: [{ email: 'a@x.io', walletAddress: '0xabcdef0123456789abcdef0123456789abcdef01' }],
    });
    assert.equal(out.request.headers.authorization, `Bearer ${LONG_MASK}`);
    assert.equal(out.request.headers.accept, 'application/json');
    assert.equal(out.request.body.grant_type, 'authorization_code');
    assert.ok(!out.request.body.code.includes('ddc_code_'), out.request.body.code);
    assert.equal(out.request.body.code_verifier, LONG_MASK);
    assert.deepEqual(out.tokens, [{ token: LONG_MASK }, { refresh_token: LONG_MASK }, 'plain']);
    assert.deepEqual(out.users, [{ email: '***@x.io', walletAddress: '0xabcd…ef01' }]);
  });

  it('keeps error-code style values under `code`, masks everything else', () => {
    const out = redactObject({ code: 'P2002', nested: { code: 'IDTOKEN_INVALID' }, http: { code: 401 } });
    assert.deepEqual(out, { code: 'P2002', nested: { code: 'IDTOKEN_INVALID' }, http: { code: 401 } });
    assert.equal(redactObject({ code: 'ddc_code_abcdef0123456789' }).code, 'ddc_…(len=25)');
    assert.equal(redactObject({ code: 'AbCdEf0123456789' }).code, 'AbCd…(len=16)');
  });

  it('redacts URLs found in string values', () => {
    const out = redactObject({ url: `/oauth/authorize?client_id=tge&code=${LONG}`, referer: `https://x/cb?ticket=${LONG}` });
    assert.equal(out.url, `/oauth/authorize?client_id=tge&code=${LONG_MASK}`);
    assert.equal(out.referer, `https://x/cb?ticket=${LONG_MASK}`);
  });

  it('does not mutate the input', () => {
    const input = { token: LONG, nested: { password: LONG } };
    redactObject(input);
    assert.equal(input.token, LONG);
    assert.equal(input.nested.password, LONG);
  });

  it('survives circular references and deep nesting', () => {
    const a = { token: LONG };
    a.self = a;
    const out = redactObject(a);
    assert.equal(out.token, LONG_MASK);
    assert.equal(out.self, '[Circular]');

    let deep = { token: LONG };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    assert.doesNotThrow(() => redactObject(deep));
    assert.ok(!JSON.stringify(redactObject(deep)).includes(LONG));
  });

  it('turns Error instances into plain objects with redacted message and stack', () => {
    const err = new Error(`fetch /cb?code=${LONG} failed`);
    err.token = LONG;
    const out = redactObject({ error: err });
    assert.equal(out.error.name, 'Error');
    assert.equal(out.error.message, `fetch /cb?code=${LONG_MASK} failed`);
    assert.ok(typeof out.error.stack === 'string' && !out.error.stack.includes(LONG));
    assert.equal(out.error.token, LONG_MASK);
  });

  it('leaves dates, buffers and primitives alone', () => {
    const when = new Date('2026-09-21T00:00:00Z');
    const buf = Buffer.from('x');
    const out = redactObject({ when, buf, n: 1, b: true, nil: null, u: undefined });
    assert.equal(out.when, when);
    assert.equal(out.buf, buf);
    assert.deepEqual({ n: out.n, b: out.b, nil: out.nil, u: out.u }, { n: 1, b: true, nil: null, u: undefined });
  });
});

describe('redactFormat (winston)', () => {
  it('masks meta on the info object in place, keeping level and message', () => {
    const fmt = redactFormat();
    const info = {
      level: 'info',
      message: `Redirecting to /cb?code=${LONG}`,
      token: LONG,
      meta: { headers: { authorization: `Bearer ${LONG}` } },
      list: [{ password: 'hunter2' }],
    };
    const out = fmt.transform(info);
    assert.equal(out, info);
    assert.equal(out.level, 'info');
    assert.equal(out.message, `Redirecting to /cb?code=${LONG_MASK}`);
    assert.equal(out.token, LONG_MASK);
    assert.equal(out.meta.headers.authorization, `Bearer ${LONG_MASK}`);
    assert.deepEqual(out.list, [{ password: '[redacted]' }]);
  });
});

describe('createLogger request/error loggers', () => {
  function stubReq() {
    return {
      reqId: 'req-1',
      method: 'GET',
      originalUrl: `/api/campaigns/active?token=${LONG}`,
      url: `/api/campaigns/active?token=${LONG}`,
      ip: '203.0.113.9',
      user: { id: 'u1' },
    };
  }

  it('requestLogger logs reqId and a redacted URL on finish', () => {
    const logger = createLogger('test');
    const captured = [];
    logger.info = (message, meta) => captured.push({ message, meta });
    const handlers = {};
    const res = { statusCode: 200, on: (event, fn) => { handlers[event] = fn; } };
    let nexted = false;
    logger.requestLogger(stubReq(), res, () => { nexted = true; });
    assert.ok(nexted);
    handlers.finish();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].message, 'Request completed');
    assert.equal(captured[0].meta.reqId, 'req-1');
    assert.equal(captured[0].meta.url, `/api/campaigns/active?token=${LONG_MASK}`);
    // the winston format sees the same meta again and must not double-mask it
    assert.equal(redactFormat().transform({ level: 'info', message: 'x', ...captured[0].meta }).url, `/api/campaigns/active?token=${LONG_MASK}`);
    assert.equal(captured[0].meta.userId, 'u1');
    assert.equal(captured[0].meta.status, 200);
    logger.close();
  });

  it('errorLogger logs reqId, a redacted URL and forwards the error', () => {
    const logger = createLogger('test');
    const captured = [];
    logger.error = (message, meta) => captured.push({ message, meta });
    const err = new Error('boom');
    let forwarded = null;
    logger.errorLogger(err, stubReq(), {}, (e) => { forwarded = e; });
    assert.equal(forwarded, err);
    assert.equal(captured[0].message, 'Request failed');
    assert.equal(captured[0].meta.reqId, 'req-1');
    assert.equal(captured[0].meta.url, `/api/campaigns/active?token=${LONG_MASK}`);
    logger.close();
  });
});
