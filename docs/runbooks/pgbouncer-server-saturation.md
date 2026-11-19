# pgbouncer-server-saturation — Conexões de servidor do PgBouncer perto do teto

**Dispara quando:** as conexões do PgBouncer a um banco chegam a 80% do `max_db_connections` dele.

## O que significa

O PgBouncer abre no Postgres no máximo `max_db_connections` conexões por banco (60 na staging e na produção). O alias da readiness (`trajetto_probe`) tem 2 próprias e fica fora desta conta: num minuto calmo ele já está com as 2 ocupadas (a do login da sonda e a do `auth_query` do `pgbouncer_auth`), e isso não diz nada do orçamento. As conexões dele continuam somadas em `server_connections`. Perto do teto, a próxima rajada não ganha conexão nova e entra na fila: o [pgbouncer-clients-waiting](./pgbouncer-clients-waiting.md) vem logo depois. O portão de carga do 1M pede menos de 70% sustentado.

## Primeira ação

1. `pgbouncer.totals.server_usage_percent` e `server_usage_database` em `/health/metrics`; em `instances[].pools`, quais logins (`trajetto_http`, `trajetto_worker`, `trajetto_read`) ocupam as conexões.
2. Muitas conexões `sv_idle` com pouco `sv_active` são pools grandes demais para o tráfego; muitas `sv_active` são carga ou Postgres lento (a consulta do [pgbouncer-clients-waiting](./pgbouncer-clients-waiting.md)).

## Como confirmar

O uso volta abaixo de 80% e o motivo some no minuto seguinte.

## Quando escalar

Uso alto sustentado pede revisar o orçamento de conexões (ADR 0008 e o plano de escala, seção 2.2): subir o `PGBOUNCER_MAX_DB_CONNECTIONS` só cabe se o `max_connections` do Postgres tiver folga. Decisão do dono.
