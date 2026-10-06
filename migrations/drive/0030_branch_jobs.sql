-- Branch jobs (drive issue #563): copy, approve, discard and rewind run as a
-- queued job in file batches, so a 100,000-file branch stays inside one
-- Worker's subrequest budget instead of blowing it in a single HTTP request.
--
-- Expand only. Four job columns and two stored counts, each with a DEFAULT,
-- so a revert of the Worker still writes the previous INSERT (those columns
-- omitted) and reads the previous SELECT (those columns omitted). Nothing is
-- dropped from the table. The unique open-name index is replaced with one that
-- also covers in-flight job states: approve's first step is
-- `UPDATE … SET state='approving' WHERE state='open'`, and without that cover
-- a second create of the same name could INSERT while approve is copying and
-- then clear the prefix approve is reading.
--
--   job_kind                 create / approve / discard / rewind, or ''
--   job_cursor               JSON the next batch resumes from
--   job_done / job_total     progress the UI and CLI poll
--   changed_count            files the branch changed, stored, not a live diff
--   source_changed_count     files the original moved, stored the same way
--
-- A row written before this file keeps zeros and an empty job, which reads as
-- "no job, no counted changes" — the honest list answer until a detail read
-- or a job writes the counts. D1 has no down-migration: this file is one-way.

ALTER TABLE branches ADD COLUMN job_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN job_cursor TEXT NOT NULL DEFAULT '';
ALTER TABLE branches ADD COLUMN job_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branches ADD COLUMN job_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branches ADD COLUMN changed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE branches ADD COLUMN source_changed_count INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS branches_one_open_name_idx;

CREATE UNIQUE INDEX IF NOT EXISTS branches_one_active_name_idx
  ON branches (account_id, name)
  WHERE state IN ('open', 'creating', 'approving', 'discarding', 'rewinding');
