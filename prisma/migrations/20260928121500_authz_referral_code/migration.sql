-- Carry the inviter's code from the TGE registration link into DDC registration.
--
-- GET /oauth/authorize (partner client only) accepts an optional `referral_code`, format-checked
-- and stored on the pending authorization request; GET /api/oauth/requests/:id returns it as
-- `referralCode` so the Wallet login page can prefill it. Additive and nullable: rows written by
-- the previous image carry NULL, and it is never applied automatically — binding still only
-- happens through the normal login/registration path the user performs.

-- AlterTable
ALTER TABLE "OAuthAuthorization" ADD COLUMN "referralCode" TEXT;
