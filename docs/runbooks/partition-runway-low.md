# partition-runway-low — Partições acabando

**Dispara quando:** uma tabela particionada do registro
(`src/shared/database/partitions.ts`; hoje, `driver_position`) tem menos de 3
dias de partições à frente.

## O que significa

A tabela é particionada (a de posições, por dia), e restam poucos dias de partições criadas. Sem a partição do dia, o INSERT é **recusado**: para a trilha, o mapa do motorista para. O aviso anterior, com 5 dias, é o `partition-lookahead-low`.

## Primeira ação

1. Veja no log o erro do job `partition-maintenance` (04:10 UTC).
2. Rode o job de novo: ele é idempotente. Um `lock_timeout` (alguém segurando a tabela) se resolve rodando fora do horário do backup.

## Como confirmar

`partitions.<tabela>.lookahead_days` em `/health/metrics` volta a 6 ou 7 dias e o motivo some.

## Quando escalar

Menos de 1 dia de folga e o job falhando: chame o dono na hora.
