-- Partner login-method hint: GET /oauth/authorize (partner client only) may carry an optional
-- `login_method` (email|google|apple|x|wallet) and `login_hint`; both are stored on the pending
-- authorization request and returned by GET /api/oauth/requests/:id so the Wallet login page can
-- read them from the server row (never from its own URL). Additive and nullable: rows written by
-- the previous image carry NULL, and nothing is ever sent or signed on the user's behalf from them.

-- AlterTable
ALTER TABLE "OAuthAuthorization" ADD COLUMN "loginMethod" TEXT,
ADD COLUMN "loginHint" TEXT;
