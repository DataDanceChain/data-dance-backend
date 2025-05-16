-- AlterTable
ALTER TABLE "User" ALTER COLUMN "inviteCode" SET DEFAULT substring(md5(random()::text), 1, 8);
