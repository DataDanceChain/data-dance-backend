/*
  Warnings:

  - You are about to drop the column `organizationId` on the `Badge` table. All the data in the column will be lost.
  - You are about to drop the `Organization` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `creatorId` to the `Badge` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Activity" DROP CONSTRAINT "Activity_creatorId_fkey";

-- DropForeignKey
ALTER TABLE "Badge" DROP CONSTRAINT "Badge_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "NFTDataAsset" DROP CONSTRAINT "NFTDataAsset_ownerId_fkey";

-- DropForeignKey
ALTER TABLE "User" DROP CONSTRAINT "User_organizationId_fkey";

-- AlterTable
ALTER TABLE "Badge" DROP COLUMN "organizationId",
ADD COLUMN     "creatorId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "description" TEXT,
ADD COLUMN     "isOrganization" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "logo" TEXT;

-- DropTable
DROP TABLE "Organization";

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Badge" ADD CONSTRAINT "Badge_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NFTDataAsset" ADD CONSTRAINT "NFTDataAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
