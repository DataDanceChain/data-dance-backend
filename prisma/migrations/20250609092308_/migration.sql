/*
  Warnings:

  - A unique constraint covering the columns `[source,sourceId]` on the table `CrawlerData` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "CrawlerData_source_sourceId_key" ON "CrawlerData"("source", "sourceId");
