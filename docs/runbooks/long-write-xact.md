# long-write-xact — Transação de escrita aberta há muito tempo

**Dispara quando:** escrita aberta há mais de LONG_WRITE_XACT_ALERT_SECONDS (120 s).

## O que significa

Alguma sessão, em qualquer banco do cluster, tem uma transação com xid aberta há mais que o limite. Ela segura o horizonte do vacuum (as linhas mortas não saem) e, com o feed de integração, segura o feed. A reversão de importação roda até 60 s dentro do HTTP: por isso o limite é 120 s até ela virar job.

## Primeira ação

1. Ache a sessão, com a consulta abaixo.
2. Uma sessão esquecida no `psql` ou num cliente de banco: `SELECT pg_terminate_backend(<pid>);`.
3. Uma sessão da própria API: anote a consulta e o `application_name` antes de terminar, para achar o código.

```sql
SELECT pid, usename, application_name, now() - xact_start AS aberta,
       state, left(query, 80) AS consulta
FROM pg_stat_activity
WHERE backend_xid IS NOT NULL
ORDER BY xact_start;
```

## Como confirmar

A consulta acima não mostra mais a sessão, e o motivo some.

## Quando escalar

A mesma consulta da API voltando a ficar aberta: é um bug de código, chame o dono com a consulta.
