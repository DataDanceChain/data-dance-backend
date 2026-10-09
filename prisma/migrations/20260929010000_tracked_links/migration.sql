-- CreateTable
CREATE TABLE "TrackedLink" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "buttonLabel" TEXT NOT NULL DEFAULT '',
    "targetUrl" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrackedLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedLinkHit" (
    "id" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "visitorId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "dest" TEXT,
    "referrerHost" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedLinkHit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TrackedLink_slug_key" ON "TrackedLink"("slug");

-- CreateIndex
CREATE INDEX "TrackedLinkHit_linkId_event_createdAt_idx" ON "TrackedLinkHit"("linkId", "event", "createdAt");

-- CreateIndex
CREATE INDEX "TrackedLinkHit_linkId_visitorId_event_idx" ON "TrackedLinkHit"("linkId", "visitorId", "event");

-- AddForeignKey
ALTER TABLE "TrackedLinkHit" ADD CONSTRAINT "TrackedLinkHit_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "TrackedLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The two live requests: an event download code, and the Reddit form behind a DataDance page.
INSERT INTO "TrackedLink" ("id", "slug", "name", "kind", "title", "body", "buttonLabel", "targetUrl", "active", "createdAt", "updatedAt")
VALUES
    (
        'link_event_app',
        'event',
        'Event app download',
        'app',
        '下载 DataDance',
        '用手机打开这个页面，即可下载 App。',
        '',
        NULL,
        true,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    ),
    (
        'link_reddit_beta',
        'reddit',
        'Reddit beta apply',
        'page',
        'DataDance beta',
        'One short form. Then you are on the list.',
        'Apply',
        'https://forms.gle/9hDn2DKauL8B4NQs8',
        true,
        CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
    );
