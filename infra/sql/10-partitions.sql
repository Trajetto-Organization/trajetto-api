-- trajetto_partitions: the owner of the partitioned tables and of every
-- partition (plano-escala F2-07).
--
-- Why a role of its own. On Postgres 16, ATTACH and DETACH PARTITION, DROP,
-- VACUUM, ANALYZE and ALTER TABLE … SET need the table's OWNER (the MAINTAIN
-- privilege only arrives in 17), and creating a partition needs CREATE on
-- the schema. Today the runtime connects as the Database's user, a
-- superuser, so it can do all of it; once it connects as trajetto_batch
-- (wave 6, F3-19/F3-21) it can only do it through a NOLOGIN role that owns
-- the tables and that it is a member of: this one. Until then nothing
-- changes for the runtime: a superuser may still do everything, and the
-- partition job runs as this role only where it already owns the parent
-- (src/shared/database/partition-owner.ts).
--
-- What it does, idempotently, on every release (infra/sql/README.md):
--   1. creates the role NOLOGIN when it is missing;
--   2. gives it USAGE and CREATE on the schema the migrations use;
--   3. makes it the owner of each registered parent and of every partition
--      under it. `ALTER TABLE parent OWNER TO` does not reach the
--      partitions, and a partition someone created by hand in an incident
--      must converge too, so the partitions come from pg_partition_tree,
--      not from a naming pattern. Only what has another owner is touched,
--      so a second run takes no lock at all.
--
-- The parents are the tables the partition job keeps
-- (src/shared/database/partitions.ts; a unit test keeps the two lists in
-- step) and the ones the plan adds later (the lean trail, the event and
-- activity shells); a table that does not exist yet is skipped.
--
-- A change of owner takes ACCESS EXCLUSIVE on the table, and the whole
-- file is one transaction (infra/sql/README.md): every lock it takes is
-- held until its COMMIT. Once the parent is reowned, every ping INSERT and
-- every read of it waits for the end of the file, the waits on each
-- partition after it included. So the lock waits of the whole file share
-- ONE budget of 3 s, under the runtime URL's lock_timeout of 5 s (a ping
-- waits and lands, never a 503): each wait gets what is left of it, and
-- once it is spent a table changes owner only if its lock is free at once.
-- A table whose lock did not come is 'pending', retried by the next
-- release (U-11) instead of failing it; the same for a privilege the
-- migration user lacks, which must never stop a deploy of the API.
--
-- The parent goes first on purpose: an INSERT locks the parent, then the
-- partition it lands in. Reowning the partitions first and the parent
-- last would take the same two locks in the other order, and a ping that
-- came in between would deadlock with the step (one of the two aborted).
-- In the INSERT's order, the step only waits, or gives up.
DO $$
DECLARE
  parents CONSTANT text[] := ARRAY[
    'driver_position',
    'driver_position_v2',
    'delivery_event_part',
    'activity_part'
  ];
  owner_name CONSTANT name := 'trajetto_partitions';
  lock_budget CONSTANT interval := interval '3 seconds';
  budget_ends timestamptz;
  target_schema CONSTANT name := current_schema();
  owner_oid oid;
  parent_name text;
  parent_rel regclass;
  member_rel record;
  kept text[] := ARRAY[]::text[];
  waiting text[] := ARRAY[]::text[];
  role_made boolean := false;
  schema_granted boolean := false;
  reowned integer := 0;
BEGIN
  -- For the schema's GRANT below; the tables have the budget.
  SET LOCAL lock_timeout = '3s';

  SELECT r.oid INTO owner_oid
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = owner_name;

  IF owner_oid IS NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r
      WHERE r.rolname = current_user AND (r.rolsuper OR r.rolcreaterole)
    ) THEN
      RAISE NOTICE 'pending: o usuário % não pode criar o role %; rode a etapa com o usuário do Database', current_user, owner_name;
      RETURN;
    END IF;

    -- Roles belong to the cluster: `yarn dev` and the E2E template may
    -- create it at the same second on one server.
    BEGIN
      CREATE ROLE trajetto_partitions NOLOGIN;
      role_made := true;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;

    SELECT r.oid INTO owner_oid
    FROM pg_catalog.pg_roles r
    WHERE r.rolname = owner_name;
  END IF;

  IF NOT (
    has_schema_privilege(owner_oid, target_schema, 'USAGE')
    AND has_schema_privilege(owner_oid, target_schema, 'CREATE')
  ) THEN
    BEGIN
      EXECUTE format(
        'GRANT USAGE, CREATE ON SCHEMA %I TO %I',
        target_schema,
        owner_name
      );
      schema_granted := true;
    EXCEPTION WHEN insufficient_privilege THEN
      waiting := waiting || format('o schema %s (sem privilégio)', target_schema);
    END;
  END IF;

  FOREACH parent_name IN ARRAY parents LOOP
    parent_rel := to_regclass(format('%I.%I', target_schema, parent_name));

    CONTINUE WHEN parent_rel IS NULL;

    kept := kept || parent_name;

    -- The parent first (level 0), then the partitions in name order.
    FOR member_rel IN
      SELECT tree.relid::regclass AS rel
      FROM pg_partition_tree(parent_rel) AS tree
      JOIN pg_catalog.pg_class c ON c.oid = tree.relid
      WHERE c.relowner <> owner_oid
      ORDER BY tree.level, c.relname
    LOOP
      -- The budget starts with the first lock and is never renewed; past
      -- it, 1 ms: only a lock that is free right now.
      budget_ends := coalesce(budget_ends, clock_timestamp() + lock_budget);
      PERFORM set_config(
        'lock_timeout',
        greatest(
          1,
          ceil(extract(epoch FROM budget_ends - clock_timestamp()) * 1000)
        )::bigint || 'ms',
        true
      );

      BEGIN
        EXECUTE format('ALTER TABLE %s OWNER TO %I', member_rel.rel, owner_name);
        reowned := reowned + 1;
      EXCEPTION
        WHEN lock_not_available THEN
          waiting := waiting || format('%s (lock)', member_rel.rel);
        WHEN insufficient_privilege THEN
          waiting := waiting || format('%s (sem privilégio)', member_rel.rel);
      END;
    END LOOP;
  END LOOP;

  IF cardinality(waiting) > 0 THEN
    RAISE NOTICE 'pending: dono não trocado em %; o próximo release tenta de novo', array_to_string(waiting, ', ');
  ELSIF role_made OR schema_granted OR reowned > 0 THEN
    RAISE NOTICE 'applied: %', concat_ws(
      '; ',
      CASE WHEN role_made THEN 'role trajetto_partitions criado (NOLOGIN)' END,
      CASE WHEN schema_granted THEN format('USAGE e CREATE no schema %s', target_schema) END,
      CASE WHEN reowned > 0 THEN format('%s tabela(s) passaram ao trajetto_partitions', reowned) END
    );
  ELSE
    RAISE NOTICE 'skipped: trajetto_partitions já é dono de % e das partições', coalesce(nullif(array_to_string(kept, ', '), ''), 'nenhuma tabela particionada');
  END IF;
END $$;
