CREATE TABLE "DdcOAuthCodeIssuance" (
  "codeId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "refreshHash" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DdcOAuthCodeIssuance_pkey" PRIMARY KEY ("codeId"),
  CONSTRAINT "DdcOAuthCodeIssuance_codeId_fkey"
    FOREIGN KEY ("codeId") REFERENCES "OAuthAuthorization"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "DdcOAuthCodeIssuance_expiresAt_idx" ON "DdcOAuthCodeIssuance"("expiresAt");
