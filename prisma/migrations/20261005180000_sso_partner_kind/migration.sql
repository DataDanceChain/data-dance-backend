-- First-party partners (Data Planet) share this table. developer stays the self-serve default.
--
-- IDEMPOTENT on purpose, like 20261005120000_sso_developer_client: where the table was created
-- outside the migration history, these two columns can already exist, with exactly these types and
-- defaults. There each statement is a no-op and the rows stay. The owner index is created either way.
ALTER TABLE "SsoDeveloperClient" ADD COLUMN IF NOT EXISTS "kind" TEXT NOT NULL DEFAULT 'developer';
ALTER TABLE "SsoDeveloperClient" ADD COLUMN IF NOT EXISTS "ownerUserId" TEXT;
CREATE INDEX IF NOT EXISTS "SsoDeveloperClient_ownerUserId_idx" ON "SsoDeveloperClient"("ownerUserId");
