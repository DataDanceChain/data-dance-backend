-- Let a partner hide the Wallet invite-code field for one sign-in.
--
-- GET /oauth/authorize (partner client only) accepts an optional `referral_prompt`:
--   hide → the Wallet login page does not show the field and does not send a code
--   show, or omitted → the field stays, as before
-- Stored on the pending authorization request and returned as `referralPrompt` by
-- GET /api/oauth/requests/:id. The consent redirect also carries `referral_prompt=hide`
-- so the login page can hide the field before that read returns.
-- Additive, default false: rows written by the previous image keep showing the field.

ALTER TABLE "OAuthAuthorization" ADD COLUMN IF NOT EXISTS "hideReferralPrompt" BOOLEAN NOT NULL DEFAULT false;
