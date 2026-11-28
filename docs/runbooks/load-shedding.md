# load-shedding — Descarte de carga

**Quando:** respostas 503 com `code` `SERVICE_BUSY` e `Retry-After`, ou a seção `shedding` do `/health/metrics` (e do `ops_sample`) contando recusas, ou o dono decidindo passar `SHED_MODE` de `observe` para `enforce`.

## O que significa

Cada réplica da API mede o próprio aperto (plano de escala F2-24): o laço de eventos acima de 95% ou com 300 ms de atraso, ou o pool do banco com mais pedidos esperando do que conexões. Nesse aperto, cada rota tem uma classe: a crítica (login, o comprovante, o que o motorista não pode refazer) passa sempre; a que pode esperar (a Torre, as exportações; as posições só com o app novo na frota, `SHED_POSITIONS_MODE`) é recusada no limiar; o resto, só acima de 98% ou de 1 s de atraso.

Com `SHED_MODE=observe` (o padrão), nada é recusado: a seção `shedding` só conta o que **seria** recusado, por grupo de rota. Com `enforce`, a réplica responde 503 `SERVICE_BUSY` com `Retry-After` de 5 s (120 s nas posições), e a web e o app esperam e tentam de novo. Recusar trabalho que ia falhar de qualquer jeito protege o resto da réplica; recusar demais é perder trabalho bom.

## Primeira ação

1. No `/health/metrics` de cada réplica, leia `shedding`: quantas recusas (ou quase recusas), de que grupo de rota e em que réplica. Uma réplica só apertada é um problema dela (uma exportação pesada, um vizinho no host); todas é carga de verdade ou o banco lento.
2. Em `enforce`, com recusas de trabalho que deveria passar: volte para `observe` (Dokploy → `trajetto-api` → _Environment_ → `SHED_MODE=observe` → _Save_ → _Deploy_). É a volta, sem perda.
3. Ache a causa do aperto: o banco (conexões, consultas lentas no `pgss_snapshot`, [connection-usage-high](./connection-usage-high.md)), uma rajada de um cliente ([noisy-tenant](./noisy-tenant.md)), ou réplicas de menos para a carga.

## Como confirmar

A contagem de `shedding` para de subir e os 503 `SERVICE_BUSY` somem do log de acesso. Em `observe`, o número de quase recusas por semana é o que decide o `enforce` (decisão D41: 7 dias de observação antes).

## Quando escalar

Recusas em rota crítica (não devia acontecer: a classe crítica nunca é recusada), ou o aperto em todas as réplicas por mais de 15 minutos: chame o dono.
