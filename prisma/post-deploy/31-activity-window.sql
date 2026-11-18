-- ----------------------------------------------------------------------------
-- The copy window of the activity trail: activity becomes the table
-- partitioned by month on its id, its random ids re-keyed to uuid v7, only
-- inside the interval the owner approved (plano-escala F2-18, D39, D68)
-- ----------------------------------------------------------------------------
-- Why. activity is written by every action of every user and kept for
-- good (ACTIVITY_RETENTION_DAYS is opt-in). Partitioned by month on its id,
-- the listing of a period reads one or two months (F2-19) instead of the
-- whole trail. The shell, activity_part, was made empty by the migrations
-- 20261118140000 to 20261118140200 with every column, index and foreign
-- key, so the window has nothing left to build under its lock.
--
-- The ids. Rows written before the switch to uuid v7 (09/2025) carry a v4,
-- random from its first digit: it would land in any month's range, or in
-- none. The copy gives each of them a v7 of its own created_at, the same
-- one on every run (trajetto_activity_rekey, below: the instant of
-- created_at, then bits of the md5 of the old id). A v7 id stays as it is.
-- Nothing references activity.id; the web drops its cached feed when the
-- data version the API sends changes (x-trajetto-data-version), and for
-- 14 days the old id resolves through activity_legacy:
--   SELECT id AS id_antigo, trajetto_activity_rekey(id, created_at) AS id_novo
--   FROM activity_legacy WHERE id = '<id antigo>';
--
-- When. Only inside HISTORY_WINDOW_APPROVED, as
-- 30-delivery-event-window.sql (the same approval, the same night); 'skipped:
-- aguardando janela' outside it, on a database with no company too. Inside
-- it, 'pending' until every live process announces
-- history-partition-agnostic-v1: the image from before the plan relies on
-- the unique of activity.deliveryId, which the partitioned table does not
-- keep (an activity of the pipeline is written under its delivery's id,
-- F2-15).
--
-- How, in one transaction: LOCK activity IN SHARE ROW EXCLUSIVE MODE (the
-- writes of the trail wait, the reads go on; 10 s per attempt, three), the
-- INSERT ... SELECT with the re-key, the counts of both tables compared, the
-- lock raised to ACCESS EXCLUSIVE for the renames (30 s), activity and what
-- it owns renamed to activity_legacy (14 days; wave 20 drops it) and the
-- shell, its indexes, constraints and partitions to the canonical names
-- (activity_YYYYMM, and activity_older for the partition FROM (MINVALUE)),
-- the plain table's grants on the new parent. Then an ANALYZE of it.
--
-- A lock that does not come, an id that fits no partition or an error
-- leaves both tables as they were, and the step says 'pending' with the
-- cause. The way back in the 14 days is
-- prisma/post-deploy/rollback/unpartition-activity.sql
-- (docs/runbooks/history-window.md).
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  approval_text CONSTANT text := nullif(trim(coalesce(current_setting('trajetto.history_window_approved', true), '')), '');
  hold_marker CONSTANT text := 'trajetto:window-hold';
  v7_pattern CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
  -- What each lock waits, in its set_config: 10 s for the trail's first
  -- lock, 30 s for the renames; named here for the notices.
  lock_wait CONSTANT text := '10s';
  rename_wait CONSTANT text := '30s';
  max_attempts CONSTANT integer := 3;
  max_window CONSTANT interval := interval '24 hours';
  plain_kind text;
  plain_note text;
  shell_kind text;
  approved_from timestamptz;
  approved_to timestamptz;
  columns_list text;
  select_list text;
  member record;
  new_name text;
  attempt integer := 0;
  phase text;
  outcome text;
  failure text;
  lock_asked_at timestamptz;
  locked_at timestamptz;
  copied_at timestamptz;
  done_at timestamptz;
  copied bigint := 0;
  rekeyed bigint := 0;
  source_rows bigint;
  shell_rows bigint;
  acl_row record;
