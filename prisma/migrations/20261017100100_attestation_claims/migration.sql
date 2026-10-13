-- Exclusive claims for chain attestations (admin issue #2).
--
-- Additive: one nullable column on "PurchaseOrder" and one on "DisbursementItem". No existing row
-- or column changes. Rollback = the previous image; the columns are then simply not read.
--
--   PurchaseOrder.attestationClaimedAt   set while one caller sends the order's attestation on
--                                        chain; a second caller sends nothing
--   DisbursementItem.reconcileClaimedAt  set while one caller runs a confirmed payout's reconcile
--                                        step (attest, mark the redemption paid)
--
-- Live database: adding a column needs a short lock on each table. As in
-- 20261017100000_ops_roles_audit, lock_timeout makes the migration fail at once (and change
-- nothing: it is one transaction) instead of queueing behind a long reader. If it fails with
-- "canceling statement due to lock timeout", run `prisma migrate resolve --rolled-back
-- 20261017100100_attestation_claims` and deploy again (docs/OPS_ADMIN.md, "Migration").

SET lock_timeout = '3s';

-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "attestationClaimedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "DisbursementItem" ADD COLUMN "reconcileClaimedAt" TIMESTAMP(3);

-- Later migrations in the same deploy run keep the server default.
RESET lock_timeout;
