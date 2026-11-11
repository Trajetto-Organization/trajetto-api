# ADR 0002 — Redis descartável

- **Status:** aceito. ADR da fase final, ampliado depois sem mudar a regra
  (veja _Os usos de hoje_) e com o adendo de 10/11/2026 (as chaves do
  geocodificador e o cache da busca de endereço).
- **Escopo:** `trajetto-api`.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova.

## Decisão

O Redis guarda **só o que pode sumir**. Nada nele é fonte de verdade: fila,
lock, sessão e dado de empresa ficam no Postgres. Se o Redis cair, a API
continua atendendo, em modo degradado.

No texto original, os usos eram dois: os contadores de rate limit, que falham
aberto, e o pub/sub do adapter do Socket.IO entre réplicas.

## Os usos de hoje

Os quatro últimos vieram depois do texto original e seguem a mesma regra:
chave curta e expiração própria. O intervalo do "esqueci minha senha" e as
fotos falham aberto, como o rate limit. O ticket de socket e o geocodificador
falham fechado: sem Redis, a web não abre socket novo e nada é perguntado ao
provedor (veja o adendo de 10/11/2026, abaixo).

| Uso                                                | Onde                                                                                                                                                                      | Sem Redis                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| rate limit (HTTP, handshake, chave de API)         | `src/http.ts` (`skipOnError: true`), `src/shared/socket/handshake-rate-limit.ts`, `src/shared/integration/integration-rate-guard.ts`                                      | o pedido passa sem limite                                                                                                                   |
| pub/sub do Socket.IO                               | `src/shared/socket/adapter-redis.ts`                                                                                                                                      | cada réplica só alcança os próprios sockets                                                                                                 |
| tickets de socket da web (30 s, uso único)         | `src/shared/socket/socket-ticket.ts`; o Redis guarda só o hash                                                                                                            | a web não abre socket novo; o resto funciona                                                                                                |
| intervalo de 60 s do "esqueci minha senha"         | `src/shared/security/mail-cooldown.ts` (`SET NX EX`, chave = HMAC do e-mail)                                                                                              | o e-mail sai                                                                                                                                |
| fotos curtas de leituras da plataforma             | `src/shared/cache/snapshot-cache.ts`: prontidão dos provedores (30 s, ou 5 s com provedor transitório) e o dashboard global do MASTER (60 s)                              | cada réplica calcula a sua                                                                                                                  |
| geocodificador e busca de endereço (`geocoding:*`) | `src/shared/delivery/geocoding/geocoding-keys.ts` (as chaves), `geocoding-gate.ts`, `geocoding-budget.ts` e `src/shared/services/address-search/address-search-limits.ts` | nada é perguntado ao provedor (falha fechada): a entrega espera o próximo minuto, a busca responde 503 e o clique no mapa continua gravando |

Fora do cache da busca de endereço (adendo de 10/11/2026), nenhum dado de
empresa nem de pessoa entra em cache. A trava de senha por conta fica no
Postgres justamente porque o rate limit do Redis falha aberto (comentário de
`failed_login_attempts` em `prisma/schema.prisma`).

## Consequências registradas

- **Readiness não depende do Redis** (`GET /health/readiness` só olha o
  banco): condicionar a ele tiraria todas as réplicas do ar ao mesmo tempo.
  O `GET /health` mostra o Redis como `degraded`, com status 200.
- **Sem persistência e com teto de memória** no Database Redis do Dokploy
  (RDB e AOF desligados, 256 MB com `allkeys-lru`); não precisa de backup.
- Um `REDIS_URL` compartilhado por dois ambientes exige `SOCKET_ADAPTER_KEY`
  diferente, porque o Pub/Sub ignora o número do banco.
- Prova: `tests/E2E/resilience-redis-loss.test.ts`.

## Adendo de 10/11/2026: as chaves `geocoding:*` e o cache da busca de endereço

A localização automática das entregas (plano de 02/11/2026, E1) e a busca do
"Fixar no mapa" (plano pin-search, decisões do dono de 10/11/2026) guardam no
Redis o que dividem com o provedor (LocationIQ) e entre as réplicas. A regra
deste ADR continua valendo: tudo ali pode sumir, nada é fonte de verdade, e o
ponto da entrega só é gravado no Postgres, pelo job ou pelo
`PATCH /route/set-delivery-location`. Entram:

