SET lock_timeout = '3s';
CREATE TABLE "DeveloperHostSession" (
  "id" TEXT NOT NULL PRIMARY KEY, "tokenHash" TEXT NOT NULL UNIQUE,
  "environment" TEXT NOT NULL CHECK ("environment" IN ('mainnet','devnet')),
  "issuer" TEXT NOT NULL, "callbackUri" TEXT NOT NULL, "generation" INTEGER NOT NULL DEFAULT 0,
  "activeRequestId" TEXT, "userId" TEXT REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "authClaims" JSONB, "grantedScopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "authenticationExpiresAt" TIMESTAMP(3), "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DeveloperHostSession_expiresAt_idx" ON "DeveloperHostSession"("expiresAt");
CREATE INDEX "DeveloperHostSession_userId_idx" ON "DeveloperHostSession"("userId");
CREATE TABLE "DeveloperHostRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "DeveloperHostSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "generation" INTEGER NOT NULL, "challenge" TEXT NOT NULL, "state" TEXT NOT NULL,
  "requestedScopes" TEXT[] NOT NULL, "userId" TEXT, "authClaims" JSONB,
  "codeHash" TEXT UNIQUE, "codeExpiresAt" TIMESTAMP(3), "consumedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "DeveloperHostRequest_sessionId_generation_idx" ON "DeveloperHostRequest"("sessionId","generation");
CREATE INDEX "DeveloperHostRequest_expiresAt_idx" ON "DeveloperHostRequest"("expiresAt");
