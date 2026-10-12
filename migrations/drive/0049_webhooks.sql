-- Outbound webhooks (polish gap 19, drive#901): a signed POST to a customer's
-- https address when something happens on their account.
--
-- An endpoint belongs to one account and carries the secret that signs every
-- delivery (the Standard Webhooks scheme, `whsec_` + base64), so the customer
-- can check a delivery with any library that speaks it. The secret is shown
-- once, when the endpoint is made, and read back only by the sender.
--
-- A delivery row is the log: one per attempt, with the status the customer's
-- server answered, so the account page can show what was sent and how it went.
-- An endpoint's rows older than 30 days are deleted when it next gets one.

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  -- JSON list of event names; every event when the list is empty.
  events TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_endpoints_account_idx
  ON webhook_endpoints (account_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event TEXT NOT NULL,
  -- The HTTP status the customer's server answered, or NULL when it did not.
  status_code INTEGER,
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  -- Why a delivery failed without a status (timeout, refused), in plain words.
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
  ON webhook_deliveries (endpoint_id, id);
