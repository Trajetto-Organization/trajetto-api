# cluster-epoch-stale — Época do cluster velha

**Dispara quando:** a linha de `cluster_epoch` não descreve mais o cluster: o `system_identifier` ou a timeline do Postgres mudaram, ou a linha não existe, e a etapa de release ainda não rodou depois disso.

## O que significa

O feed da integração anda pelo id da transação que gravou cada evento (`delivery_event.txid`, plano de escala F2-03), e o cursor de cada integrador guarda o último que recebeu. Depois de um **PITR** ou de um **failover** (um promote), o cluster continua do xid do instante de onde veio, e os ids de transação voltam a ser usados: um cursor pode apontar para um xid que esta história deu a outra transação. Por isso o cursor leva a **época do cluster** (F2-04), um contador na tabela `cluster_epoch` que a etapa de release (`infra/sql/50-cluster-epoch.sql`) sobe sempre que o par muda:

- o `system_identifier` (`pg_control_system()`) muda com um cluster novo: um restore lógico noutro Database, um `pg_upgrade`;
- a timeline em que o cluster grava (os 8 primeiros dígitos de `pg_walfile_name(pg_current_wal_lsn())`) muda com um PITR e com um promote, na hora: a de `pg_control_checkpoint()` só mudaria no primeiro checkpoint da timeline nova, minutos depois.

Enquanto a etapa não roda, os xids reaproveitados saem com a época velha. O `ops-heartbeat` confere o par a cada minuto e alerta até a etapa rodar. "Sem linha" quer dizer que a etapa nunca rodou neste banco (um banco restaurado de um dump de antes da tabela, ou a etapa falhou).

## Primeira ação

1. Rode a etapa de release no banco: **Deploy** na Application `trajetto-api-migrate` do ambiente (ou GitHub → Actions → staging/production → _Run workflow_ com `force_release`, na produção com a `image_tag` que está no ar) e espere `Running`. É o mesmo passo que os runbooks [pitr-restore](./pitr-restore.md) e de restore do [deploy.md](../deploy.md#restaurar-a-partir-do-r2) já mandam rodar antes de subir o runtime.
2. Se foi um restore lógico num Database novo, confira também o txid do feed: [feed-txid-regressed](./feed-txid-regressed.md).

## Como confirmar

No log da etapa, a linha do `infra/sql/50-cluster-epoch.sql` diz `applied: época N para N+1` (ou `skipped` quando já estava certa), e o motivo some do `ops-heartbeat` no minuto seguinte. No banco:

```sql
SELECT e.epoch, e.system_identifier, e.timeline, e.changed_at,
       s.system_identifier AS cluster_system,
       ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::integer AS cluster_timeline
FROM cluster_epoch e, pg_control_system() s;
```

A linha e o cluster têm de dizer o mesmo par. A etapa e o alerta leem a timeline do WAL atual, que muda já no promote: a etapa rodada logo depois dele sobe a época, sem esperar um checkpoint.

## Quando escalar

Se ninguém fez PITR, promote nem restore e o alerta disparou, chame o dono na hora: o banco no ar não é o que deveria ser (outro Database na mesma URL, um failover que ninguém pediu).
