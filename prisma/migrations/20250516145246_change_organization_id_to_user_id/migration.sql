/*
  Warnings:

  - You are about to drop the column `fromOrganizationId` on the `OrganizationTransaction` table. All the data in the column will be lost.
  - You are about to drop the column `toOrganizationId` on the `OrganizationTransaction` table. All the data in the column will be lost.
  - Added the required column `userId` to the `OrganizationTransaction` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "OrganizationTransaction" DROP COLUMN "fromOrganizationId",
DROP COLUMN "toOrganizationId",
ADD COLUMN     "userId" TEXT NOT NULL;

-- AddForeignKey
ALTER TABLE "OrganizationTransaction" ADD CONSTRAINT "OrganizationTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
