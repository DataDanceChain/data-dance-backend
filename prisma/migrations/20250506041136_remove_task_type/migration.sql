/*
  Warnings:

  - You are about to drop the column `type` on the `Task` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Task" DROP COLUMN "type";

-- AlterTable
ALTER TABLE "UserProfile" ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "UserTask" ADD COLUMN     "claimed" BOOLEAN NOT NULL DEFAULT false;

-- DropEnum
DROP TYPE "TaskType";
