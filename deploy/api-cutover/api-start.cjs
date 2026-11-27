'use strict';

// PID 1 owns no listening socket until the API-only reconciler authorizes
// this exact boot. Mount the operator-owned directory read-only.
const fs = require('node:fs');
const crypto = require('node:crypto');
const base = '/run/ddc-api-handoff';
const getBoot = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const challenge = {
  nonce: crypto.randomUUID(), netns: fs.readlinkSync('/proc/self/ns/net'), bootId: getBoot(),
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fields = ['email-bind', 'email-code', 'oauth'];
const pin = /^sha256:[0-9a-f]{64}$/;
const startup = '/usr/local/bin/docker-entrypoint.sh';
const deadline = process.hrtime.bigint() + 85_000_000_000n;

function read(name) {
  const dir = fs.lstatSync(base);
  if (!dir.isDirectory() || dir.uid !== 0 || dir.mode & 0o022) throw new Error('Handoff directory');
  const fd = fs.openSync(base + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || st.mode & 0o022 || st.size < 1 || st.size > 65536) {
      throw new Error('Handoff input');
    }
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== st.size) throw new Error('Handoff input changed');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

if (process.argv.length !== 2 || process.env.DDC_SHARED_AUTH_STATE !== 'true') process.exit(78);
fs.writeFileSync('/tmp/ddc-api-launch-challenge.json', JSON.stringify(challenge), { mode: 0o600, flag: 'wx' });
setInterval(() => {
  if (process.hrtime.bigint() >= deadline) {
    console.error('API remains closed: current shared admission was not established');
    process.exit(78);
  }
  try {
    const policyBytes = read('policy.json'), ownerBytes = read('owners.json');
    const policy = JSON.parse(policyBytes), owners = JSON.parse(ownerBytes), admission = JSON.parse(read('admission.json'));
    if (policy.version !== 1 || admission.version !== 1 || !['primary', 'rollback'].includes(admission.role) ||
        !Object.keys(challenge).every(key => challenge[key] === admission[key]) ||
        admission.policySha256 !== sha(policyBytes) || admission.ownerSha256 !== sha(ownerBytes) ||
        !pin.test(admission.image) || policy.legacyImage === admission.image ||
        policy[admission.role + 'Image'] !== admission.image ||
        Object.keys(owners).sort().join() !== fields.join() ||
        !fields.every(key => owners[key]?.owner === 'shared' && owners[key].pending === 0 &&
          owners[key].unknown === 0)) return;
    process.execve(startup, [startup, 'node', 'src/server.js'], process.env);
  } catch {}
}, 100);
