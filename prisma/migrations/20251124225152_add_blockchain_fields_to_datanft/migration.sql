-- AlterTable
ALTER TABLE "DataNFT" ADD COLUMN "blockchainTokenId" TEXT,
ADD COLUMN "blockchainTxHash" TEXT,
ADD COLUMN "blockchainRecordedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "DataNFT_blockchainTokenId_key" ON "DataNFT"("blockchainTokenId");
