-- DropIndex
DROP INDEX "Pass_userId_creatorId_key";

-- CreateTable
CREATE TABLE "NftMarketOrder" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price" DOUBLE PRECISION NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NftMarketOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Snapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "activityId" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,

    CONSTRAINT "Snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataNFT" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION NOT NULL,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "maxSales" INTEGER NOT NULL DEFAULT 1,
    "currentSales" INTEGER NOT NULL DEFAULT 0,
    "merchantId" TEXT NOT NULL,

    CONSTRAINT "DataNFT_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataNFTPurchase" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataNFTId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,

    CONSTRAINT "DataNFTPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_SnapshotToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_DataNFTToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "_DataNFTToSnapshot" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "NftMarketOrder_userId_idx" ON "NftMarketOrder"("userId");

-- CreateIndex
CREATE INDEX "NftMarketOrder_activityId_idx" ON "NftMarketOrder"("activityId");

-- CreateIndex
CREATE UNIQUE INDEX "_SnapshotToTag_AB_unique" ON "_SnapshotToTag"("A", "B");

-- CreateIndex
CREATE INDEX "_SnapshotToTag_B_index" ON "_SnapshotToTag"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_DataNFTToTag_AB_unique" ON "_DataNFTToTag"("A", "B");

-- CreateIndex
CREATE INDEX "_DataNFTToTag_B_index" ON "_DataNFTToTag"("B");

-- CreateIndex
CREATE UNIQUE INDEX "_DataNFTToSnapshot_AB_unique" ON "_DataNFTToSnapshot"("A", "B");

-- CreateIndex
CREATE INDEX "_DataNFTToSnapshot_B_index" ON "_DataNFTToSnapshot"("B");

-- AddForeignKey
ALTER TABLE "NftMarketOrder" ADD CONSTRAINT "NftMarketOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NftMarketOrder" ADD CONSTRAINT "NftMarketOrder_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Snapshot" ADD CONSTRAINT "Snapshot_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataNFT" ADD CONSTRAINT "DataNFT_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataNFTPurchase" ADD CONSTRAINT "DataNFTPurchase_dataNFTId_fkey" FOREIGN KEY ("dataNFTId") REFERENCES "DataNFT"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataNFTPurchase" ADD CONSTRAINT "DataNFTPurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SnapshotToTag" ADD CONSTRAINT "_SnapshotToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "ActivityTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SnapshotToTag" ADD CONSTRAINT "_SnapshotToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DataNFTToTag" ADD CONSTRAINT "_DataNFTToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "ActivityTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DataNFTToTag" ADD CONSTRAINT "_DataNFTToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "DataNFT"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DataNFTToSnapshot" ADD CONSTRAINT "_DataNFTToSnapshot_A_fkey" FOREIGN KEY ("A") REFERENCES "DataNFT"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DataNFTToSnapshot" ADD CONSTRAINT "_DataNFTToSnapshot_B_fkey" FOREIGN KEY ("B") REFERENCES "Snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;
