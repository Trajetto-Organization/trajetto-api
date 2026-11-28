# noisy-tenant — Empresa barulhenta

**Quando:** respostas 429 com `code` `TENANT_BUSY` para o painel de uma empresa, ou a seção `panel_budget` do `/health/metrics` (e do `ops_sample`) mostrando uma empresa estourando o orçamento, ou uma empresa sozinha pesando na latência de todas.

## O que significa

Cada requisição de uma sessão do painel gasta unidades do minuto da empresa (plano de escala F2-28, decisão D41): um detalhe 1, a Torre 3, uma lista 5 (10 sem período), uma exportação 20. A empresa tem `TENANT_PANEL_BUDGET_PER_MINUTE` (6.000) por minuto, e cada pessoa no máximo a fatia `TENANT_PANEL_USER_SHARE` (25%) dele, cobrada antes de a sessão ser conferida: um token revogado ou uma pessoa só não esgotam a empresa. O motorista e o MASTER nunca pagam.

Com `TENANT_PANEL_BUDGET_MODE=observe` (o padrão), nada é recusado: `panel_budget` só conta. Com `enforce`, o que passa do orçamento recebe 429 `TENANT_BUSY` com `Retry-After` até o fim do minuto. Se o Redis falhar, o orçamento abre (não recusa nada).

## Primeira ação

1. No `/health/metrics`, leia `panel_budget`: qual empresa, e se é a empresa toda ou uma pessoa só (a fatia).
2. Uma pessoa ou uma integração mal feita usando o painel como API (um robô atualizando a lista a cada segundo): fale com a empresa; a integração tem a API pública, com o próprio limite.
3. Uma empresa grande de verdade, trabalhando normal: aumente `TENANT_PANEL_BUDGET_PER_MINUTE` no _Environment_ da `trajetto-api` (vale para todas) ou volte para `observe` enquanto decide. Nenhuma das duas perde dado.

## Como confirmar

Os 429 `TENANT_BUSY` dessa empresa somem do log de acesso, e a contagem dela em `panel_budget` volta abaixo do orçamento. A latência das outras empresas volta ao normal.

## Quando escalar

O `enforce` recusando uma empresa que trabalha normal mesmo depois de subir o orçamento, ou o orçamento sem efeito (um 429 que não devia, ou nenhum quando devia, com o Redis no ar): chame o dono.
