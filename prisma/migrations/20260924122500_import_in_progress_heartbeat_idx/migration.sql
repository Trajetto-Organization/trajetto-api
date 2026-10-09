-- The uploads whose process died halfway (IDEMP-10).
--
-- An upload opens IN_PROGRESS before its first row, so everything it creates
-- carries its id from birth, and the running upload bumps "updated_at" as it
-- goes (the heartbeat). A process that dies mid-way — OOM, SIGKILL, a lost
-- node — leaves it IN_PROGRESS for good, and the undo refuses a running
-- upload. The close-abandoned-imports sweep closes every IN_PROGRESS upload
-- whose heartbeat stopped; this index hands it exactly those, oldest first.
-- Partial on IN_PROGRESS, so it holds the uploads running right now and not
-- the history: without it the sweep scanned every upload ever made, every
-- five minutes.
--
-- Raw SQL: Prisma cannot declare a partial index, and its diff ignores them
-- (the Import model names it). Plain CREATE INDEX: the table is created by
-- this same release and is empty in production when this runs.
CREATE INDEX IF NOT EXISTS "import_in_progress_heartbeat_idx"
  ON "import" ("updated_at")
  WHERE "status" = 'IN_PROGRESS';
