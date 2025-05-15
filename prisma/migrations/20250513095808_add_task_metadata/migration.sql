/*
  Warnings:

  - A unique constraint covering the columns `[xid]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "metadata" JSONB DEFAULT '{}';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "xAccessToken" TEXT,
ADD COLUMN     "xRefreshToken" TEXT,
ADD COLUMN     "xid" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_xid_key" ON "User"("xid");
