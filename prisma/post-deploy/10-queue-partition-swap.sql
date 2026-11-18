-- ----------------------------------------------------------------------------
-- The four queues become tables partitioned by day on RANGE(id), the
-- plain table of today kept as the legacy partition (plano-escala F5-09,
-- ADR 0014)
-- ----------------------------------------------------------------------------
-- Why. domain_outbox_event, notification_delivery,
-- notification_provider_receipt and webhook_delivery are work queues: each
-- row is claimed a few times and then only waits for its purge, and at 5M
-- deliveries a month that purge is millions of DELETEs a night, the dead
-- rows the claims step over and the WAL the standby replays. Partitioned
-- by day on their uuid v7 id, a day leaves whole, by DETACH and DROP
-- (F5-11, F5-12), with nothing left to vacuum.
--
-- When. Only once every live process announces queue-partition-agnostic-v1
-- and no unnamed session is connected (trajetto_queue_swap_ready,
-- 00-queue-swap-ready.sql): the image from before the plan leans on the
-- foreign keys and uniques a partitioned table cannot have. And only once
-- 05-queue-contract.sql took them (F5-06). Until then 'pending', and the
-- next deploy, or a force_release, runs the step again (U-11). On a
-- database with no company (the E2E template, `yarn dev` from scratch) it
-- swaps at once, so the suites run on the swapped schema.
--
-- How, one transaction per table, under its ACCESS EXCLUSIVE lock:
--
--   1. the indexes of the plain table get a `_legacy` name, and the table
--      becomes <table>_legacy;
--   2. a new <table>, partitioned by RANGE ("id"), with the same columns,
--      defaults and CHECKs, the primary key and every index under their
--      original names (Prisma and the migrations keep naming them);
--   3. CHECK ("id" < cutoff) on the legacy table, validated: the one scan of
--      the swap, and the proof that lets the ATTACH skip its own;
--   4. ATTACH of the legacy table FOR VALUES FROM (MINVALUE) TO (cutoff):
--      its indexes are attached to the parent's, never rebuilt (a legacy
--      index left unattached aborts the table's swap);
--   5. the days ahead, from the cutoff (tomorrow, UTC) for a week, with the
--      storage parameters the plain table had (a partitioned parent cannot
--      hold them), and the columns' statistics targets on the parent and
--      every partition; the nightly partition-maintenance job keeps the
--      lookahead from then on;
--   6. the grants the plain table had, on the new parent (the partitions
--      get none: every query names the parent), and trajetto_partitions as
--      the owner of the tree when it exists (infra/sql/10-partitions.sql
--      converges it on the next release anyway).
--
-- The cutoff is the next UTC midnight: what is written until then still
-- lands in the legacy partition, and the day after has a partition of its
-- own. Every id of the four is a uuid v7 (queue-ids-v7-guard.test.ts); an
-- id at or past the cutoff (a v4 written by hand) keeps that table plain,
-- 'pending', until the purge takes it.
--
-- The lock: each attempt waits at most 3 s for it (one second longer than
-- deadlock_timeout if that is longer: an autovacuum holding the table is
-- only cancelled by the waiter's deadlock check), and gives way for a
-- second, three times. While it waits, every new query of that table
-- queues behind it, so the wait is the pause the queue sees. Under the
-- lock the swap only scans the table once (the CHECK), so a table with
-- more than 2 M rows (pg_class.reltuples) is left plain, 'skipped': its
-- swap needs a window of its own (docs/adr/0014-filas-particionadas.md).
-- An error in one table rolls that table back and leaves the step
-- 'pending' with the message: the swap never fails a deploy.
--
-- The way back is prisma/post-deploy/rollback/unpartition-queue.sql, run
-- by hand; it marks the table with the comment 'trajetto:swap-hold', and
-- this step leaves a marked table alone ('skipped').
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  queues CONSTANT text[] := ARRAY[
    'domain_outbox_event',
    'notification_delivery',
    'notification_provider_receipt',
    'webhook_delivery'
  ];
  days_ahead CONSTANT integer := 7;
  max_rows CONSTANT real := 2000000;
  max_attempts CONSTANT integer := 3;
  hold_marker CONSTANT text := 'trajetto:swap-hold';
  owner_role CONSTANT name := 'trajetto_partitions';
  queue text;
  legacy text;
  plain record;
  index_row record;
  acl_row record;
  member_row record;
  index_defs text[];
  pk_name text;
  legacy_name text;
  suffix integer;
  table_options text[];
  day_start timestamp;
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
  owner_kept boolean := false;
BEGIN
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
    ELSIF plain.reltuples > max_rows THEN
      too_big := too_big || format('%s (~%s linhas)', queue, plain.reltuples::bigint);
    ELSE
      left_over := left_over || queue;
    END IF;
  END LOOP;

  IF cardinality(left_over) = 0 THEN
    RAISE NOTICE 'skipped: %', concat_ws(
      '; ',
      CASE WHEN cardinality(too_big) + cardinality(held) = 0
        THEN 'as filas já são particionadas por dia'
        ELSE 'nenhuma fila comum a trocar'
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
    RETURN;
  END IF;

  IF NOT trajetto_queue_swap_ready(interval '5 minutes') THEN
    RAISE NOTICE 'pending: % fila(s) esperam todo processo vivo anunciar queue-partition-agnostic-v1 para virar particionadas (%)', cardinality(left_over), array_to_string(left_over, ', ');
    RETURN;
  END IF;

  -- What 05-queue-contract.sql (F5-06) takes, and a partitioned table
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
    RAISE NOTICE 'pending: a contração das filas (05-queue-contract.sql) ainda não tirou %', array_to_string(contract_left, ', ');
    RETURN;
  END IF;

  PERFORM set_config(
    'lock_timeout',
    greatest(
      3000,
      floor(extract(epoch FROM current_setting('deadlock_timeout')::interval) * 1000) + 1000
    )::bigint || 'ms',
    false
  );

  FOREACH queue IN ARRAY left_over LOOP
    legacy := queue || '_legacy';
    attempt := 0;

    LOOP
      BEGIN
        EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', queue);

        -- Under the lock, as it is now: another run may have swapped it.
        IF (SELECT c.relkind FROM pg_catalog.pg_class c
            WHERE c.oid = to_regclass(quote_ident(queue))) <> 'r' THEN
          EXIT;
        END IF;

        IF to_regclass(quote_ident(legacy)) IS NOT NULL THEN
          RAISE EXCEPTION 'já existe uma tabela %', legacy;
        END IF;

        day_start := date_trunc('day', timezone('UTC', now()));
        cutoff_at := day_start + interval '1 day';
        hex := lpad(to_hex((extract(epoch FROM cutoff_at) * 1000)::bigint), 12, '0');
        cutoff := substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-0000-0000-000000000000';

        -- The newest id, from the primary key's index: one past the cutoff
        -- would fail the CHECK after a whole scan.
        EXECUTE format('SELECT max("id") FROM %I', queue) INTO newest;

        IF newest IS NOT NULL AND newest >= cutoff THEN
          out_of_range := out_of_range || format('%s (id %s)', queue, newest);
          EXIT;
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

        -- 2. The partitioned parent, under the original names.
        EXECUTE format(
          'CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING COMMENTS INCLUDING STATISTICS) PARTITION BY RANGE ("id")',
          queue,
          legacy
        );
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY ("id")', queue, pk_name);

        FOR def_index IN 1..coalesce(cardinality(index_defs), 0) LOOP
          EXECUTE index_defs[def_index];
        END LOOP;

        -- 3. and 4. The legacy table, proven below the cutoff, attached.
        EXECUTE format(
          'ALTER TABLE %I ADD CONSTRAINT %I CHECK ("id" < %L)',
          legacy,
          queue || '_swap_cutoff',
          cutoff
        );
        EXECUTE format(
          'ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (MINVALUE) TO (%L)',
          queue,
          legacy,
          cutoff
        );
        EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', legacy, queue || '_swap_cutoff');

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

        -- 5. The days ahead, with the plain table's storage parameters.
        FOR day_offset IN 1..days_ahead LOOP
          hex := lpad(to_hex((extract(epoch FROM day_start + make_interval(days => day_offset)) * 1000)::bigint), 12, '0');
          bound_from := substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-0000-0000-000000000000';
          hex := lpad(to_hex((extract(epoch FROM day_start + make_interval(days => day_offset + 1)) * 1000)::bigint), 12, '0');
          bound_to := substr(hex, 1, 8) || '-' || substr(hex, 9, 4) || '-0000-0000-000000000000';

          EXECUTE format(
            'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)%s',
            queue || '_' || to_char(day_start + make_interval(days => day_offset), 'YYYYMMDD'),
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

        -- 6. The plain table's grants on the parent; none on a partition.
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

        swapped := swapped || queue;
        EXIT;
      EXCEPTION
        WHEN lock_not_available OR deadlock_detected THEN
          attempt := attempt + 1;

          IF attempt >= max_attempts THEN
            waiting := waiting || queue;
            EXIT;
          END IF;

          PERFORM pg_sleep(1);
        WHEN OTHERS THEN
          failed := failed || format('%s (%s)', queue, SQLERRM);
          EXIT;
      END;
    END LOOP;

    COMMIT;

    -- The parent's statistics, outside the lock: autovacuum never analyzes
    -- a partitioned parent, and the planner reads them. A table someone is
    -- vacuuming is left for the partition job's Sunday ANALYZE.
    IF queue = ANY (swapped) THEN
      BEGIN
        EXECUTE format('ANALYZE (SKIP_LOCKED) %I', queue);
      EXCEPTION WHEN lock_not_available THEN
        NULL;
      END;

      COMMIT;
    END IF;
  END LOOP;

  IF cardinality(waiting) + cardinality(out_of_range) + cardinality(failed) > 0 THEN
    RAISE NOTICE 'pending: %', concat_ws(
      '; ',
      CASE WHEN cardinality(waiting) > 0 THEN format('o lock não veio para %s', array_to_string(waiting, ', ')) END,
      CASE WHEN cardinality(out_of_range) > 0 THEN format('id fora da faixa v7, a fila fica comum até o expurgo levá-lo: %s', array_to_string(out_of_range, ', ')) END,
      CASE WHEN cardinality(failed) > 0 THEN format('erro, a tabela voltou ao que era: %s', array_to_string(failed, ', ')) END,
      format('já trocadas: %s', coalesce(nullif(array_to_string(swapped, ', '), ''), 'nenhuma')),
      'o próximo release tenta de novo'
    );
  ELSE
    RAISE NOTICE 'applied: %', concat_ws(
      '; ',
      format('%s fila(s) particionadas por dia, a tabela de antes anexada como <fila>_legacy: %s', cardinality(swapped), array_to_string(swapped, ', ')),
      CASE WHEN owner_kept THEN format('o dono %s fica para o infra/sql/10-partitions.sql', owner_role) END,
      CASE WHEN cardinality(too_big) > 0 THEN format('grandes demais, exigem uma janela própria: %s', array_to_string(too_big, ', ')) END,
      CASE WHEN cardinality(held) > 0 THEN format('desfeitas à mão: %s', array_to_string(held, ', ')) END
    );
  END IF;
END
$step$;
