# xid-age-high — Idade do xid alta

**Dispara quando:** age(datfrozenxid) do cluster acima de 1 bilhão.

## O que significa

O vacuum não está congelando as linhas velhas a tempo. Em ~2,1 bilhões o Postgres para de aceitar escritas para se proteger (wraparound). Um bilhão é tempo de agir, não pânico.

## Primeira ação

1. Ache o banco e a tabela mais velhos, com as consultas abaixo.
2. Uma transação longa impede o congelamento: veja o [long-write-xact](./long-write-xact.md) antes de tudo.
3. Rode `VACUUM (FREEZE, VERBOSE)` na tabela mais velha, fora do pico.

```sql
SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC;

SELECT relname, age(relfrozenxid)
FROM pg_class WHERE relkind = 'r'
ORDER BY 2 DESC LIMIT 10;
```

## Como confirmar

A idade cai depois do vacuum, e o motivo some.

## Quando escalar

Acima de 1,5 bilhão, ou o vacuum não termina: chame o dono na hora.
