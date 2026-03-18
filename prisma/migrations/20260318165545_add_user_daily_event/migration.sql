-- CreateTable
CREATE TABLE "UserDailyEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserDailyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserDailyEvent_userId_day_idx" ON "UserDailyEvent"("userId", "day");

-- CreateIndex
CREATE INDEX "UserDailyEvent_type_day_idx" ON "UserDailyEvent"("type", "day");

-- CreateIndex
CREATE UNIQUE INDEX "UserDailyEvent_userId_type_day_key" ON "UserDailyEvent"("userId", "type", "day");

-- AddForeignKey
ALTER TABLE "UserDailyEvent" ADD CONSTRAINT "UserDailyEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
