# cron-partial-stuck — Expurgo só parcial há 26 h

**Dispara quando:** 26 h só de execuções parciais.

## O que significa

Um expurgo noturno para no orçamento (`CRON_PURGE_RUN_BUDGET_MS`) ou no teto com linhas ainda vencidas, e isso se repete há 26 horas: o expurgo perde para o que entra. A primeira parcial não alerta; esta sim.

## Primeira ação

1. `cron_jobs` em `/health/metrics`: `last_error` começa com `[partial]` e diz a tabela que sobrou.
2. Meça o volume vencido da tabela e o tempo de cada lote no log antes de mudar qualquer coisa ([deploy.md, Expurgos parciais](../deploy.md#expurgos-parciais)).

## Como confirmar

A próxima execução termina SUCCEEDED e o motivo some.

## Quando escalar

O orçamento já está no máximo: subir o teto ou mudar a retenção é decisão do dono.
