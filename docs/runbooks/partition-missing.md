# partition-missing — Partição faltando

**Quando:** um erro `no partition of relation "<tabela>" found for row` (SQLSTATE `23514`) no log, ou o job `partition-maintenance` terminando com "partições necessárias agora não foram criadas".

## O que significa

As tabelas do registro de partições (`src/shared/database/partitions.ts`: a trilha de posições, a linha do tempo das entregas e o registro de atividades depois da janela do histórico, as quatro filas, o sino) não têm partição DEFAULT, de propósito: uma linha sem partição é **recusada**, e o erro aparece na hora, em vez de a linha cair num lugar de onde nenhum expurgo a tira. O job `partition-maintenance` (04:10 UTC) mantém as partições à frente (dias nas filas e na trilha, meses na linha do tempo, nas atividades e no sino) e falha quando a de ontem, de hoje ou de amanhã não existe. Os avisos anteriores são [partition-lookahead-low](./partition-lookahead-low.md) e [partition-runway-low](./partition-runway-low.md).

Causas comuns: o job não rodou por noites seguidas (nenhum processo com os crons ligados, um lock que não veio), ou um relógio de réplica adiantado gravando um id do mês seguinte antes de a partição existir.

## Primeira ação

1. Leia no log o erro do `partition-maintenance` da última noite e o nome da partição que falta.
2. Crie a partição à mão, como o job faz (`LIKE` mais `ATTACH`, que não faz o INSERT esperar), no `psql` do Database. Para uma tabela mensal pelo id (`delivery_event`, `activity`, `notification`):

   ```sql
   DO $$
   DECLARE
     parent CONSTANT text := 'delivery_event';
     month_start CONSTANT timestamp := '2026-12-01';
     hex_from text := lpad(to_hex((extract(epoch FROM month_start) * 1000)::bigint), 12, '0');
     hex_to text := lpad(to_hex((extract(epoch FROM month_start + interval '1 month') * 1000)::bigint), 12, '0');
     child text := parent || '_' || to_char(month_start, 'YYYYMM');
   BEGIN
     SET LOCAL lock_timeout = '3s';
     EXECUTE format('CREATE TABLE %I (LIKE %I INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', child, parent);
     EXECUTE format('ALTER TABLE %I ATTACH PARTITION %I FOR VALUES FROM (%L) TO (%L)',
       parent, child,
       substr(hex_from, 1, 8) || '-' || substr(hex_from, 9, 4) || '-0000-0000-000000000000',
       substr(hex_to, 1, 8) || '-' || substr(hex_to, 9, 4) || '-0000-0000-000000000000');
   END $$;
   ```

   Troque `parent` e `month_start` (o primeiro dia do mês, em UTC). Numa fila diária, o mesmo com `interval '1 day'` e o nome `<tabela>_AAAAMMDD`; na trilha de posições, os limites são o próprio `timestamp` do dia. Um `lock_timeout`: tente de novo em seguida.

3. O dono da partição nova é o usuário do Database; o `infra/sql/10-partitions.sql` a passa ao `trajetto_partitions` no próximo release.

## Como confirmar

```sql
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid)
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = '<tabela>'::regclass ORDER BY 1;
```

A partição aparece com os limites certos, o erro `23514` some e `partitions.<tabela>` no `/health/metrics` volta a mostrar a folga.

## Quando escalar

A linha recusada é de um mês ou dia muito à frente (um relógio errado, um id que não é uuid v7), ou o job falha de novo na noite seguinte depois da partição criada à mão: chame o dono.
