-- AlterTable
ALTER TABLE "User" ALTER COLUMN "inviteCode" SET DEFAULT substring(md5(random()::text), 1, 8);

-- CreateTable
CREATE TABLE "XPostCache" (
    "key" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "XPostCache_pkey" PRIMARY KEY ("key")
);
