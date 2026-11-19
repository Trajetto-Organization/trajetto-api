-- The cluster's epoch (plano-escala U-14): which history of the cluster
-- this database lives in.
--
-- Why. The integration feed walks events by the id of the transaction that
-- wrote them (delivery_event.txid, F2-03), and its cursor carries the last
-- one it served. After a PITR or a failover those ids are handed out
-- again: the restored or promoted cluster continues from the xid of the
-- moment it came from, so an integrator's cursor may name an xid that this
-- history reuses for another transaction, and the feed would skip it. The
-- cursor carries this epoch too (F2-04), and the feed converts a cursor of
-- an older epoch instead of trusting its xid (F2-05).
--
-- What. The row (cluster_epoch, created by
-- migrations/20261117150000_cluster_epoch) keeps the epoch with the pair it
-- was taken from: pg_control_system().system_identifier, which changes
-- with a new cluster (a logical restore into another Database, a
-- pg_upgrade), and the timeline the cluster writes on, which changes with
-- a PITR and with a promote. When the pair differs from the cluster's, the
-- epoch goes up by one and the row takes the new pair. The first run
-- writes epoch 1.
--
-- The timeline is the one of the current WAL position
-- (pg_walfile_name(pg_current_wal_lsn()), its first 8 hex digits), not
-- pg_control_checkpoint()'s: after a promote, the control file keeps the
-- old timeline until the first checkpoint of the new one completes, and
-- that checkpoint is a spread one, minutes later (measured on the infra
-- stack of the E2E, F4-44: still timeline 1 seconds after pg_promote(),
-- timeline 2 in the WAL at once). A step run right after the promote, as
-- the failover runbook does, said 'skipped' and left the feed on the old
-- epoch, exactly when the reused xids appear. During recovery (never the
-- release step, which runs on the primary) only the control file has it.
--
-- When. Every release, and the restore and failover runbooks force the
-- release step before the runtime comes back (U-11; docs/deploy.md, the
-- restore section). Until it runs, the ops heartbeat alerts
-- cluster-epoch-stale (src/shared/health/cluster-epoch.ts).
--
-- Idempotent: with the pair unchanged it writes nothing and says
-- 'skipped'.
DO $$
DECLARE
  current_system bigint;
  current_timeline integer;
  stored record;
BEGIN
  SELECT s.system_identifier INTO current_system FROM pg_control_system() s;
  SELECT CASE
           WHEN pg_is_in_recovery() THEN c.timeline_id
           ELSE ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::integer
         END
    INTO current_timeline
    FROM pg_control_checkpoint() c;

  SELECT e.epoch, e.system_identifier, e.timeline INTO stored
  FROM cluster_epoch e
  WHERE e.id = 1;

  IF NOT FOUND THEN
    INSERT INTO cluster_epoch (id, epoch, system_identifier, timeline, changed_at)
    VALUES (1, 1, current_system, current_timeline, now())
    ON CONFLICT (id) DO NOTHING;

    RAISE NOTICE 'applied: época 1 (system_identifier %, timeline %)', current_system, current_timeline;
    RETURN;
  END IF;

  IF stored.system_identifier = current_system AND stored.timeline = current_timeline THEN
    RAISE NOTICE 'skipped: época % (system_identifier %, timeline %)', stored.epoch, current_system, current_timeline;
    RETURN;
  END IF;

  -- Compare and set: a second run at the same time finds the row already
  -- moved and bumps nothing.
  UPDATE cluster_epoch
  SET epoch = epoch + 1,
      system_identifier = current_system,
      timeline = current_timeline,
      changed_at = now()
  WHERE id = 1
    AND epoch = stored.epoch
    AND system_identifier = stored.system_identifier
    AND timeline = stored.timeline;

  IF NOT FOUND THEN
    RAISE NOTICE 'skipped: outra execução da etapa já mudou a época';
    RETURN;
  END IF;

  RAISE NOTICE 'applied: época % para % (system_identifier % para %, timeline % para %)',
    stored.epoch, stored.epoch + 1,
    stored.system_identifier, current_system,
    stored.timeline, current_timeline;
END $$;
