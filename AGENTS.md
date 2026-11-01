# AGENTS.md — trajetto-api

> Guia de trabalho para agentes de código (e para quem chega ao repositório).
> `CLAUDE.md` e `AGENTS.md` têm o mesmo conteúdo a partir da segunda linha;
> o teste `tests/unitaires/quality/agent-guides.test.ts` falha se divergirem —
> mude os dois juntos.

## O que é este repositório

O back-end do **Trajetto**, um SaaS B2B multiempresa para transportadoras com
dois módulos contratados por empresa: **Frotas** (`FLEET`) e **Entregas**
(`DELIVERIES`). Aqui vivem a API HTTP (Fastify), o tempo real (Socket.IO com
adapter Redis), os workers e crons (filas no Postgres), o serviço de IA local
(`infra/ai-ocr`, Python, OCR em CPU) e a infraestrutura de deploy (`.github/workflows/`, `.github/scripts/`,
`infra/scripts/`). Atende o painel web (pasta `trajetto-ui`, GitHub
`Trajetto-Organization/trajetto-ui`), o app Android do motorista (pasta
`trajetto-mobile`, GitHub `Trajetto-Organization/trajetto-mobile`) e os ERPs
dos clientes pela API pública (`/integration/v1`). Organização no GitHub: `Trajetto-Organization`.
Idioma do produto: pt-BR.

## Leia primeiro

| Precisa de…                                                                                   | Abra                            |
| --------------------------------------------------------------------------------------------- | ------------------------------- |
| visão geral, comandos                                                                         | `README.md`                     |
| estrutura do código, como criar uma feature, regras de negócio transversais, migrations, ADRs | `docs/arquitetura.md`           |
| testes: suítes, comandos, regras                                                              | `docs/testes.md`                |
| variáveis de ambiente (todas)                                                                 | `docs/variaveis-de-ambiente.md` |
| pipeline, Dokploy, staging/produção, rollback, backup, alertas                                | `docs/deploy.md`                |
| contas e painéis feitos à mão (Contabo, Dokploy, Cloudflare, GitHub, Expo), tokens, porquês   | `docs/infraestrutura.md`        |

## Stack

Node.js 22 · TypeScript 5.7 (`strict`) · Fastify 5 · Prisma 7.10 (`@prisma/adapter-pg`) · PostgreSQL 16
· Redis 7 (ioredis) · Socket.IO 4 · tsyringe (DI) · zod 3 · pino · Vitest 1.6
· Stryker 8.7 · tsup · Yarn 1 (`yarn.lock`; nunca npm) · Docker (imagem
`node:22.21.1-alpine`) · Python 3.12 no serviço de IA.

## Mapa do repositório

```
src/server.ts                 boot (HTTP + Socket.IO + workers) e desligamento ordenado
src/http.ts                   instância Fastify, plugins, hooks, tratamento de erro, registro das rotas
src/websocket.ts              Socket.IO, salas, emissores (sendCatalogChangedEvent…)
src/env/index.ts              carrega .env e valida com src/schemas/env-schema/index.ts
src/config/                   auth, CORS, rate limit, borda confiável (faixas da Cloudflare), upload, permissões
src/routes/<área>-routes.ts   rotas com guards e schema OpenAPI; routes.ts registra com o prefixo
src/routes/documentation/     schemas de resposta do OpenAPI
src/schemas/<nome>-schema/    schemas zod de entrada
src/modules/<domínio>/        dtos/, repositories/ (I*-repository, Prisma, in-memory/), usecases/<caso>/ (controller + usecase), errors
src/modules/middlewares/      ensure-authenticated, verify-permission, verify-tenant-active, verify-module-enabled, tenant-authorization…
src/shared/                   código transversal (ai, delivery, route, notifications, integration, health, http, pagination,
                              security, time, lifecycle, logging, providers, services, in-memory, errors)
src/shared/index.ts           registro dos repositórios/serviços no container do tsyringe
src/jobs/cron/                crons (index.ts registra)
src/workers/index.ts          pipelines de notificação e IA, dispatcher de webhooks
prisma/schema.prisma          modelo de dados; prisma/migrations/ (SQL, expandir/contrair)
prisma/vitest-environment-prisma/  ambiente de teste: um banco por arquivo E2E
infra/scripts/                entrypoint da imagem (serve, migrate, release), verify-rollout, backup/restore manuais, seeds, guard de bootstrap
infra/ai-ocr/                 serviço trajetto-ai (server.py, Dockerfile com stage test, requisitos com hash, modelos)
infra/traefik/                referência da configuração estática do Traefik do Dokploy
tests/unitaires/              unitários (por domínio + contract/, lifecycle/, security/, quality/…)
tests/E2E/                    E2E contra Postgres e Redis reais
tests/contract/               suítes de contrato de repositório (Prisma × in-memory)
tests/ai-local/               contrato opt-in com o contêiner de IA real
tests/load/                   harness de carga (k6 + Traefik) e seed das suítes de navegador da web/app
.github/workflows/ci.yml      portão das branches de trabalho
.github/workflows/deploy.yml  pipeline: staging (validação + build + deploy) → PR → main (promoção) → release
.github/scripts/dokploy-deploy.mjs  deploy de uma Application do Dokploy pela API (application.deploy) e acompanhamento
compose.development.yaml      Postgres, Redis e (perfil ai) o serviço de IA para desenvolvimento (só dev)
```

