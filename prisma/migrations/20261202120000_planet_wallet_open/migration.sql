ALTER TABLE "SsoTicket"
  ADD COLUMN "walletOpenHash" TEXT,
  ADD COLUMN "walletOpenBrowserHash" TEXT,
  ADD COLUMN "walletOpenAuthorizationId" TEXT;

CREATE UNIQUE INDEX "SsoTicket_walletOpenHash_key" ON "SsoTicket"("walletOpenHash");
CREATE UNIQUE INDEX "SsoTicket_walletOpenAuthorizationId_key" ON "SsoTicket"("walletOpenAuthorizationId");
