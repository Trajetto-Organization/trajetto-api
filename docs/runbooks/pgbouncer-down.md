# pgbouncer-down — PgBouncer sem resposta pelo login de estatística

**Dispara quando:** com `PGBOUNCER_STATS_URL` na Application que roda o cron, uma tarefa do `trajetto-pgbouncer` não responde ao `SHOW` em 2 s, ou o DNS não devolve nenhum endereço para `PGBOUNCER_STATS_HOSTS`.

## O que significa

O processo com o cron lê, a cada minuto, o console de cada tarefa do PgBouncer pelo login `pgbouncer_stats` (plano de escala, F4-36). Uma tarefa que não responde pode estar fora do ar (e as Applications que passam por ela falham junto), reiniciando, ou recusando o login de estatística (senha trocada só de um lado). Sem endereço nenhum, o nome em `PGBOUNCER_STATS_HOSTS` está errado ou a Application não tem tarefa rodando.

## Primeira ação

1. `pgbouncer` em `/health/metrics`: `instances[].error` diz por quê. `ECONNREFUSED` ou `ETIMEDOUT` é a tarefa fora; `SASL authentication failed` é a senha; `ENOTFOUND` é o nome.
2. A readiness da API (`/health/readiness`) e o `docker service ps trajetto-pgbouncer-<ambiente>`: se a tarefa caiu, os pedidos das Applications que passam por ela estão falhando (503).
3. Senha recusada: a de `PGBOUNCER_STATS_PASSWORD` da `trajetto-pgbouncer` precisa ser a mesma da `PGBOUNCER_STATS_URL` (Environment da Application que roda o cron).
4. Nome: `PGBOUNCER_STATS_HOSTS=tasks.<App Name do PgBouncer>` (por exemplo `tasks.trajetto-pgbouncer-production`).

## Como confirmar

`pgbouncer.status` volta a `up` em `/health/metrics` (uma linha por minuto) e o motivo some.

## Quando escalar

PgBouncer fora com a API respondendo 503: voltar as URLs ao Postgres direto, uma Application por vez, é decisão do dono ([deploy.md, PgBouncer](../deploy.md#pgbouncer-a-imagem-trajetto-pgbouncer-onda-17)).
