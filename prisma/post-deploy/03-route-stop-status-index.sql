-- ----------------------------------------------------------------------------
-- route_stop ("status", "deliveryId") leaves once nobody needs it
-- (plano-escala F2-21b)
-- ----------------------------------------------------------------------------
-- Since F2-21, "not on an open stop" looks for the stop through the
-- company's open routes and no longer reads this index; every write of
-- route_stop still pays for it. The image from before the plan runs the
-- global anti-join that needs it, so the drop waits, 'pending', until every
-- live process announces route-stop-open-by-route-v1 and no unnamed session
-- is connected (trajetto_capability_ready, 00-queue-swap-ready.sql). On a
-- database with no company the migration
-- 20261118110000_drop_route_stop_status_delivery_idx already dropped it.
--
-- A plain DROP INDEX, not CONCURRENTLY: a step runs inside one transaction,
-- where CONCURRENTLY is refused, and the gate must be in the same file. It
-- takes route_stop's ACCESS EXCLUSIVE for the instant of the catalog change.
-- While it waits for that lock (a long read of route_stop) every new query
-- of the table queues behind it, so each attempt waits one second longer
-- than deadlock_timeout (an autovacuum holding the table is only cancelled
-- by the waiter's deadlock check) and gives way for a second, up to five
-- attempts; then 'pending', and the next release tries again.
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  attempt integer := 0;
BEGIN
  IF to_regclass('"route_stop_status_deliveryId_idx"') IS NULL THEN
    RAISE NOTICE 'skipped: route_stop_status_deliveryId_idx já saiu';
    RETURN;
  END IF;

  IF NOT trajetto_capability_ready('route-stop-open-by-route-v1', interval '5 minutes') THEN
    RAISE NOTICE 'pending: route_stop_status_deliveryId_idx espera todo processo vivo anunciar route-stop-open-by-route-v1 (a imagem anterior ainda usa o índice)';
    RETURN;
  END IF;

  PERFORM set_config(
    'lock_timeout',
    (floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000)::bigint || 'ms',
    true
  );

  LOOP
    BEGIN
      DROP INDEX IF EXISTS "route_stop_status_deliveryId_idx";
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      attempt := attempt + 1;

      IF attempt >= 5 THEN
        RAISE NOTICE 'pending: o lock de route_stop não veio em 5 tentativas; o próximo release tenta de novo';
        RETURN;
      END IF;

      PERFORM pg_sleep(1);
    END;
  END LOOP;

  RAISE NOTICE 'applied: route_stop_status_deliveryId_idx removido';
END $$;
