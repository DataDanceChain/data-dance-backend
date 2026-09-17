-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "internalName" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleZh" TEXT NOT NULL,
    "blurbEn" TEXT NOT NULL,
    "blurbZh" TEXT NOT NULL,
    "pillEn" TEXT,
    "pillZh" TEXT,
    "template" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "ctaKind" TEXT NOT NULL,
    "ctaValue" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT '',
    "legalText" TEXT NOT NULL DEFAULT '',
    "legalVersion" INTEGER NOT NULL DEFAULT 1,
    "coverImageUrl" TEXT,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "publishedBy" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEvent" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_slug_key" ON "Campaign"("slug");

-- CreateIndex
CREATE INDEX "Campaign_status_startsAt_endsAt_idx" ON "Campaign"("status", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "CampaignEvent_campaignId_createdAt_idx" ON "CampaignEvent"("campaignId", "createdAt");

-- AddForeignKey
ALTER TABLE "CampaignEvent" ADD CONSTRAINT "CampaignEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the existing Summer Travel home card so Earn can read it from the API.
INSERT INTO "Campaign" (
    "id",
    "slug",
    "internalName",
    "titleEn",
    "titleZh",
    "blurbEn",
    "blurbZh",
    "pillEn",
    "pillZh",
    "template",
    "status",
    "startsAt",
    "endsAt",
    "timezone",
    "ctaKind",
    "ctaValue",
    "purpose",
    "legalText",
    "legalVersion",
    "createdBy",
    "updatedBy",
    "publishedBy",
    "publishedAt",
    "updatedAt"
) VALUES (
    '3c8f0a11-6d2e-4b91-9c44-12ef34567890',
    'summer-travel-2026-home',
    'Summer Travel 2026 home card',
    'Summer Payback',
    '夏季回馈',
    'Double points on every summer stay, plus bonus points inside.',
    '夏季住宿双倍积分，活动内还有额外奖励。',
    'Ends Sep 30',
    '截至 9 月 30 日',
    'HOME_CARD',
    'SCHEDULED',
    '2026-08-03T07:00:00.000Z',
    '2026-10-01T06:59:59.999Z',
    'America/Los_Angeles',
    'ROUTE',
    '/user/summer-travel',
    'Surface the live Summer Travel 2026 stay-bonus campaign on Earn home cards.',
    'Existing Summer Travel 2026 rules apply. Eligibility, double points on qualifying stays, and bonus points are unchanged. This card only controls whether the campaign is shown on Earn.',
    1,
    'migration',
    'migration',
    'migration',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
);

INSERT INTO "CampaignEvent" (
    "id",
    "campaignId",
    "actor",
    "action",
    "toStatus",
    "note"
) VALUES (
    '4d9f1b22-7e3f-5c02-ad55-23fa45678901',
    '3c8f0a11-6d2e-4b91-9c44-12ef34567890',
    'migration',
    'seed',
    'SCHEDULED',
    'Imported the hardcoded Summer Travel Earn card'
);
