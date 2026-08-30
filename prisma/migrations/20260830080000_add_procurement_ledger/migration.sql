-- AlterTable
ALTER TABLE "PurchaseOrder" ADD COLUMN "attestationHash" TEXT,
ADD COLUMN "attestationTxHash" TEXT,
ADD COLUMN "attestedAt" TIMESTAMP(3),
ADD COLUMN "attestationPayload" JSONB,
ADD COLUMN "pointsUnitPriceUsd" DOUBLE PRECISION,
ADD COLUMN "serviceFeeAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CommerceSettings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "pointsUnitPriceUsd" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementAllocation" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "displayName" TEXT,
    "role" TEXT,
    "points" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "userId" TEXT,
    "claimStatus" TEXT NOT NULL DEFAULT 'reserved',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementCostItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "points" DOUBLE PRECISION NOT NULL,
    "unitPriceUsd" DOUBLE PRECISION NOT NULL,
    "amountUsd" DOUBLE PRECISION NOT NULL,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementCostItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PointsRedemption" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "createdById" TEXT,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "userId" TEXT,
    "points" DOUBLE PRECISION NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDT',
    "amount" DOUBLE PRECISION NOT NULL,
    "vendor" TEXT,
    "vendorReference" TEXT,
    "proofPath" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PointsRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProcurementAllocation_orderId_idx" ON "ProcurementAllocation"("orderId");

-- CreateIndex
CREATE INDEX "ProcurementAllocation_kind_idx" ON "ProcurementAllocation"("kind");

-- CreateIndex
CREATE INDEX "ProcurementAllocation_emailNormalized_idx" ON "ProcurementAllocation"("emailNormalized");

-- CreateIndex
CREATE INDEX "ProcurementCostItem_orderId_idx" ON "ProcurementCostItem"("orderId");

-- CreateIndex
CREATE INDEX "ProcurementCostItem_kind_idx" ON "ProcurementCostItem"("kind");

-- CreateIndex
CREATE INDEX "PointsRedemption_orderId_idx" ON "PointsRedemption"("orderId");

-- CreateIndex
CREATE INDEX "PointsRedemption_emailNormalized_idx" ON "PointsRedemption"("emailNormalized");

-- CreateIndex
CREATE INDEX "PointsRedemption_status_idx" ON "PointsRedemption"("status");

-- AddForeignKey
ALTER TABLE "ProcurementAllocation" ADD CONSTRAINT "ProcurementAllocation_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementAllocation" ADD CONSTRAINT "ProcurementAllocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementCostItem" ADD CONSTRAINT "ProcurementCostItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsRedemption" ADD CONSTRAINT "PointsRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointsRedemption" ADD CONSTRAINT "PointsRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "CommerceSettings" ("id", "pointsUnitPriceUsd", "updatedAt")
VALUES ('default', 0.01, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
