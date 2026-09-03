const { createLogger } = require('../utils/logger');
const { isLifePrivacyLevel, mcpEndpointUrl, publicBaseUrl } = require('../constants/lifeContext');
const { getSettings, upsertSettings, saveRefined } = require('../services/lifeContextSettings');
const { asRefined } = require('../services/lifeContextGemini');
const { loadPortrait, loadVault, refinePortrait } = require('../services/lifeContextDistill');
const { issueMcpToken, listMcpTokens, revokeMcpToken } = require('../services/mcpTokenService');

const logger = createLogger('lifeContextController');

async function serializeStatus(req, userId) {
  const [settings, portrait, vault] = await Promise.all([
    getSettings(userId),
    loadPortrait(userId),
    loadVault(userId),
  ]);
  return {
    privacyLevel: settings.privacyLevel,
    customBoundaries: settings.customBoundaries,
    aboutMe: settings.aboutMe,
    updatedAt: settings.updatedAt,
    recordCount: portrait.recordCount,
    lastSyncedAt: portrait.lastSyncedAt,
    publicProfile: portrait.publicProfile,
    platforms: portrait.platforms,
    shoppingThemes: portrait.shoppingThemes,
    travelPlaces: portrait.travelPlaces,
    eventThemes: portrait.eventThemes,
    sampleTitles: portrait.sampleTitles,
    cadence: portrait.cadence,
    precision: portrait.precision,
    vault,
    refined: settings.refined,
    refinedAt: settings.refinedAt,
    refinedModel: settings.refinedModel,
    mcpUrl: mcpEndpointUrl(req),
    oauth: {
      authorizationServer: publicBaseUrl(req),
      authorizationEndpoint: `${publicBaseUrl(req)}/oauth/authorize`,
    },
  };
}

async function getStatus(req, res) {
  try {
    res.json({ status: 'success', data: await serializeStatus(req, req.user.id) });
  } catch (error) {
    logger.error('getStatus failed', error);
    res.status(500).json({ status: 'error', message: 'Could not load Connect AI status.' });
  }
}

async function updateSettings(req, res) {
  try {
    const privacyLevel = isLifePrivacyLevel(req.body?.privacyLevel) ? req.body.privacyLevel : undefined;
    const customBoundaries =
      typeof req.body?.customBoundaries === 'string' ? req.body.customBoundaries : undefined;
    const aboutMe = typeof req.body?.aboutMe === 'string' ? req.body.aboutMe : undefined;
    if (!privacyLevel && customBoundaries === undefined && aboutMe === undefined) {
      return res.status(400).json({ status: 'error', message: 'No settings to update.' });
    }
    await upsertSettings(req.user.id, { privacyLevel, customBoundaries, aboutMe });
    res.json({ status: 'success', data: await serializeStatus(req, req.user.id) });
  } catch (error) {
    logger.error('updateSettings failed', error);
    res.status(500).json({ status: 'error', message: 'Could not save Connect AI settings.' });
  }
}

async function getTokens(req, res) {
  try {
    const tokens = await listMcpTokens(req.user.id);
    res.json({ status: 'success', data: { tokens } });
  } catch (error) {
    logger.error('getTokens failed', error);
    res.status(500).json({ status: 'error', message: 'Could not list tokens.' });
  }
}

async function createToken(req, res) {
  try {
    const issued = await issueMcpToken(req.user.id, req.body?.label);
    res.json({ status: 'success', data: issued });
  } catch (error) {
    logger.error('createToken failed', error);
    res.status(500).json({ status: 'error', message: 'Could not create token.' });
  }
}

async function postSavedRefined(req, res) {
  try {
    const refined = asRefined(req.body?.refined);
    if (!refined) {
      return res.status(400).json({ status: 'error', message: 'No extract to save.' });
    }
    const model = typeof req.body?.model === 'string' ? req.body.model.slice(0, 80) : '';
    await saveRefined(req.user.id, refined, model);
    res.json({ status: 'success', data: await serializeStatus(req, req.user.id) });
  } catch (error) {
    logger.error('postSavedRefined failed', error);
    res.status(500).json({ status: 'error', message: 'Could not save extract.' });
  }
}

async function postRefine(req, res) {
  try {
    const language = typeof req.body?.language === 'string' ? req.body.language : 'en';
    await refinePortrait(req.user.id, language);
    res.json({ status: 'success', data: await serializeStatus(req, req.user.id) });
  } catch (error) {
    logger.error('postRefine failed', error);
    if (error.code === 'NO_TRACES') {
      return res.status(400).json({ status: 'error', message: error.message });
    }
    if (error.code === 'NO_GEMINI') {
      return res.status(503).json({ status: 'error', message: error.message });
    }
    res.status(502).json({ status: 'error', message: error.message || 'Could not extract a portrait.' });
  }
}

async function deleteToken(req, res) {
  try {
    const ok = await revokeMcpToken(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ status: 'error', message: 'Token not found.' });
    res.json({ status: 'success', data: { ok: true } });
  } catch (error) {
    logger.error('deleteToken failed', error);
    res.status(500).json({ status: 'error', message: 'Could not revoke token.' });
  }
}

module.exports = {
  getStatus,
  updateSettings,
  getTokens,
  createToken,
  deleteToken,
  postRefine,
  postSavedRefined,
};
