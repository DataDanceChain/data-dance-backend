/*
  Warnings:

  - A unique constraint covering the columns `[serialNumber]` on the table `Pass` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `updatedAt` to the `Pass` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Pass" ADD COLUMN     "serialNumber" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "passUrl" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Pass_serialNumber_key" ON "Pass"("serialNumber");

-- AddForeignKey
ALTER TABLE "Pass" ADD CONSTRAINT "Pass_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
