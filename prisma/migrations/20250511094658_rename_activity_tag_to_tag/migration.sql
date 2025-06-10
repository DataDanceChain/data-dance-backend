/*
  Warnings:

  - You are about to drop the `ActivityTag` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_ActivityToActivityTag` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "_ActivityToActivityTag" DROP CONSTRAINT "_ActivityToActivityTag_A_fkey";

-- DropForeignKey
ALTER TABLE "_ActivityToActivityTag" DROP CONSTRAINT "_ActivityToActivityTag_B_fkey";

-- DropForeignKey
ALTER TABLE "_DataNFTToTag" DROP CONSTRAINT "_DataNFTToTag_A_fkey";

-- DropForeignKey
ALTER TABLE "_DataNFTToTag" DROP CONSTRAINT "_DataNFTToTag_B_fkey";

-- DropForeignKey
ALTER TABLE "_SnapshotToTag" DROP CONSTRAINT "_SnapshotToTag_A_fkey";

-- DropForeignKey
ALTER TABLE "_SnapshotToTag" DROP CONSTRAINT "_SnapshotToTag_B_fkey";

-- DropTable
DROP TABLE "ActivityTag";

-- DropTable
DROP TABLE "_ActivityToActivityTag";

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_ActivityToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "_ActivityToTag_AB_unique" ON "_ActivityToTag"("A", "B");

-- CreateIndex
CREATE INDEX "_ActivityToTag_B_index" ON "_ActivityToTag"("B");

-- AddForeignKey
ALTER TABLE "_ActivityToTag" ADD CONSTRAINT "_ActivityToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Activity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_ActivityToTag" ADD CONSTRAINT "_ActivityToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SnapshotToTag" ADD CONSTRAINT "_SnapshotToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Snapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_SnapshotToTag" ADD CONSTRAINT "_SnapshotToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DataNFTToTag" ADD CONSTRAINT "_DataNFTToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "DataNFT"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_DataNFTToTag" ADD CONSTRAINT "_DataNFTToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
