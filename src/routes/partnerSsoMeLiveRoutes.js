const express = require('express');
const { readPartnerMe } = require('../services/ssoDeveloperLive');

const router = express.Router();

router.get('/me', async (req, res) => {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'A partner access token is required.' });
  }
  if (req.query && (req.query.sub !== undefined || req.query.access_token !== undefined)) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'Send the token only in the Authorization header.' });
  }
  const body = await readPartnerMe(match[1]);
  if (!body) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'The access token is invalid or expired.' });
  }
  return res.json(body);
});

module.exports = router;
