# cron-overdue — Cron sem sucesso

**Dispara quando:** job sem execução bem-sucedida há 26 h, ou que rodou e nunca teve sucesso.

## O que significa

Um job registrado não teve execução bem-sucedida em 26 horas (todos são pelo menos diários), ou rodou e só falhou. O que ele faz (expurgo, partição, recibos) parou.

## Primeira ação

1. `cron_jobs` em `/health/metrics` traz o `last_error` do job.
2. Corrija a causa (banco, permissão, provedor); o catch-up refaz jobs diários a cada hora.

## Como confirmar

Uma execução SUCCEEDED do job em `cron_jobs`, e o motivo some.

## Quando escalar

Um erro de código (exceção que se repete) precisa de correção e deploy: chame o dono.
