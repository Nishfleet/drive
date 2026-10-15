-- The biggest size (bytes) the nightly pass last saw in the account's trailing
-- 30 days, so a drop in the bill can be told once, on the day it happens.
ALTER TABLE accounts ADD COLUMN peak_seen_bytes INTEGER;
