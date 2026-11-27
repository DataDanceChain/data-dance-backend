-- Match the legacy lookup expression, including its existing NULL handling.
CREATE INDEX CONCURRENTLY "User_legacyReferralCode_lower_lookup_idx"
    ON "User" (LOWER(COALESCE("legacyReferralCode", '')));
