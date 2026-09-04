const KYC_FIELDS = [
  { key: 'companyName', label: 'Company name' },
  { key: 'brNumber', label: 'Business registration number' },
  { key: 'beneficialOwner', label: 'Beneficial owner' },
  { key: 'address', label: 'Registered address' },
  { key: 'country', label: 'Country' },
  { key: 'email', label: 'Company contact email' },
];

function filled(value) {
  return String(value || '').trim().length >= 2;
}

function missingKycFields(entity) {
  return KYC_FIELDS.filter((field) => !filled(entity?.[field.key])).map((field) => field.key);
}

function kycComplete(entity) {
  return missingKycFields(entity).length === 0;
}

function kycAllowsCredit(entity) {
  return kycComplete(entity) && entity?.kycStatus !== 'rejected';
}

function presentKyc(entity) {
  const missing = missingKycFields(entity);
  return {
    complete: missing.length === 0,
    allowsCredit: true,
    status: entity?.kycStatus || 'incomplete',
    missing,
    submittedAt: entity?.kycSubmittedAt || null,
    reviewedAt: entity?.kycReviewedAt || null,
    reviewedBy: entity?.kycReviewedBy || null,
    note: entity?.kycNote || null,
  };
}

function presentLegalEntity(entity) {
  if (!entity) {
    return {
      companyName: '',
      brNumber: '',
      taxId: '',
      beneficialOwner: '',
      address: '',
      country: '',
      email: '',
      bankName: '',
      bankAccount: '',
      currency: 'USD',
      kyc: presentKyc(null),
    };
  }
  return {
    ...entity,
    currency: 'USD',
    kyc: presentKyc(entity),
  };
}

function kycError(message = 'Complete company KYC before requesting or receiving credit.') {
  return Object.assign(new Error(message), {
    statusCode: 403,
    code: 'merchant_kyc_required',
  });
}

async function loadLegalEntity(db, userId) {
  return db.legalEntity.findUnique({ where: { userId } });
}

async function assertMerchantKyc(db, userId) {
  const entity = await loadLegalEntity(db, userId);
  if (!kycAllowsCredit(entity)) {
    throw kycError();
  }
  return entity;
}

function nextMerchantKycFields(body = {}, previous = {}) {
  const companyName = body.companyName !== undefined ? String(body.companyName || '').trim() : previous.companyName;
  const brNumber = body.brNumber !== undefined ? String(body.brNumber || '').trim() : previous.brNumber;
  const taxId = body.taxId !== undefined ? String(body.taxId || '').trim() : previous.taxId;
  const data = {
    companyName,
    brNumber,
    taxId: taxId || brNumber || previous.taxId || null,
    beneficialOwner:
      body.beneficialOwner !== undefined ? String(body.beneficialOwner || '').trim() : previous.beneficialOwner,
    address: body.address !== undefined ? String(body.address || '').trim() : previous.address,
    country: body.country !== undefined ? String(body.country || '').trim() : previous.country,
    email: body.email !== undefined ? String(body.email || '').trim() : previous.email,
    bankName: body.bankName !== undefined ? String(body.bankName || '').trim() : previous.bankName,
    bankAccount: body.bankAccount !== undefined ? String(body.bankAccount || '').trim() : previous.bankAccount,
    currency: 'USD',
  };

  const draft = { ...previous, ...data };
  if (kycComplete(draft)) {
    data.kycStatus = previous.kycStatus === 'approved' ? 'approved' : 'submitted';
    data.kycSubmittedAt = previous.kycSubmittedAt || new Date();
    if (previous.kycStatus === 'rejected') {
      data.kycReviewedAt = null;
      data.kycReviewedBy = null;
      data.kycNote = null;
    }
  } else {
    data.kycStatus = 'incomplete';
  }
  return data;
}

module.exports = {
  KYC_FIELDS,
  kycComplete,
  kycAllowsCredit,
  presentKyc,
  presentLegalEntity,
  kycError,
  loadLegalEntity,
  assertMerchantKyc,
  nextMerchantKycFields,
};
