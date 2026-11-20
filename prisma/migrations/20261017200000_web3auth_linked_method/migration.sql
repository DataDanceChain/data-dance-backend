-- Additional sign-in methods linked to an existing account (WEB3AUTH_LINK_TRUSTED_METHODS).
--
-- On Sapphire mainnet each login connection derives its own wallet, so one person signing in with
-- Google and with the e-mail code has two (verifier, verifierId) pairs and two wallets. The account
-- keeps its own pair and wallet on "User"; each further connection that verified the same e-mail
-- address is recorded here, with the wallet that connection derives (a record, never bound).
--
-- Additive: one new table, no change to any existing table or row. Nothing reads or writes it while
-- WEB3AUTH_LINK_TRUSTED_METHODS=off (the default). Rollback = the previous image; the table is then
-- simply not read.
--
-- Live database: the foreign key needs a short lock on "User". The lock_timeout below makes the
-- migration fail at once (and change nothing: it is one transaction) instead of waiting behind a
-- long reader while every sign-in queues behind it. If it fails with "canceling statement due to
-- lock timeout", run `prisma migrate resolve --rolled-back 20261017200000_web3auth_linked_method`
-- and deploy again, or apply it in a quiet window.

SET lock_timeout = '3s';

-- CreateTable
CREATE TABLE "Web3AuthLinkedMethod" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "verifierId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Web3AuthLinkedMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Web3AuthLinkedMethod_verifier_verifierId_key" ON "Web3AuthLinkedMethod"("verifier", "verifierId");

-- CreateIndex
CREATE INDEX "Web3AuthLinkedMethod_userId_idx" ON "Web3AuthLinkedMethod"("userId");

-- AddForeignKey
ALTER TABLE "Web3AuthLinkedMethod" ADD CONSTRAINT "Web3AuthLinkedMethod_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
