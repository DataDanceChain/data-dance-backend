-- AlterTable
ALTER TABLE "User" ADD COLUMN     "xUsername" TEXT,
ALTER COLUMN "inviteCode" SET DEFAULT substring(md5(random()::text), 1, 8);