BEGIN
  SELECT c.relkind::text, coalesce(obj_description(c.oid, 'pg_class'), '')
  INTO plain_kind, plain_note
  FROM pg_catalog.pg_class c
  WHERE c.oid = to_regclass('activity');

  IF plain_kind IS NULL THEN
    RAISE NOTICE 'pending: a tabela activity não existe';
    RETURN;
  END IF;

  IF plain_kind = 'p' THEN
    RAISE NOTICE 'skipped: o registro de atividades (activity) já é particionado por mês';
    RETURN;
  END IF;

  IF starts_with(plain_note, hold_marker) THEN
    RAISE NOTICE 'skipped: activity voltou a ser comum à mão (comentário %); a janela fica parada até o comentário sair', hold_marker;
    RETURN;
  END IF;

  SELECT c.relkind::text INTO shell_kind
  FROM pg_catalog.pg_class c
  WHERE c.oid = to_regclass('activity_part');

  IF shell_kind IS DISTINCT FROM 'p' THEN
    RAISE NOTICE 'pending: a casca activity_part não existe ou não é particionada (migration 20261118140000_activity_part)';
    RETURN;
  END IF;

  IF approval_text IS NULL THEN
    RAISE NOTICE 'skipped: aguardando janela (HISTORY_WINDOW_APPROVED vazia na trajetto-api-migrate)';
    RETURN;
  END IF;

  BEGIN
    approved_from := split_part(approval_text, '/', 1)::timestamptz;
    approved_to := split_part(approval_text, '/', 2)::timestamptz;
  EXCEPTION WHEN others THEN
    approved_from := NULL;
    approved_to := NULL;
  END;

  IF approved_from IS NULL OR approved_to IS NULL
     OR approved_to <= approved_from
     OR approved_to - approved_from > max_window THEN
    RAISE NOTICE 'skipped: aguardando janela (HISTORY_WINDOW_APPROVED não é um intervalo de até 24 h: %)', approval_text;
    RETURN;
  END IF;

  IF clock_timestamp() < approved_from OR clock_timestamp() >= approved_to THEN
    RAISE NOTICE 'skipped: aguardando janela (agora, %, fora do intervalo aprovado de % a %)',
      to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      to_char(approved_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      to_char(approved_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
    RETURN;
  END IF;

  -- On a database with no company the answer is yes: nothing to protect.
  IF NOT trajetto_capability_ready('history-partition-agnostic-v1', interval '5 minutes') THEN
    RAISE NOTICE 'pending: dentro da janela aprovada, mas nem todo processo vivo anuncia history-partition-agnostic-v1 (a imagem anterior ainda conta com o unique de activity.deliveryId); rode de novo quando o rolling terminar';
    RETURN;
  END IF;

  IF to_regclass('activity_legacy') IS NOT NULL THEN
    RAISE NOTICE 'pending: já existe uma tabela activity_legacy; confira a volta de uma janela anterior (docs/runbooks/history-window.md)';
    RETURN;
  END IF;

  -- The re-key, made before the copy (the window, the way back and the
  -- support query of the 14 days use it). IMMUTABLE: the same old id and
  -- created_at give the same new id, on any run, before and after the
  -- window. Inside this block, so the file stays one statement and may
  -- COMMIT.
  EXECUTE $create$
    CREATE OR REPLACE FUNCTION trajetto_activity_rekey(old_id text, created timestamp)
    RETURNS text
    LANGUAGE sql
    IMMUTABLE
    PARALLEL SAFE
    SET search_path = pg_catalog, pg_temp
    AS $fn$
      SELECT substr(t, 1, 8) || '-' || substr(t, 9, 4) || '-7' || substr(h, 1, 3)
             || '-' || substr('89ab', (get_byte(decode(substr(h, 4, 2), 'hex'), 0) % 4) + 1, 1)
             || substr(h, 6, 3) || '-' || substr(h, 9, 12)
      FROM (
        SELECT lpad(to_hex(floor(extract(epoch FROM created) * 1000)::bigint), 12, '0') AS t,
               md5('trajetto:activity-rekey:' || old_id) AS h
      ) parts
    $fn$
  $create$;

  REVOKE ALL ON FUNCTION trajetto_activity_rekey(text, timestamp) FROM PUBLIC;

  -- Every column of the trail, in its order; the id re-keyed where it is
  -- not a v7.
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
         string_agg(
           CASE WHEN a.attname = 'id'
             THEN format('CASE WHEN "id" ~ %L THEN "id" ELSE trajetto_activity_rekey("id", "created_at") END', v7_pattern)
             ELSE quote_ident(a.attname)
           END,
           ', ' ORDER BY a.attnum
         )
  INTO columns_list, select_list
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = to_regclass('activity')
    AND a.attnum > 0
    AND NOT a.attisdropped;

  COMMIT;

  LOOP
    attempt := attempt + 1;
    phase := 'lock';
    outcome := NULL;
    failure := NULL;
    lock_asked_at := clock_timestamp();

    BEGIN
      PERFORM set_config('lock_timeout', '10s', true);

      -- Writers wait from here; readers do not.
      LOCK TABLE "activity" IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE "activity_part" IN ACCESS EXCLUSIVE MODE;
      locked_at := clock_timestamp();
      phase := 'copy';

      IF (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('activity')) <> 'r' THEN
        outcome := 'already';
      ELSE
        IF EXISTS (SELECT 1 FROM "activity_part" LIMIT 1) THEN
          RAISE EXCEPTION 'a casca activity_part não está vazia';
        END IF;

        EXECUTE format(
          'INSERT INTO "activity_part" (%s) SELECT %s FROM "activity"',
          columns_list,
          select_list
        );

        GET DIAGNOSTICS copied = ROW_COUNT;
        copied_at := clock_timestamp();

        SELECT count(*), count(*) FILTER (WHERE "id" !~ v7_pattern)
        INTO source_rows, rekeyed
        FROM "activity";
        SELECT count(*) INTO shell_rows FROM "activity_part";

        IF source_rows <> shell_rows OR source_rows <> copied THEN
          RAISE EXCEPTION 'as contagens não batem: activity % linhas, casca %, copiadas %',
            source_rows, shell_rows, copied;
        END IF;

        phase := 'rename';
        PERFORM set_config('lock_timeout', '30s', true);
        LOCK TABLE "activity" IN ACCESS EXCLUSIVE MODE;

        -- The plain table steps aside, with what it owns.
        FOR member IN
          SELECT ic.relname::text AS name
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = to_regclass('activity')
          ORDER BY 1
        LOOP
          new_name := left(CASE
            WHEN starts_with(member.name, 'activity_') THEN 'activity_legacy_' || substr(member.name, 10)
            ELSE member.name || '_legacy'
          END, 63);
          EXECUTE format('ALTER INDEX %I RENAME TO %I', member.name, new_name);
        END LOOP;

        FOR member IN
          SELECT con.conname::text AS name
          FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = to_regclass('activity')
            AND con.contype NOT IN ('p', 'u', 'x')
          ORDER BY 1
        LOOP
          new_name := left(CASE
            WHEN starts_with(member.name, 'activity_') THEN 'activity_legacy_' || substr(member.name, 10)
            ELSE member.name || '_legacy'
          END, 63);
          EXECUTE format('ALTER TABLE "activity" RENAME CONSTRAINT %I TO %I', member.name, new_name);
        END LOOP;

        ALTER TABLE "activity" RENAME TO "activity_legacy";

        -- The shell takes the canonical names.
        FOR member IN
          SELECT ic.relname::text AS name
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = to_regclass('activity_part')
            AND starts_with(ic.relname::text, 'activity_part_')
          ORDER BY 1
        LOOP
          EXECUTE format('ALTER INDEX %I RENAME TO %I', member.name, 'activity_' || substr(member.name, 15));
        END LOOP;

        FOR member IN
          SELECT con.conname::text AS name
          FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = to_regclass('activity_part')
            AND con.contype NOT IN ('p', 'u', 'x')
            AND starts_with(con.conname::text, 'activity_part_')
          ORDER BY 1
        LOOP
          EXECUTE format('ALTER TABLE "activity_part" RENAME CONSTRAINT %I TO %I', member.name, 'activity_' || substr(member.name, 15));
        END LOOP;

        FOR member IN
          SELECT c.relname::text AS name
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = to_regclass('activity_part')
            AND starts_with(c.relname::text, 'activity_part_')
          ORDER BY 1
        LOOP
          EXECUTE format(
            'ALTER TABLE %I RENAME TO %I',
            member.name,
            CASE
              WHEN member.name = 'activity_part_legacy' THEN 'activity_older'
              ELSE 'activity_' || substr(member.name, 15)
            END
          );
        END LOOP;

        ALTER TABLE "activity_part" RENAME TO "activity";

        -- The plain table's grants on the new parent; none on a partition.
        FOR acl_row IN
          SELECT a.grantee, a.privilege_type, a.is_grantable
          FROM pg_catalog.pg_class c
          CROSS JOIN LATERAL aclexplode(c.relacl) a
          WHERE c.oid = to_regclass('activity_legacy')
            AND a.grantee <> c.relowner
        LOOP
          EXECUTE format(
            'GRANT %s ON TABLE "activity" TO %s%s',
            acl_row.privilege_type,
            CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_row.grantee)) END,
            CASE WHEN acl_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
          );
        END LOOP;

        COMMENT ON TABLE "activity_legacy" IS
          'trajetto:window-legacy activity de antes da janela do histórico (plano-escala F2-18), com os ids de antes; fica 14 dias, trajetto_activity_rekey(id, created_at) dá o id novo, e a volta é prisma/post-deploy/rollback/unpartition-activity.sql';

        done_at := clock_timestamp();
        outcome := 'swapped';
      END IF;
    EXCEPTION
      WHEN lock_not_available OR deadlock_detected THEN
        outcome := CASE WHEN phase = 'lock' THEN 'busy' ELSE 'rename_busy' END;
        failure := SQLERRM;
      WHEN OTHERS THEN
        outcome := 'failed';
        failure := format('%s (%s)', SQLERRM, SQLSTATE);
    END;

    COMMIT;

    EXIT WHEN outcome <> 'busy' OR attempt >= max_attempts;

    PERFORM pg_sleep(1);
  END LOOP;

  IF outcome = 'already' THEN
    RAISE NOTICE 'skipped: o registro de atividades (activity) já é particionado por mês';
    RETURN;
  END IF;

  IF outcome <> 'swapped' THEN
    RAISE NOTICE 'pending: %; activity ficou como era (escritas paradas por % s nesta tentativa); rode de novo dentro do intervalo aprovado',
      CASE outcome
        WHEN 'busy' THEN format('o lock de activity não veio em %s tentativas de %s', attempt, lock_wait)
        WHEN 'rename_busy' THEN format('o lock do rename não veio em %s (%s)', rename_wait, failure)
        ELSE format('erro na cópia: %s', failure)
      END,
      round(extract(epoch FROM clock_timestamp() - lock_asked_at)::numeric, 1);
    RETURN;
  END IF;

  BEGIN
    ANALYZE (SKIP_LOCKED) "activity";
  EXCEPTION WHEN lock_not_available THEN
    NULL;
  END;

  RAISE NOTICE 'applied: activity particionada por mês, % linhas copiadas, % id(s) de antes do v7 re-chaveados; pausa de escrita de % s (lock em % s, cópia em % s, contagens e renames em % s); a tabela de antes é activity_legacy (14 dias)',
    copied,
    rekeyed,
    round(extract(epoch FROM done_at - lock_asked_at)::numeric, 1),
    round(extract(epoch FROM locked_at - lock_asked_at)::numeric, 1),
    round(extract(epoch FROM copied_at - locked_at)::numeric, 1),
    round(extract(epoch FROM done_at - copied_at)::numeric, 1);
END
$step$;
