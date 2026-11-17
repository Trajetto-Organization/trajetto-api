# partition-lookahead-low — Folga de partições baixa

**Dispara quando:** uma tabela particionada do registro
(`src/shared/database/partitions.ts`; hoje, `driver_position`) tem menos de
5 dias de partições à frente.

## O que significa

O job `partition-maintenance` (04:10 UTC) deixa cerca de 7 dias de partições
criados à frente, e logo antes de rodar restam 6. Abaixo de 5, ele não as
criou em duas noites seguidas. Ainda não há perda: o INSERT só é recusado
quando a partição do dia falta, e antes disso vem o `partition-runway-low`
(menos de 3 dias). É o aviso para agir com folga.

## Primeira ação

1. Veja no log o erro do job `partition-maintenance` das últimas noites
   (`partition creation postponed` diz a tabela, a partição e o motivo) e,
   em `/health/metrics`, `cron_jobs` e `partitions.<tabela>`.
2. Um `lock_timeout` quer dizer que algo segurava a tabela (um `VACUUM` ou
   `ANALYZE` à mão, um `CREATE INDEX`): rode o job de novo fora desse
   horário. Ele é idempotente.
3. Com `owner_ok` falso em `partitions.<tabela>`, o passo
   `infra/sql/10-partitions.sql` ficou pendente: veja `GET /health/rollout`
   e rode a etapa de release de novo.

## Como confirmar

`partitions.<tabela>.lookahead_days` em `/health/metrics` volta a 6 ou 7 e o
motivo some do próximo `ops-heartbeat`.

## Quando escalar

Se o job falhar de novo na mesma noite, ou se a folga chegar a 3 dias (aí
dispara o `partition-runway-low`): chame o dono.
