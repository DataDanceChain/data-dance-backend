CREATE TABLE "DdcAuthWindow" (
    "keyHash" CHAR(64) PRIMARY KEY,
    "state" JSONB NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL
);
CREATE INDEX "DdcAuthWindow_expiry_idx" ON "DdcAuthWindow" ("expiresAt");
