# outbox-lag — Outbox parado

**Dispara quando:** evento do outbox devido há mais de 5 min.

## O que significa

Um evento de `domain_outbox_event` já devido (`availableAt` no passado) espera mais de 5 minutos para ser expandido em entregas. Sino, push, e-mail, WhatsApp e webhooks nascem dessa expansão: enquanto o outbox não anda, nada disso sai. O número é atraso **elegível**, não idade: um evento em espera de nova tentativa não conta.

## Primeira ação

1. Abra `/health/metrics` (MASTER) e veja `workers`: qual réplica tem o worker do outbox sem sinal de progresso, ou se nenhuma o roda (`WORKERS_ENABLED=false` em todas).
2. Leia a aba _Logs_ da `trajetto-api` do ambiente procurando erros do outbox (`outbox`, `P1008`, `timeout exceeded`).
3. Se um worker travou, dê **Deploy** na `trajetto-api` (as tasks sobem de novo, uma por vez).

## Como confirmar

O motivo some no minuto seguinte do `ops-heartbeat`. No banco:

```sql
SELECT count(*) AS devidos, now() - min("availableAt") AS mais_antigo
FROM domain_outbox_event
WHERE status = 'PENDING' AND "availableAt" <= now();
```

## Quando escalar

Se depois do Deploy o atraso não cai em 15 minutos, ou o log mostra o banco recusando (pool cheio, `P1008`), o problema é o banco: veja [connection-usage-high](./connection-usage-high.md) e [long-write-xact](./long-write-xact.md) e chame o dono.
