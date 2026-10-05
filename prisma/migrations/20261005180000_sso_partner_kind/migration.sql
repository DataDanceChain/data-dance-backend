-- First-party partners (Data Planet) share this table. developer stays the self-serve default.
ALTER TABLE "SsoDeveloperClient" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'developer';
ALTER TABLE "SsoDeveloperClient" ADD COLUMN "ownerUserId" TEXT;
CREATE INDEX "SsoDeveloperClient_ownerUserId_idx" ON "SsoDeveloperClient"("ownerUserId");
