-- AlterTable
ALTER TABLE "User" 
  ALTER COLUMN "password" DROP NOT NULL,
  ADD COLUMN "authType" TEXT NOT NULL DEFAULT 'traditional',
  ADD COLUMN "userType" TEXT NOT NULL DEFAULT 'regular'; 