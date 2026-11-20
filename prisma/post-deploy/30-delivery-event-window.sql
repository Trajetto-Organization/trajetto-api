-- ----------------------------------------------------------------------------
-- The copy window of the delivery trail: delivery_event becomes the table
-- partitioned by month on its id, only inside the interval the owner
-- approved (plano-escala F2-17, D39, D66, D68)
-- ----------------------------------------------------------------------------
-- Why. delivery_event grows by a few rows per delivery for good, read by
-- tenant and by delivery and never purged. Partitioned by month on its id
-- (a uuid v7, so ids sort in time), the hot reads carry a floor of ids and
-- touch one or two months instead of the whole history. The shell,
-- delivery_event_part, was made empty by the migrations of F2-16 with
-- every column, index, foreign key and the writer bound of U-16 already in
-- it, so the window has nothing left to build under its lock.
--
-- When. Only inside HISTORY_WINDOW_APPROVED, the interval the owner types in
-- the Environment of trajetto-api-migrate at the start of the window
-- (release-steps.ts hands it over as trajetto.history_window_approved).
-- Outside it, or without it, the step ends 'skipped: aguardando janela': a
-- hotfix promoted after this release never runs the window by surprise.
-- The same on a database with no company: the E2E template and `yarn dev`
-- keep the plain table production has until its window, and a database
-- made for the rehearsal can still be seeded before the window runs (the
-- E2E files of the window approve it on their own database). Inside the
-- interval it also waits,
-- 'pending', until every live process announces
-- history-partition-agnostic-v1 (trajetto_capability_ready,
-- 00-queue-swap-ready.sql): the image from before the plan relies on the
-- global unique of client_submission_id, which the partitioned table does
-- not keep (its uniqueness lives in delivery_event_submission, F2-14).
--
-- How, in one transaction:
--   1. LOCK delivery_event IN SHARE ROW EXCLUSIVE MODE: every write of the
--      trail waits from here to the COMMIT (the measured pause), every read
--      goes on. A write of the API waits only its own lock_timeout (5 s)
--      and fails with a 503 SERVICE_BUSY (docs/runbooks/history-window.md
--      says what the users see). Each attempt waits at most 10 s for the
--      lock, three times, each attempt a transaction of its own;
--   2. the catch-up of delivery_event_submission: the keys the previous
--      image wrote only on delivery_event since the migration of F2-14
--      backfilled them;
--   3. INSERT ... SELECT of every row into the shell, txid named in the
--      column list: copied as it is, NULL included, never stamped by the
--      column's DEFAULT with the copy's own xid (a poller with a v2 cursor
--      would get the whole history again, F2-05);
--   4. the counts of both tables, and of the rows with a txid, must match;
--   5. the lock goes up to ACCESS EXCLUSIVE for the renames, waiting at
--      most 30 s for the reads in flight;
--   6. delivery_event and its indexes, constraints and trigger become
--      delivery_event_legacy (kept 14 days, wave 20 drops it); the shell,
--      its indexes, constraints, trigger and partitions take the canonical
--      names (delivery_event_YYYYMM, and delivery_event_older for the
--      partition FROM (MINVALUE)); the plain table's grants go to the new
--      parent;
--   7. the writer bound of U-16 on the new delivery_event (the shell's,
--      renamed; recreated if it is missing).
-- Then an ANALYZE of the parent, outside the lock.
--
-- A lock that does not come, an id past the shell's last month or an error
-- leaves both tables as they were, and the step says 'pending' with the
-- cause: the window may be run again while the interval lasts. The way back
-- in the 14 days is prisma/post-deploy/rollback/unpartition-delivery-event.sql
-- (docs/runbooks/history-window.md).
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  approval_text CONSTANT text := nullif(trim(coalesce(current_setting('trajetto.history_window_approved', true), '')), '');
  hold_marker CONSTANT text := 'trajetto:window-hold';
  submission_migration CONSTANT text := '20261117190000_delivery_event_submission';
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
  catchup_from timestamp;
  columns_list text;
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
  caught_up bigint := 0;
  copied bigint := 0;
  source_rows bigint;
  source_txids bigint;
  shell_rows bigint;
  shell_txids bigint;
  acl_row record;
