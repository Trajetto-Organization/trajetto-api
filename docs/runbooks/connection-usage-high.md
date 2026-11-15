# connection-usage-high — Conexões do Postgres perto do teto

**Dispara quando:** conexões em 80% de max_connections.

## O que significa

O banco está perto de recusar conexões novas. Réplicas novas, um pool grande demais ou sessões esquecidas enchem o `max_connections`, e a próxima conexão falha.

## Primeira ação

1. `runtime.prisma_pool` em `/health/metrics` e a conta réplicas × `connection_limit` da `DATABASE_URL`.
2. Veja quem segura conexões, com a consulta abaixo.
3. Sessões `idle in transaction` antigas são o [long-write-xact](./long-write-xact.md).

```sql
SELECT usename, application_name, state, count(*)
FROM pg_stat_activity GROUP BY 1, 2, 3 ORDER BY 4 DESC;
```

## Como confirmar

O uso volta abaixo de 80% e o motivo some.

## Quando escalar

Se o uso é legítimo (mais réplicas), o orçamento de conexões do plano de escala precisa de revisão: chame o dono.
