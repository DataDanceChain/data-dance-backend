-- 添加新字段
ALTER TABLE "Pass" ADD COLUMN "platform" TEXT NOT NULL DEFAULT 'apple';
ALTER TABLE "Pass" ADD COLUMN "googleObjectId" TEXT;
ALTER TABLE "Pass" ADD COLUMN "googleClassId" TEXT;
ALTER TABLE "Pass" ADD COLUMN "googleAddUrl" TEXT;

-- 删除旧的唯一约束
ALTER TABLE "Pass" DROP CONSTRAINT IF EXISTS "Pass_userId_creatorId_key";

-- 添加新的唯一约束（包含 platform）
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_userId_creatorId_platform_key" UNIQUE ("userId", "creatorId", "platform");

-- 更新现有数据
UPDATE "Pass" SET "platform" = 'apple' WHERE "platform" IS NULL; 