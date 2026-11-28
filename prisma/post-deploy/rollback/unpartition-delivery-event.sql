-- ----------------------------------------------------------------------------
-- The way back of 30-delivery-event-window.sql (plano-escala F2-17): the
-- delivery trail goes back to the plain table it was before the copy
-- window, while delivery_event_legacy is still there (14 days; wave 20
-- drops it). Run BY HAND, never by the release step (this folder is not one
-- of its steps):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "SET trajetto.unpartition_history = 'delivery_event'" \
--     -f prisma/post-deploy/rollback/unpartition-delivery-event.sql
--
-- Without that setting the script refuses to run.
--
-- What it does, in one transaction, under ACCESS EXCLUSIVE on both tables
-- (every read and write of the trail waits for it; at most 30 s for the
-- lock):
--
--   1. the rows the partitioned table got after the window go back to the
--      plain one: every id not in delivery_event_legacy from an hour before
--      the newest one it has (a writer is bounded to 4 min, U-16, so no row
--      of the window's time is older than that), and the reverse-geocoded
--      address filled in later on a copied row;
--   2. the names go back: the partitioned table, its indexes, constraints,
--      trigger and partitions become the empty shell delivery_event_part
--      again (truncated), and delivery_event_legacy becomes delivery_event;
--   3. the comment 'trajetto:window-hold' on delivery_event: the window
--      step leaves it plain from then on ('skipped'). To let a new window
--      run: COMMENT ON TABLE "delivery_event" IS NULL.
--
-- What it cannot give back: a row deleted straight from the partitioned
-- table after the window (a delivery deleted cascades into both, so it is
-- gone in both) and the keys of delivery_event_submission, which stay.
-- docs/runbooks/history-window.md says when to use it.
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  wanted CONSTANT text := nullif(trim(coalesce(current_setting('trajetto.unpartition_history', true), '')), '');
  hold_marker CONSTANT text := 'trajetto:window-hold';
  columns_list text;
  newest text;
  newest_ms bigint;
  floor_hex text;
  floor_id text := '';
  restored bigint := 0;
  readdressed bigint := 0;
  member record;
BEGIN
  IF wanted IS DISTINCT FROM 'delivery_event' THEN
    RAISE EXCEPTION 'defina trajetto.unpartition_history = ''delivery_event'' antes de rodar o script';
  END IF;

  IF (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('delivery_event')) IS DISTINCT FROM 'p' THEN
    RAISE NOTICE 'skipped: delivery_event já é uma tabela comum';
    RETURN;
  END IF;

  IF to_regclass('delivery_event_legacy') IS NULL THEN
    RAISE EXCEPTION 'delivery_event_legacy não existe mais: a volta só vale nos 14 dias depois da janela';
  END IF;

  IF to_regclass('delivery_event_part') IS NOT NULL THEN
    RAISE EXCEPTION 'já existe uma tabela delivery_event_part';
  END IF;

  SET LOCAL lock_timeout = '30s';

  LOCK TABLE "delivery_event", "delivery_event_legacy" IN ACCESS EXCLUSIVE MODE;

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
  INTO columns_list
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = to_regclass('delivery_event_legacy')
    AND a.attnum > 0
    AND NOT a.attisdropped;

  -- 1. What came after the window.
  SELECT max("id") INTO newest FROM "delivery_event_legacy";

  IF newest ~ '^[0-9a-f]{8}-[0-9a-f]{4}-' THEN
    newest_ms := ('x' || lpad(substr(newest, 1, 8) || substr(newest, 10, 4), 16, '0'))::bit(64)::bigint;
    floor_hex := lpad(to_hex(greatest(newest_ms - 3600000, 0)), 12, '0');
    floor_id := substr(floor_hex, 1, 8) || '-' || substr(floor_hex, 9, 4) || '-0000-0000-000000000000';
  END IF;

  EXECUTE format(
    'INSERT INTO "delivery_event_legacy" (%s)
     SELECT %s FROM "delivery_event" p
     WHERE p."id" >= %L
       AND NOT EXISTS (SELECT 1 FROM "delivery_event_legacy" l WHERE l."id" = p."id")',
    columns_list,
    (SELECT string_agg('p.' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
     FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = to_regclass('delivery_event_legacy')
       AND a.attnum > 0
       AND NOT a.attisdropped),
    floor_id
  );

  GET DIAGNOSTICS restored = ROW_COUNT;

  UPDATE "delivery_event_legacy" l
  SET "gps_address" = p."gps_address",
      "gps_address_source" = p."gps_address_source",
      "gps_geocoded_at" = p."gps_geocoded_at"
  FROM "delivery_event" p
  WHERE p."id" = l."id"
    AND p."gps_geocoded_at" IS NOT NULL
    AND p."gps_geocoded_at" IS DISTINCT FROM l."gps_geocoded_at";

  GET DIAGNOSTICS readdressed = ROW_COUNT;

  -- 2. The partitioned table becomes the shell again.
  FOR member IN
    SELECT ic.relname::text AS name
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('delivery_event')
      AND starts_with(ic.relname::text, 'delivery_event_')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', member.name, 'delivery_event_part_' || substr(member.name, 16));
  END LOOP;

  FOR member IN
    SELECT con.conname::text AS name
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = to_regclass('delivery_event')
      AND con.contype NOT IN ('p', 'u', 'x')
      AND starts_with(con.conname::text, 'delivery_event_')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER TABLE "delivery_event" RENAME CONSTRAINT %I TO %I', member.name, 'delivery_event_part_' || substr(member.name, 16));
  END LOOP;

  FOR member IN
    SELECT t.tgname::text AS name
    FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = to_regclass('delivery_event')
      AND NOT t.tgisinternal
      AND starts_with(t.tgname::text, 'delivery_event_')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER TRIGGER %I ON "delivery_event" RENAME TO %I', member.name, 'delivery_event_part_' || substr(member.name, 16));
  END LOOP;

  FOR member IN
    SELECT c.relname::text AS name
    FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = to_regclass('delivery_event')
    ORDER BY 1
  LOOP
    EXECUTE format(
      'ALTER TABLE %I RENAME TO %I',
      member.name,
      CASE
        WHEN member.name = 'delivery_event_older' THEN 'delivery_event_part_legacy'
        WHEN starts_with(member.name, 'delivery_event_') THEN 'delivery_event_part_' || substr(member.name, 16)
        ELSE member.name
      END
    );
  END LOOP;

  ALTER TABLE "delivery_event" RENAME TO "delivery_event_part";

  -- The plain table takes its names back.
  FOR member IN
    SELECT ic.relname::text AS name
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('delivery_event_legacy')
    ORDER BY 1
  LOOP
    EXECUTE format(
      'ALTER INDEX %I RENAME TO %I',
      member.name,
      CASE
        WHEN starts_with(member.name, 'delivery_event_legacy_') THEN 'delivery_event_' || substr(member.name, 23)
        ELSE regexp_replace(member.name, '_legacy$', '')
      END
    );
  END LOOP;

  FOR member IN
    SELECT con.conname::text AS name
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = to_regclass('delivery_event_legacy')
      AND con.contype NOT IN ('p', 'u', 'x')
    ORDER BY 1
  LOOP
    EXECUTE format(
      'ALTER TABLE "delivery_event_legacy" RENAME CONSTRAINT %I TO %I',
      member.name,
      CASE
        WHEN starts_with(member.name, 'delivery_event_legacy_') THEN 'delivery_event_' || substr(member.name, 23)
        ELSE regexp_replace(member.name, '_legacy$', '')
      END
    );
  END LOOP;

  FOR member IN
    SELECT t.tgname::text AS name
    FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = to_regclass('delivery_event_legacy')
      AND NOT t.tgisinternal
    ORDER BY 1
  LOOP
    EXECUTE format(
      'ALTER TRIGGER %I ON "delivery_event_legacy" RENAME TO %I',
      member.name,
      CASE
        WHEN starts_with(member.name, 'delivery_event_legacy_') THEN 'delivery_event_' || substr(member.name, 23)
        ELSE regexp_replace(member.name, '_legacy$', '')
      END
    );
  END LOOP;

  ALTER TABLE "delivery_event_legacy" RENAME TO "delivery_event";

  -- The shell empty again, for a later window.
  TRUNCATE "delivery_event_part";

  -- 3. The window leaves it alone until the comment goes.
  EXECUTE format(
    'COMMENT ON TABLE "delivery_event" IS %L',
    hold_marker || ' a linha do tempo voltou a ser comum à mão (prisma/post-deploy/rollback/unpartition-delivery-event.sql); COMMENT ON TABLE "delivery_event" IS NULL libera uma nova janela'
  );

  RAISE NOTICE 'applied: delivery_event voltou a ser comum; % linha(s) gravadas depois da janela trazidas de volta, % endereço(s) do GPS atualizados; delivery_event_part vazia de novo',
    restored, readdressed;
END
$step$;
