-- CreateTable
CREATE TABLE "Pass" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "brandLogo" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userName" TEXT NOT NULL,
    "userWalletAddress" TEXT NOT NULL,
    "passUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Pass_userId_idx" ON "Pass"("userId");

-- CreateIndex
CREATE INDEX "Pass_brandId_idx" ON "Pass"("brandId");
