-- One ops merchant credit per Idempotency-Key.
--
-- Additive: one nullable column on "OrganizationTransaction" and a unique index over it. No
-- existing row or column changes: every existing row keeps a NULL key, and NULL keys never
-- conflict. Rollback = the previous image; the column is then simply not read.
--
--   OrganizationTransaction.idempotencyKey   the Idempotency-Key of the ops credit
--                                            (POST /api/ops/merchants/:userId/credit) that wrote
--                                            the row; NULL for every other row
--   ("userId", "idempotencyKey") unique      a second credit with the same key for the same
--                                            merchant is refused by the database, also when two
--                                            requests arrive at once
--
-- IF NOT EXISTS: when another migration has already added the column or the index, this one
-- changes nothing instead of failing.
--
-- Live database: adding the column and building the index need short locks on the table (the
-- index build blocks writes to it while it runs; every row's key is NULL, so it is quick).
-- lock_timeout makes the migration fail at once (and change nothing: it is one transaction)
-- instead of queueing behind a long reader while every later query on the table queues behind it.
-- If it fails with "canceling statement due to lock timeout", run `prisma migrate resolve
-- --rolled-back 20261016210000_merchant_credit_idempotency` and deploy again, or apply it in a
-- quiet window.

SET lock_timeout = '3s';

-- AlterTable
ALTER TABLE "OrganizationTransaction" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OrganizationTransaction_userId_idempotencyKey_key" ON "OrganizationTransaction"("userId", "idempotencyKey");

-- Later migrations in the same deploy run keep the server default.
RESET lock_timeout;
