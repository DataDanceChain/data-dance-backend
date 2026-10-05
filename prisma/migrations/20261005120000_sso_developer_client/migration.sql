-- Self-serve DDC SSO partners. secretHash is sha256 of the secret; the plaintext is never stored.
CREATE TABLE "SsoDeveloperClient" (
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

CREATE UNIQUE INDEX "SsoDeveloperClient_clientId_key" ON "SsoDeveloperClient"("clientId");

CREATE INDEX "SsoDeveloperClient_contactEmail_idx" ON "SsoDeveloperClient"("contactEmail");
