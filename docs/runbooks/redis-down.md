# redis-down — Redis sem resposta

**Dispara quando:** Redis não responde ao PING em 2 s.

## O que significa

A API segue de pé sem o Redis (falha aberta), mas perde o que ele faz: o rate limit fica local em cada réplica (cada uma conta sozinha), o Socket.IO não cruza réplicas (um evento emitido numa réplica não chega aos sockets da outra) e as fotos curtas de leituras do MASTER deixam de ser compartilhadas. O Redis não guarda dado de negócio: não há o que restaurar ([ADR 0002](../adr/0002-redis-descartavel.md)).

## Primeira ação

1. No Dokploy, abra o Database Redis do ambiente: está rodando? A aba _Logs_ diz se caiu por memória.
2. Dê **Deploy** (ou _Start_) no Database Redis. Ele volta vazio, e está tudo bem.
3. Confira que a `REDIS_URL` da `trajetto-api` aponta para o App Name certo.

## Como confirmar

O motivo some, e `redis.status` em `/health/metrics` volta a `up`.

## Quando escalar

Redis caindo de novo por memória: o teto (`--maxmemory`) precisa subir um degrau, decisão do dono ([redis-evictions](./redis-evictions.md)).
