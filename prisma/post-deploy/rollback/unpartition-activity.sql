-- ----------------------------------------------------------------------------
-- The way back of 31-activity-window.sql (plano-escala F2-18): the activity
-- trail goes back to the plain table it was before the copy window, with
-- its ids of before, while activity_legacy is still there (14 days; wave 20
-- drops it). Run BY HAND, never by the release step (this folder is not one
-- of its steps):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "SET trajetto.unpartition_history = 'activity'" \
--     -f prisma/post-deploy/rollback/unpartition-activity.sql
--
-- Without that setting the script refuses to run.
--
-- What it does, in one transaction, under ACCESS EXCLUSIVE on both tables
-- (every read and write of the trail waits for it; at most 30 s for the
-- lock):
--
--   1. the rows the partitioned table got after the window go back to the
--      plain one: every id not in activity_legacy from an hour before its
--      newest uuid v7 on. The rows the window re-keyed are not among them:
--      their new ids are of their created_at, long before, and the plain
--      table still has them under the old ones;
--   2. the names go back: the partitioned table, its indexes, constraints
--      and partitions become the empty shell activity_part again
--      (truncated), and activity_legacy becomes activity;
--   3. the comment 'trajetto:window-hold' on activity: the window step
--      leaves it plain from then on ('skipped'). To let a new window run:
--      COMMENT ON TABLE "activity" IS NULL.
--
-- The web drops its cached feed again, as the data version the API sends
-- goes back with the table (x-trajetto-data-version). A row deleted
-- straight from the partitioned table after the window (the opt-in
-- retention purge, ACTIVITY_RETENTION_DAYS) is still in the plain one.
-- docs/runbooks/history-window.md says when to use it.
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  wanted CONSTANT text := nullif(trim(coalesce(current_setting('trajetto.unpartition_history', true), '')), '');
  hold_marker CONSTANT text := 'trajetto:window-hold';
  v7_pattern CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  columns_list text;
  select_list text;
  newest text;
  newest_ms bigint;
  floor_hex text;
  floor_id text := '';
  restored bigint := 0;
  member record;
BEGIN
  IF wanted IS DISTINCT FROM 'activity' THEN
    RAISE EXCEPTION 'defina trajetto.unpartition_history = ''activity'' antes de rodar o script';
  END IF;

  IF (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('activity')) IS DISTINCT FROM 'p' THEN
    RAISE NOTICE 'skipped: activity já é uma tabela comum';
    RETURN;
  END IF;

  IF to_regclass('activity_legacy') IS NULL THEN
    RAISE EXCEPTION 'activity_legacy não existe mais: a volta só vale nos 14 dias depois da janela';
  END IF;

  IF to_regclass('activity_part') IS NOT NULL THEN
    RAISE EXCEPTION 'já existe uma tabela activity_part';
  END IF;

  SET LOCAL lock_timeout = '30s';

  LOCK TABLE "activity", "activity_legacy" IN ACCESS EXCLUSIVE MODE;

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
         string_agg('p.' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
  INTO columns_list, select_list
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = to_regclass('activity_legacy')
    AND a.attnum > 0
    AND NOT a.attisdropped;

  -- 1. What came after the window: past the newest v7 the plain table has.
  SELECT max("id") INTO newest FROM "activity_legacy" WHERE "id" ~ v7_pattern;

  IF newest IS NOT NULL THEN
    newest_ms := ('x' || lpad(substr(newest, 1, 8) || substr(newest, 10, 4), 16, '0'))::bit(64)::bigint;
    floor_hex := lpad(to_hex(greatest(newest_ms - 3600000, 0)), 12, '0');
    floor_id := substr(floor_hex, 1, 8) || '-' || substr(floor_hex, 9, 4) || '-0000-0000-000000000000';
  END IF;

  -- Without a v7 to start from, every row of the partitioned table is a
  -- candidate, and the re-keyed ones are told apart by their re-key.
  EXECUTE format(
    'INSERT INTO "activity_legacy" (%s)
     SELECT %s FROM "activity" p
     WHERE p."id" >= %L
       AND NOT EXISTS (SELECT 1 FROM "activity_legacy" l WHERE l."id" = p."id")%s',
    columns_list,
    select_list,
    floor_id,
    CASE WHEN floor_id = '' THEN format(
      ' AND NOT EXISTS (SELECT 1 FROM "activity_legacy" l WHERE l."id" !~ %L AND trajetto_activity_rekey(l."id", l."created_at") = p."id")',
      v7_pattern
    ) ELSE '' END
  );

  GET DIAGNOSTICS restored = ROW_COUNT;

  -- 2. The partitioned table becomes the shell again.
  FOR member IN
    SELECT ic.relname::text AS name
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('activity')
      AND starts_with(ic.relname::text, 'activity_')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER INDEX %I RENAME TO %I', member.name, 'activity_part_' || substr(member.name, 10));
  END LOOP;

  FOR member IN
    SELECT con.conname::text AS name
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = to_regclass('activity')
      AND con.contype NOT IN ('p', 'u', 'x')
      AND starts_with(con.conname::text, 'activity_')
    ORDER BY 1
  LOOP
    EXECUTE format('ALTER TABLE "activity" RENAME CONSTRAINT %I TO %I', member.name, 'activity_part_' || substr(member.name, 10));
  END LOOP;

  FOR member IN
    SELECT c.relname::text AS name
    FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = to_regclass('activity')
    ORDER BY 1
  LOOP
    EXECUTE format(
      'ALTER TABLE %I RENAME TO %I',
      member.name,
      CASE
        WHEN member.name = 'activity_older' THEN 'activity_part_legacy'
        WHEN starts_with(member.name, 'activity_') THEN 'activity_part_' || substr(member.name, 10)
        ELSE member.name
      END
    );
  END LOOP;

  ALTER TABLE "activity" RENAME TO "activity_part";

  -- The plain table takes its names back.
  FOR member IN
    SELECT ic.relname::text AS name
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = to_regclass('activity_legacy')
    ORDER BY 1
  LOOP
    EXECUTE format(
      'ALTER INDEX %I RENAME TO %I',
      member.name,
      CASE
        WHEN starts_with(member.name, 'activity_legacy_') THEN 'activity_' || substr(member.name, 17)
        ELSE regexp_replace(member.name, '_legacy$', '')
      END
    );
  END LOOP;

  FOR member IN
    SELECT con.conname::text AS name
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = to_regclass('activity_legacy')
      AND con.contype NOT IN ('p', 'u', 'x')
    ORDER BY 1
  LOOP
    EXECUTE format(
      'ALTER TABLE "activity_legacy" RENAME CONSTRAINT %I TO %I',
      member.name,
      CASE
        WHEN starts_with(member.name, 'activity_legacy_') THEN 'activity_' || substr(member.name, 17)
        ELSE regexp_replace(member.name, '_legacy$', '')
      END
    );
  END LOOP;

  ALTER TABLE "activity_legacy" RENAME TO "activity";

  -- The shell empty again, for a later window.
  TRUNCATE "activity_part";

  -- 3. The window leaves it alone until the comment goes.
  EXECUTE format(
    'COMMENT ON TABLE "activity" IS %L',
    hold_marker || ' o registro de atividades voltou a ser comum à mão (prisma/post-deploy/rollback/unpartition-activity.sql); COMMENT ON TABLE "activity" IS NULL libera uma nova janela'
  );

  RAISE NOTICE 'applied: activity voltou a ser comum, com os ids de antes; % linha(s) gravadas depois da janela trazidas de volta; activity_part vazia de novo',
    restored;
END
$step$;
