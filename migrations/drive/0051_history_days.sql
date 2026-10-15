-- The paid history add-on: how many days an account keeps deleted and replaced
-- copies. NULL is the free default (HIDDEN_VERSION_DAYS, 3 days). 30 and 365
-- are the add-on options (core/history-addon.js). Additive only.
ALTER TABLE accounts ADD COLUMN history_days INTEGER;
