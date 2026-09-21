#!/usr/bin/env node
/**
 * Generates a fresh partner (TGE) client secret and the sha256 the server stores.
 *
 *   node scripts/genPartnerSecret.js
 *
 * Prints once, writes nothing. Hand the SECRET to the partner over the agreed channel; put
 * only the SHA256 into the server environment (SSO_TGE_CLIENT_SECRET_SHA256). To rotate,
 * move the current hash to SSO_TGE_CLIENT_SECRET_SHA256_PREVIOUS, set the new hash, and set
 * SSO_TGE_SECRET_ROTATION_UNTIL to when the old secret must stop working.
 */
const crypto = require('crypto');

const secret = crypto.randomBytes(32).toString('base64url');
const sha256 = crypto.createHash('sha256').update(secret).digest('hex');

process.stdout.write(
  [
    '# Give this to the partner (once, out of band). It is not stored anywhere by DataDance:',
    `client_secret=${secret}`,
    '',
    '# Put this in the server environment:',
    `SSO_TGE_CLIENT_SECRET_SHA256=${sha256}`,
    '',
  ].join('\n'),
);
