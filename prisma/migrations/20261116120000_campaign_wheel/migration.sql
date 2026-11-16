-- CreateTable
CREATE TABLE "CampaignSpin" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "prizeId" TEXT NOT NULL,
    "prizeKind" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "labelEn" TEXT NOT NULL,
    "labelZh" TEXT NOT NULL,
    "claimStatus" TEXT NOT NULL DEFAULT 'none',
    "claim" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignSpin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignSpin_campaignId_createdAt_idx" ON "CampaignSpin"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignSpin_campaignId_userId_idx" ON "CampaignSpin"("campaignId", "userId");

-- CreateIndex
CREATE INDEX "CampaignSpin_campaignId_prizeId_idx" ON "CampaignSpin"("campaignId", "prizeId");

-- AddForeignKey
ALTER TABLE "CampaignSpin" ADD CONSTRAINT "CampaignSpin_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignSpin" ADD CONSTRAINT "CampaignSpin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
