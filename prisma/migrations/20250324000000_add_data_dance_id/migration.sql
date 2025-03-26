-- CreateTable
CREATE TABLE "DataDanceID" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataDanceID_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DataDanceID_identifier_key" ON "DataDanceID"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "DataDanceID_userId_activityId_key" ON "DataDanceID"("userId", "activityId");

-- AddForeignKey
ALTER TABLE "DataDanceID" ADD CONSTRAINT "DataDanceID_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DataDanceID" ADD CONSTRAINT "DataDanceID_activityId_fkey" FOREIGN KEY ("activityId") REFERENCES "Activity"("id") ON DELETE RESTRICT ON UPDATE CASCADE; 