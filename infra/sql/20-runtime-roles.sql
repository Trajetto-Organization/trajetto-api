-- The runtime's own database roles and what each one may touch
-- (plano-escala F3-19, wave 6).
--
-- Why. The runtime connects today as the Database's user: the owner of
-- every table and a superuser (docs/deploy.md, section 7.7). An SQL
-- injection there could read the PITR keys in the Database's container and
-- delete the backups, rewrite the delivery trail, or drop a table. After
-- the cut the runtime logs in as one of these roles instead, each with only
-- what its process needs:
--
--   trajetto_app     the group (NOLOGIN, never a login): SELECT, INSERT,
--                    UPDATE and DELETE on every table but the delivery
--                    trail and the release's own tables; USAGE on the
--                    sequences.
--   trajetto_http    the API's requests (member of trajetto_app).
--   trajetto_worker  the queue workers (member of trajetto_app).
--   trajetto_batch   the crons' maintenance pool (member of trajetto_app),
--                    with the partitions' owner role and the statistics
--                    roles: it is the one login that may DELETE from the
--                    delivery trail.
--   trajetto_read    the heavy reads (wave 12): SELECT only, outside the
--                    group.
--
-- The delivery trail (delivery_event, and delivery_event_part, the
-- partitioned table it moves to later in the plan) is history: http and
-- worker may read it, append to it and fill in the reverse-geocoded
-- address of a proof (gps_address, gps_address_source, gps_geocoded_at);
-- only batch may change or delete a row. A path that writes anything else
-- fails with 42501, and tests/unitaires/database/delivery-event-writes-guard
-- refuses such a write before it ships. The foreign keys' own SET NULL and
-- CASCADE still work: Postgres runs them as the table's owner.
--
-- _prisma_migrations, release_step_state and cluster_epoch belong to the
-- release step (the migration user): the runtime only reads them.
--
-- Partitions get no grant at all: every query goes through the parent, and
-- Postgres checks the privileges of the table the query names. A grant a
-- partition picked up (one made by the migration user, whose default
-- privileges below apply to it) is taken back.
--
-- Every timeout is also a property of the role (ALTER ROLE … SET), so a
-- connection through PgBouncer, which carries no `options` (wave 17), keeps
-- the same ceilings as today's URL.
--
-- What it never does (infra/sql/README.md, with a test): give a role LOGIN
-- or a password, or drop one. Logins and passwords are the owner's, by hand
-- (docs/deploy.md, the roles section): a release never locks the runtime
-- out of its own database. Until the owner gives the roles a login and
-- switches the URLs, nothing uses them, and the image before this one does
-- not notice them.
--
-- Idempotent, as every file here: it compares the catalog with what it
-- should be and changes only the difference, so a second run takes no lock
-- and says 'skipped'. A grant or a revoke refused (a lock that did not
-- come in time, a privilege the migration user lacks) is 'pending', and the
-- next release tries again (U-11).
DO $$
DECLARE
  target_schema CONSTANT name := current_schema();
  group_role CONSTANT text := 'trajetto_app';
  roles CONSTANT text[] := ARRAY[
    'trajetto_app',
    'trajetto_http',
    'trajetto_worker',
    'trajetto_batch',
    'trajetto_read'
  ];
  group_members CONSTANT text[] := ARRAY[
    'trajetto_http',
    'trajetto_worker',
    'trajetto_batch'
  ];
  -- The trail: append-only for the runtime, see above.
  trail_tables CONSTANT text[] := ARRAY['delivery_event', 'delivery_event_part'];
  gps_columns CONSTANT text[] := ARRAY[
    'gps_address',
    'gps_address_source',
    'gps_geocoded_at'
  ];
  release_tables CONSTANT text[] := ARRAY[
    '_prisma_migrations',
    'release_step_state',
    'cluster_epoch'
  ];
  crud CONSTANT text[] := ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
  -- The roles trajetto_batch is a member of: the partitions' owner (DDL
  -- through SET ROLE, F3-20) and the statistics (the heavy metrics and
  -- pg_stat_statements read every session, F3-18).
  batch_roles CONSTANT text[] := ARRAY[
    'pg_read_all_stats',
    'pg_monitor',
    'trajetto_partitions'
  ];
  schema_oid oid;
  can_manage_roles boolean;
  role_name text;
  member_name text;
  setting record;
  rel record;
  col record;
  expected text[];
  actual text[];
  missing text[];
  extra text[];
  created text[] := ARRAY[]::text[];
  changed text[] := ARRAY[]::text[];
  waiting text[] := ARRAY[]::text[];
  tables_changed integer := 0;
  table_touched boolean;
