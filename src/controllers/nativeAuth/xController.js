/**
 * Stub (work package BE5 owns this file and replaces it). Every handler answers 501
 * NOT_IMPLEMENTED; nothing reaches it while DDC_AUTH_ENABLED is off (router answers 404).
 */
const { notImplemented } = require('./respond');

module.exports = {
  start: notImplemented,
  callback: notImplemented,
  exchange: notImplemented,
};
