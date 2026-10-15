-- An account that used the unsubscribe link in a nudge email (src/activation.js)
-- gets no more nudges. Additive only.
ALTER TABLE accounts ADD COLUMN nudges_off INTEGER;
