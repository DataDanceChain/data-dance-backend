/*
  Warnings:

  - You are about to drop the column `createdAt` on the `Participation` table. All the data in the column will be lost.
  - You are about to drop the column `updatedAt` on the `Participation` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Participation" DROP COLUMN "createdAt",
DROP COLUMN "updatedAt",
ADD COLUMN     "claimed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
