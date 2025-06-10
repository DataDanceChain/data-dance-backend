/*
  Warnings:

  - You are about to drop the `OrganizationTransaction` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "OrganizationTransaction" DROP CONSTRAINT "OrganizationTransaction_fromOrganizationId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationTransaction" DROP CONSTRAINT "OrganizationTransaction_toOrganizationId_fkey";

-- DropTable
DROP TABLE "OrganizationTransaction";

-- DropEnum
DROP TYPE "OrganizationTransactionStatus";

-- DropEnum
DROP TYPE "OrganizationTransactionType";
