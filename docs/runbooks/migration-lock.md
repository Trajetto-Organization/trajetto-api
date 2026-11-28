# migration-lock — Migration presa num lock

**Quando:** a etapa de release espera por um lock e falha pelo lock_timeout.

## O que significa

A migration da `trajetto-api-migrate` precisa de um lock numa tabela que alguém segura (uma transação longa, um `pg_dump`, um vacuum). Com `lock_timeout` de 5 s ela falha em vez de travar a tabela para todo mundo; a versão anterior continua servindo.

## Primeira ação

1. Não reinicie as réplicas da API: elas seguem servindo.
2. Ache quem segura o lock, com a consulta abaixo, e o [long-write-xact](./long-write-xact.md).
3. Liberado o lock, dê **Deploy** na `trajetto-api-migrate` do ambiente. Se o Prisma acusar P3009, siga [deploy.md, P3009](../deploy.md#p3009-uma-migration-ficou-pela-metade).

```sql
SELECT pid, pg_blocking_pids(pid) AS bloqueado_por, now() - xact_start AS aberta,
       left(query, 80) AS consulta
FROM pg_stat_activity
WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

## Como confirmar

A aba _Logs_ da `trajetto-api-migrate` diz "etapa de release concluída", e a migration tem `finished_at` em `_prisma_migrations`.

## Quando escalar

Uma migration pela metade (índice `INVALID`, DDL aplicado sem registro): chame o dono antes de resolver.
