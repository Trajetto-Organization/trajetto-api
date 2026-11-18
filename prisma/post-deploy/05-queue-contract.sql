-- ----------------------------------------------------------------------------
-- The four queues lose their foreign keys and uniques, once nobody needs
-- them (plano-escala F5-06)
-- ----------------------------------------------------------------------------
-- What goes, and why the code stands without it:
-- migrations/20261118120000_queue_contract. The image from before the plan
-- writes through these uniques and deletes through these cascades, so the
-- contraction waits, 'pending', until every live process announces
-- queue-partition-agnostic-v1 and no unnamed session is connected
-- (trajetto_queue_swap_ready, 00-queue-swap-ready.sql). On a database with
-- no company the migration already did it.
--
-- In order:
--
--   1. the second backfill of outbox_event_key: the key of every event
--      that has none (what the previous image wrote during the rolling
--      deploy, with no key row), so the keys' table alone keeps an event
--      written twice under one key one event once the unique goes;
--   2. each constraint and unique, one per transaction (the step is one DO
--      statement, so it may COMMIT): a drop takes ACCESS EXCLUSIVE on its
--      table, and a foreign key's also SHARE ROW EXCLUSIVE on the table it
--      references ("user", business, webhook_endpoint); committed at once,
--      no lock is held past its own drop. While a drop waits for its lock,
--      every new query of the table queues behind it, so each attempt
--      waits one second longer than deadlock_timeout (an autovacuum is
--      only cancelled by the waiter's deadlock check), and gives way for a
--      second, five times; a deadlock with a worker is retried the same
--      way. What did not get its lock stays, and the step says 'pending':
--      the next release goes on from there.
--
-- Once 'applied', the rollback floor of the code is this release
-- (docs/deploy.md, "Contrações que esperam a capability").
-- ----------------------------------------------------------------------------

DO $$
DECLARE
  items CONSTANT text[][] := ARRAY[
    ['constraint', 'notification_delivery', 'notification_delivery_outboxEventId_fkey'],
    ['constraint', 'notification_delivery', 'notification_delivery_userId_fkey'],
    ['constraint', 'notification_delivery', 'notification_delivery_externalRecipientId_fkey'],
    ['constraint', 'notification_provider_receipt', 'notification_provider_receipt_deliveryId_fkey'],
    ['constraint', 'webhook_delivery', 'webhook_delivery_endpointId_fkey'],
    ['constraint', 'webhook_delivery', 'webhook_delivery_businessId_fkey'],
    ['index', 'domain_outbox_event', 'domain_outbox_event_eventKey_key'],
    ['index', 'notification_delivery', 'notification_delivery_user_event_channel_idx'],
    ['index', 'notification_delivery', 'notification_delivery_external_event_channel_idx'],
    ['index', 'notification_provider_receipt', 'notification_provider_receipt_provider_providerMessageId_st_key']
  ];
  item text[];
  present boolean;
  left_over text[] := ARRAY[]::text[];
  dropped text[] := ARRAY[]::text[];
  waiting text[] := ARRAY[]::text[];
  backfilled bigint := 0;
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
    RAISE NOTICE 'skipped: as filas já não têm chave estrangeira nem unique além da chave primária';
    RETURN;
  END IF;

  IF NOT trajetto_queue_swap_ready(interval '5 minutes') THEN
    RAISE NOTICE 'pending: % constraint(s) e unique(s) das filas esperam todo processo vivo anunciar queue-partition-agnostic-v1 (a imagem anterior ainda grava por eles)', cardinality(left_over);
    RETURN;
  END IF;

  IF to_regclass('"notification_provider_receipt_fact_idx"') IS NULL THEN
    RAISE NOTICE 'pending: falta o índice notification_provider_receipt_fact_idx (prisma/concurrent) que substitui o unique dos recibos';
    RETURN;
  END IF;

  INSERT INTO "outbox_event_key" ("event_key", "event_id", "created_at")
  SELECT e."eventKey", e."id", e."created_at"
  FROM "domain_outbox_event" e
  WHERE NOT EXISTS (
    SELECT 1 FROM "outbox_event_key" k WHERE k."event_key" = e."eventKey"
  )
  ON CONFLICT ("event_key") DO NOTHING;

  GET DIAGNOSTICS backfilled = ROW_COUNT;

  COMMIT;

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
    RAISE NOTICE 'pending: o lock não veio para %; o próximo release tenta de novo (já saíram: %; % chave(s) copiadas para outbox_event_key)', array_to_string(waiting, ', '), coalesce(nullif(array_to_string(dropped, ', '), ''), 'nenhum'), backfilled;
  ELSE
    RAISE NOTICE 'applied: % constraint(s) e unique(s) das filas removidos (%); % chave(s) copiadas para outbox_event_key', cardinality(dropped), array_to_string(dropped, ', '), backfilled;
  END IF;
END $$;
