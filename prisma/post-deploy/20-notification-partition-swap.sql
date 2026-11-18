-- ----------------------------------------------------------------------------
-- The bell (notification) becomes a table partitioned by month on
-- RANGE(id), the plain table of today kept as the legacy partition
-- (plano-escala F5-15, as the queues' swap of F5-09, ADR 0014)
-- ----------------------------------------------------------------------------
-- Why. The bell grows by about one row per IN_APP delivery (millions a
-- month at the target scale), and its nightly purge was the only way out:
-- a DELETE for each read row past NOTIFICATION_READ_RETENTION_DAYS and
-- each unread one past NOTIFICATION_UNREAD_RETENTION_DAYS. Partitioned by
-- month on its uuid v7 id (a notification's id is its delivery's, the
-- event's millisecond, F5-14), a month past the unread retention leaves
-- whole, by DETACH and DROP in the partition-maintenance job, and the
-- bell's reads carry a floor of ids (notification-repository.ts) that keeps
-- them on the months the retention keeps.
--
-- When. Only once every live process announces
-- notification-partition-agnostic-v1 (trajetto_capability_ready,
-- 00-queue-swap-ready.sql) and 07-notification-contract.sql took the
-- foreign keys and the unique on deliveryId, which a partitioned table
-- cannot keep. Until then 'pending'. On a database with no company it
-- swaps at once.
--
-- How: as 10-queue-partition-swap.sql, in three transactions, the table
-- under ACCESS EXCLUSIVE only for instants and never while it is read
-- (every IN_APP delivery writes the bell inside a transaction of its own):
--
--   A. the guard CHECK ("id" < cutoff) NOT VALID,
--      notification_swap_cutoff, once max("id") is below the cutoff;
--   B. its VALIDATE, the one read of the table, under SHARE UPDATE
--      EXCLUSIVE: reads and writes go on;
--   C. under the lock again, the plain table becomes notification_legacy,
--      attached FROM (MINVALUE) TO the cutoff with no read (the guard
--      proves it), its indexes attached to the parent's under the original
--      names; then the two months from the cutoff, the grants of the plain
--      table on the parent, and trajetto_partitions as the owner of the
--      tree. The partition job keeps two months ahead from then on.
--
-- The cutoff is the first day of a month (UTC) at least a day away: next
-- month's, or on the last day of this one the month after. The day is
-- the guard's margin: every INSERT between A and C is checked against it.
-- A swap that does not finish takes its guard back off before the step
-- ends; a guard it could not take off, or one left by a run that died, is
-- taken off (or gone on from) by the next run, and until then the step
-- says 'pending'.
--
-- The locks: each attempt waits at most 3 s (or one second longer than
-- deadlock_timeout), three times; while an ACCESS EXCLUSIVE waits, every
-- read of the bell queues behind it, and the wait of B holds up nobody (the
-- NOTICE says how long each took: 'tempos: notification em N s (espera,
-- trava, validação)'). B reads the whole table, so a bell with more than
-- 2 M rows is left plain, 'skipped', for a window of its own: this file run
-- by hand after SET trajetto.swap_window = 'on'. A lock that does not come,
-- an id at or past the cutoff or an error keeps it plain and the step
-- 'pending'; the swap never fails a deploy. The way back is
-- prisma/post-deploy/rollback/unpartition-queue.sql with
-- trajetto.unpartition_queue = 'notification'.
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  queues CONSTANT text[] := ARRAY['notification'];
  months_ahead CONSTANT integer := 2;
  max_rows CONSTANT real := 2000000;
  max_attempts CONSTANT integer := 3;
  guard_margin CONSTANT interval := interval '1 day';
  hold_marker CONSTANT text := 'trajetto:swap-hold';
  owner_role CONSTANT name := 'trajetto_partitions';
  queue text;
  legacy text;
  guard text;
  guard_def text;
  guard_valid boolean;
  state text;
  blocked text;
  plain record;
  index_row record;
  acl_row record;
  member_row record;
  index_defs text[];
  pk_name text;
  legacy_name text;
  suffix integer;
  table_options text[];
  cutoff_at timestamp;
  cutoff text;
  hex text;
  bound_from text;
  bound_to text;
  newest text;
  day_offset integer;
  def_index integer;
  attempt integer;
  unattached text;
  left_over text[] := ARRAY[]::text[];
  too_big text[] := ARRAY[]::text[];
  held text[] := ARRAY[]::text[];
  contract_left text[];
  swapped text[] := ARRAY[]::text[];
  waiting text[] := ARRAY[]::text[];
  out_of_range text[] := ARRAY[]::text[];
  failed text[] := ARRAY[]::text[];
  guards_left text[] := ARRAY[]::text[];
  guard_note text;
  -- What each swap cost, for the step's log: the waits for ACCESS
  -- EXCLUSIVE (every query of the table queues behind them), the time it
  -- was held, and the validation (which holds up nobody).
  started_at timestamptz;
  lock_asked timestamptz;
  locked_at timestamptz;
  waited interval;
  held_for interval;
  validated interval;
  timings text[] := ARRAY[]::text[];
  owner_kept boolean := false;
  -- Set by hand for a window of its own (docs/adr/0014-filas-particionadas.md):
  -- the size cap is the release step's, not the swap's.
  in_window CONSTANT boolean := coalesce(current_setting('trajetto.swap_window', true), '') = 'on';
BEGIN
  PERFORM set_config(
    'lock_timeout',
    greatest(
      3000,
      floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000
    )::bigint || 'ms',
    false
  );

  FOREACH queue IN ARRAY queues LOOP
    SELECT c.relkind::text AS kind,
           c.reltuples,
           coalesce(obj_description(c.oid, 'pg_class'), '') AS note
    INTO plain
    FROM pg_catalog.pg_class c
    WHERE c.oid = to_regclass(quote_ident(queue));

    CONTINUE WHEN NOT FOUND OR plain.kind <> 'r';

    IF starts_with(plain.note, hold_marker) THEN
      held := held || queue;
    ELSIF plain.reltuples > max_rows AND NOT in_window THEN
      too_big := too_big || format('%s (~%s linhas)', queue, plain.reltuples::bigint);
    ELSE
      left_over := left_over || queue;
    END IF;
  END LOOP;

  IF cardinality(left_over) > 0 THEN
    IF NOT trajetto_capability_ready('notification-partition-agnostic-v1', interval '5 minutes') THEN
      blocked := 'o sino espera todo processo vivo anunciar notification-partition-agnostic-v1 para virar particionado por mês';
    ELSE
      -- What 07-notification-contract.sql takes, and a partitioned table
      -- cannot keep: a unique without the id, or a foreign key to or from it.
      SELECT coalesce(array_agg(name ORDER BY name), ARRAY[]::text[])
      INTO contract_left
      FROM (
        SELECT c.conname::text AS name
        FROM pg_catalog.pg_constraint c
        WHERE c.contype = 'f'
          AND (c.conrelid = ANY (SELECT to_regclass(quote_ident(q)) FROM unnest(left_over) q)
            OR c.confrelid = ANY (SELECT to_regclass(quote_ident(q)) FROM unnest(left_over) q))
        UNION ALL
        SELECT i.indexrelid::regclass::text
        FROM pg_catalog.pg_index i
        WHERE i.indisunique AND NOT i.indisprimary
          AND i.indrelid = ANY (SELECT to_regclass(quote_ident(q)) FROM unnest(left_over) q)
      ) leftovers;

      IF cardinality(contract_left) > 0 THEN
        blocked := format(
          'a contração do sino (07-notification-contract.sql) ainda não tirou %s',
          array_to_string(contract_left, ', ')
        );
      END IF;
    END IF;
  END IF;

  FOREACH queue IN ARRAY CASE WHEN blocked IS NULL THEN left_over ELSE ARRAY[]::text[] END LOOP
    legacy := queue || '_legacy';
    guard := queue || '_swap_cutoff';
    state := 'go';
    started_at := clock_timestamp();
    waited := interval '0';
    held_for := interval '0';
    validated := interval '0';

    cutoff_at := date_trunc('month', timezone('UTC', now())) + interval '1 month';

    IF cutoff_at < timezone('UTC', now()) + guard_margin THEN
      cutoff_at := cutoff_at + interval '1 month';
    END IF;

    hex := lpad(to_hex((extract(epoch FROM cutoff_at) * 1000)::bigint), 12, '0');
    cutoff := substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-0000-0000-000000000000';

    -- A guard left by a run whose session died: kept when it is the one
    -- this run would add (B and C go on from it), replaced otherwise.
    SELECT pg_get_constraintdef(c.oid), c.convalidated
    INTO guard_def, guard_valid
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = to_regclass(quote_ident(queue))
      AND c.conname = guard;

    -- A. The guard, NOT VALID: an instant under the lock.
    IF guard_def IS NULL OR strpos(guard_def, quote_literal(cutoff)) = 0 THEN
      attempt := 0;

      LOOP
        BEGIN
          lock_asked := clock_timestamp();
          EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', queue);
          locked_at := clock_timestamp();
          waited := waited + (locked_at - lock_asked);

          -- Under the lock, as it is now: another run may have swapped it.
          IF (SELECT c.relkind FROM pg_catalog.pg_class c
              WHERE c.oid = to_regclass(quote_ident(queue))) <> 'r' THEN
            state := 'gone';
            EXIT;
          END IF;

          IF to_regclass(quote_ident(legacy)) IS NOT NULL THEN
            RAISE EXCEPTION 'já existe uma tabela %', legacy;
          END IF;

          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', queue, guard);

          -- The newest id, from the primary key's index: one past the
          -- cutoff would fail the validation after a whole read.
          EXECUTE format('SELECT max("id") FROM %I', queue) INTO newest;

          IF newest IS NOT NULL AND newest >= cutoff THEN
            out_of_range := out_of_range || format('%s (id %s)', queue, newest);
            state := 'out_of_range';
            EXIT;
          END IF;

          EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK ("id" < %L) NOT VALID', queue, guard, cutoff);
          guard_valid := false;
          held_for := held_for + (clock_timestamp() - locked_at);
          EXIT;
        EXCEPTION
          WHEN lock_not_available OR deadlock_detected THEN
            waited := waited + (clock_timestamp() - lock_asked);
            attempt := attempt + 1;

            IF attempt >= max_attempts THEN
              waiting := waiting || queue;
              state := 'waiting';
              EXIT;
            END IF;

            PERFORM pg_sleep(1);
          WHEN OTHERS THEN
            failed := failed || format('%s (%s)', queue, SQLERRM);
            state := 'failed';
            EXIT;
        END;
      END LOOP;

      COMMIT;
    END IF;

    -- B. The one read of the table, under SHARE UPDATE EXCLUSIVE: the
    -- writes go on, each checked against the guard.
    IF state = 'go' AND NOT guard_valid THEN
      attempt := 0;

      LOOP
        BEGIN
          lock_asked := clock_timestamp();
          EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', queue, guard);
          validated := clock_timestamp() - lock_asked;
          EXIT;
        EXCEPTION
          WHEN lock_not_available OR deadlock_detected THEN
            attempt := attempt + 1;

            IF attempt >= max_attempts THEN
              waiting := waiting || queue;
              state := 'waiting';
              EXIT;
            END IF;

            PERFORM pg_sleep(1);
          WHEN check_violation THEN
            out_of_range := out_of_range || format('%s (um id no corte %s ou depois)', queue, cutoff);
            state := 'out_of_range';
            EXIT;
          WHEN OTHERS THEN
            failed := failed || format('%s (%s)', queue, SQLERRM);
            state := 'failed';
            EXIT;
        END;
      END LOOP;

      COMMIT;
    END IF;

    -- C. The swap, under the lock: catalog changes only.
    IF state = 'go' THEN
      attempt := 0;

      LOOP
        BEGIN
          lock_asked := clock_timestamp();
          EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', queue);
          locked_at := clock_timestamp();
          waited := waited + (locked_at - lock_asked);

          IF (SELECT c.relkind FROM pg_catalog.pg_class c
              WHERE c.oid = to_regclass(quote_ident(queue))) <> 'r' THEN
            state := 'gone';
            EXIT;
          END IF;

          IF to_regclass(quote_ident(legacy)) IS NOT NULL THEN
            RAISE EXCEPTION 'já existe uma tabela %', legacy;
          END IF;

          -- The guard as B left it: without it valid and at this cutoff,
          -- the ATTACH would read the whole table under this lock.
          IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_constraint c
            WHERE c.conrelid = to_regclass(quote_ident(queue))
              AND c.conname = guard
              AND c.convalidated
              AND strpos(pg_get_constraintdef(c.oid), quote_literal(cutoff)) > 0
          ) THEN
            RAISE EXCEPTION 'a restrição % não está validada no corte %', guard, cutoff;
          END IF;

          SELECT c.reloptions INTO table_options
          FROM pg_catalog.pg_class c
          WHERE c.oid = to_regclass(quote_ident(queue));

          SELECT con.conname::text INTO pk_name
          FROM pg_catalog.pg_constraint con
          WHERE con.conrelid = to_regclass(quote_ident(queue))
            AND con.contype = 'p';

          IF pk_name IS NULL THEN
            RAISE EXCEPTION '% não tem chave primária', queue;
          END IF;

          SELECT coalesce(array_agg(pg_get_indexdef(i.indexrelid) ORDER BY ic.relname), ARRAY[]::text[])
          INTO index_defs
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = to_regclass(quote_ident(queue))
            AND NOT i.indisprimary;

          -- 1. The plain table and its indexes step aside.
          FOR index_row IN
            SELECT ic.relname::text AS name
            FROM pg_catalog.pg_index i
            JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
            WHERE i.indrelid = to_regclass(quote_ident(queue))
            ORDER BY ic.relname
          LOOP
            legacy_name := left(index_row.name, 56) || '_legacy';
            suffix := 1;

            WHILE to_regclass(quote_ident(legacy_name)) IS NOT NULL LOOP
              suffix := suffix + 1;
              legacy_name := left(index_row.name, 52) || '_legacy' || suffix;
            END LOOP;

            EXECUTE format('ALTER INDEX %I RENAME TO %I', index_row.name, legacy_name);
          END LOOP;

          EXECUTE format('ALTER TABLE %I RENAME TO %I', queue, legacy);

          -- 2. The partitioned parent, under the original names, without
          -- the guard LIKE copied (it would refuse every month after the
          -- cutoff).
          EXECUTE format(
            'CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING COMMENTS INCLUDING STATISTICS) PARTITION BY RANGE ("id")',
            queue,
            legacy
          );
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', queue, guard);
          EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY ("id")', queue, pk_name);

          FOR def_index IN 1..coalesce(cardinality(index_defs), 0) LOOP
            EXECUTE index_defs[def_index];
          END LOOP;

          -- 3. The legacy table, proven below the cutoff by the guard,
          -- attached without a read; then the guard goes.
          EXECUTE format(
            'ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (MINVALUE) TO (%L)',
            queue,
            legacy,
            cutoff
          );
          EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', legacy, guard);

          SELECT string_agg(ic.relname::text, ', ' ORDER BY ic.relname)
          INTO unattached
          FROM pg_catalog.pg_index i
          JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
          WHERE i.indrelid = to_regclass(quote_ident(legacy))
            AND NOT EXISTS (
              SELECT 1 FROM pg_catalog.pg_inherits h WHERE h.inhrelid = i.indexrelid
            );

          IF unattached IS NOT NULL THEN
            RAISE EXCEPTION 'índice(s) de % sem par no pai: %', legacy, unattached;
          END IF;

          -- 4. The months from the cutoff, with the plain table's storage
          -- parameters.
          FOR day_offset IN 0..months_ahead - 1 LOOP
            hex := lpad(to_hex((extract(epoch FROM cutoff_at + make_interval(months => day_offset)) * 1000)::bigint), 12, '0');
            bound_from := substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-0000-0000-000000000000';
            hex := lpad(to_hex((extract(epoch FROM cutoff_at + make_interval(months => day_offset + 1)) * 1000)::bigint), 12, '0');
            bound_to := substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-0000-0000-000000000000';

            EXECUTE format(
              'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)%s',
              queue || '_' || to_char(cutoff_at + make_interval(months => day_offset), 'YYYYMM'),
              queue,
              bound_from,
              bound_to,
              CASE WHEN cardinality(table_options) > 0
                THEN ' WITH (' || array_to_string(table_options, ', ') || ')'
                ELSE ''
              END
            );
          END LOOP;

          -- The planner settings of a column (a tenant column's statistics
          -- target, F2-22), which LIKE does not copy; down to every partition.
          FOR member_row IN
            SELECT a.attname::text AS name, a.attstattarget AS target
            FROM pg_catalog.pg_attribute a
            WHERE a.attrelid = to_regclass(quote_ident(legacy))
              AND a.attnum > 0
              AND NOT a.attisdropped
              AND coalesce(a.attstattarget, -1) <> -1
          LOOP
            EXECUTE format(
              'ALTER TABLE %I ALTER COLUMN %I SET STATISTICS %s',
              queue,
              member_row.name,
              member_row.target
            );
          END LOOP;

          -- 5. The plain table's grants on the parent; none on a partition.
          FOR acl_row IN
            SELECT a.grantee, a.privilege_type, a.is_grantable
            FROM pg_catalog.pg_class c
            CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE c.oid = to_regclass(quote_ident(legacy))
              AND a.grantee <> c.relowner
          LOOP
            EXECUTE format(
              'GRANT %s ON TABLE %I TO %s%s',
              acl_row.privilege_type,
              queue,
              CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_row.grantee)) END,
              CASE WHEN acl_row.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
            );
          END LOOP;

          FOR acl_row IN
            SELECT DISTINCT tree.relid::regclass AS rel, a.grantee
            FROM pg_partition_tree(to_regclass(quote_ident(queue))) tree
            JOIN pg_catalog.pg_class c ON c.oid = tree.relid
            CROSS JOIN LATERAL aclexplode(c.relacl) a
            WHERE tree.level > 0
              AND a.grantee <> c.relowner
          LOOP
            EXECUTE format(
              'REVOKE ALL ON TABLE %s FROM %s',
              acl_row.rel,
              CASE WHEN acl_row.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(acl_row.grantee)) END
            );
          END LOOP;

          IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = owner_role) THEN
            BEGIN
              FOR member_row IN
                SELECT tree.relid::regclass AS rel
                FROM pg_partition_tree(to_regclass(quote_ident(queue))) tree
                ORDER BY tree.level, tree.relid::regclass::text
              LOOP
                EXECUTE format('ALTER TABLE %s OWNER TO %I', member_row.rel, owner_role);
              END LOOP;
            EXCEPTION WHEN insufficient_privilege THEN
              owner_kept := true;
            END;
          END IF;

          held_for := held_for + (clock_timestamp() - locked_at);
          swapped := swapped || queue;
          state := 'swapped';
          EXIT;
        EXCEPTION
          WHEN lock_not_available OR deadlock_detected THEN
            waited := waited + (clock_timestamp() - lock_asked);
            attempt := attempt + 1;

            IF attempt >= max_attempts THEN
              waiting := waiting || queue;
              state := 'waiting';
              EXIT;
            END IF;

            PERFORM pg_sleep(1);
          WHEN OTHERS THEN
            failed := failed || format('%s (%s)', queue, SQLERRM);
            state := 'failed';
            EXIT;
        END;
      END LOOP;

      COMMIT;
    END IF;

    IF state = 'swapped' THEN
      timings := timings || format(
        '%s em %s s (espera %s s, trava %s s, validação %s s)',
        queue,
        to_char(extract(epoch FROM clock_timestamp() - started_at), 'FM9999990.00'),
        to_char(extract(epoch FROM waited), 'FM9999990.00'),
        to_char(extract(epoch FROM held_for), 'FM9999990.00'),
        to_char(extract(epoch FROM validated), 'FM9999990.00')
      );
    END IF;

    -- The parent's statistics, outside the lock: autovacuum never analyzes
    -- a partitioned parent, and the planner reads them. A table someone is
    -- vacuuming is left for the partition job's Sunday ANALYZE.
    IF state = 'swapped' THEN
      BEGIN
        EXECUTE format('ANALYZE (SKIP_LOCKED) %I', queue);
      EXCEPTION WHEN lock_not_available THEN
        NULL;
      END;

      COMMIT;
    END IF;
  END LOOP;

  -- Every guard on a table still plain goes: the ones of the swaps that did
  -- not finish, and any a run that died left behind on a table this run
  -- did not swap (it was blocked, too big, or put back by hand).
  FOREACH queue IN ARRAY queues LOOP
    guard := queue || '_swap_cutoff';

    SELECT pg_get_constraintdef(c.oid)
    INTO guard_def
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class t ON t.oid = c.conrelid
    WHERE t.oid = to_regclass(quote_ident(queue))
      AND t.relkind = 'r'
      AND c.conname = guard;

    CONTINUE WHEN guard_def IS NULL;

    attempt := 0;

    LOOP
      BEGIN
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', queue, guard);
        EXIT;
      EXCEPTION
        WHEN lock_not_available OR deadlock_detected THEN
          attempt := attempt + 1;

          IF attempt >= max_attempts THEN
            guards_left := guards_left || format('%s (%s)', queue, guard_def);
            EXIT;
          END IF;

          PERFORM pg_sleep(1);
        WHEN OTHERS THEN
          guards_left := guards_left || format('%s (%s; %s)', queue, guard_def, SQLERRM);
          EXIT;
      END;
    END LOOP;

    COMMIT;
  END LOOP;

  IF cardinality(guards_left) > 0 THEN
    guard_note := format(
      'a restrição notification_swap_cutoff ficou em %s: passado o corte dela, o sino recusa toda gravação; rode a etapa de novo antes disso, ou tire à mão (ALTER TABLE notification DROP CONSTRAINT notification_swap_cutoff)',
      array_to_string(guards_left, ', ')
    );
  END IF;

  IF cardinality(left_over) = 0 THEN
    RAISE NOTICE '%: %',
      CASE WHEN guard_note IS NULL THEN 'skipped' ELSE 'pending' END,
      concat_ws(
        '; ',
        guard_note,
        CASE WHEN cardinality(too_big) + cardinality(held) = 0
          THEN 'o sino já é particionado por mês'
          ELSE 'o sino fica comum'
        END,
        CASE WHEN cardinality(too_big) > 0 THEN format(
          'grandes demais para a etapa, a troca exige uma janela própria (docs/adr/0014-filas-particionadas.md): %s',
          array_to_string(too_big, ', ')
        ) END,
        CASE WHEN cardinality(held) > 0 THEN format(
          'desfeitas à mão (comentário %s): %s',
          hold_marker,
          array_to_string(held, ', ')
        ) END
      );
  ELSIF blocked IS NOT NULL THEN
    RAISE NOTICE 'pending: %', concat_ws('; ', guard_note, blocked);
  ELSIF cardinality(waiting) + cardinality(out_of_range) + cardinality(failed) + cardinality(guards_left) > 0 THEN
    RAISE NOTICE 'pending: %', concat_ws(
      '; ',
      guard_note,
      CASE WHEN cardinality(waiting) > 0 THEN format('o lock não veio para %s', array_to_string(waiting, ', ')) END,
      CASE WHEN cardinality(out_of_range) > 0 THEN format('id fora da faixa v7, o sino fica comum até o expurgo levá-lo: %s', array_to_string(out_of_range, ', ')) END,
      CASE WHEN cardinality(failed) > 0 THEN format('erro, a tabela voltou ao que era: %s', array_to_string(failed, ', ')) END,
      format('já trocadas: %s', coalesce(nullif(array_to_string(swapped, ', '), ''), 'nenhuma')),
      CASE WHEN cardinality(timings) > 0 THEN format('tempos: %s', array_to_string(timings, ', ')) END,
      'o próximo release tenta de novo'
    );
  ELSE
    RAISE NOTICE 'applied: %', concat_ws(
      '; ',
      format('sino particionado por mês, a tabela de antes anexada como notification_legacy: %s', array_to_string(swapped, ', ')),
      CASE WHEN cardinality(timings) > 0 THEN format('tempos: %s', array_to_string(timings, ', ')) END,
      CASE WHEN owner_kept THEN format('o dono %s fica para o infra/sql/10-partitions.sql', owner_role) END,
      CASE WHEN cardinality(too_big) > 0 THEN format('grandes demais, exigem uma janela própria: %s', array_to_string(too_big, ', ')) END,
      CASE WHEN cardinality(held) > 0 THEN format('desfeitas à mão: %s', array_to_string(held, ', ')) END
    );
  END IF;
END
$step$;
