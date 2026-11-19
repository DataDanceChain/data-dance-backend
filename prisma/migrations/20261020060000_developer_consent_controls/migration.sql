-- Existing clients are deliberately NOT opted in. Image rollback leaves additive fields unused.
BEGIN;
SET LOCAL lock_timeout = '3s';
ALTER TABLE "SsoDeveloperClient"
  ADD COLUMN "skipConfirmationEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "skipConfirmationOwnerUserId" TEXT;
ALTER TABLE "UserRoleGrant" DROP CONSTRAINT "UserRoleGrant_role_check";
ALTER TABLE "UserRoleGrant" ADD CONSTRAINT "UserRoleGrant_role_check"
  CHECK ("role" IN ('ddc_admin', 'operator', 'developer', 'trusted_developer'));
COMMIT;
