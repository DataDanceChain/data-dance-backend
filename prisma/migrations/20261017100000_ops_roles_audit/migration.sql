-- Operator accounts, roles and the ops audit log (admin issue #2).
--
-- Additive: two nullable columns on "User" and four new tables. No existing row or column changes.
-- The legacy "Role" / "Permission" / "UserRole" tables are untouched and stay unused.
-- Rollback = the previous image; the new columns and tables are then simply not read.
--
--   UserRoleGrant     one row per active grant (ddc_admin | operator | developer); revoke deletes it
--   OpsAuditLog       append-only: no route updates or deletes a row; no foreign keys, so rows
--                     outlive the users they name
--   OpsSignInCode     the single-use hand-off code from the developer console to the ops site;
--                     only its sha256 is stored
--   IdentityConflict  sign-ins refused by web3authIdentity.resolveUser; no e-mail, verifierId or
--                     wallet address is stored

-- AlterTable
ALTER TABLE "User" ADD COLUMN "disabledBy" TEXT,
ADD COLUMN "disabledReason" TEXT;

-- CreateTable
CREATE TABLE "UserRoleGrant" (
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" TEXT,
    "grantedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,

    CONSTRAINT "UserRoleGrant_pkey" PRIMARY KEY ("userId","role")
);

-- CreateTable
CREATE TABLE "OpsAuditLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorKind" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "reason" TEXT,
    "detail" JSONB,
    "surface" TEXT NOT NULL,
    "requestId" TEXT,

    CONSTRAINT "OpsAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OpsSignInCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpsSignInCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdentityConflict" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "candidateBy" TEXT,
    "candidateUserId" TEXT,
    "verifier" TEXT NOT NULL,

    CONSTRAINT "IdentityConflict_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserRoleGrant_role_idx" ON "UserRoleGrant"("role");

-- CreateIndex
CREATE INDEX "OpsAuditLog_createdAt_idx" ON "OpsAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "OpsAuditLog_targetType_targetId_createdAt_idx" ON "OpsAuditLog"("targetType", "targetId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAuditLog_actorUserId_createdAt_idx" ON "OpsAuditLog"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "OpsAuditLog_action_createdAt_idx" ON "OpsAuditLog"("action", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OpsSignInCode_codeHash_key" ON "OpsSignInCode"("codeHash");

-- CreateIndex
CREATE INDEX "OpsSignInCode_expiresAt_idx" ON "OpsSignInCode"("expiresAt");

-- CreateIndex
CREATE INDEX "IdentityConflict_createdAt_idx" ON "IdentityConflict"("createdAt");

-- CreateIndex
CREATE INDEX "IdentityConflict_candidateUserId_createdAt_idx" ON "IdentityConflict"("candidateUserId", "createdAt");

-- CreateIndex
CREATE INDEX "IdentityConflict_reason_createdAt_idx" ON "IdentityConflict"("reason", "createdAt");

-- AddForeignKey
ALTER TABLE "UserRoleGrant" ADD CONSTRAINT "UserRoleGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OpsSignInCode" ADD CONSTRAINT "OpsSignInCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed value sets (Prisma does not model them)
ALTER TABLE "UserRoleGrant" ADD CONSTRAINT "UserRoleGrant_role_check" CHECK ("role" IN ('ddc_admin', 'operator', 'developer'));

ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "OpsAuditLog_actorKind_check" CHECK ("actorKind" IN ('user', 'shared', 'system'));

ALTER TABLE "OpsAuditLog" ADD CONSTRAINT "OpsAuditLog_surface_check" CHECK ("surface" IN ('ops', 'console', 'script'));

ALTER TABLE "IdentityConflict" ADD CONSTRAINT "IdentityConflict_route_check" CHECK ("route" IN ('network_rebind', 'backfill', 'create'));
