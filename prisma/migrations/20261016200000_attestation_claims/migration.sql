-- Exclusive claims for chain attestations and payout reconciles.
--
-- Additive: one nullable column on "PurchaseOrder" and one on "DisbursementItem". No existing row
-- or column changes. Rollback = the previous image; the columns are then simply not read.
--
--   PurchaseOrder.attestationClaimedAt   set while one caller sends the order's attestation on
--                                        chain; a second caller sends nothing
--   DisbursementItem.reconcileClaimedAt  set while one caller runs a confirmed payout's reconcile
--                                        step (attest, mark the redemption paid)
--
-- IF NOT EXISTS: when another migration has already added these two columns, this one changes
-- nothing instead of failing.
--
-- Live database: adding a column needs a short lock on each table. lock_timeout makes the
-- migration fail at once (and change nothing: it is one transaction) instead of queueing behind a
-- long reader while every later query on the table queues behind it. If it fails with "canceling
-- statement due to lock timeout", run `prisma migrate resolve --rolled-back
-- 20261016200000_attestation_claims` and deploy again, or apply it in a quiet window.

SET lock_timeout = '3s';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN IF NOT EXISTS "attestationClaimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DisbursementItem" ADD COLUMN IF NOT EXISTS "reconcileClaimedAt" TIMESTAMP(3);

-- Later migrations in the same deploy run keep the server default.
RESET lock_timeout;
