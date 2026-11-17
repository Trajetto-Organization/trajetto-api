-- ----------------------------------------------------------------------------
-- Bulk load: the secondary indexes back on (plano-escala LOAD-02)
-- ----------------------------------------------------------------------------
-- Every index 05-indexes-off.sql dropped, built again from its own
-- definition, then load_seed_index goes: the schema is the one the
-- migrations left. Safe to run again (an index already there is skipped),
-- which is how a seed that failed half-way gets its indexes back.
-- ----------------------------------------------------------------------------

SET maintenance_work_mem = '256MB';

DO $$
DECLARE
  entry record;
BEGIN
  IF to_regclass('load_seed_index') IS NULL THEN
    RETURN;
  END IF;

  FOR entry IN EXECUTE 'SELECT "name", "definition" FROM "load_seed_index"' LOOP
    IF to_regclass(entry.name) IS NULL THEN
      EXECUTE entry.definition;
    END IF;
  END LOOP;

  EXECUTE 'DROP TABLE "load_seed_index"';
END $$;
