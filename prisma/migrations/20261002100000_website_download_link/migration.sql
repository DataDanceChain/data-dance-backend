-- Standing download link for the official website. Same app page as the
-- Token 2049 slug, with its own opens, people, and continues.
INSERT INTO "TrackedLink" ("id", "slug", "name", "kind", "title", "body", "buttonLabel", "targetUrl", "active", "createdAt", "updatedAt")
VALUES (
    'link_website_download',
    'download',
    'Official website',
    'app',
    '下载 DataDance',
    '用手机打开这个页面，即可下载 App。',
    '',
    NULL,
    true,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("slug") DO NOTHING;

UPDATE "TrackedLink"
SET "name" = 'Token 2049', "updatedAt" = CURRENT_TIMESTAMP
WHERE "slug" = 'event' AND "name" = 'Event app download';
