# cron-lease-expired — Cron interrompido no meio

**Dispara quando:** execução RUNNING com o lease vencido.

## O que significa

Uma execução de cron ficou RUNNING além do lease de 10 minutos: a réplica que a rodava caiu no meio (deploy, falta de memória, nó reiniciado). O catch-up marca a linha como FAILED e o job roda de novo.

## Primeira ação

1. Veja na aba _Logs_ da `trajetto-api` se a réplica foi morta (OOM, restart) na hora do job.
2. Nada mais a fazer: os jobs são idempotentes e o próximo horário (ou o catch-up) refaz.

## Como confirmar

`cron_jobs` em `/health/metrics` mostra o job com uma execução SUCCEEDED depois da interrompida.

## Quando escalar

Se o mesmo job é interrompido em toda execução, ele não cabe no lease ou derruba a réplica: chame o dono.
