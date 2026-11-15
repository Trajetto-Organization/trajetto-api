# partition-runway-low — Partições de posição acabando

**Dispara quando:** driver_position com menos de 3 dias de partições à frente.

## O que significa

A tabela de posições é particionada por dia, e restam poucos dias de partições criadas. Sem a partição do dia, o INSERT de posição é **recusado** e o mapa do motorista para.

## Primeira ação

1. Veja no log o erro do job `driver-position-partitions` (04:10 UTC).
2. Rode o job de novo: ele é idempotente. Um `lock_timeout` (alguém segurando a tabela) se resolve rodando fora do horário do backup.

## Como confirmar

`/health/metrics` mostra a folga de partições de volta a 7 dias e o motivo some.

## Quando escalar

Menos de 1 dia de folga e o job falhando: chame o dono na hora.
