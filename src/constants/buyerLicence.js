const { licenceTerms } = require('../i18n/merchantLocale');

const BUYER_LICENCE_VERSION = '2026-09-04';

const BUYER_LICENCE_TERMS = licenceTerms('en');

function hasAcceptedBuyerLicence(row) {
  return Boolean(row?.licenceAcceptedAt && row.licenceVersion === BUYER_LICENCE_VERSION);
}

module.exports = {
  BUYER_LICENCE_VERSION,
  BUYER_LICENCE_TERMS,
  licenceTerms,
  hasAcceptedBuyerLicence,
};
