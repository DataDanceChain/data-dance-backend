-- CreateEnum
CREATE TYPE "OrganizationTransactionType" AS ENUM ('DEPOSIT', 'WITHDRAW', 'TRANSFER');

-- CreateEnum
CREATE TYPE "OrganizationTransactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "OrganizationTransaction" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(20,6) NOT NULL,
    "type" "OrganizationTransactionType" NOT NULL,
    "status" "OrganizationTransactionStatus" NOT NULL DEFAULT 'PENDING',
    "description" TEXT,
    "fromOrganizationId" TEXT,
    "toOrganizationId" TEXT,
    "systemTransactionId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationTransaction_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "OrganizationTransaction" ADD CONSTRAINT "OrganizationTransaction_fromOrganizationId_fkey" FOREIGN KEY ("fromOrganizationId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationTransaction" ADD CONSTRAINT "OrganizationTransaction_toOrganizationId_fkey" FOREIGN KEY ("toOrganizationId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE; 