/** Test-only outbound deny; loopback HTTP/PostgreSQL and local Unix sockets remain real. */
'use strict';
const net = require('node:net');
const connect = net.Socket.prototype.connect;
let denied = 0;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  const host = options.host || options.hostname || 'localhost';
  if (!options.path && !['127.0.0.1', 'localhost', '::1'].includes(host)) { denied++; throw new Error('Fixture denied external network'); }
  return connect.apply(this, args);
};
const realFetch = globalThis.fetch;
if (realFetch) globalThis.fetch = (input, ...args) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) { denied++; return Promise.reject(new Error('Fixture denied external fetch')); }
  return realFetch(input, ...args);
};
module.exports = { deniedCount: () => denied };
