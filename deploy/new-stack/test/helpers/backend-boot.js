// backend-boot.js <repository dir> <env file>   (local test helper; touches no server and opens no connection)
// Runs this checkout's own src/server.js, with every boot-time check in its order, against an env file the way the api
// container gets it (compose env_file), without starting the app: src/app.js is replaced by a stub whose listen() only
// calls back, so nothing listens and no route, database client query or job starts. The environment is exactly the
// file's: process.env is cleared first, and dotenv (the parser the backend itself uses) reads the file.
// Prints what src/server.js prints (its boot lines are secret-free by design), then "BOOT CHECKS OK", or
// "BOOT CHECKS FAIL: <the backend's own message>" and exit 1. Run it with a scratch directory as the working directory:
// the backend's logger writes logs/*.log there, and dotenv.config() finds no .env there.
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const [repo, envFile] = process.argv.slice(2);
const parsed = require(path.join(repo, 'node_modules', 'dotenv')).parse(fs.readFileSync(envFile));
for (const k of Object.keys(process.env)) delete process.env[k];
Object.assign(process.env, parsed);

const appPath = require.resolve(path.join(repo, 'src', 'app.js'));
const stub = new Module(appPath, module);
stub.filename = appPath;
stub.loaded = true;
stub.exports = { listen(port, cb) { if (typeof cb === 'function') cb(); return { close() {} }; } };
require.cache[appPath] = stub;

try {
  require(path.join(repo, 'src', 'server.js'));
} catch (e) {
  console.log('BOOT CHECKS FAIL: ' + String(e && e.message ? e.message : e).replace(/\s+/g, ' ').slice(0, 600));
  process.exit(1);
}
setImmediate(() => { console.log('BOOT CHECKS OK'); process.exit(0); });
