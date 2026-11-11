BEGIN;
SET LOCAL lock_timeout = '5s';

-- Keep the recovery address out of default User and nested User selections.
CREATE TABLE "UserLoginEmail" (
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLoginEmail_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "UserLoginEmail_email_normalized" CHECK (
        "email" = lower(btrim("email")) AND length("email") BETWEEN 3 AND 254
    ),
    CONSTRAINT "UserLoginEmail_userId_fkey" FOREIGN KEY ("userId")
        REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "UserLoginEmail_email_key" ON "UserLoginEmail"("email");
COMMIT;
