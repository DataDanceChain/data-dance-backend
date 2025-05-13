-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "isPromoted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "promotionInfo" JSONB;
