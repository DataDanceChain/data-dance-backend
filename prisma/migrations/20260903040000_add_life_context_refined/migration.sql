-- AlterTable
ALTER TABLE "LifeContextSettings" ADD COLUMN "refinedJson" JSONB,
ADD COLUMN "refinedAt" TIMESTAMP(3),
ADD COLUMN "refinedModel" TEXT NOT NULL DEFAULT '';
