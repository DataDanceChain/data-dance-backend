-- CreateTable
CREATE TABLE "DataDemand" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "buyerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'submitted',
    "category" TEXT,
    "region" TEXT,
    "recordCount" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "bidUsd" DOUBLE PRECISION NOT NULL,
    "deadline" TIMESTAMP(3),
    "similarPackId" TEXT,
    "quotedCount" INTEGER,
    "quotedPriceUsd" DOUBLE PRECISION,
    "quoteNote" TEXT,
    "quoteExpiresAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "dataNFTId" TEXT,
    "purchaseId" TEXT,
    "orderId" TEXT,

    CONSTRAINT "DataDemand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemandEvent" (
    "id" TEXT NOT NULL,
    "demandId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemandEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DataDemand_buyerId_createdAt_idx" ON "DataDemand"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "DataDemand_status_createdAt_idx" ON "DataDemand"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DemandEvent_demandId_createdAt_idx" ON "DemandEvent"("demandId", "createdAt");

-- AddForeignKey
ALTER TABLE "DataDemand" ADD CONSTRAINT "DataDemand_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataDemand" ADD CONSTRAINT "DataDemand_dataNFTId_fkey" FOREIGN KEY ("dataNFTId") REFERENCES "DataNFT"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemandEvent" ADD CONSTRAINT "DemandEvent_demandId_fkey" FOREIGN KEY ("demandId") REFERENCES "DataDemand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
