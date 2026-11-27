-- Keep this concurrent build as the only statement in this migration.
CREATE INDEX CONCURRENTLY "User_referralCode_lower_lookup_idx"
    ON "User" (LOWER("referralCode"));
