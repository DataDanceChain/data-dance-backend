-- AlterTable
ALTER TABLE "Referral" ADD COLUMN     "campaignSlug" TEXT;

-- CreateIndex
CREATE INDEX "Referral_inviterId_campaignSlug_idx" ON "Referral"("inviterId", "campaignSlug");
