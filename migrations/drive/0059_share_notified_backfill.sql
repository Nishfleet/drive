-- 0055 added notified_count at 0 for every existing link. Without this, the
-- first nightly run after it deploys would write to every owner about each
-- link's lifetime download total. Set every link to its current count so only
-- opens after this migration are reported. Data change only.
UPDATE shares SET notified_count = download_count WHERE notified_count = 0;
