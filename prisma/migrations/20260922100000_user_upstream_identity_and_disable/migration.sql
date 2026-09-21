-- AlterTable
ALTER TABLE "User" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "web3authLinkedAt" TIMESTAMP(3),
ADD COLUMN     "web3authVerifier" TEXT,
ADD COLUMN     "web3authVerifierId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_web3authVerifier_web3authVerifierId_key" ON "User"("web3authVerifier", "web3authVerifierId");
