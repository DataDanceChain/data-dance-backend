'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A single supervisor owns this private directory. An unclean process exit
// leaves its lock in place for explicit recovery, never an automatic takeover.
function openJournal(directory, families) {
  if (!path.isAbsolute(directory)) throw new Error('State directory must be absolute');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077)) {
    throw new Error('State directory must be privately owned');
  }
  const lock = path.join(directory, 'owner.lock');
  const lockFD = fs.openSync(lock, 'wx', 0o600);
  try {
    fs.writeFileSync(lockFD, JSON.stringify({ pid: process.pid, openedAt: new Date().toISOString() }) + '\n');
    fs.fsyncSync(lockFD);
  } finally { fs.closeSync(lockFD); }
  const filename = path.join(directory, 'owners.json');
  let state;
  let uncertain = false;
  let released = false;

  function replace(next) {
    if (uncertain) throw new Error('State persistence unavailable');
    const temp = path.join(directory, '.state-' + crypto.randomUUID());
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(next) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, filename);
      const dir = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
      state = next;
    } catch (error) {
      uncertain = true;
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  }

  function edit(name, apply) {
    const row = { ...state[name] };
    apply(row);
    replace({ ...state, [name]: row });
  }

  try {
    if (fs.existsSync(filename)) {
      const existing = fs.lstatSync(filename);
      if (!existing.isFile() || existing.uid !== process.getuid() || (existing.mode & 0o077)) {
        throw new Error('State file must be privately owned');
      }
      state = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (Object.keys(state).sort().join() !== [...families].sort().join()) throw new Error('State families differ');
      const noInflight = {};
      for (const name of families) {
        const row = state[name];
        if (!row || !['legacy', 'shared'].includes(row.owner) ||
            ![row.pending, row.unknown].every(v => Number.isSafeInteger(v) && v >= 0)) {
          throw new Error('Invalid persisted family state');
        }
        noInflight[name] = { ...row, unknown: row.unknown + row.pending, pending: 0 };
      }
      replace(noInflight);
    } else {
      replace(Object.fromEntries(families.map(n => [n, { owner: 'legacy', pending: 0, unknown: 0 }])));
    }
  } catch (error) {
    fs.unlinkSync(lock);
    throw error;
  }
  return {
    status: () => structuredClone(state),
    get healthy() { return !uncertain; },
    begin: name => edit(name, row => {
      if (row.owner !== 'legacy') throw new Error('Invalid legacy admission');
      row.pending++;
    }),
    end: (name, complete) => edit(name, row => {
      if (!row.pending) throw new Error('Untracked legacy response');
      row.pending--;
      if (!complete) row.unknown++;
    }),
    commit: name => {
      const row = state[name];
      if (row.owner !== 'legacy' || row.pending || row.unknown) return false;
      edit(name, x => { x.owner = 'shared'; });
      return true;
    },
    release() {
      if (!released && !uncertain && Object.values(state).every(x => x.pending === 0)) {
        fs.unlinkSync(lock);
        released = true;
      }
    },
  };
}

module.exports = { openJournal };
