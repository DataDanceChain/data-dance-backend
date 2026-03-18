-- Ensure unique constraints for Prisma upsert conflict targets.
-- This is defensive: some environments may have had schema.prisma updated without the
-- corresponding migration being applied (or applied partially).

DO $$
BEGIN
  -- UserTask(userId, taskId)
  IF to_regclass('public."UserTask"') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'UserTask_userId_taskId_key'
    ) THEN
      CREATE UNIQUE INDEX "UserTask_userId_taskId_key"
      ON "UserTask"("userId", "taskId");
    END IF;
  END IF;

  -- UserDailyEvent(userId, type, day)
  IF to_regclass('public."UserDailyEvent"') IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = 'UserDailyEvent_userId_type_day_key'
    ) THEN
      CREATE UNIQUE INDEX "UserDailyEvent_userId_type_day_key"
      ON "UserDailyEvent"("userId", "type", "day");
    END IF;
  END IF;
END $$;

