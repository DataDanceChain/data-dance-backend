/**
 * Ledger math for the November 2026 social review.
 * Unqualified social rows were paid at 10 points. Deduct those points without
 * driving the balance below zero (redeemed cards stay redeemed). An account
 * that actually loses points receives the announced 750-point goodwill.
 */

const HISTORICAL_SOCIAL_POINTS = 10;
const GOODWILL_POINTS = 750;

function round2(value) {
  return Math.round(Number(value) * 100) / 100;
}

function reviewedSocialLedger({ totalPoints, ledgerSum, crawlerPoints, crawlerRows, badSocialRows }) {
  const expectedCrawler = crawlerRows * HISTORICAL_SOCIAL_POINTS;
  if (Math.abs(round2(crawlerPoints) - expectedCrawler) > 0.01) {
    return { ok: false, reason: 'crawler points are not 10 per stored row' };
  }
  if (Math.abs(round2(ledgerSum) - round2(totalPoints)) > 0.01) {
    return { ok: false, reason: 'balance does not match the point ledger' };
  }
  if (!Number.isInteger(badSocialRows) || badSocialRows < 0 || badSocialRows > crawlerRows) {
    return { ok: false, reason: 'bad social row count is outside the stored rows' };
  }
  const badPoints = badSocialRows * HISTORICAL_SOCIAL_POINTS;
  const target = Math.max(0, round2(totalPoints - badPoints));
  const deduction = round2(totalPoints - target);
  const goodwill = deduction > 0 ? GOODWILL_POINTS : 0;
  return {
    ok: true,
    badPoints,
    target,
    deduction,
    goodwill,
    nextTotal: round2(target + goodwill),
  };
}

module.exports = {
  HISTORICAL_SOCIAL_POINTS,
  GOODWILL_POINTS,
  reviewedSocialLedger,
};
