-- Web3Auth network switch (Sapphire devnet -> mainnet), phase 1: one record per legacy account
-- that may re-bind on its first mainnet login, plus one row per scripts/mainnetSwitch.js run.
--
-- Additive: two new tables, no change to any existing table or row. Nothing reads or writes them
-- while WEB3AUTH_NETWORK_REBIND=off (the default) and before `node scripts/mainnetSwitch.js --apply`
-- has run. Rollback = `--rollback`, then the previous image; the tables are simply no longer used.
--
-- Web3AuthNetworkRebind is also the old -> new wallet address map the chain team needs to reissue
-- what is held at the devnet addresses (oldAddress -> newAddress once status = 'rebound').
-- It is deliberately NOT feat/native-login's WalletAddressHistory: that table needs the new address
-- and subject when the row is written (a planned migration), while here they are only known when
-- the user logs in, and re-creating it on main would collide with that branch's migration.

-- CreateTable
CREATE TABLE "Web3AuthNetworkRebind" (
    "userId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fromNetwork" TEXT NOT NULL,
    "toNetwork" TEXT NOT NULL,
    "oldVerifier" TEXT,
    "oldVerifierId" TEXT,
    "oldAddress" TEXT,
    "walletPolicy" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "newVerifier" TEXT,
    "newVerifierId" TEXT,
    "newAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reboundAt" TIMESTAMP(3),

    CONSTRAINT "Web3AuthNetworkRebind_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Web3AuthNetworkRebindRun" (
    "id" TEXT NOT NULL,
    "backupTable" TEXT NOT NULL,
    "fromNetwork" TEXT NOT NULL,
    "toNetwork" TEXT NOT NULL,
    "accountCount" INTEGER NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBackAt" TIMESTAMP(3),

    CONSTRAINT "Web3AuthNetworkRebindRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Web3AuthNetworkRebind_runId_idx" ON "Web3AuthNetworkRebind"("runId");

-- CreateIndex
CREATE INDEX "Web3AuthNetworkRebind_oldAddress_idx" ON "Web3AuthNetworkRebind"("oldAddress");

-- AddForeignKey
ALTER TABLE "Web3AuthNetworkRebind" ADD CONSTRAINT "Web3AuthNetworkRebind_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Web3AuthNetworkRebind" ADD CONSTRAINT "Web3AuthNetworkRebind_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Web3AuthNetworkRebindRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Closed value sets (Prisma does not model them)
ALTER TABLE "Web3AuthNetworkRebind" ADD CONSTRAINT "Web3AuthNetworkRebind_walletPolicy_check" CHECK ("walletPolicy" IN ('replace', 'keep'));

ALTER TABLE "Web3AuthNetworkRebind" ADD CONSTRAINT "Web3AuthNetworkRebind_status_check" CHECK ("status" IN ('pending', 'rebound'));
