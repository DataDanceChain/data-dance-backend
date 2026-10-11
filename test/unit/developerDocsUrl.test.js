const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { developerDocsUrl } = require('../../src/utils/developerDocsUrl');

describe('developerDocsUrl', () => {
  it('prefers an https DEVELOPER_DOCS_URL', () => {
    assert.equal(developerDocsUrl({ DEVELOPER_DOCS_URL: 'https://docs.example.test/x', APP_PUBLIC_URL: 'https://app.example.test' }), 'https://docs.example.test/x');
  });
  it('falls back to the docs page next to the web app', () => {
    assert.equal(developerDocsUrl({ APP_PUBLIC_URL: 'https://app.example.test/some/path' }), 'https://app.example.test/developers/docs.html');
  });
  it('ignores values that are not https URLs', () => {
    assert.equal(developerDocsUrl({ DEVELOPER_DOCS_URL: 'http://docs.example.test', APP_PUBLIC_URL: 'javascript:alert(1)' }), null);
    assert.equal(developerDocsUrl({ DEVELOPER_DOCS_URL: 'not a url' }), null);
  });
  it('returns null when nothing is configured, so the root keeps its 404', () => {
    assert.equal(developerDocsUrl({}), null);
  });
});
