-- PgBouncer's auth_query: the one door through which it reads the SCRAM
-- verifier of a login (plano-escala F4-33, wave 17; the security review).
--
-- Why. With auth_type=scram-sha-256 and auth_user=pgbouncer_auth (F4-34),
-- PgBouncer keeps no list of the runtime's passwords: it asks Postgres
-- for the verifier of whoever logs in, with
-- `SELECT * FROM pgbouncer.user_lookup($1)`, and checks the client's proof
-- against it. The verifiers live in pg_authid, which only a superuser
-- reads, so the lookup is a SECURITY DEFINER function owned by one. That
-- makes it as dangerous as what it returns:
--
--   - EXECUTE is taken away from PUBLIC and given to pgbouncer_auth only
--     (with USAGE on its schema). Without the REVOKE, any role (an SQL
--     injection as trajetto_http) would read every verifier and try them
--     offline (tests/E2E/pgbouncer-user-lookup.test.ts fails then).
--   - search_path is pinned to pg_catalog, pg_temp, and every name in the
--     body is qualified: a temporary table or function of the caller's
--     never stands in for the catalog's (with pg_catalog alone, pg_temp
--     would be searched first for relations).
--   - It serves only a role that may log in with a SCRAM verifier still
--     valid, and never a superuser, a replication role, a member of the
--     tables' owner (the migration user, which never goes through
--     PgBouncer), trajetto_replication (the standby's, F4-40) nor
--     pgbouncer_auth itself. For any of those it returns no row, and
--     PgBouncer refuses the login as it would an unknown user.
--
-- pgbouncer_auth is created NOLOGIN, only when missing, as every role here
-- (infra/sql/README.md): its login and password are the owner's, by hand,
-- before the trajetto-pgbouncer Application exists (docs/deploy.md, the
-- roles section). Until then nothing calls the function, and the image
-- before this one does not notice it.
--
-- The sessions PgBouncer opens as pgbouncer_auth (the auth_query's) carry
-- a name, trajetto-pgbouncer-auth, by a default of the role: PgBouncer
-- sends none for them, and the release step's trajetto_capability_ready
-- (prisma/post-deploy/00-queue-swap-ready.sql) reads an unnamed session in
-- this database as the image from before the scale plan, holding every
-- contraction back for as long as PgBouncer runs (measured on the infra
-- stack of the E2E: the auth session was the one unnamed). A client that
-- sends its own name still wins. Never on a runtime role: its unnamed
-- sessions are exactly that old image, which the check must keep seeing.
--
-- The schema and the function must be a superuser's (one a role made first
-- is taken back, and an overload under the same name is dropped): their
-- owner could rewrite the body and read every verifier. Only a superuser
-- reads pg_authid, so as another user the step is 'pending'.
--
-- Idempotent: it compares the catalog with what it should be (the
-- function's body, settings and owner; the schema's owner; both ACLs) and
-- changes only the difference, so a second run says 'skipped'.
DO $$
DECLARE
  lookup_schema CONSTANT name := 'pgbouncer';
  lookup_function CONSTANT name := 'user_lookup';
  auth_role CONSTANT name := 'pgbouncer_auth';
  auth_session_name CONSTANT text := 'trajetto-pgbouncer-auth';
  -- Never served, whatever their attributes say.
  refused_roles CONSTANT text[] := ARRAY['pgbouncer_auth', 'trajetto_replication'];
  pinned_path CONSTANT text := 'search_path=pg_catalog, pg_temp';
  expected_arguments CONSTANT text := 'i_username text';
  expected_result CONSTANT text := 'TABLE(usename name, passwd text)';
  body text;
  schema_oid oid;
  schema_owner_is_superuser boolean;
  function_oid oid;
  found_function record;
  function_present boolean;
  overload record;
  expected_acl text[];
  actual_acl text[];
  grantee_name text;
  done text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname = current_user AND r.rolsuper
  ) THEN
    RAISE NOTICE 'pending: o usuário % não é superusuário e não cria a função %.% (só um superusuário lê os verificadores); rode a etapa com o usuário do Database', current_user, lookup_schema, lookup_function;
    RETURN;
  END IF;

  -- 1. The role PgBouncer authenticates as, NOLOGIN until the owner says.
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname = auth_role) THEN
    EXECUTE format('CREATE ROLE %I NOLOGIN', auth_role);
    done := done || format('role %I (NOLOGIN)', auth_role);
  END IF;

  -- 1b. A name for its sessions, the auth_query's (see the header).
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_db_role_setting s
    JOIN pg_catalog.pg_roles r ON r.oid = s.setrole
    WHERE s.setdatabase = 0
      AND r.rolname = auth_role
      AND format('application_name=%s', auth_session_name) = ANY (s.setconfig)
  ) THEN
    EXECUTE format('ALTER ROLE %I SET application_name = %L', auth_role, auth_session_name);
    done := done || format('application_name %s nas sessões do %s', auth_session_name, auth_role);
  END IF;

  -- 2. The schema, a superuser's.
  SELECT n.oid, r.rolsuper
    INTO schema_oid, schema_owner_is_superuser
  FROM pg_catalog.pg_namespace n
  JOIN pg_catalog.pg_roles r ON r.oid = n.nspowner
  WHERE n.nspname = lookup_schema;

  IF schema_oid IS NULL THEN
    EXECUTE format('CREATE SCHEMA %I', lookup_schema);
    schema_oid := to_regnamespace(quote_ident(lookup_schema));
    done := done || format('schema %I', lookup_schema);
  ELSIF NOT schema_owner_is_superuser THEN
    EXECUTE format('ALTER SCHEMA %I OWNER TO CURRENT_USER', lookup_schema);
    done := done || format('schema %I devolvido a um superusuário', lookup_schema);
  END IF;

  -- 3. The function. The tables' owner is read at each call, from the
  -- schema the migrations use, so a member of it is refused even when it
  -- is not a superuser.
  body := format(
    $lookup$
  SELECT a.rolname, a.rolpassword
    FROM pg_catalog.pg_authid a
   WHERE a.rolname = i_username
     AND a.rolcanlogin
     AND NOT a.rolsuper
     AND NOT a.rolreplication
     AND a.rolname <> ALL (%L::pg_catalog.name[])
     AND pg_catalog.starts_with(a.rolpassword, 'SCRAM-SHA-256$')
     AND (a.rolvaliduntil IS NULL OR a.rolvaliduntil > pg_catalog.now())
     AND NOT EXISTS (
           SELECT 1
             FROM pg_catalog.pg_class c
            WHERE c.oid = pg_catalog.to_regclass(%L)
              AND pg_catalog.pg_has_role(a.oid, c.relowner, 'MEMBER')
         )
$lookup$,
    refused_roles,
    format('%I._prisma_migrations', current_schema())
  );

  -- Any other function under the same name in the schema: PgBouncer's call
  -- is qualified, so an overload is the only thing that could stand in.
  FOR overload IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = schema_oid
      AND p.proname = lookup_function
      AND p.oid IS DISTINCT FROM to_regprocedure(format('%I.%I(text)', lookup_schema, lookup_function))::oid
  LOOP
    EXECUTE format('DROP ROUTINE %s', overload.signature);
    done := done || format('sobrecarga %s removida', overload.signature);
  END LOOP;

  SELECT p.oid,
         p.prokind,
         p.prosrc,
         p.proconfig,
         p.prosecdef,
         p.provolatile,
         l.lanname,
         pg_catalog.pg_get_function_arguments(p.oid) AS arguments,
         pg_catalog.pg_get_function_result(p.oid) AS result,
         r.rolsuper AS owner_is_superuser
    INTO found_function
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  WHERE p.oid = to_regprocedure(format('%I.%I(text)', lookup_schema, lookup_function))::oid;

  function_present := found_function.oid IS NOT NULL;

  -- A replace cannot change the kind, the arguments' names nor the result.
  IF function_present AND (
    found_function.prokind <> 'f'
    OR found_function.arguments IS DISTINCT FROM expected_arguments
    OR found_function.result IS DISTINCT FROM expected_result
  ) THEN
    EXECUTE format('DROP ROUTINE %I.%I(text)', lookup_schema, lookup_function);
    function_present := false;
  END IF;

  IF NOT function_present
    OR found_function.prosrc IS DISTINCT FROM body
    OR found_function.proconfig IS DISTINCT FROM ARRAY[pinned_path]
    OR NOT found_function.prosecdef
    OR found_function.provolatile <> 's'
    OR found_function.lanname <> 'sql'
    OR NOT found_function.owner_is_superuser
  THEN
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION %I.%I(%s) RETURNS %s LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS %L',
      lookup_schema,
      lookup_function,
      expected_arguments,
      expected_result,
      body
    );

    -- A replace keeps the owner: one a role made first must change hands,
    -- or that role could rewrite the lookup later.
    IF function_present AND NOT found_function.owner_is_superuser THEN
      EXECUTE format('ALTER FUNCTION %I.%I(text) OWNER TO CURRENT_USER', lookup_schema, lookup_function);
    END IF;

    done := done || format('função %I.%I(text)', lookup_schema, lookup_function);
  END IF;

  function_oid := to_regprocedure(format('%I.%I(text)', lookup_schema, lookup_function));

  -- 4. EXECUTE for pgbouncer_auth and nobody else (the owner aside). A
  -- grant made by a grantee with GRANT OPTION goes with it (CASCADE).
  expected_acl := ARRAY[format('%s=EXECUTE', auth_role)];

  SELECT coalesce(
           array_agg(
             format(
               '%s=%s%s',
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
               a.privilege_type,
               CASE WHEN a.is_grantable THEN '*' ELSE '' END
             )
             ORDER BY 1
           ),
           ARRAY[]::text[]
         )
    INTO actual_acl
  FROM pg_catalog.pg_proc p,
       LATERAL pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
  WHERE p.oid = function_oid
    AND a.grantee <> p.proowner;

  IF actual_acl IS DISTINCT FROM expected_acl THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(text) FROM PUBLIC', lookup_schema, lookup_function);

    FOR grantee_name IN
      SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee)
      FROM pg_catalog.pg_proc p,
           LATERAL pg_catalog.aclexplode(p.proacl) a
      WHERE p.oid = function_oid
        AND a.grantee <> 0
        AND a.grantee <> p.proowner
    LOOP
      EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(text) FROM %I CASCADE', lookup_schema, lookup_function, grantee_name);
    END LOOP;

    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(text) TO %I', lookup_schema, lookup_function, auth_role);
    done := done || format('EXECUTE só para %s (antes: %s)', auth_role, coalesce(nullif(array_to_string(actual_acl, ', '), ''), 'ninguém'));
  END IF;

  -- 5. USAGE on the schema for pgbouncer_auth and nobody else; no CREATE.
  expected_acl := ARRAY[format('%s=USAGE', auth_role)];

  SELECT coalesce(
           array_agg(
             format(
               '%s=%s%s',
               CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(a.grantee) END,
               a.privilege_type,
               CASE WHEN a.is_grantable THEN '*' ELSE '' END
             )
             ORDER BY 1
           ),
           ARRAY[]::text[]
         )
    INTO actual_acl
  FROM pg_catalog.pg_namespace n,
       LATERAL pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
  WHERE n.oid = schema_oid
    AND a.grantee <> n.nspowner;

  IF actual_acl IS DISTINCT FROM expected_acl THEN
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', lookup_schema);

    FOR grantee_name IN
      SELECT DISTINCT pg_catalog.pg_get_userbyid(a.grantee)
      FROM pg_catalog.pg_namespace n,
           LATERAL pg_catalog.aclexplode(n.nspacl) a
      WHERE n.oid = schema_oid
        AND a.grantee <> 0
        AND a.grantee <> n.nspowner
    LOOP
      EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I CASCADE', lookup_schema, grantee_name);
    END LOOP;

    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', lookup_schema, auth_role);
    done := done || format('USAGE no schema %s só para %s', lookup_schema, auth_role);
  END IF;

  IF cardinality(done) > 0 THEN
    RAISE NOTICE 'applied: %; o PgBouncer lê pelo %.% só o verificador SCRAM dos logins do runtime', array_to_string(done, ', '), lookup_schema, lookup_function;
  ELSE
    RAISE NOTICE 'skipped: a função %.% já é de um superusuário, com o search_path fixo, e só o % a executa', lookup_schema, lookup_function, auth_role;
  END IF;
END $$;
