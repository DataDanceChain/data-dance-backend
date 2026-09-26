-- Bind an authorization request to the browser that started it (authorization request fixation).
--
-- GET /oauth/authorize sets a `__Host-ddc_authz` cookie carrying a high-entropy initiator nonce
-- and stores its sha256 here; POST /api/oauth/consent must present the same nonce before a code
-- is minted. Additive and nullable: rows written by the previous image carry NULL and stay
-- usable (unbound), so the deploy and the rollback are both safe.

-- AlterTable
ALTER TABLE "OAuthAuthorization" ADD COLUMN "initiatorHash" TEXT;
ALTER TABLE "OAuthAuthorization" ADD COLUMN "initiatorBoundAt" TIMESTAMP(3);
ALTER TABLE "OAuthAuthorization" ADD COLUMN "initiatorMismatchCount" INTEGER NOT NULL DEFAULT 0;
