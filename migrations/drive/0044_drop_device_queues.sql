-- The contract step of the per-device upload-queue report (drive issue #516,
-- phase 2 of drive#743): the 0014 account-only device_queues table goes.
--
-- Since 0027 every write lands on device_queue_reports keyed by account and
-- device, and since #736 every read answers from it, with the old table kept
-- only as a dual-write for readers that predated the expand. That expand has
-- been deployed and observed on production far longer than one heartbeat
-- window, and the writes and reads that still touched the old table are
-- removed from core/queues.js in the same change, so no code targets it
-- after this lands. Two devices on one account stay two rows, summed on
-- read -- the shape the account-only table could never carry.
--
-- One-way, as every D1 migration is: there is no down-migration. The table's
-- index goes with the table.

DROP TABLE IF EXISTS device_queues;
