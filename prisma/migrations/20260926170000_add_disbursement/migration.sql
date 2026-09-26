-- CreateTable
CREATE TABLE "DisbursementPartner" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisbursementPartner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisbursementBatch" (
    "id" TEXT NOT NULL,
    "partnerId" TEXT,
    "origin" TEXT NOT NULL,
    "externalBatchId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "totalAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisbursementBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DisbursementItem" (
    "id" TEXT NOT NULL,
    "payoutId" TEXT NOT NULL,
    "batchId" TEXT,
    "partnerId" TEXT,
    "origin" TEXT NOT NULL,
    "recordClass" TEXT NOT NULL,
    "countsAsDataUpload" BOOLEAN NOT NULL DEFAULT false,
    "countsAsDataTrade" BOOLEAN NOT NULL DEFAULT false,
    "externalUserRef" TEXT,
    "email" TEXT,
    "emailNormalized" TEXT,
    "userId" TEXT,
    "redemptionId" TEXT,
    "walletAddress" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "asset" TEXT NOT NULL DEFAULT 'USDT',
    "chainId" INTEGER NOT NULL DEFAULT 56,
    "tokenAddress" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'accepted',
    "txHash" TEXT,
    "attestationHash" TEXT,
    "attestationTxHash" TEXT,
    "attestationPayload" JSONB,
    "attestedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "submittedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisbursementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementPartner_slug_key" ON "DisbursementPartner"("slug");

-- CreateIndex
CREATE INDEX "DisbursementBatch_origin_idx" ON "DisbursementBatch"("origin");

-- CreateIndex
CREATE INDEX "DisbursementBatch_status_idx" ON "DisbursementBatch"("status");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementBatch_partnerId_externalBatchId_key" ON "DisbursementBatch"("partnerId", "externalBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementItem_payoutId_key" ON "DisbursementItem"("payoutId");

-- CreateIndex
CREATE UNIQUE INDEX "DisbursementItem_redemptionId_key" ON "DisbursementItem"("redemptionId");

-- CreateIndex
CREATE INDEX "DisbursementItem_origin_idx" ON "DisbursementItem"("origin");

-- CreateIndex
CREATE INDEX "DisbursementItem_recordClass_idx" ON "DisbursementItem"("recordClass");

-- CreateIndex
CREATE INDEX "DisbursementItem_status_idx" ON "DisbursementItem"("status");

-- CreateIndex
CREATE INDEX "DisbursementItem_partnerId_idx" ON "DisbursementItem"("partnerId");

-- CreateIndex
CREATE INDEX "DisbursementItem_emailNormalized_idx" ON "DisbursementItem"("emailNormalized");

-- AddForeignKey
ALTER TABLE "DisbursementBatch" ADD CONSTRAINT "DisbursementBatch_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "DisbursementPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisbursementItem" ADD CONSTRAINT "DisbursementItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "DisbursementBatch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisbursementItem" ADD CONSTRAINT "DisbursementItem_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "DisbursementPartner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisbursementItem" ADD CONSTRAINT "DisbursementItem_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DisbursementItem" ADD CONSTRAINT "DisbursementItem_redemptionId_fkey" FOREIGN KEY ("redemptionId") REFERENCES "PointsRedemption"("id") ON DELETE SET NULL ON UPDATE CASCADE;
