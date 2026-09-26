const ORIGIN_PARTNER_VOLUME = 'partner_volume';
const ORIGIN_INTERNAL_REWARD = 'internal_reward';

const RECORD_PARTNER_VOLUME = 'partner_volume';
const RECORD_INTERNAL_REWARD = 'internal_reward_settlement';
const RECORD_DATA_UPLOAD = 'data_upload';

const RECEIPT_SCHEMA = 'datadance.disbursement.receipt.v1';

function recordClassForOrigin(origin) {
  if (origin === ORIGIN_PARTNER_VOLUME) return RECORD_PARTNER_VOLUME;
  if (origin === ORIGIN_INTERNAL_REWARD) return RECORD_INTERNAL_REWARD;
  return '';
}

function countsAsDataUpload(record) {
  return Boolean(
    record
    && record.recordClass === RECORD_DATA_UPLOAD
    && record.countsAsDataUpload === true,
  );
}

function isPartnerVolume(record) {
  return Boolean(
    record
    && record.origin === ORIGIN_PARTNER_VOLUME
    && record.recordClass === RECORD_PARTNER_VOLUME
    && record.countsAsDataUpload !== true
    && record.countsAsDataTrade !== true,
  );
}

function assertSeparateFromDataUploads(record) {
  if (!record) {
    throw Object.assign(new Error('Disbursement record is missing'), { statusCode: 400, code: 'disbursement_missing' });
  }
  if (record.origin === ORIGIN_PARTNER_VOLUME && countsAsDataUpload(record)) {
    throw Object.assign(
      new Error('Partner volume cannot be stored as a data upload'),
      { statusCode: 409, code: 'partner_volume_not_data_upload' },
    );
  }
  if (record.countsAsDataTrade === true || record.recordClass === RECORD_DATA_UPLOAD) {
    throw Object.assign(
      new Error('A disbursement receipt cannot be recorded as a data trade'),
      { statusCode: 409, code: 'disbursement_not_data_trade' },
    );
  }
}

module.exports = {
  ORIGIN_PARTNER_VOLUME,
  ORIGIN_INTERNAL_REWARD,
  RECORD_PARTNER_VOLUME,
  RECORD_INTERNAL_REWARD,
  RECORD_DATA_UPLOAD,
  RECEIPT_SCHEMA,
  recordClassForOrigin,
  countsAsDataUpload,
  isPartnerVolume,
  assertSeparateFromDataUploads,
};
