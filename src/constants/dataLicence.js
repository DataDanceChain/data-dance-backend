const DATA_LICENCE_POLICY_VERSION = '2026-09-04';

function serializeConsent(row) {
  const granted = Boolean(row && !row.withdrawnAt && row.policyVersion === DATA_LICENCE_POLICY_VERSION);
  return {
    granted,
    policyVersion: DATA_LICENCE_POLICY_VERSION,
    acceptedVersion: row?.policyVersion || null,
    grantedAt: row?.grantedAt || null,
    withdrawnAt: row?.withdrawnAt || null,
  };
}

module.exports = {
  DATA_LICENCE_POLICY_VERSION,
  serializeConsent,
};
