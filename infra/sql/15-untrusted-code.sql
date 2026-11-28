-- No code in the schema from a role that is not the tables' owner (the
-- security review of plano-escala F3-19 and F1-25).
--
-- Why. trajetto_partitions has CREATE on the schema the migrations use
-- (10-partitions.sql): it creates tomorrow's partitions. trajetto_batch,
-- the cron's login after the cut of the roles, is a member of it
-- (20-runtime-roles.sql), so whoever holds the batch credentials (code run
-- in an API container, an SQL injection in a cron) may create objects
-- there too. A function, an operator or anything that carries one is the
-- dangerous kind: the release step and the migrations run as the
-- Database's user, a superuser, with that schema on their search_path, and
-- Postgres runs the best-matching overload of an unqualified call wherever
-- it lives (CVE-2018-1058). A public.array_to_string(text[], text) would
-- run as the superuser on the next release, a `COPY … FROM PROGRAM` away
-- from the PITR keys in the Database's container (F1-25) and from deleting
-- the backups.
--
-- What it does: an event trigger refuses, before it runs, every DDL from a
-- role that is neither a superuser nor a member of the tables' owner (the
-- owner of _prisma_migrations, the migration user), except what the
-- partition job runs: CREATE, ALTER and DROP TABLE. No function,
-- procedure, aggregate, operator, cast, type, rule, trigger, policy or
-- grant. The CREATE the partitions need stays; the code goes. The
-- migrations, the release step and the runtime before the cut are the
-- superuser: nothing changes for them.
--
-- What it does not cover: a table the role owns runs its own defaults and
-- CHECKs as whoever writes to it. No migration writes to a partitioned
-- table after this step gave it away; one that must, writes as
-- trajetto_partitions (SET LOCAL ROLE), never as the superuser.
--
-- Only a superuser creates an event trigger: as another user the step is
-- 'pending'. Idempotent: the function is replaced only when its body, its
-- search_path or its owner differ (a function a role made first under the
-- same name is taken back), the trigger created only when missing and
-- enabled when someone disabled it, so a second run says 'skipped'.
DO $$
DECLARE
  target_schema CONSTANT name := current_schema();
  function_name CONSTANT name := 'trajetto_refuse_untrusted_code';
  trigger_name CONSTANT name := 'trajetto_untrusted_code';
  pinned_path CONSTANT text := 'search_path=pg_catalog, pg_temp';
  -- The partition job's DDL (partition-maintenance-job.ts): LIKE + ATTACH,
  -- DETACH … CONCURRENTLY and FINALIZE, DROP.
  allowed_tags CONSTANT text[] := ARRAY['CREATE TABLE', 'ALTER TABLE', 'DROP TABLE'];
  body text;
  found_function record;
  found_trigger record;
  trigger_present boolean;
  function_oid oid;
  done text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname = current_user AND r.rolsuper
  ) THEN
    RAISE NOTICE 'pending: o usuário % não é superusuário e não cria o event trigger %; rode a etapa com o usuário do Database', current_user, trigger_name;
    RETURN;
  END IF;

  -- Invoker's rights: current_user is the role the DDL runs as (after a
  -- SET ROLE, that role). The catalog only, through a pinned search_path.
  body := format(
    $guard$
DECLARE
  trusted boolean;
BEGIN
  IF tg_tag = ANY (%L::text[]) THEN
    RETURN;
  END IF;

  SELECT r.rolsuper
         OR coalesce(pg_has_role(current_user, c.relowner, 'MEMBER'), false)
    INTO trusted
  FROM pg_roles r
  LEFT JOIN pg_class c ON c.oid = to_regclass(%L)
  WHERE r.rolname = current_user;

  IF NOT coalesce(trusted, false) THEN
    RAISE EXCEPTION '%% recusado para o role %%: só o usuário das migrations cria código no schema',
      tg_tag, current_user
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'infra/sql/15-untrusted-code.sql';
  END IF;
END
$guard$,
    allowed_tags,
    format('%I._prisma_migrations', target_schema)
  );

  SELECT p.oid, p.prosrc, p.proconfig, r.rolsuper AS owner_is_superuser
    INTO found_function
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles r ON r.oid = p.proowner
  WHERE p.pronamespace = to_regnamespace(quote_ident(target_schema))
    AND p.proname = function_name
    AND p.pronargs = 0;

  IF found_function.oid IS NULL
    OR found_function.prosrc IS DISTINCT FROM body
    OR NOT coalesce(found_function.proconfig @> ARRAY[pinned_path], false)
    OR NOT found_function.owner_is_superuser
  THEN
    EXECUTE format(
      'CREATE OR REPLACE FUNCTION %I.%I() RETURNS event_trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS %L',
      target_schema,
      function_name,
      body
    );

    -- A replace keeps the owner: one a role made first must change hands,
    -- or that role could rewrite the guard later.
    IF found_function.oid IS NOT NULL AND NOT found_function.owner_is_superuser THEN
      EXECUTE format('ALTER FUNCTION %I.%I() OWNER TO CURRENT_USER', target_schema, function_name);
    END IF;

    done := done || format('função %I.%I', target_schema, function_name);
  END IF;

  function_oid := to_regprocedure(format('%I.%I()', target_schema, function_name));

  SELECT e.evtfoid, e.evtevent, e.evttags, e.evtenabled
    INTO found_trigger
  FROM pg_catalog.pg_event_trigger e
  WHERE e.evtname = trigger_name;

  trigger_present := found_trigger.evtfoid IS NOT NULL;

  -- Another function, another event or a tag filter is not this guard.
  IF trigger_present AND (
    found_trigger.evtfoid <> function_oid
    OR found_trigger.evtevent <> 'ddl_command_start'
    OR found_trigger.evttags IS NOT NULL
  ) THEN
    EXECUTE format('DROP EVENT TRIGGER %I', trigger_name);
    trigger_present := false;
  END IF;

  IF NOT trigger_present THEN
    EXECUTE format(
      'CREATE EVENT TRIGGER %I ON ddl_command_start EXECUTE FUNCTION %I.%I()',
      trigger_name,
      target_schema,
      function_name
    );
    done := done || format('event trigger %I criado', trigger_name);
  ELSIF found_trigger.evtenabled = 'D' THEN
    EXECUTE format('ALTER EVENT TRIGGER %I ENABLE', trigger_name);
    done := done || format('event trigger %I religado', trigger_name);
  END IF;

  IF cardinality(done) > 0 THEN
    RAISE NOTICE 'applied: %; só um superusuário ou o usuário das migrations cria código no schema %', array_to_string(done, ', '), target_schema;
  ELSE
    RAISE NOTICE 'skipped: o event trigger % já recusa código no schema % de quem não é o dono das tabelas', trigger_name, target_schema;
  END IF;
END $$;
