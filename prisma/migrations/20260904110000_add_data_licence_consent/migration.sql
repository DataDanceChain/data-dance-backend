-- CreateTable
CREATE TABLE "DataLicenceConsent" (
    "userId" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "withdrawnAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'connect',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataLicenceConsent_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "DataLicenceConsent" ADD CONSTRAINT "DataLicenceConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