BEGIN
  SELECT n.oid INTO schema_oid
  FROM pg_catalog.pg_namespace n
  WHERE n.nspname = target_schema;

  SELECT (r.rolsuper OR r.rolcreaterole) INTO can_manage_roles
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user;

  -- 1. The roles, NOLOGIN, only when missing.
  FOREACH role_name IN ARRAY roles LOOP
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = role_name
    );

    IF NOT can_manage_roles THEN
      RAISE NOTICE 'pending: o usuário % não pode criar o role %; rode a etapa com o usuário do Database', current_user, role_name;
      RETURN;
    END IF;

    -- Roles belong to the cluster: `yarn dev` and the E2E template may
    -- create one at the same second on one server.
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      created := created || role_name;
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
  END LOOP;

  -- 2. Memberships: the three runtime logins in the group; trajetto_read
  --    never (SELECT only); batch in the partitions' owner and the
  --    statistics roles.
  FOREACH member_name IN ARRAY group_members LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
      JOIN pg_catalog.pg_roles u ON u.oid = m.member
      WHERE g.rolname = group_role AND u.rolname = member_name
    ) THEN
      BEGIN
        EXECUTE format('GRANT %I TO %I', group_role, member_name);
        changed := changed || format('%s no %s', member_name, group_role);
      EXCEPTION WHEN insufficient_privilege THEN
        waiting := waiting || format('%s no %s (sem privilégio)', member_name, group_role);
      END;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
    JOIN pg_catalog.pg_roles u ON u.oid = m.member
    WHERE g.rolname = group_role AND u.rolname = 'trajetto_read'
  ) THEN
    BEGIN
      EXECUTE format('REVOKE %I FROM trajetto_read', group_role);
      changed := changed || format('trajetto_read fora do %s', group_role);
    EXCEPTION WHEN insufficient_privilege THEN
      waiting := waiting || format('trajetto_read no %s (sem privilégio)', group_role);
    END;
  END IF;

  FOREACH role_name IN ARRAY batch_roles LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = role_name
    ) THEN
      -- trajetto_partitions comes from 10-partitions.sql, which runs
      -- first; a 'pending' there leaves this one waiting too.
      waiting := waiting || format('%s ainda não existe', role_name);
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles g ON g.oid = m.roleid
      JOIN pg_catalog.pg_roles u ON u.oid = m.member
      WHERE g.rolname = role_name AND u.rolname = 'trajetto_batch'
    ) THEN
      BEGIN
        EXECUTE format('GRANT %I TO trajetto_batch', role_name);
        changed := changed || format('trajetto_batch no %s', role_name);
      EXCEPTION WHEN insufficient_privilege THEN
        waiting := waiting || format('trajetto_batch no %s (sem privilégio)', role_name);
      END;
    END IF;
  END LOOP;

  -- 3. The ceilings of each role, for every database. statement_timeout
  --    as each pool's: 30 s for requests and workers, 10 s for the heavy
  --    reads, 30 min for the maintenance (a VACUUM, a DETACH).
  FOR setting IN
    SELECT v.role_name, v.parameter, v.value
    FROM (VALUES
      ('trajetto_http', 'lock_timeout', '5s'),
      ('trajetto_http', 'idle_in_transaction_session_timeout', '60s'),
      ('trajetto_http', 'statement_timeout', '30s'),
      ('trajetto_worker', 'lock_timeout', '5s'),
      ('trajetto_worker', 'idle_in_transaction_session_timeout', '60s'),
      ('trajetto_worker', 'statement_timeout', '30s'),
      ('trajetto_batch', 'lock_timeout', '5s'),
      ('trajetto_batch', 'idle_in_transaction_session_timeout', '60s'),
      ('trajetto_batch', 'statement_timeout', '30min'),
      ('trajetto_read', 'lock_timeout', '5s'),
      ('trajetto_read', 'idle_in_transaction_session_timeout', '60s'),
      ('trajetto_read', 'statement_timeout', '10s')
    ) AS v(role_name, parameter, value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_db_role_setting s
      JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
      WHERE s.setdatabase = 0
        AND r.rolname = v.role_name
        AND format('%s=%s', v.parameter, v.value) = ANY (s.setconfig)
    )
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER ROLE %I SET %I = %L',
        setting.role_name,
        setting.parameter,
        setting.value
      );
      changed := changed || format('%s.%s=%s', setting.role_name, setting.parameter, setting.value);
    EXCEPTION WHEN insufficient_privilege THEN
      waiting := waiting || format('%s.%s (sem privilégio)', setting.role_name, setting.parameter);
    END;
  END LOOP;

  -- 4. The schema: USAGE for the group and the readers.
  FOREACH role_name IN ARRAY ARRAY['trajetto_app', 'trajetto_read'] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_namespace n
      CROSS JOIN LATERAL aclexplode(
        coalesce(n.nspacl, acldefault('n', n.nspowner))
      ) a
      JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
      WHERE n.oid = schema_oid
        AND r.rolname = role_name
        AND a.privilege_type = 'USAGE'
    ) THEN
      BEGIN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', target_schema, role_name);
        changed := changed || format('USAGE no schema para %s', role_name);
      EXCEPTION WHEN insufficient_privilege THEN
        waiting := waiting || format('schema %s para %s (sem privilégio)', target_schema, role_name);
      END;
    END IF;
  END LOOP;

  -- 5. Every table, view and partition of the schema: the direct
  --    privileges of each of the five roles, made exactly what they should
  --    be. Members inherit the group's, so their own are only the trail's.
  FOR rel IN
    SELECT c.oid,
           c.relname::text AS name,
           c.relispartition AS is_partition,
           c.relacl,
           c.relowner
    FROM pg_catalog.pg_class c
    WHERE c.relnamespace = schema_oid
      AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    ORDER BY c.relname
  LOOP
    table_touched := false;

    BEGIN
      FOREACH role_name IN ARRAY roles LOOP
        expected := CASE
          WHEN rel.is_partition THEN ARRAY[]::text[]
          WHEN rel.name = ANY (trail_tables) THEN CASE role_name
            WHEN 'trajetto_http' THEN ARRAY['INSERT', 'SELECT']
            WHEN 'trajetto_worker' THEN ARRAY['INSERT', 'SELECT']
            WHEN 'trajetto_batch' THEN ARRAY['DELETE', 'SELECT', 'UPDATE']
            WHEN 'trajetto_read' THEN ARRAY['SELECT']
            ELSE ARRAY[]::text[]
          END
          WHEN rel.name = ANY (release_tables) THEN CASE role_name
            WHEN 'trajetto_app' THEN ARRAY['SELECT']
            WHEN 'trajetto_read' THEN ARRAY['SELECT']
            ELSE ARRAY[]::text[]
          END
          ELSE CASE role_name
            WHEN 'trajetto_app' THEN crud
            WHEN 'trajetto_read' THEN ARRAY['SELECT']
            ELSE ARRAY[]::text[]
          END
        END;

        SELECT coalesce(array_agg(a.privilege_type::text), ARRAY[]::text[])
        INTO actual
        FROM aclexplode(coalesce(rel.relacl, acldefault('r', rel.relowner))) a
        JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
        WHERE r.rolname = role_name;

        missing := ARRAY(SELECT unnest(expected) EXCEPT SELECT unnest(actual) ORDER BY 1);
        extra := ARRAY(SELECT unnest(actual) EXCEPT SELECT unnest(expected) ORDER BY 1);

        IF cardinality(extra) > 0 THEN
          EXECUTE format(
            'REVOKE %s ON TABLE %s FROM %I',
            array_to_string(extra, ', '),
            rel.oid::regclass,
            role_name
          );
          table_touched := true;
        END IF;

        IF cardinality(missing) > 0 THEN
          EXECUTE format(
            'GRANT %s ON TABLE %s TO %I',
            array_to_string(missing, ', '),
            rel.oid::regclass,
            role_name
          );
          table_touched := true;
        END IF;
      END LOOP;

      -- Column privileges: only UPDATE of the trail's GPS columns, for
      -- http and worker. Anything else one of the roles holds on a column
      -- is taken back.
      FOR col IN
        SELECT a.attname::text AS name,
               r.rolname::text AS role_name,
               x.privilege_type::text AS privilege
        FROM pg_catalog.pg_attribute a
        CROSS JOIN LATERAL aclexplode(a.attacl) x
        JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
        WHERE a.attrelid = rel.oid
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attacl IS NOT NULL
          AND r.rolname = ANY (roles)
      LOOP
        CONTINUE WHEN NOT rel.is_partition
          AND rel.name = ANY (trail_tables)
          AND col.role_name IN ('trajetto_http', 'trajetto_worker')
          AND col.privilege = 'UPDATE'
          AND col.name = ANY (gps_columns);

        EXECUTE format(
          'REVOKE %s (%I) ON TABLE %s FROM %I',
          col.privilege,
          col.name,
          rel.oid::regclass,
          col.role_name
        );
        table_touched := true;
      END LOOP;

      IF NOT rel.is_partition AND rel.name = ANY (trail_tables) THEN
        FOR col IN
          SELECT a.attname::text AS name, m.role_name
          FROM pg_catalog.pg_attribute a
          CROSS JOIN unnest(ARRAY['trajetto_http', 'trajetto_worker']) AS m(role_name)
          WHERE a.attrelid = rel.oid
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.attname = ANY (gps_columns)
            AND NOT EXISTS (
              SELECT 1
              FROM aclexplode(a.attacl) x
              JOIN pg_catalog.pg_roles r ON r.oid = x.grantee
              WHERE r.rolname = m.role_name AND x.privilege_type = 'UPDATE'
            )
          ORDER BY a.attname, m.role_name
        LOOP
          EXECUTE format(
            'GRANT UPDATE (%I) ON TABLE %s TO %I',
            col.name,
            rel.oid::regclass,
            col.role_name
          );
          table_touched := true;
        END LOOP;
      END IF;

      IF table_touched THEN
        tables_changed := tables_changed + 1;
      END IF;
    EXCEPTION
      WHEN lock_not_available THEN
        waiting := waiting || format('%s (lock)', rel.name);
      WHEN insufficient_privilege THEN
        waiting := waiting || format('%s (sem privilégio)', rel.name);
    END;
  END LOOP;

  -- 6. Sequences: USAGE for the group (nextval of webhook_event_seq).
  FOR rel IN
    SELECT c.oid, c.relname::text AS name, c.relacl, c.relowner
    FROM pg_catalog.pg_class c
    WHERE c.relnamespace = schema_oid AND c.relkind = 'S'
    ORDER BY c.relname
  LOOP
    BEGIN
      FOREACH role_name IN ARRAY roles LOOP
        expected := CASE role_name
          WHEN 'trajetto_app' THEN ARRAY['USAGE']
          ELSE ARRAY[]::text[]
        END;

        SELECT coalesce(array_agg(a.privilege_type::text), ARRAY[]::text[])
        INTO actual
        FROM aclexplode(coalesce(rel.relacl, acldefault('s', rel.relowner))) a
        JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
        WHERE r.rolname = role_name;

        missing := ARRAY(SELECT unnest(expected) EXCEPT SELECT unnest(actual) ORDER BY 1);
        extra := ARRAY(SELECT unnest(actual) EXCEPT SELECT unnest(expected) ORDER BY 1);

        IF cardinality(extra) > 0 THEN
          EXECUTE format(
            'REVOKE %s ON SEQUENCE %s FROM %I',
            array_to_string(extra, ', '),
            rel.oid::regclass,
            role_name
          );
          changed := changed || format('sequência %s', rel.name);
        END IF;

        IF cardinality(missing) > 0 THEN
          EXECUTE format(
            'GRANT %s ON SEQUENCE %s TO %I',
            array_to_string(missing, ', '),
            rel.oid::regclass,
            role_name
          );
          changed := changed || format('sequência %s', rel.name);
        END IF;
      END LOOP;
    EXCEPTION WHEN insufficient_privilege THEN
      waiting := waiting || format('sequência %s (sem privilégio)', rel.name);
    END;
  END LOOP;

  -- 7. Default privileges of the migration user (the one running this):
  --    a table a later migration or a prisma/post-deploy step creates is
  --    born with the same grants, before the next release reaches it.
  --    Partitions are created by trajetto_partitions, which has none.
  FOR setting IN
    SELECT v.kind, v.object_type, v.role_name, v.privileges
    FROM (VALUES
      ('r', 'TABLES', 'trajetto_app', ARRAY['DELETE', 'INSERT', 'SELECT', 'UPDATE']),
      ('r', 'TABLES', 'trajetto_read', ARRAY['SELECT']),
      ('S', 'SEQUENCES', 'trajetto_app', ARRAY['USAGE'])
    ) AS v(kind, object_type, role_name, privileges)
  LOOP
    SELECT coalesce(array_agg(a.privilege_type::text), ARRAY[]::text[])
    INTO actual
    FROM pg_catalog.pg_default_acl d
    CROSS JOIN LATERAL aclexplode(d.defaclacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE d.defaclrole = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)
      AND d.defaclnamespace = schema_oid
      AND d.defaclobjtype = setting.kind::"char"
      AND r.rolname = setting.role_name;

    missing := ARRAY(SELECT unnest(setting.privileges) EXCEPT SELECT unnest(actual) ORDER BY 1);
    extra := ARRAY(SELECT unnest(actual) EXCEPT SELECT unnest(setting.privileges) ORDER BY 1);

    IF cardinality(extra) > 0 THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE %s ON %s FROM %I',
        target_schema,
        array_to_string(extra, ', '),
        setting.object_type,
        setting.role_name
      );
      changed := changed || format('privilégio padrão de %s (%s)', setting.role_name, lower(setting.object_type));
    END IF;

    IF cardinality(missing) > 0 THEN
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT %s ON %s TO %I',
        target_schema,
        array_to_string(missing, ', '),
        setting.object_type,
        setting.role_name
      );
      changed := changed || format('privilégio padrão de %s (%s)', setting.role_name, lower(setting.object_type));
    END IF;
  END LOOP;

  IF tables_changed > 0 THEN
    changed := changed || format('%s tabela(s) com os grants acertados', tables_changed);
  END IF;

  IF cardinality(waiting) > 0 THEN
    RAISE NOTICE 'pending: %; o próximo release tenta de novo', array_to_string(waiting, ', ');
  ELSIF cardinality(created) > 0 OR cardinality(changed) > 0 THEN
    RAISE NOTICE 'applied: %', concat_ws(
      '; ',
      CASE WHEN cardinality(created) > 0 THEN format('roles criados (NOLOGIN): %s', array_to_string(created, ', ')) END,
      CASE WHEN cardinality(changed) > 0 THEN array_to_string(changed, ', ') END
    );
  ELSE
    RAISE NOTICE 'skipped: roles do runtime, grants e privilégios padrão já como devem ser';
  END IF;
END $$;