Aliases: `@/*` → `src/*`, `infra/*` → `infra/*`.

## Comandos

```bash
yarn install                       # dependências (Yarn 1)
cp .env.example .env               # a API lê SÓ o .env
yarn dev                           # Postgres + Redis (docker), migrate, seeds, servidor com recarga na :3333
yarn dev:server                    # só o servidor
yarn prisma:generate               # gere o client antes do typecheck
yarn typecheck                     # tsc --noEmit
yarn test                          # unitários
npx vitest run <arquivo>           # um arquivo
yarn test:coverage                 # unitários com o piso de cobertura do CI
yarn test:e2e                      # E2E em duas fases (precisa de DATABASE_URL/REDIS_URL de um Postgres/Redis DESCARTÁVEL)
yarn prisma:migrate:dev            # cria uma migration (--create-only); revise o SQL
yarn prisma:migrate:deploy         # aplica
docker compose -f compose.development.yaml --profile ai up -d trajetto-ai   # IA local (~1 GiB)
docker build --target test infra/ai-ocr                                       # pytest do serviço de IA
```

E2E contra um banco descartável (nunca o de desenvolvimento): o ambiente de
teste cria e apaga um banco por arquivo no servidor de `TEST_DATABASE_URL` (ou
`DATABASE_URL`):

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:54321/trajetto?schema=public" \
REDIS_URL="redis://localhost:63790" npx vitest run tests/E2E/<arquivo>.test.ts
```

**Não rode `yarn lint:check`/`yarn lint:fix` nem `yarn build` localmente**: o
CI roda o lint, e o build é o da imagem. Antes de dizer "pronto": typecheck +
os testes que tocam o que mudou (e os E2E relevantes, em lotes de até 8 no
Windows).

## Convenções de código

- **Comentários no código em inglês**; mensagens ao usuário, erros, descrições
  do OpenAPI e documentação (README, `docs/`) em **pt-BR com acentos**. Títulos
  de teste em inglês.
- Comentários explicam o **porquê** (o incidente, a decisão, o limite medido),
  não o quê. Siga o tom dos arquivos vizinhos.
- **Camadas**: rota (guards + schema) → controller fino (parse com zod,
  `container.resolve`) → usecase `@injectable()` com as regras → repositório
  por interface (`@inject("NomeRepository")`). Repositório novo: interface +
  Prisma + gêmeo in-memory com a **mesma semântica**, registrado em
  `src/shared/index.ts`.
- **Multiempresa em tudo**: filtre por `businessId`; id de outra empresa = 404
  (como inexistente); campo de empresa no corpo que não pode mudar é recusado,
  não ignorado. O guard de tenant roda em **`preHandler`** (no `onRequest` o
  corpo ainda não foi lido) — não mova.
- **Guards de rota**: `onRequest: [ensureAuthenticated]`; `preHandler` com
  `verifyBusinessActive`, `verifyModuleEnabled("FLEET"|"DELIVERIES")` quando o
  módulo é contratado e `verifyPermission("<chave>", "read"|"write")` (chaves em
  `src/config/permissions.ts`; o motorista tem tabela fixa).
- **Erros** com `code` estável e mensagem em pt-BR (`AppError` e as classes de
  `usecases/errors/`). Unicidade: 409 com `code`, mensagem "nesta empresa",
  nunca confirmando existência em outra empresa; trate o P2002 do índice.
- **OpenAPI é a documentação**: toda rota declara `tags`, `summary`,
  `description` (pt-BR), `params`/`querystring`/`body` e `response` com os
  códigos de erro. A referência pública é gerada por subtração.
- **Dia de negócio**: `src/shared/time/business-day.ts` para todo "hoje"/"N
  dias"; datas sem hora são `@db.Date` (`YYYY-MM-DD`). Nunca `setHours` no
  relógio do servidor; o contêiner é UTC sem `TZ`.
- **Tempo real e efeitos depois do commit**: emita eventos (`catalogChanged`
  etc.) e publique no outbox dentro da transação do dado; nunca anuncie o que
  não foi gravado.
- **Idempotência** em escritas do app e da API pública (`Idempotency-Key`,
  `client_submission_id`).
- **Listagens** do painel: NDJSON com offset e a linha `meta`; seletores com
  cursor.
- **Buscas sem diferenciar maiúsculas** com `insensitiveEquals`
  (`src/shared/utils/like-pattern.ts`), nunca `{ mode: "insensitive" }` cru
  (curinga `%`/`_` vaza entre tenants).
- **Logs** pelo logger único (`src/shared/logging/logger.ts`); nunca logue
  segredo, token, URL assinada ou corpo com senha.
- **Variável de ambiente nova**: no env-schema (com o porquê), no
  `.env.example`, em `docs/variaveis-de-ambiente.md` (com onde ela é
  definida) e, se for segredo, na censura do logger
  (`provider-secret-redaction.test.ts` cobra). Em staging e produção ela é
  digitada à mão no _Environment_ da Application `trajetto-api` (ou na
  `trajetto-api-migrate`, se quem lê é a etapa de release) no Dokploy
  (nenhum arquivo do repositório leva variáveis ao servidor): diga isso na
  entrega. Vazio conta como ausente.
- Formatação: Prettier (`.prettierrc`); o CI confere.

## Migrations

Toda migration roda com a versão **anterior** servindo e continua aplicada
depois de um rollback. Expandir/contrair sempre: nada de DROP/RENAME/tipo
novo/`SET NOT NULL` sobre o que a produção lê sem a fase de contract (marcador
`-- contract-phase:`), enum novo só gravado na release seguinte
(`-- enum-expand:`), `DROP NOT NULL` idem (`-- nullable-expand:`),
`SET lock_timeout = '5s'` em tabela quente, `CREATE INDEX IF NOT EXISTS`. O
guard é `tests/unitaires/lifecycle/migration-safety.test.ts`. **Nunca edite
uma migration já aplicada em algum banco** (nem um comentário: muda o
checksum). Detalhes: `docs/arquitetura.md` ("Migrations: expandir e contrair").

## Testes (resumo de `docs/testes.md`)

- Vermelho antes de verde; títulos em inglês; um teste por garantia, com o
  porquê no comentário do topo.
- Pelo caminho real: rota pela pilha inteira (E2E HTTP) quando a regra depende
  de autorização, tenant ou SQL; scripts `.sh` e blocos `run:` de workflow
  executados com stubs (`tests/unitaires/lifecycle/support/shell-harness.ts`).
- Todo recurso novo: um caso com id de outra empresa (404) e um com campo de
  empresa no corpo (recusado).
- Mudou o repositório Prisma? Mude o gêmeo in-memory e o contrato de
  repositório juntos.
- Contratos com os clientes não se ajustam ao código: `outbox-body-contract`
  falhando = corrigir o servidor; rota removida vai para
  `src/routes/retired-routes.ts`; `client-routes.test.ts` confere as URLs da
  web e do app.
- Piso de cobertura no `test:coverage` (statements/linhas 70,8 %, branches
  82,57 %, funções 57,62 %); não baixe.
- Nenhum teste sai da máquina: a trava de rede do `setupTests.ts` falha o
  arquivo que conectar fora do loopback e dos bancos configurados; todo
  terceiro é um falso local (com `NODE_ENV=test`, o e-mail fica numa caixa em
  memória do processo).
- Espere por estado, nunca por tempo: `tests/E2E/support/socket-waits.ts`
  (salas, _acknowledgement_ do subscribe), `vi.waitFor` com prazo; nada de
  `setTimeout` fixo esperando o servidor.
- E2E novo que sobe réplicas da API entra em
  `tests/E2E/support/replica-files.ts` (a fase própria do `yarn test:e2e`, um
  arquivo por vez); `quality/e2e-replica-isolation.test.ts` cobra.
- Windows: E2E em lotes de no máximo 8 arquivos (limite herdado do napi panic do
  Prisma 6; o Prisma 7 não tem engine nativo, mas lotes maiores não foram medidos).

## Pipeline e deploy (resumo de `docs/deploy.md`)

- Branches: trabalho → `staging` → PR `staging → main` → merge **com merge
  commit** (nunca squash/rebase).
- `ci.yml` valida as branches de trabalho. `deploy.yml`: push em `staging`
  roda a validação completa (audit, lint, typecheck, unitários com piso, E2E,
  pytest da IA, gitleaks), constrói **uma vez** as imagens `trajetto-api`,
  `trajetto-api-migrate` e `trajetto-ai` (`sha-<sha>`, SBOM, proveniência,
  Trivy; a de migração e a da IA são reaproveitadas por `src-<hash>` quando o
  que rodam não mudou), roda as migrations pela Application
  `trajetto-api-migrate` do Dokploy (só se o banco ainda não aplicou aquela
  imagem; `dokploy-release.mjs` espera a etapa terminar), move `staging` por
  digest e faz o deploy do staging no Dokploy; PR para
  `main` revalida e exige que o staging tenha rodado o head (ou que o head só
  mude documentação desde um commit que rodou: `[skip ci]` só para
  documentação é seguro); o merge em `main`
  **promove** o mesmo digest para `stable` (as migrations antes, do mesmo jeito,
  environment `production` com aprovação, conferência da convergência) e roda
  o `semantic-release`. _Run workflow_ com `image_tag=sha-<sha>` = rollback.
- Sem os secrets do Dokploy, os jobs movem as tags e pulam o deploy com
  aviso.
- Staging e produção rodam no Dokploy (Docker Swarm), sem Compose nem
  template: em cada environment, o projeto `trajetto-api` tem as Applications
  `trajetto-api` (2 réplicas, com domínio), `trajetto-api-migrate` (as
  migrations e os seeds; parada depois da etapa) e `trajetto-ai` (provider
  Docker, imagem do GHCR, sem domínio) e os Databases PostgreSQL e Redis do Dokploy, todos na rede `dokploy-network` (um serviço acha o outro
  pelo App Name). Imagem, variáveis, domínio, réplicas, limites e healthcheck
  são configurados no painel; o passo a passo e as lacunas em relação ao
  antigo compose estão em `docs/deploy.md`.
- Backup do banco: **só** o Backup do próprio Database PostgreSQL no Dokploy
  (aba _Backups_, destino S3 no Cloudflare R2, diário, 30 cópias). Não há
  serviço nem imagem de backup no repositório; `infra/scripts/backup-postgres.sh`
  e `restore-postgres.sh` são só para dump manual e ensaio.
- As garantias do pipeline são guardadas por testes em
  `tests/unitaires/lifecycle/` (`promote-workflow`, `release-migrations`,
  `dokploy-release`, `migrate-source`, `compose-rollout-verify`,
  `supply-chain`, `secrets-hygiene`, `dokploy-deploy`). Se um deles falhar depois de uma mudança em
  workflow/script, a mudança provavelmente quebrou uma garantia: entenda antes
  de ajustar o teste.
- O deploy chama a API do Dokploy por `.github/scripts/dokploy-deploy.mjs`
  (`application.deploy` com a chave de API e o id de cada Application, na
  ordem IA → API); a web usa o mesmo script, numa cópia
  idêntica (um teste da web compara as duas), e repete até 6 vezes, com
  espera crescente (20 → 160 s), um deploy que termina em erro, registrando
  o motivo que o Dokploy deu.
- Entre repositórios: a ordem do primeiro deploy (bancos → IA → migrations →
  API → backup do banco → web → app), a ordem de cada release (**API → web → app**) e os valores que
  precisam casar com a web e o app (`HTTP_REQUEST` = origem da web,
  `RATE_LIMIT_FORWARDER_SECRET`, `TURNSTILE_SECRET_KEY`, R2) estão em
  `docs/deploy.md`, seção "Os três repositórios juntos", igual nos três
  repositórios. Mudou ali, mude nos outros dois.

## Faça

- Leia o arquivo vizinho antes de escrever: o padrão local é a referência.
- Mantenha tudo multiempresa, idempotente e com `code` nos erros.
- Atualize a documentação (`docs/*.md`, README) no mesmo trabalho em que muda
  o comportamento que ela descreve.
- Rode `yarn prisma:generate && yarn typecheck` e os testes afetados antes de
  entregar.
- Prefira mudanças pequenas e verificadas, uma por vez.

## Não faça

- Não faça commit, push, stash, reset ou checkout por conta própria; só quando
  pedirem, e nunca de trabalho pela metade. Mensagens no estilo do histórico:
  `tipo(escopo): frase em pt-BR` (`feat`, `fix`, `perf`, `test`, `chore`…),
  que o `semantic-release` lê.
- Não rode lint nem build localmente.
- Não edite migrations aplicadas; não remova coluna/rota que a versão anterior
  ou o app em campo ainda usam.
- Não use npm (o lockfile é o `yarn.lock`); não fixe action por tag nem imagem
  base sem digest.
- Não coloque segredo em código, teste, fixture, log ou documentação (só nomes
  e como gerar).
- Não introduza broker, cache no Redis nem provedor externo de IA: são
  decisões registradas (ADRs 0001, 0002, 0010). A única exceção ao cache é
  `src/shared/cache/snapshot-cache.ts`: fotos curtas (5–60 s), que falham
  aberto, de leituras **da plataforma** que só o MASTER vê; nunca dado de
  empresa.
- Não exija Turnstile na API (quebraria o login do app); não ponha `TZ` no
  contêiner.
- Não crie Compose nem template no Dokploy para staging ou produção (decisão
  do dono, 22/10/2026): cada serviço é uma Application (provider Docker) ou um
  Database. O `compose.development.yaml` é só para desenvolvimento.

## Onde procurar quando…

| Situação                                                           | Onde                                                                           |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| uma rota responde 403/404 inesperado                               | `src/modules/middlewares/`, `src/config/permissions.ts`, o guard de tenant     |
| uma notificação não chegou                                         | `src/shared/notifications/`, `/health/dead-letter`, `docs/deploy.md` (alertas) |
| leitura de IA parada                                               | `src/shared/ai/`, serviço `trajetto-ai`, `/health/providers`                   |
| conta de dia errada                                                | `src/shared/time/business-day.ts`                                              |
| erro de conexão com o banco (503 + Retry-After, P1008, pool cheio) | `docs/arquitetura.md` (Conexão com o Postgres)                                 |
| migration falhou em produção (P3009)                               | `docs/deploy.md` (Migrations)                                                  |
| variável nova ou desconhecida                                      | `docs/variaveis-de-ambiente.md`, `src/schemas/env-schema/index.ts`             |
| o deploy não convergiu                                             | `docs/deploy.md` (Conferir a convergência, Rollback)                           |