BEGIN
  SELECT c.relkind::text, coalesce(obj_description(c.oid, 'pg_class'), '')
  INTO plain_kind, plain_note
  FROM pg_catalog.pg_class c
  WHERE c.oid = to_regclass('delivery_event');

  IF plain_kind IS NULL THEN
    RAISE NOTICE 'pending: a tabela delivery_event não existe';
    RETURN;
  END IF;

  IF plain_kind = 'p' THEN
    RAISE NOTICE 'skipped: a linha do tempo (delivery_event) já é particionada por mês';
    RETURN;
  END IF;

  IF starts_with(plain_note, hold_marker) THEN
    RAISE NOTICE 'skipped: delivery_event voltou a ser comum à mão (comentário %); a janela fica parada até o comentário sair', hold_marker;
    RETURN;
  END IF;

  SELECT c.relkind::text INTO shell_kind
  FROM pg_catalog.pg_class c
  WHERE c.oid = to_regclass('delivery_event_part');

  IF shell_kind IS DISTINCT FROM 'p' THEN
    RAISE NOTICE 'pending: a casca delivery_event_part não existe ou não é particionada (migration 20261117200000_delivery_event_part)';
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
    RAISE NOTICE 'pending: dentro da janela aprovada, mas nem todo processo vivo anuncia history-partition-agnostic-v1 (a imagem anterior ainda conta com o unique de client_submission_id); rode de novo quando o rolling terminar';
    RETURN;
  END IF;

  IF to_regclass('delivery_event_legacy') IS NOT NULL THEN
    RAISE NOTICE 'pending: já existe uma tabela delivery_event_legacy; confira a volta de uma janela anterior (docs/runbooks/history-window.md)';
    RETURN;
  END IF;

  -- The keys written since the backfill of F2-14 (a day of margin for the
  -- transactions in flight when it ran); all of them without its row.
  SELECT (max(m.finished_at) AT TIME ZONE 'UTC') - interval '1 day'
  INTO catchup_from
  FROM "_prisma_migrations" m
  WHERE m.migration_name = submission_migration
    AND m.finished_at IS NOT NULL
    AND m.rolled_back_at IS NULL;

  catchup_from := coalesce(catchup_from, '-infinity'::timestamp);

  -- Every column of the trail, in its order, txid included.
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
  INTO columns_list
  FROM pg_catalog.pg_attribute a
  WHERE a.attrelid = to_regclass('delivery_event')
    AND a.attnum > 0
    AND NOT a.attisdropped;

  -- Read before the transaction of the copy: its now() is the start the
  -- writer bound of U-16 measures from, so nothing waits before it.
  COMMIT;

  LOOP
    attempt := attempt + 1;
    phase := 'lock';
    outcome := NULL;
    failure := NULL;
    lock_asked_at := clock_timestamp();

    BEGIN
      PERFORM set_config('lock_timeout', '10s', true);

      -- 1. Writers wait from here; readers do not.
      LOCK TABLE "delivery_event" IN SHARE ROW EXCLUSIVE MODE;
      LOCK TABLE "delivery_event_part" IN ACCESS EXCLUSIVE MODE;
      locked_at := clock_timestamp();
      phase := 'copy';

      IF (SELECT c.relkind FROM pg_catalog.pg_class c WHERE c.oid = to_regclass('delivery_event')) <> 'r' THEN
        outcome := 'already';
      ELSE
        IF EXISTS (SELECT 1 FROM "delivery_event_part" LIMIT 1) THEN
          RAISE EXCEPTION 'a casca delivery_event_part não está vazia';
        END IF;

        -- 2. The catch-up of the submission keys.
        INSERT INTO "delivery_event_submission" ("client_submission_id", "event_id", "businessId", "created_at")
        SELECT e."client_submission_id", e."id", e."businessId", e."created_at"
        FROM "delivery_event" e
        WHERE e."client_submission_id" IS NOT NULL
          AND e."created_at" >= catchup_from
        ON CONFLICT ("client_submission_id") DO NOTHING;

        GET DIAGNOSTICS caught_up = ROW_COUNT;

        -- 3. Every row, txid as it is.
        EXECUTE format(
          'INSERT INTO "delivery_event_part" (%s) SELECT %s FROM "delivery_event"',
          columns_list,
          columns_list
        );

        GET DIAGNOSTICS copied = ROW_COUNT;
        copied_at := clock_timestamp();

        -- 4. Nothing lost, nothing stamped.
        SELECT count(*), count("txid") INTO source_rows, source_txids FROM "delivery_event";
        SELECT count(*), count("txid") INTO shell_rows, shell_txids FROM "delivery_event_part";

        IF source_rows <> shell_rows OR source_rows <> copied OR source_txids <> shell_txids THEN
          RAISE EXCEPTION 'as contagens não batem: delivery_event % linhas (% com txid), casca % (% com txid), copiadas %',
            source_rows, source_txids, shell_rows, shell_txids, copied;
        END IF;

        -- 5. The renames need the table alone.
        phase := 'rename';
        PERFORM set_config('lock_timeout', '30s', true);
        LOCK TABLE "delivery_event" IN ACCESS EXCLUSIVE MODE;

        -- 6a. The plain table steps aside, with what it owns.
        FOR member IN
          SELECT ic.relname::text AS name
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = to_regclass('delivery_event')
          ORDER BY 1
        LOOP
          new_name := left(CASE
            WHEN starts_with(member.name, 'delivery_event_') THEN 'delivery_event_legacy_' || substr(member.name, 16)
            ELSE member.name || '_legacy'
          END, 63);
          EXECUTE format('ALTER INDEX %I RENAME TO %I', member.name, new_name);
        END LOOP;

        FOR member IN
          SELECT con.conname::text AS name
          FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = to_regclass('delivery_event')
            AND con.contype NOT IN ('p', 'u', 'x')
          ORDER BY 1
        LOOP
          new_name := left(CASE
            WHEN starts_with(member.name, 'delivery_event_') THEN 'delivery_event_legacy_' || substr(member.name, 16)
            ELSE member.name || '_legacy'
          END, 63);
          EXECUTE format('ALTER TABLE "delivery_event" RENAME CONSTRAINT %I TO %I', member.name, new_name);
        END LOOP;

        FOR member IN
          SELECT t.tgname::text AS name
          FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid = to_regclass('delivery_event')
            AND NOT t.tgisinternal
          ORDER BY 1
        LOOP
          new_name := left(CASE
            WHEN starts_with(member.name, 'delivery_event_') THEN 'delivery_event_legacy_' || substr(member.name, 16)
            ELSE member.name || '_legacy'
          END, 63);
          EXECUTE format('ALTER TRIGGER %I ON "delivery_event" RENAME TO %I', member.name, new_name);
        END LOOP;

        ALTER TABLE "delivery_event" RENAME TO "delivery_event_legacy";

        -- 6b. The shell takes the canonical names.
        FOR member IN
          SELECT ic.relname::text AS name
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = to_regclass('delivery_event_part')
            AND starts_with(ic.relname::text, 'delivery_event_part_')
          ORDER BY 1
        LOOP
          EXECUTE format('ALTER INDEX %I RENAME TO %I', member.name, 'delivery_event_' || substr(member.name, 21));
        END LOOP;

        FOR member IN
          SELECT con.conname::text AS name
          FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = to_regclass('delivery_event_part')
            AND con.contype NOT IN ('p', 'u', 'x')
            AND starts_with(con.conname::text, 'delivery_event_part_')
          ORDER BY 1
        LOOP
          EXECUTE format('ALTER TABLE "delivery_event_part" RENAME CONSTRAINT %I TO %I', member.name, 'delivery_event_' || substr(member.name, 21));
        END LOOP;

        FOR member IN
          SELECT t.tgname::text AS name
          FROM pg_catalog.pg_trigger t
          WHERE t.tgrelid = to_regclass('delivery_event_part')
            AND NOT t.tgisinternal
            AND starts_with(t.tgname::text, 'delivery_event_part_')
          ORDER BY 1
        LOOP
          EXECUTE format('ALTER TRIGGER %I ON "delivery_event_part" RENAME TO %I', member.name, 'delivery_event_' || substr(member.name, 21));
        END LOOP;

        FOR member IN
          SELECT c.relname::text AS name
          FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = to_regclass('delivery_event_part')
            AND starts_with(c.relname::text, 'delivery_event_part_')
          ORDER BY 1
        LOOP
          EXECUTE format(
            'ALTER TABLE %I RENAME TO %I',
            member.name,
            CASE
              WHEN member.name = 'delivery_event_part_legacy' THEN 'delivery_event_older'
              ELSE 'delivery_event_' || substr(member.name, 21)
            END
          );
        END LOOP;

        ALTER TABLE "delivery_event_part" RENAME TO "delivery_event";

        -- The plain table's grants on the new parent; none on a partition.
        FOR acl_row IN
          SELECT a.grantee, a.privilege_type, a.is_grantable
          FROM pg_catalog.pg_class c
          CROSS JOIN LATERAL aclexplode(c.relacl) a
          WHERE c.oid = to_regclass('delivery_event_legacy')
            AND a.grantee <> c.relowner
        LOOP
          EXECUTE format(
            'GRANT %s ON TABLE "delivery_event" TO %s%s',
            acl_row.privilege_type,
            CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_row.grantee)) END,
            CASE WHEN acl_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
          );
        END LOOP;

        -- 7. The writer bound of U-16 on the new table.
        CREATE OR REPLACE TRIGGER "delivery_event_writer_bound"
          BEFORE INSERT ON "delivery_event"
          FOR EACH STATEMENT
          EXECUTE FUNCTION "trajetto_delivery_event_writer_bound"('240');

        -- The instant of the window, on the table it leaves behind: the
        -- contraction of F2-20 drops it 14 days after it, and the release
        -- step's own row of this file is overwritten by the next run.
        EXECUTE format(
          'COMMENT ON TABLE "delivery_event_legacy" IS %L',
          'trajetto:window-legacy at='
            || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
            || ' delivery_event de antes da janela do histórico (plano-escala F2-17); fica 14 dias, a volta é prisma/post-deploy/rollback/unpartition-delivery-event.sql'
        );

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
    RAISE NOTICE 'skipped: a linha do tempo (delivery_event) já é particionada por mês';
    RETURN;
  END IF;

  IF outcome <> 'swapped' THEN
    RAISE NOTICE 'pending: %; delivery_event ficou como era (escritas paradas por % s nesta tentativa); rode de novo dentro do intervalo aprovado',
      CASE outcome
        WHEN 'busy' THEN format('o lock de delivery_event não veio em %s tentativas de %s', attempt, lock_wait)
        WHEN 'rename_busy' THEN format('o lock do rename não veio em %s (%s)', rename_wait, failure)
        ELSE format('erro na cópia: %s', failure)
      END,
      round(extract(epoch FROM clock_timestamp() - lock_asked_at)::numeric, 1);
    RETURN;
  END IF;

  -- The parent's statistics, outside the lock: autovacuum never analyzes a
  -- partitioned parent, and the planner reads them.
  BEGIN
    ANALYZE (SKIP_LOCKED) "delivery_event";
  EXCEPTION WHEN lock_not_available THEN
    NULL;
  END;

  RAISE NOTICE 'applied: delivery_event particionada por mês, % linhas copiadas (% com txid), % chave(s) de envio recuperadas; pausa de escrita de % s (lock em % s, cópia em % s, contagens e renames em % s); a tabela de antes é delivery_event_legacy (14 dias)',
    copied,
    shell_txids,
    caught_up,
    round(extract(epoch FROM done_at - lock_asked_at)::numeric, 1),
    round(extract(epoch FROM locked_at - lock_asked_at)::numeric, 1),
    round(extract(epoch FROM copied_at - locked_at)::numeric, 1),
    round(extract(epoch FROM done_at - copied_at)::numeric, 1);
END
$step$;
