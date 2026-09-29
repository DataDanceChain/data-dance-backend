/**
 * Stub (work package BE4 owns this file and replaces it). Every handler answers 501
 * NOT_IMPLEMENTED; nothing reaches it while DDC_AUTH_ENABLED is off (router answers 404).
 */
const { notImplemented } = require('./respond');

module.exports = {
  nonce: notImplemented,
  google: notImplemented,
  apple: notImplemented,
};
