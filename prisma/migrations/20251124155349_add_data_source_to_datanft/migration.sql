-- AlterTable: 为 DataNFT 添加 dataSource 和 dataRecords 字段
ALTER TABLE "DataNFT" 
ADD COLUMN "dataSource" TEXT NOT NULL DEFAULT 'activity',
ADD COLUMN "dataRecords" JSONB;

-- 为现有记录设置 dataSource 为 'activity'
UPDATE "DataNFT" SET "dataSource" = 'activity' WHERE "dataSource" IS NULL;

