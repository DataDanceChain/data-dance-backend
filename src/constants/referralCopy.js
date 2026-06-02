/**
 * Referral program rules (mirrors frontend src/constants/referralCopy.ts).
 * Exposed via referral status/overview APIs for clients that prefer server copy.
 */

const REFERRAL_RULES_TITLE = 'Referral Rules';

const REFERRAL_RULES = [
  'Referral rewards will only be granted after the invited user completes their first valid upload.',
  'Invited users can unlock part of their Welcome Bonus after completing their first valid upload.',
  'Fake accounts, self-referrals, repeated registrations, scripts, or other abusive behaviors are not allowed. Rewards may be canceled if abnormal activity is detected.',
  'DataDance Wallet Team reserves the final interpretation rights of this program.',
];

const REFERRAL_RULES_CONTACT = {
  label: 'Questions?',
  email: 'contact@datadance.com',
  telegramHandle: '@datadancechain',
  telegramUrl: 'https://t.me/datadancechain',
};

function getReferralRulesPayload() {
  return {
    title: REFERRAL_RULES_TITLE,
    rules: REFERRAL_RULES,
    contact: REFERRAL_RULES_CONTACT,
  };
}

module.exports = {
  REFERRAL_RULES_TITLE,
  REFERRAL_RULES,
  REFERRAL_RULES_CONTACT,
  getReferralRulesPayload,
};