| Chave                                                            | O quê                                                    | Prazo                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| `geocoding:deliveries:{dia}`                                     | as consultas do job no dia UTC                           | 26 h                                                             |
| `geocoding:deliveries:rate:{segundo}`                            | a vaga por segundo do provedor, do job e da busca juntos | 2 s                                                              |
| `geocoding:provider:minute`                                      | as chamadas dos últimos 60 s (_sorted set_)              | 60 s depois da última                                            |
| `geocoding:deliveries:paused`                                    | a pausa da conta: recusa, cota do dia ou pico            | 15 min, até a meia-noite UTC ou 60 s                             |
| `geocoding:search:paused`                                        | a pausa só da busca, e a cópia da cota e do pico         | o da pausa que guarda                                            |
| `geocoding:search:{dia}` e `geocoding:search:{dia}:{businessId}` | as buscas do dia, da plataforma e de cada empresa        | 26 h                                                             |
| `geocoding:search:cache:{businessId}:{HMAC}`                     | as sugestões de uma busca de uma empresa, cifradas       | `ADDRESS_SEARCH_CACHE_SECONDS` (48 h); "nada encontrado", 10 min |

**O cache da busca é o único dado de empresa em cache no Redis**, e por isso
tem regras próprias:

- **por empresa**: a chave leva o `businessId`, e uma empresa não descobre,
  pelo tempo da resposta, o que outra buscou;
- **a chave é um HMAC**, nunca o texto digitado, que pode ser o endereço de um
  destinatário. A chave do HMAC é derivada da `JWT_SECRET` com rótulo próprio
  (HKDF): um hash sem chave de um endereço se desfaz com um dicionário;
- **o valor é cifrado** (AES-256-GCM, `src/shared/integration/secret-box.ts`,
  com outra chave derivada da `JWT_SECRET`): numa busca por número, a
  sugestão é o endereço digitado, e um dump do Redis não entrega o que cada
  empresa buscou. Valor em claro, adulterado ou cifrado com outra `JWT_SECRET`
  conta como cache vazio;
- **o prazo é curto e próprio**: 48 h, o máximo que o plano grátis do provedor
  permite guardar. O `allkeys-lru` pode tirar antes, e nada se perde.

**Falha fechada**, como o ticket de socket e ao contrário do rate limit, do
intervalo do "esqueci minha senha" e das fotos. Um limitador que falha aberto
custa um limite e poupa o pedido de um cliente; aqui, falhar aberto só
gastaria a cota e o dinheiro do provedor sem contar. Sem Redis, nada é
perguntado ao provedor: a entrega fica sem ponto até o próximo minuto, a busca
responde `503 ADDRESS_SEARCH_UNAVAILABLE` e o clique no mapa continua
gravando. O resto da API não percebe.

**Perder tudo custa pouco**, e o Redis continua descartável: sem o cache, a
busca pergunta de novo; uma contagem do dia perdida recomeça do zero, e o teto
do próprio provedor (o 429 de cota, que vira a pausa `QUOTA`) segura o resto;
uma pausa perdida custa uma chamada recusada, que a grava de novo. Nada muda
na persistência (RDB e AOF continuam desligados) nem no backup.

**Um prefixo só, o mesmo em toda réplica.** As chaves saem de
`src/shared/delivery/geocoding/geocoding-keys.ts`, sob o prefixo `geocoding`,
o mesmo em todas as réplicas, nas antigas e nas novas de um rolling deploy: só
assim a vaga do segundo, o minuto e as pausas valem para a conta inteira. Os
E2E que usam essas chaves (o portão, a pausa, a `geocoding-hold`, o orçamento
e a busca) rodam sob um prefixo próprio por execução
(`tests/E2E/support/geocoding-test-keys.ts`), porque o Redis deles sobrevive
à execução e pode servir duas ao mesmo tempo;
`tests/unitaires/delivery/geocoding-keys.test.ts` prova que a produção
continua no prefixo compartilhado.

## Fontes

- [`arquitetura.md` → Redis e tempo real](../arquitetura.md#redis-e-tempo-real)
  e a linha "Redis 7" de [Componentes e relações](../arquitetura.md#componentes-e-relações).
- [`deploy.md` → 7.5 Redis (Database)](../deploy.md#75-redis-database) e
  [§10, Redis](../deploy.md#redis).
- [ADR 0001](./0001-filas-e-mensageria.md), item 2 da decisão.
- Adendo de 10/11/2026: [`arquitetura.md` → Busca de endereço](../arquitetura.md#busca-de-endereço-fixar-no-mapa)
  e os comentários de `geocoding-keys.ts`, `geocoding-gate.ts`,
  `geocoding-budget.ts` e `address-search-limits.ts`.
