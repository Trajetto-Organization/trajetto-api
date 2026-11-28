-- ----------------------------------------------------------------------------
-- The bell (notification) loses its foreign keys and the unique on
-- deliveryId, once nobody needs them (plano-escala F5-15)
-- ----------------------------------------------------------------------------
-- What goes, and why the code stands without it:
-- migrations/20261118130000_notification_contract. The image from before
-- the plan deletes the bell through these cascades and, writing a bell row
-- under an id of its own, dedupes a retried IN_APP by the unique. So the
-- contraction waits, 'pending', until:
--
--   1. every live process announces notification-partition-agnostic-v1 and
--      no unnamed session is connected (trajetto_capability_ready,
--      00-queue-swap-ready.sql): nothing deletes by cascade any more;
--   2. no IN_APP delivery still in flight has a bell row under another id
--      (one the previous image wrote before it could mark the delivery
--      DELIVERED): this image would retry it under the delivery's id, and
--      only the unique keeps the user from a second bell. Such a delivery
--      settles within its attempts; until then, 'pending'.
--
-- Then each constraint and the unique go, one per transaction (the step is
-- one DO statement, so it may COMMIT): a foreign key's drop also takes
-- SHARE ROW EXCLUSIVE on "user" or business, for an instant. Each attempt
-- waits one second longer than deadlock_timeout for its lock (an autovacuum
-- is only cancelled by the waiter's deadlock check) and gives way for a
-- second, five times; what did not get its lock stays for the next release.
-- On a database with no company the migration already did it.
--
-- Once 'applied', the rollback floor of the code is this release
-- (docs/deploy.md, "Contrações que esperam a capability").
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  items CONSTANT text[][] := ARRAY[
    ['constraint', 'notification', 'notification_userId_fkey'],
    ['constraint', 'notification', 'notification_businessId_fkey'],
    ['index', 'notification', 'notification_deliveryId_key']
  ];
  item text[];
  present boolean;
  left_over text[] := ARRAY[]::text[];
  dropped text[] := ARRAY[]::text[];
  waiting text[] := ARRAY[]::text[];
  attempt integer;
BEGIN
  FOREACH item SLICE 1 IN ARRAY items LOOP
    IF item[1] = 'constraint' THEN
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint c
        WHERE c.conname = item[3]
          AND c.conrelid = to_regclass(quote_ident(item[2]))
      ) INTO present;
    ELSE
      present := to_regclass(quote_ident(item[3])) IS NOT NULL;
    END IF;

    IF present THEN
      left_over := left_over || item[3];
    END IF;
  END LOOP;

  IF cardinality(left_over) = 0 THEN
    RAISE NOTICE 'skipped: o sino já não tem chave estrangeira nem unique além da chave primária';
    RETURN;
  END IF;

  IF NOT trajetto_capability_ready('notification-partition-agnostic-v1', interval '5 minutes') THEN
    RAISE NOTICE 'pending: % constraint(s) e unique(s) do sino esperam todo processo vivo anunciar notification-partition-agnostic-v1 (a imagem anterior ainda apaga por cascata e deduplica pelo unique)', cardinality(left_over);
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "notification_delivery" d
    JOIN "notification" n ON n."deliveryId" = d."id" AND n."id" <> d."id"
    WHERE d."status" IN ('PENDING', 'PROCESSING')
      AND d."channel" IN ('IN_APP', 'ACTIVITY', 'PUSH')
      AND d."channel" = 'IN_APP'
  ) THEN
    RAISE NOTICE 'pending: uma entrega do sino ainda em voo tem a notificação que a imagem anterior gravou com outro id; o unique de deliveryId ainda evita o sino em dobro';
    RETURN;
  END IF;

  PERFORM set_config(
    'lock_timeout',
    (floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000)::bigint || 'ms',
    false
  );

  FOREACH item SLICE 1 IN ARRAY items LOOP
    CONTINUE WHEN NOT (item[3] = ANY (left_over));

    attempt := 0;

    LOOP
      BEGIN
        IF item[1] = 'constraint' THEN
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', item[2], item[3]);
        ELSE
          EXECUTE format('DROP INDEX IF EXISTS %I', item[3]);
        END IF;

        dropped := dropped || item[3];
        EXIT;
      EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
        attempt := attempt + 1;

        IF attempt >= 5 THEN
          waiting := waiting || item[3];
          EXIT;
        END IF;

        PERFORM pg_sleep(1);
      END;
    END LOOP;

    COMMIT;
  END LOOP;

  IF cardinality(waiting) > 0 THEN
    RAISE NOTICE 'pending: o lock não veio para %; o próximo release tenta de novo (já saíram: %)', array_to_string(waiting, ', '), coalesce(nullif(array_to_string(dropped, ', '), ''), 'nenhum');
  ELSE
    RAISE NOTICE 'applied: % constraint(s) e unique(s) do sino removidos (%)', cardinality(dropped), array_to_string(dropped, ', ');
  END IF;
END $$;
