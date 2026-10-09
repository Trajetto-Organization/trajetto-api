-- The nightly purge deletes PUBLISHED events 30 days after processing, in
-- batches ordered by "processedAt" (cleanup-notification-pipeline-job.ts,
-- publishedPurgeBatchSql). Nothing indexed (status, processedAt): each batch
-- stopped early only because old rows sit at the start of the heap, and the
-- LAST batch of every night was a sequential scan of domain_outbox_event —
-- millions of rows at the target scale, against the 30 s statement_timeout
-- production applies to the cron.
--
-- Partial on the terminal status the purge reads, with the status as a
-- literal so a generic plan can prove it. domain_outbox_event is created by
-- this same release (20260815130000), so production builds it on an empty
-- table; a plain CREATE INDEX is enough.
CREATE INDEX IF NOT EXISTS "domain_outbox_event_published_processed_idx"
  ON "domain_outbox_event" ("processedAt")
  WHERE "status" = 'PUBLISHED';
