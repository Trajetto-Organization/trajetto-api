# redis-memory-policy — Redis sem teto de memória ou com noeviction

**Dispara quando:** Redis respondendo sem maxmemory ou com maxmemory-policy noeviction.

## O que significa

O Redis está sem `maxmemory` (cresce até o contêiner morrer por memória) ou com `noeviction` (cheio, recusa toda escrita e desliga o rate limit de uma vez). O esperado é `--maxmemory 256mb --maxmemory-policy allkeys-lru`.

## Primeira ação

1. No Database Redis do ambiente, campo de comando personalizado (_Advanced_), numa linha: `redis-server --requirepass <a senha> --save "" --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru` ([deploy.md, 7.5](../deploy.md#75-redis-database)).
2. **Save** → **Deploy** no Database.

## Como confirmar

`redis-cli CONFIG GET maxmemory-policy` responde `allkeys-lru`, e o motivo some.

## Quando escalar

Se a versão do Dokploy não tem o campo de comando, registre a lacuna e chame o dono.
