CREATE TABLE "CampaignCalendarOpen" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "labelEn" TEXT NOT NULL,
    "labelZh" TEXT NOT NULL,
    "claimStatus" TEXT NOT NULL DEFAULT 'none',
    "claim" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignCalendarOpen_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CampaignCalendarOpen_campaignId_userId_day_key" ON "CampaignCalendarOpen"("campaignId", "userId", "day");
CREATE INDEX "CampaignCalendarOpen_campaignId_createdAt_idx" ON "CampaignCalendarOpen"("campaignId", "createdAt");

ALTER TABLE "CampaignCalendarOpen" ADD CONSTRAINT "CampaignCalendarOpen_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CampaignCalendarOpen" ADD CONSTRAINT "CampaignCalendarOpen_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
