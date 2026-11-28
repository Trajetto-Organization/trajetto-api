-- ----------------------------------------------------------------------------
-- The writers of delivery_event, bounded to 240 s from their transaction's
-- start (plano-escala U-16, decision D66)
-- ----------------------------------------------------------------------------
-- The integration feed walks the events in commit order (F2-05): by the
-- writing transaction's id (delivery_event.txid), up to the oldest
-- transaction still open. Each page starts its index scan at a floor of
-- uuid v7 ids, the created_at of the last event it served minus
-- FEED_FLOOR_MARGIN_MS (10 min): below the floor the scan never looks, so
-- the monthly partitions of wave 11 are pruned to one or two.
--
-- That floor is only safe if a transaction cannot insert an event long
-- after it began. An event the feed has not served yet belongs to a
-- transaction whose id is above the last served one, so it began after
-- that one did; but nothing bounded how long after its start it inserted.
-- Postgres 16 has no transaction_timeout, and neither statement_timeout nor
-- idle_in_transaction_session_timeout limits a whole transaction. One that
-- inserted an event 20 minutes in would land below the floor of a poller
-- already past it, and the event would be skipped for good, with no error.
--
-- So every INSERT into delivery_event (and into its partitioned shell,
-- delivery_event_part, which takes the history over in wave 11) checks,
-- once per statement, how long its transaction has been open:
-- clock_timestamp() - now(), since now() is the transaction's start. Past
-- the bound it raises SQLSTATE TJ001 and the transaction rolls back. The
-- xid of a transaction is assigned at its first write, after its start, so
-- this also bounds the time between the xid and the insert. The bound is
-- the trigger's argument, in seconds (240): FEED_FLOOR_MARGIN_MS must be at
-- least twice it, which the boot checks (src/modules/integration/feed-floor.ts),
-- and the long write alert (LONG_WRITE_XACT_ALERT_SECONDS, 120 s) pages
-- before any writer gets near it.
--
-- Today no writer comes near: Prisma's interactive transactions end at
-- 15 s, and the longest one, the import reversal, at 60 s. A bulk loader
-- either runs short transactions or turns the triggers off for its session
-- (session_replication_role = replica, as the load seed does); a restore
-- creates the triggers after it loads the data (pg_dump's post-data
-- section). docs/runbooks/delivery-event-writer-bound.md says what to do
-- when a TJ001 shows up.
--
-- Wave 11's copy window creates the same trigger on the table that takes
-- the history over, at the end of the copy.
--
-- Expand: a function and two triggers. CREATE TRIGGER takes SHARE ROW
-- EXCLUSIVE on the table for an instant, under lock_timeout (delivery_event
-- is hot). The serving image's inserts are checked too, and none of them
-- runs in a transaction that long. A rollback leaves the triggers, which
-- hold the same rule for the older image.
-- ----------------------------------------------------------------------------

SET lock_timeout = '5s';

CREATE OR REPLACE FUNCTION "trajetto_delivery_event_writer_bound"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  bound interval := make_interval(secs => TG_ARGV[0]::integer);
  open_for interval := clock_timestamp() - now();
BEGIN
  IF open_for > bound THEN
    RAISE EXCEPTION USING
      ERRCODE = 'TJ001',
      MESSAGE = format(
        '%s: INSERT numa transação aberta há %s s; o limite é %s s (plano de escala U-16).',
        TG_TABLE_NAME,
        floor(extract(epoch FROM open_for))::bigint,
        TG_ARGV[0]
      ),
      HINT = 'Grave o histórico em transações curtas: docs/runbooks/delivery-event-writer-bound.md.';
  END IF;

  RETURN NULL;
END;
$$;

CREATE OR REPLACE TRIGGER "delivery_event_writer_bound"
  BEFORE INSERT ON "delivery_event"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "trajetto_delivery_event_writer_bound"('240');

CREATE OR REPLACE TRIGGER "delivery_event_part_writer_bound"
  BEFORE INSERT ON "delivery_event_part"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "trajetto_delivery_event_writer_bound"('240');
