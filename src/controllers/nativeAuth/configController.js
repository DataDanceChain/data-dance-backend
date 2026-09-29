/**
 * GET /api/auth/native/config → LoginConfig (§2.3). Public values only. Reached only while
 * DDC_AUTH_ENABLED=true; the router answers 404 NATIVE_AUTH_DISABLED (data {enabled:false}) before.
 */
const { buildLoginConfig, readNativeAuthConfig } = require('../../services/nativeAuth/config');
const { sendSuccess } = require('./respond');

function getConfig(req, res) {
  return sendSuccess(res, buildLoginConfig(readNativeAuthConfig()));
}

module.exports = { getConfig };
