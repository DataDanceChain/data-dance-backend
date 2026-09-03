const prisma = require('../utils/prisma');
const { DEFAULT_BOUNDARIES, isLifePrivacyLevel } = require('../constants/lifeContext');
const { asRefined } = require('./lifeContextGemini');

function serializeSettings(row) {
  return {
    privacyLevel: row && isLifePrivacyLevel(row.privacyLevel) ? row.privacyLevel : 'transparent',
    customBoundaries: row?.customBoundaries || DEFAULT_BOUNDARIES,
    aboutMe: row?.aboutMe || '',
    updatedAt: row?.updatedAt || null,
    refined: asRefined(row?.refinedJson),
    refinedAt: row?.refinedAt || null,
    refinedModel: row?.refinedModel || '',
  };
}

async function getSettings(userId) {
  const row = await prisma.lifeContextSettings.findUnique({
    where: { userId },
  });
  return serializeSettings(row);
}

async function upsertSettings(userId, patch) {
  const current = await getSettings(userId);
  const privacyLevel = isLifePrivacyLevel(patch.privacyLevel) ? patch.privacyLevel : current.privacyLevel;
  const customBoundaries =
    typeof patch.customBoundaries === 'string'
      ? patch.customBoundaries.slice(0, 4000)
      : current.customBoundaries;
  const aboutMe =
    typeof patch.aboutMe === 'string' ? patch.aboutMe.slice(0, 800) : current.aboutMe;
  const row = await prisma.lifeContextSettings.upsert({
    where: { userId },
    create: { userId, privacyLevel, customBoundaries, aboutMe },
    update: { privacyLevel, customBoundaries, aboutMe },
  });
  return serializeSettings(row);
}

async function saveRefined(userId, refined, model) {
  const current = await getSettings(userId);
  const row = await prisma.lifeContextSettings.upsert({
    where: { userId },
    create: {
      userId,
      privacyLevel: current.privacyLevel,
      customBoundaries: current.customBoundaries,
      aboutMe: current.aboutMe,
      refinedJson: refined,
      refinedAt: new Date(),
      refinedModel: model || '',
    },
    update: {
      refinedJson: refined,
      refinedAt: new Date(),
      refinedModel: model || '',
    },
  });
  return serializeSettings(row);
}

module.exports = {
  getSettings,
  upsertSettings,
  saveRefined,
};
