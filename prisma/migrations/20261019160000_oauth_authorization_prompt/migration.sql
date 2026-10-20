-- Persist explicit partner account selection independently of the browser's URL.
-- Nullable and additive: existing requests retain their previous ordinary consent behavior.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "OAuthAuthorization" ADD COLUMN "prompt" TEXT;
COMMIT;
