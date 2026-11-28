-- The standby's role (plano-escala F4-40, wave 17; the security review).
--
-- Why. A standby is a clone of the primary (pg_basebackup) that keeps
-- following its WAL, both as trajetto_replication, through the one pg_hba
-- line the trajetto-postgres image writes for POSTGRES_REPLICATION_CIDR
-- (infra/postgres/trajetto-entrypoint.sh). The role exists here, the same
-- in every environment, NOLOGIN and with REPLICATION: its login and its
-- password are the owner's, by hand, only when there is a standby
-- (docs/deploy.md, the roles section). Until then nobody logs in as it,
-- and the pg_hba line, if any, lets nobody in.
--
-- REPLICATION reads the whole cluster (a base backup is every byte of it,
-- the verifiers of pg_authid included), so the role gets nothing else:
-- never SUPERUSER, CREATEDB, CREATEROLE nor BYPASSRLS (taken away if
-- someone gave them), and never a member of another role, which would
-- hand it the tables over an ordinary connection too (revoked, whoever
-- granted it). pgbouncer.user_lookup never serves it
-- (30-pgbouncer-auth.sql): it does not pass through PgBouncer.
--
-- A role of that name made by hand without REPLICATION is reported, not
-- changed: giving a power is the owner's (infra/sql/README.md).
--
-- Only a superuser creates a role with REPLICATION (and reads the
-- memberships of others), so as another user the step is 'pending'.
-- Idempotent: it changes only the difference, and a second run says
-- 'skipped'.
DO $$
DECLARE
  replication_role CONSTANT name := 'trajetto_replication';
  found_role record;
  membership record;
  done text[] := ARRAY[]::text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles r
    WHERE r.rolname = current_user AND r.rolsuper
  ) THEN
    RAISE NOTICE 'pending: o usuário % não é superusuário e não cuida do role % (só um superusuário dá o atributo de replicação); rode a etapa com o usuário do Database', current_user, replication_role;
    RETURN;
  END IF;

  SELECT r.oid, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolbypassrls,
         r.rolreplication
    INTO found_role
    FROM pg_catalog.pg_roles r
   WHERE r.rolname = replication_role;

  IF NOT FOUND THEN
    CREATE ROLE trajetto_replication NOLOGIN REPLICATION;
    RAISE NOTICE 'applied: role % criado (NOLOGIN, com REPLICATION; o login e a senha são do dono, à mão, quando houver standby)', replication_role;
    RETURN;
  END IF;

  IF found_role.rolsuper THEN
    ALTER ROLE trajetto_replication NOSUPERUSER;
    done := done || 'NOSUPERUSER'::text;
  END IF;
  IF found_role.rolcreatedb THEN
    ALTER ROLE trajetto_replication NOCREATEDB;
    done := done || 'NOCREATEDB'::text;
  END IF;
  IF found_role.rolcreaterole THEN
    ALTER ROLE trajetto_replication NOCREATEROLE;
    done := done || 'NOCREATEROLE'::text;
  END IF;
  IF found_role.rolbypassrls THEN
    ALTER ROLE trajetto_replication NOBYPASSRLS;
    done := done || 'NOBYPASSRLS'::text;
  END IF;

  -- Every grant of a membership, by each grantor (PostgreSQL 16 keeps one
  -- row per grantor, and a REVOKE without GRANTED BY removes only its own).
  FOR membership IN
    SELECT m.roleid::regrole::text AS granted, m.grantor::regrole::text AS grantor
      FROM pg_catalog.pg_auth_members m
     WHERE m.member = found_role.oid
     ORDER BY 1, 2
  LOOP
    EXECUTE format(
      'REVOKE %s FROM %I GRANTED BY %s CASCADE',
      membership.granted, replication_role, membership.grantor
    );
    done := done || format('membro de %s (por %s) revogado', membership.granted, membership.grantor);
  END LOOP;

  -- Without REPLICATION the clone is refused by the primary itself, which
  -- says so in the standby's log; the step only reports it.
  IF NOT found_role.rolreplication THEN
    done := done || 'sem o atributo de replicação, que fica assim (dar um poder é do dono, à mão, antes de clonar um standby: docs/deploy.md)'::text;
  END IF;

  -- Only that to say: nothing was changed.
  IF NOT found_role.rolreplication AND cardinality(done) = 1 THEN
    RAISE NOTICE 'skipped: role %: %', replication_role, done[1];
    RETURN;
  END IF;

  IF cardinality(done) > 0 THEN
    RAISE NOTICE 'applied: role %: %', replication_role, array_to_string(done, '; ');
    RETURN;
  END IF;

  RAISE NOTICE 'skipped: role % já existe, NOLOGIN ou com o login do dono, com REPLICATION e nada além disso', replication_role;
END $$;
