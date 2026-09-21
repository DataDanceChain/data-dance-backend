-- Phase 3 App->browser hand-off: one-time tickets (ddc-sso-tge-v0.1 /api/sso/*).
-- Additive: one new table, no change to existing tables. Rollback = previous image
-- (the table is simply no longer written; rows expire after 60 s).

-- CreateTable
CREATE TABLE "SsoTicket" (
    "id" TEXT NOT NULL,
    "ticketHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoTicket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SsoTicket_ticketHash_key" ON "SsoTicket"("ticketHash");

-- CreateIndex
CREATE INDEX "SsoTicket_expiresAt_idx" ON "SsoTicket"("expiresAt");

-- AddForeignKey
ALTER TABLE "SsoTicket" ADD CONSTRAINT "SsoTicket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
