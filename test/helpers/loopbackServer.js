/**
 * An HTTP server for supertest, bound to 127.0.0.1 BEFORE the first request.
 *
 * `request(app)` makes supertest call `app.listen(0)` — the wildcard address — and then connect to
 * 127.0.0.1:<port>. Node listens with SO_REUSEADDR, so on macOS that wildcard bind succeeds even when
 * ANOTHER local process already holds 127.0.0.1:<port>, and the kernel gives the connection to that
 * more specific socket. Seen on the developer Mac: once in ~150 runs a request was answered
 * `403 bad password` by some other local service (no X-Request-Id — not this app). Binding to
 * 127.0.0.1 ourselves makes the kernel choose a port nobody holds on that address.
 *
 *   let server; before(async () => { server = await listenLoopback(app); }); after(() => server.close());
 *   request(server).get(...)
 */
const http = require('http');

function listenLoopback(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { listenLoopback };
