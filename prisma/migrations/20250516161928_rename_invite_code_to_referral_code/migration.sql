/*
  Warnings:

  - You are about to drop the column `inviteCode` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[referralCode]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `referralCode` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "Referral_code_key";

-- DropIndex
DROP INDEX "User_inviteCode_key";

-- 第一步：添加 referralCode 列但允许为空
ALTER TABLE "User" ADD COLUMN "referralCode" TEXT;

-- 第二步：从 inviteCode 复制数据到 referralCode
UPDATE "User" SET "referralCode" = "inviteCode";

-- 第三步：设置 referralCode 为非空
ALTER TABLE "User" ALTER COLUMN "referralCode" SET NOT NULL;

-- 第四步：删除 inviteCode 列
ALTER TABLE "User" DROP COLUMN "inviteCode";

-- CreateIndex
CREATE UNIQUE INDEX "User_referralCode_key" ON "User"("referralCode");
