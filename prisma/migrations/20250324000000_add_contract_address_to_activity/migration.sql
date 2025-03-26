-- AlterTable
ALTER TABLE "Activity" ADD COLUMN "contractAddress" TEXT,
                      ADD COLUMN "chainId" INTEGER,
                      ADD COLUMN "tokenStandard" TEXT; 