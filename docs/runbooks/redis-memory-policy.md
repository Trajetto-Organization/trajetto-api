# redis-memory-policy — Redis sem teto de memória ou com noeviction

**Dispara quando:** Redis respondendo sem maxmemory ou com maxmemory-policy noeviction.

## O que significa

O Redis está sem `maxmemory` (cresce até o contêiner morrer por memória) ou com `noeviction` (cheio, recusa toda escrita e desliga o rate limit de uma vez). O esperado é `--maxmemory 256mb --maxmemory-policy allkeys-lru` na produção e `--maxmemory 64mb` na staging.

## Primeira ação

1. No Database Redis do ambiente, _Advanced_: _Custom command_ **vazio** (ele troca o ENTRYPOINT da imagem) e, em _Args_ (_Add Argument_, um por linha), estes 7: `redis-server`, `--requirepass`, `<senha do Database>`, `--maxmemory`, `256mb` (`64mb` na staging), `--maxmemory-policy`, `allkeys-lru` ([deploy.md, 7.5](../deploy.md#75-redis-database)). Qualquer valor nesses campos substitui o padrão do Dokploy, que é quem passava o `--requirepass`: sem a senha nos _Args_, o Redis sobe aberto.
2. **Save** → **Deploy** no Database. A senha passa a morar também nos _Args_: trocar a senha do Database é trocar esse argumento junto.

## Como confirmar

`redis-cli CONFIG GET maxmemory-policy` responde `allkeys-lru`, `CONFIG GET maxmemory` responde o teto (64mb = `67108864`), e o motivo some (assim na staging em 26/11/2026).

## Quando escalar

Se a versão do Dokploy não tem os _Args_ no Database, registre a lacuna e chame o dono.
