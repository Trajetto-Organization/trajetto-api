# ADR 0002 — Redis descartável

- **Status:** aceito. ADR da fase final, ampliado depois sem mudar a regra
  (veja _Os usos de hoje_).
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

Os três últimos vieram depois do texto original e seguem a mesma regra: chave
curta, expiração própria e falha aberta.

| Uso                                        | Onde                                                                                                                                         | Sem Redis                                    |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| rate limit (HTTP, handshake, chave de API) | `src/http.ts` (`skipOnError: true`), `src/shared/socket/handshake-rate-limit.ts`, `src/shared/integration/integration-rate-guard.ts`         | o pedido passa sem limite                    |
| pub/sub do Socket.IO                       | `src/shared/socket/adapter-redis.ts`                                                                                                         | cada réplica só alcança os próprios sockets  |
| tickets de socket da web (30 s, uso único) | `src/shared/socket/socket-ticket.ts`; o Redis guarda só o hash                                                                               | a web não abre socket novo; o resto funciona |
| intervalo de 60 s do "esqueci minha senha" | `src/shared/security/mail-cooldown.ts` (`SET NX EX`, chave = HMAC do e-mail)                                                                 | o e-mail sai                                 |
| fotos curtas de leituras da plataforma     | `src/shared/cache/snapshot-cache.ts`: prontidão dos provedores (30 s, ou 5 s com provedor transitório) e o dashboard global do MASTER (60 s) | cada réplica calcula a sua                   |

Nenhum dado de empresa nem de pessoa entra em cache. A trava de senha por
conta fica no Postgres justamente porque o rate limit do Redis falha aberto
(comentário de `failed_login_attempts` em `prisma/schema.prisma`).

## Consequências registradas

- **Readiness não depende do Redis** (`GET /health/readiness` só olha o
  banco): condicionar a ele tiraria todas as réplicas do ar ao mesmo tempo.
  O `GET /health` mostra o Redis como `degraded`, com status 200.
- **Sem persistência e com teto de memória** no Database Redis do Dokploy
  (RDB e AOF desligados, 256 MB com `allkeys-lru`); não precisa de backup.
- Um `REDIS_URL` compartilhado por dois ambientes exige `SOCKET_ADAPTER_KEY`
  diferente, porque o Pub/Sub ignora o número do banco.
- Prova: `tests/E2E/resilience-redis-loss.test.ts`.

## Fontes

- [`arquitetura.md` → Redis e tempo real](../arquitetura.md#redis-e-tempo-real)
  e a linha "Redis 7" de [Componentes e relações](../arquitetura.md#componentes-e-relações).
- [`deploy.md` → 7.5 Redis (Database)](../deploy.md#75-redis-database) e
  [§10, Redis](../deploy.md#redis).
- [ADR 0001](./0001-filas-e-mensageria.md), item 2 da decisão.
