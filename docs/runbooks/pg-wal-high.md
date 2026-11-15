# pg-wal-high — pg_wal grande

**Dispara quando:** pg_wal acima de PG_WAL_ALERT_GIB (12 GiB; 8 na VPS única).

## O que significa

O diretório de WAL do Postgres passou do limite. Uso normal é 1–2 GB. Ele cresce quando o arquivamento não sai, quando um slot de replicação abandonado segura segmentos, ou num pico de escrita. O disco é o mesmo das duas produções.

## Primeira ação

1. O arquivamento primeiro: o [wal-archive-stalled](./wal-archive-stalled.md) está ativo?
2. Um slot de replicação inativo segura WAL (a consulta abaixo); um que ninguém usa se remove com `SELECT pg_drop_replication_slot('<nome>');`.
3. Veja o disco do host (Beszel) e o [disk-full](./disk-full.md).

```sql
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn))
FROM pg_replication_slots;
```

## Como confirmar

O `pg_wal` em `/health/metrics` (`database.pg_wal.bytes`) cai depois do próximo checkpoint, e o motivo some.

## Quando escalar

Disco acima de 80% ou o `pg_wal` crescendo sem causa: chame o dono na hora.
