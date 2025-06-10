-- AlterTable
ALTER TABLE "DataNFTPurchase" ADD COLUMN     "quantity" INTEGER NOT NULL DEFAULT 1;

-- CreateIndex
CREATE INDEX "DataNFTPurchase_dataNFTId_buyerId_idx" ON "DataNFTPurchase"("dataNFTId", "buyerId");
