/**
 * package.json ↔ yarn.lock.
 *
 * The Dockerfile installs with `yarn --frozen-lockfile`, which refuses to run when a dependency
 * range in package.json has no matching `name@range` key in yarn.lock. That is what broke the image
 * build: package.json asked for `pdfkit@^0.17.2` while the lockfile only knew `pdfkit@^0.17.1`
 * (resolved to 0.17.2, but frozen mode matches on the key). Checked here so it fails in `npm test`
 * instead of in the image build on the server.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');

function lockKeys() {
  const keys = new Set();
  for (const line of fs.readFileSync(path.join(root, 'yarn.lock'), 'utf8').split('\n')) {
    if (!line || line.startsWith(' ') || line.startsWith('#')) continue;
    for (const key of line.replace(/:$/, '').split(', ')) keys.add(key.replace(/^"|"$/g, ''));
  }
  return keys;
}

describe('yarn.lock covers package.json (yarn --frozen-lockfile)', () => {
  it('every dependency range has a lockfile entry', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const keys = lockKeys();
    const missing = [];
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [name, range] of Object.entries(pkg[section] || {})) {
        if (!keys.has(`${name}@${range}`)) missing.push(`${section}: ${name}@${range}`);
      }
    }
    assert.deepEqual(missing, [], `yarn --frozen-lockfile will refuse: ${missing.join('; ')}`);
  });
});
