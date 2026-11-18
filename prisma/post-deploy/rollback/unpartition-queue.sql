-- ----------------------------------------------------------------------------
-- The way back of 10-queue-partition-swap.sql (plano-escala F5-09, ADR
-- 0014): a partitioned queue becomes one plain table again. Run BY HAND,
-- never by the release step (this folder is not one of its steps):
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "SET trajetto.unpartition_queue = 'webhook_delivery'" \
--     -f prisma/post-deploy/rollback/unpartition-queue.sql
--
-- `trajetto.unpartition_queue` names one queue, several separated by
-- commas, or `all` for the four. Without it the script refuses to run.
--
-- What it does, one transaction per queue, under the table's ACCESS
-- EXCLUSIVE lock (every read and write of that queue waits for it):
--
--   1. a plain <table>_unpartitioned with the same columns, defaults and
--      CHECKs and the storage parameters of the newest partition;
--   2. a copy of EVERY row, from every partition: the lock lasts as long as
--      the copy, so with millions of rows this is a window of its own, with
--      the workers stopped (docs/adr/0014-filas-particionadas.md);
--   3. the partitioned table and its partitions dropped, the plain one
--      renamed into its place, the primary key and every index rebuilt
--      under the original names, the parent's grants and the columns'
--      statistics targets given back;
--   4. the comment 'trajetto:swap-hold' on the table: the swap step leaves
--      it plain from then on ('skipped'). To let the swap run again:
--      COMMENT ON TABLE <table> IS NULL.
--
-- The rows of a day the retention already dropped are gone either way;
-- nothing else is lost. A queue that is already plain only gets the
-- comment.
-- ----------------------------------------------------------------------------

DO $step$
DECLARE
  queues CONSTANT text[] := ARRAY[
    'domain_outbox_event',
    'notification_delivery',
    'notification_provider_receipt',
    'webhook_delivery'
  ];
  hold_marker CONSTANT text := 'trajetto:swap-hold';
  wanted text := nullif(trim(current_setting('trajetto.unpartition_queue', true)), '');
  targets text[];
  queue text;
  plain_name text;
  grants text[];
  stat_targets text[];
  index_defs text[];
  def_index integer;
  pk_name text;
  table_options text[];
  copied bigint;
  done text[] := ARRAY[]::text[];
  already text[] := ARRAY[]::text[];
