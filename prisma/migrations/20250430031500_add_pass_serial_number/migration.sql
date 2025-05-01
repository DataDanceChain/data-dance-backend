-- Add serialNumber field to Pass table
ALTER TABLE "Pass" ADD COLUMN "serialNumber" TEXT UNIQUE;

-- Add passUrl field to Pass table
ALTER TABLE "Pass" ADD COLUMN "passUrl" TEXT;

-- Add status field to Pass table with default value
ALTER TABLE "Pass" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';

-- Add updatedAt field to Pass table if not exists
DO $$ 
BEGIN 
    -- Add serialNumber field if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Pass' AND column_name = 'serialNumber') THEN
        ALTER TABLE "Pass" ADD COLUMN "serialNumber" TEXT;
        ALTER TABLE "Pass" ADD CONSTRAINT "Pass_serialNumber_key" UNIQUE ("serialNumber");
    END IF;

    -- Add status field if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Pass' AND column_name = 'status') THEN
        ALTER TABLE "Pass" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
    END IF;

    -- Add updatedAt field if not exists
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Pass' AND column_name = 'updatedAt') THEN
        ALTER TABLE "Pass" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
    END IF;
END $$; 