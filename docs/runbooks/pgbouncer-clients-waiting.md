# pgbouncer-clients-waiting — Clientes esperando conexão no PgBouncer

**Dispara quando:** algum pool do PgBouncer tem um cliente esperando uma conexão de servidor há 2 s ou mais (`maxwait`).

## O que significa

Todas as conexões de servidor de um pool (banco e login) estão ocupadas, e os clientes entram na fila. O PgBouncer derruba o cliente que espera mais de 5 s (`query_wait_timeout`), e a API responde 503 `SERVICE_BUSY` com `Retry-After` (plano de escala, F4-32): perto disso, os usuários começam a ver erro. A causa costuma ser o Postgres lento (uma query cara, um lock), não o PgBouncer. Durante um `PAUSE` planejado, a espera é esperada.

## Primeira ação

1. `pgbouncer.totals` em `/health/metrics`: `maxwait_pool` diz o pool, `cl_waiting` quantos esperam. Em `instances[].pools`, `sv_active` igual ao `pool_size` do banco (em `databases`) é o pool cheio.
2. No Postgres, o que segura as conexões, com a consulta abaixo. Uma transação longa é o [long-write-xact](./long-write-xact.md); uma query cara aparece no `pg_stat_statements`.
3. Se for um `PAUSE` esquecido (`paused_databases` acima de 0), o dono dá `RESUME` no console de administração.

```sql
SELECT usename, application_name, state, wait_event_type, count(*),
       max(now() - xact_start) AS oldest
FROM pg_stat_activity
WHERE datname = current_database()
GROUP BY 1, 2, 3, 4 ORDER BY 5 DESC;
```

## Como confirmar

`maxwait_seconds` volta abaixo de 2 s e o motivo some no minuto seguinte.

## Quando escalar

Fila recorrente sem query culpada é pool pequeno para a carga: subir o `PGBOUNCER_DEFAULT_POOL_SIZE` ou o `PGBOUNCER_MAX_DB_CONNECTIONS` mexe no orçamento de conexões do Postgres e é decisão do dono.