BEGIN
  IF wanted IS NULL THEN
    RAISE EXCEPTION 'defina trajetto.unpartition_queue (uma fila, várias separadas por vírgula, ou all) antes de rodar o script';
  END IF;

  targets := CASE
    WHEN wanted = 'all' THEN queues
    ELSE ARRAY(SELECT trim(name) FROM unnest(string_to_array(wanted, ',')) name)
  END;

  FOREACH queue IN ARRAY targets LOOP
    IF NOT (queue = ANY (queues)) THEN
      RAISE EXCEPTION '% não é uma das filas (%)', queue, array_to_string(queues, ', ');
    END IF;
  END LOOP;

  -- The whole copy holds the lock; a reader or writer that does not let go
  -- in 10 s stops the script before anything changed.
  PERFORM set_config('lock_timeout', '10s', false);

  FOREACH queue IN ARRAY targets LOOP
    plain_name := queue || '_unpartitioned';

    EXECUTE format('LOCK TABLE %I IN ACCESS EXCLUSIVE MODE', queue);

    IF (SELECT c.relkind FROM pg_catalog.pg_class c
        WHERE c.oid = to_regclass(quote_ident(queue))) <> 'p' THEN
      EXECUTE format(
        'COMMENT ON TABLE %I IS %L',
        queue,
        hold_marker || ': comum por prisma/post-deploy/rollback/unpartition-queue.sql em ' || to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI') || ' UTC; a troca 10-queue-partition-swap.sql espera este comentário sair'
      );
      already := already || queue;
      COMMIT;
      CONTINUE;
    END IF;

    SELECT c.reloptions INTO table_options
    FROM pg_partition_tree(to_regclass(quote_ident(queue))) tree
    JOIN pg_catalog.pg_class c ON c.oid = tree.relid
    WHERE tree.level = 1
    ORDER BY pg_get_expr(c.relpartbound, c.oid) LIKE '%MINVALUE%', c.relname DESC
    LIMIT 1;

    SELECT con.conname::text INTO pk_name
    FROM pg_catalog.pg_constraint con
    WHERE con.conrelid = to_regclass(quote_ident(queue))
      AND con.contype = 'p';

    -- A partitioned index prints as `ON ONLY <table>`: the plain table's
    -- index is the same statement without the ONLY.
    SELECT coalesce(array_agg(replace(pg_get_indexdef(i.indexrelid), ' ON ONLY ', ' ON ') ORDER BY ic.relname), ARRAY[]::text[])
    INTO index_defs
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
    WHERE i.indrelid = to_regclass(quote_ident(queue))
      AND NOT i.indisprimary;

    EXECUTE format(
      'CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING GENERATED INCLUDING STORAGE INCLUDING COMPRESSION INCLUDING COMMENTS INCLUDING STATISTICS)%s',
      plain_name,
      queue,
      CASE WHEN cardinality(table_options) > 0
        THEN ' WITH (' || array_to_string(table_options, ', ') || ')'
        ELSE ''
      END
    );
    EXECUTE format('INSERT INTO %I SELECT * FROM %I', plain_name, queue);
    GET DIAGNOSTICS copied = ROW_COUNT;

    -- The grants before the parent goes; given back to the plain table.
    SELECT coalesce(array_agg(format(
             'GRANT %s ON TABLE %I TO %s%s',
             a.privilege_type,
             queue,
             CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END,
             CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END
           )), ARRAY[]::text[])
    INTO grants
    FROM pg_catalog.pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE c.oid = to_regclass(quote_ident(queue))
      AND a.grantee <> c.relowner;

    -- The columns' statistics targets, which LIKE does not copy.
    SELECT coalesce(array_agg(format(
             'ALTER TABLE %I ALTER COLUMN %I SET STATISTICS %s',
             queue,
             a.attname,
             a.attstattarget
           )), ARRAY[]::text[])
    INTO stat_targets
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = to_regclass(quote_ident(queue))
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND coalesce(a.attstattarget, -1) <> -1;

    EXECUTE format('DROP TABLE %I', queue);
    EXECUTE format('ALTER TABLE %I RENAME TO %I', plain_name, queue);
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I PRIMARY KEY ("id")', queue, coalesce(pk_name, queue || '_pkey'));

    FOR def_index IN 1..coalesce(cardinality(index_defs), 0) LOOP
      EXECUTE index_defs[def_index];
    END LOOP;

    FOR def_index IN 1..coalesce(cardinality(stat_targets), 0) LOOP
      EXECUTE stat_targets[def_index];
    END LOOP;

    FOR def_index IN 1..coalesce(cardinality(grants), 0) LOOP
      EXECUTE grants[def_index];
    END LOOP;

    EXECUTE format(
      'COMMENT ON TABLE %I IS %L',
      queue,
      hold_marker || ': comum por prisma/post-deploy/rollback/unpartition-queue.sql em ' || to_char(timezone('UTC', now()), 'YYYY-MM-DD HH24:MI') || ' UTC; a troca 10-queue-partition-swap.sql espera este comentário sair'
    );

    done := done || format('%s (%s linhas)', queue, copied);
    COMMIT;

    EXECUTE format('ANALYZE %I', queue);
    COMMIT;
  END LOOP;

  RAISE NOTICE 'applied: %', concat_ws(
    '; ',
    CASE WHEN cardinality(done) > 0 THEN format('voltaram a ser tabelas comuns: %s', array_to_string(done, ', ')) END,
    CASE WHEN cardinality(already) > 0 THEN format('já eram comuns, só marcadas: %s', array_to_string(already, ', ')) END,
    format('a troca fica parada enquanto o comentário %s estiver na tabela', hold_marker)
  );
END
$step$;
