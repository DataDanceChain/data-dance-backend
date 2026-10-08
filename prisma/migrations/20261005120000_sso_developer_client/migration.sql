-- Self-serve DDC SSO partners. secretHash is sha256 of the secret; the plaintext is never stored.
--
-- IDEMPOTENT on purpose, like 20260923090000_user_legacy_referral_code: some databases already have
-- this table, created outside the migration history. There every statement below keeps the table
-- and its rows. Such a table can enforce "clientId" uniqueness with a UNIQUE constraint instead of
-- the unique index schema.prisma declares. Both carry the name "SsoDeveloperClient_clientId_key",
-- so the constraint is replaced by that index. The migration runs as one transaction, so
-- uniqueness is never off for another session, and `prisma migrate diff` stays clean.
CREATE TABLE IF NOT EXISTS "SsoDeveloperClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoDeveloperClient_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "SsoDeveloperClient" DROP CONSTRAINT IF EXISTS "SsoDeveloperClient_clientId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "SsoDeveloperClient_clientId_key" ON "SsoDeveloperClient"("clientId");

CREATE INDEX IF NOT EXISTS "SsoDeveloperClient_contactEmail_idx" ON "SsoDeveloperClient"("contactEmail");
