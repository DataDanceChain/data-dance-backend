-- Native login (DDC as the Web3Auth custom-JWT issuer): identities, wallet bindings, login
-- attempts, e-mail OTP challenges, single-use flow state and the wallet-address audit trail.
--
-- Additive: six new tables, no change to any existing table or row. Nothing reads or writes them
-- while DDC_AUTH_ENABLED=false (the default). Rollback = previous image; the tables are simply no
-- longer used (drop them only after checking NativeWalletBinding / WalletAddressHistory are empty
-- or exported, since they are the only record of native wallet subjects).
--
-- The CHECK constraints pin the closed value sets of the design (Prisma does not model them).

-- CreateTable
CREATE TABLE "AuthIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "emailLinkGrade" TEXT NOT NULL DEFAULT 'none',
    "isPrivateRelay" BOOLEAN NOT NULL DEFAULT false,
    "linkedVia" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NativeWalletBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connection" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NativeWalletBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthLoginAttempt" (
    "id" TEXT NOT NULL,
    "loginSecretHash" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "emailLinkGrade" TEXT NOT NULL DEFAULT 'none',
    "isPrivateRelay" BOOLEAN NOT NULL DEFAULT false,
    "profile" JSONB,
    "resolution" TEXT NOT NULL,
    "userId" TEXT,
    "pendingUserId" TEXT,
    "w3aSubject" TEXT,
    "walletProof" JSONB,
    "w3aTokenCount" INTEGER NOT NULL DEFAULT 0,
    "lastJti" TEXT,
    "state" TEXT NOT NULL DEFAULT 'identified',
    "ipHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthLoginAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthEmailChallenge" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "locale" TEXT NOT NULL,
    "ipHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthEmailChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthFlowState" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "valueHash" TEXT,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthFlowState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAddressHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "oldAddress" TEXT NOT NULL,
    "oldVerifier" TEXT,
    "oldVerifierId" TEXT,
    "oldNetwork" TEXT NOT NULL,
    "newAddress" TEXT NOT NULL,
    "newVerifier" TEXT NOT NULL,
    "newSubjectRef" TEXT NOT NULL,
    "newNetwork" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "chainStatus" TEXT NOT NULL,
    "chainRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "WalletAddressHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

-- CreateIndex
CREATE INDEX "AuthIdentity_email_idx" ON "AuthIdentity"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthIdentity_provider_subject_key" ON "AuthIdentity"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "NativeWalletBinding_userId_key" ON "NativeWalletBinding"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "NativeWalletBinding_subject_key" ON "NativeWalletBinding"("subject");

-- CreateIndex
CREATE UNIQUE INDEX "NativeWalletBinding_connection_subject_key" ON "NativeWalletBinding"("connection", "subject");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_provider_subject_state_idx" ON "AuthLoginAttempt"("provider", "subject", "state");

-- CreateIndex
CREATE INDEX "AuthLoginAttempt_expiresAt_idx" ON "AuthLoginAttempt"("expiresAt");

-- CreateIndex
CREATE INDEX "AuthEmailChallenge_email_createdAt_idx" ON "AuthEmailChallenge"("email", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthFlowState_valueHash_key" ON "AuthFlowState"("valueHash");

-- CreateIndex
CREATE INDEX "AuthFlowState_expiresAt_idx" ON "AuthFlowState"("expiresAt");

-- CreateIndex
CREATE INDEX "WalletAddressHistory_userId_idx" ON "WalletAddressHistory"("userId");

-- AddForeignKey
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NativeWalletBinding" ADD CONSTRAINT "NativeWalletBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuthLoginAttempt" ADD CONSTRAINT "AuthLoginAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Closed value sets
ALTER TABLE "AuthIdentity" ADD CONSTRAINT "AuthIdentity_emailLinkGrade_check" CHECK ("emailLinkGrade" IN ('strong', 'weak', 'none'));

ALTER TABLE "AuthLoginAttempt" ADD CONSTRAINT "AuthLoginAttempt_emailLinkGrade_check" CHECK ("emailLinkGrade" IN ('strong', 'weak', 'none'));

ALTER TABLE "AuthFlowState" ADD CONSTRAINT "AuthFlowState_kind_check" CHECK ("kind" IN ('idp_nonce', 'x_oauth', 'x_handoff', 'step_up'));

ALTER TABLE "WalletAddressHistory" ADD CONSTRAINT "WalletAddressHistory_status_check" CHECK ("status" IN ('planned', 'applied'));

ALTER TABLE "WalletAddressHistory" ADD CONSTRAINT "WalletAddressHistory_chainStatus_check" CHECK ("chainStatus" IN ('pending', 'moved', 'not_needed'));
