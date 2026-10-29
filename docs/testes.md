# Testes da API

> Como os testes estão organizados, como rodar cada suíte, o que cada uma
> prova e as regras para escrever um teste novo. Vale para quem chega agora ao
> repositório — pessoa ou agente — e precisa saber o que rodar antes de dizer
> "pronto". O que o pipeline roda em cada etapa está em
> [`deploy.md`](./deploy.md#3-os-workflows-em-detalhe).

## Sumário

- [As suítes](#as-suítes)
- [Comandos](#comandos)
- [Unitários (`tests/unitaires`)](#unitários-testsunitaires)
- [E2E (`tests/E2E`)](#e2e-testse2e)
- [Contrato de repositórios (`tests/contract`)](#contrato-de-repositórios-testscontract)
- [Serviço de IA (`infra/ai-ocr` e `tests/ai-local`)](#serviço-de-ia-infraai-ocr-e-testsai-local)
- [Carga, estresse, soak e multi-réplica (`tests/load`)](#carga-estresse-soak-e-multi-réplica-testsload)
- [Cobertura](#cobertura)
- [Mutação](#mutação)
- [Os guardas do pipeline e da infraestrutura](#os-guardas-do-pipeline-e-da-infraestrutura)
- [O que roda onde (local × CI)](#o-que-roda-onde-local--ci)
- [Regras para escrever testes](#regras-para-escrever-testes)
- [Windows](#windows)
- [Suítes dos outros repositórios que dependem da API](#suítes-dos-outros-repositórios-que-dependem-da-api)

## As suítes

| Suíte                    | Onde                              | Como rodar                                           | Precisa de                                                                                                                     | Prova                                                                                                                |
| ------------------------ | --------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Unitários                | `tests/unitaires` (~480 arquivos) | `yarn test`                                          | Node; um Redis em `REDIS_URL` para `socket/adapter-channel-isolation.test.ts` (alguns arquivos sobem a API inteira em memória) | regras de negócio com os gêmeos in-memory, schemas, contratos de rota/OpenAPI, workflows e scripts de infra          |
| E2E                      | `tests/E2E` (~290 arquivos)       | `yarn test:e2e`                                      | Postgres 16 e Redis 7 reais                                                                                                    | HTTP de ponta a ponta, SQL real, autorização e isolamento entre empresas, planos de consulta, filas, crons, réplicas |
| Contrato de repositórios | `tests/contract`                  | junto com o E2E (os `*-repository-contract.test.ts`) | Postgres                                                                                                                       | o gêmeo in-memory e o repositório Prisma respondem igual                                                             |
| Serviço de IA (Python)   | `infra/ai-ocr/tests`              | `docker build --target test infra/ai-ocr`            | Docker                                                                                                                         | o servidor de OCR, dentro da imagem que vai para produção                                                            |
| Contrato com a IA real   | `tests/ai-local`                  | `AI_LOCAL_E2E=1 npx vitest run tests/ai-local`       | Docker, ~1 GiB                                                                                                                 | o leitor e as regras da API contra o contêiner `trajetto-ai` de verdade                                              |
| Carga                    | `tests/load`                      | ver `tests/load/README.md`                           | Docker e k6                                                                                                                    | capacidade por réplica, gargalos, multi-réplica, injeção de falha                                                    |
| Mutação                  | `stryker.config.mjs`              | `yarn test:mutation`                                 | Postgres e Redis de teste                                                                                                      | que os testes das regras críticas matam mutantes                                                                     |

Tudo com Vitest 1.6 (`vite.config.mts`): `setupTests.ts` carrega o
`reflect-metadata`; arquivos em `tests/E2E/**` usam o ambiente
`prisma` (um banco por arquivo) e o pool `forks` (um processo por arquivo —
o engine nativo do Prisma 6 entrava em pânico quando vários arquivos dividiam
um processo; o Prisma 7 não tem engine nativo, e o `forks` segue até que
`threads` seja medido). Todo `PrismaClient` dos testes nasce em
`createPrismaClient` (`src/shared/database/database-client.ts`), o mesmo
caminho da aplicação: o Prisma 7 exige o driver adapter.

## Comandos

| Comando                        | O que faz                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `yarn test`                    | unitários (`vitest run --dir tests/unitaires`)                                                             |
| `yarn test:watch`              | unitários em modo watch                                                                                    |
| `yarn test:e2e`                | E2E (`vitest run --dir ./tests/E2E`)                                                                       |
| `yarn test:e2e:watch`          | E2E em modo watch                                                                                          |
| `yarn test:coverage`           | unitários com cobertura e **piso** (`coverage/unit`)                                                       |
| `yarn test:coverage:e2e`       | cobertura do E2E em lotes de 8, juntada com a unitária em `coverage/all` (`infra/scripts/coverage-e2e.sh`) |
| `yarn test:mutation`           | Stryker nas regras críticas (`MUTATION_BATCH=guards\|states\|outbox\|lists`)                               |
| `yarn test:ui`                 | interface do Vitest                                                                                        |
| `yarn typecheck`               | `tsc --noEmit` (gere o client antes: `yarn prisma:generate`)                                               |
| `yarn validate`                | `prisma:generate`, `typecheck` e `test`                                                                    |
| `npx vitest run <arquivo>`     | um arquivo só (unitário ou E2E)                                                                            |
| `npx vitest run -t "<título>"` | só os testes com aquele título                                                                             |

O lint (`yarn lint:check`, Prettier) e o build (`yarn build`) rodam no CI.

## Unitários (`tests/unitaires`)

Uma pasta por domínio (`delivery/`, `route/`, `chat/`, `fuel/`…) e pastas
transversais:

| Pasta                                            | O que guarda                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract/`                                      | contratos com os clientes: rotas que a web e o app chamam (`client-routes`, lê `../trajetto-ui` e `../trajetto-mobile` quando existem), rotas aposentadas (`retired-routes`, compara com `origin/main`), corpos do outbox do app (`outbox-body-contract`, fixtures `mobile-outbox-v1`/`-v2`), OpenAPI, NDJSON, exemplos de resposta, classes de erro, defaults dos gêmeos in-memory |
| `lifecycle/`                                     | infra executada de verdade: workflows (`promote-workflow`, `staging-deploy-workflow`, `supply-chain`, `secrets-hygiene`, `compose-ci-siblings`), imagens (`image-layers`, `image-scan`), scripts (`release-migrations`, `compose-rollout-verify`, `backup-scripts`, `dokploy-deploy`, `wait-for-version`), migrations (`migration-safety`), boot e workers                          |
| `security/`                                      | JWT, 2FA, mensagens de unicidade, `.env.example` contra o schema                                                                                                                                                                                                                                                                                                                    |
| `integration/`                                   | API pública, portal de documentação, webhooks                                                                                                                                                                                                                                                                                                                                       |
| `env/`                                           | o env-schema e a URL do banco de teste                                                                                                                                                                                                                                                                                                                                              |
| `quality/`                                       | a configuração de cobertura                                                                                                                                                                                                                                                                                                                                                         |
| `time/`                                          | dia de negócio; varre `src/` atrás de conta de dia com o relógio do servidor                                                                                                                                                                                                                                                                                                        |
| `health/`, `logging/`, `socket/`, `resilience/`… | o resto do que atravessa domínios                                                                                                                                                                                                                                                                                                                                                   |

Os testes de usecase usam os gêmeos in-memory (`repositories/in-memory/`), que
precisam ter a mesma semântica do Prisma (filtros, ordem, nulos, unicidade,
empresa). Os testes que sobem a API (`import("@/http")` + `app.ready()`) usam
o orçamento `APP_BOOT_TIMEOUT_MS` de `tests/support/app-boot.ts` (120 s:
carregar o grafo inteiro leva ~14 s por arquivo, mais com a máquina ocupada).

Os testes de script (`tests/unitaires/lifecycle/support/shell-harness.ts`)
rodam os `.sh` do repositório e os blocos `run:` dos workflows de verdade, com
os comandos externos (`docker`, `gh`, `git`, `pg_dump`, `rclone`…) trocados por
stubs que registram cada chamada. Sem `bash`/`sh` utilizável, eles se pulam em
vez de falhar.

## E2E (`tests/E2E`)

O ambiente `prisma/vitest-environment-prisma` cria **um banco por arquivo de
teste** no servidor apontado por `TEST_DATABASE_URL` (ou `DATABASE_URL`),
aplica todas as migrations e o apaga no fim. Um banco por arquivo, e não um
schema, porque a extensão `pg_trgm` é por banco. Aponte para um Postgres
descartável, nunca para o de desenvolvimento:

```bash
# Postgres e Redis descartáveis (portas próprias para não colidir com o dev)
docker run -d --name trajetto-test-pg -p 127.0.0.1:54321:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=trajetto postgres:16-alpine \
  -c max_connections=200
docker run -d --name trajetto-test-redis -p 127.0.0.1:63790:6379 redis:7-alpine

DATABASE_URL="postgresql://postgres:postgres@localhost:54321/trajetto?schema=public" \
REDIS_URL="redis://localhost:63790" \
  npx vitest run tests/E2E/delivery-export-http.test.ts
```

O `max_connections=200` não é enfeite: `health-metrics.test.ts` exige um
valor fora do padrão (100), senão um painel com 100 fixo passaria. No CI
(`deploy.yml`) o contêiner de serviço não aceita comando, e um passo aplica o
mesmo valor com `ALTER SYSTEM` e reinicia o contêiner. O `socket.io-client`
dos testes de socket é devDependency da API (mesma versão da web): basta o
`yarn install` daqui.

O padrão de um E2E HTTP: um `PrismaClient` próprio semeia empresas,
usuários e dados com ids fixos; `import("@/http")` sobe a API; tokens são
assinados com a chave de teste; as requisições passam pela pilha real
(guards, schemas, repositórios, SQL). Famílias que vale conhecer:

| Família                   | Exemplos                                                                                                          | Prova                                                                                                                                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolamento entre empresas | `cross-tenant-*.test.ts`, `security-idor-sweep.test.ts`, `record-company-move-sweep.test.ts`                      | id de outra empresa = 404; campo de empresa no corpo recusado; varredura de todas as rotas (`IDOR_SWEEP_REPORT=<arquivo>` grava o relatório; `COMPANY_MOVE_TRACE=1` imprime cada par) |
| HTTP por domínio          | `*-http.test.ts`                                                                                                  | contrato de cada rota contra o banco real                                                                                                                                             |
| Contrato de repositório   | `*-repository-contract.test.ts`                                                                                   | Prisma × in-memory (`tests/contract`)                                                                                                                                                 |
| Planos de consulta        | `query-plans-*.test.ts`, `dashboard-counts-index-ranges.test.ts`                                                  | as consultas quentes usam os índices certos em volume                                                                                                                                 |
| Filas, pipelines, crons   | `ai-pipeline-*.test.ts`, `cron-*.test.ts`, `outbox*`, `notification*`                                             | lease, retentativa, catch-up, uma execução por horário                                                                                                                                |
| Resiliência               | `runtime-database-dead-peer.test.ts`, `database-reconnect.test.ts`, `readiness-*.test.ts`, `resilience-*.test.ts` | par silencioso, reconexão, readiness; os de contêiner só com `RESILIENCE_DOCKER=1` (`RESILIENCE_REPLICAS` escolhe as contagens)                                                       |
| Réplicas                  | `multi-replica-events.test.ts`                                                                                    | um evento emitido numa réplica chega ao socket conectado em outra, pelo Redis                                                                                                         |
| Expandir/contrair         | `schema-expand-contract.test.ts`                                                                                  | a versão anterior continua funcionando sobre o schema novo                                                                                                                            |
| Upload                    | `upload-storage-roundtrip.test.ts`                                                                                | o caminho do presign num S3 compatível: só com `MINIO_TEST_*` (`bash tests/support/minio/minio-test.sh start` e `env`); `REQUIRE_MINIO=1` faz a ausência falhar                       |
| App antigo                | `legacy-multipart-uploads.test.ts`                                                                                | o adaptador multipart temporário                                                                                                                                                      |

## Contrato de repositórios (`tests/contract`)

`tests/contract/repositories/` tem uma suíte por repositório que roda contra
as duas implementações: os `*-repository-contract.test.ts` do E2E a executam
com o Prisma (banco real) e com o gêmeo in-memory. Uma diferença de semântica
(ordem de empate, nulos, `ILIKE` com curinga, unicidade por empresa) aparece
como falha aqui, antes de virar um teste unitário verde validando a regra
errada.

## Serviço de IA (`infra/ai-ocr` e `tests/ai-local`)

- **Pytest dentro da imagem**: `docker build --target test infra/ai-ocr`. O
  stage `test` parte da mesma base do `runtime` (rodas com hash, modelos
  conferidos por SHA-256) e roda como o usuário 10001. Roda no `ci.yml` e no
  `deploy.yml`.
- **Contrato com o contêiner real** (opt-in):
  `AI_LOCAL_E2E=1 npx vitest run tests/ai-local`. Constrói `infra/ai-ocr` (ou
  usa `AI_LOCAL_E2E_IMAGE`), sobe como na produção (só leitura, sem
  capabilities, 2 CPUs, 1 GiB, `AI_MAX_QUEUE=0`) e passa seis fotos sintéticas
  do benchmark pelo `LocalOcrReader` e pelas regras da API. No CI, só por _Run
  workflow_ do `ci.yml` (job `ai-local-e2e`).
- O benchmark de precisão e latência está em `scripts/ai-benchmark/`.

## Carga, estresse, soak e multi-réplica (`tests/load`)

O harness `tests/load/compose.load.yaml` reproduz a produção numa máquina:
Traefik v3 (com o health check de readiness que a produção tinha até as
Applications do Dokploy; ver [`deploy.md`](./deploy.md#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)), N réplicas da imagem real
(`LOAD_REPLICAS`), Postgres 16 e Redis 7 descartáveis e k6 na mesma rede.
Cenas: `smoke.js` (sempre primeiro: prova que as outras medem algo real),
`load.js`, `spike.js`, `stress.js`, `soak.js`; mais `multi-replica.sh`,
`failure-injection.sh`, `socket-hold.mjs` e `socket-across-replicas.mjs`. O
`seed.ts` prepara o banco `load_test` (empresas, motoristas, histórico) e os
`mint-*.ts` criam as contas das suítes de navegador da web e do app. Medido em
07/10/2026 com a imagem de produção: o joelho é ~110–120 req/s por réplica com
histórico. Tudo em `tests/load/README.md`.

## Cobertura

Medida honestamente (decisão 13.1; `vite.config.mts`): provider v8, `all: true`
sobre `src/**/*.ts` (um módulo sem teste aparece com 0 %, não some do total),
sem excluir código de produto (o teste `quality/coverage-config.test.ts` barra
qualquer `exclude` em `src/`), `reportOnFailure: true`.

- **Piso** (no script `test:coverage`, conferido por
  `lifecycle/compose-package-scripts.test.ts`): statements e linhas 70,8 %,
  branches 82,57 %, funções 57,62 % — a linha de base medida no unitário
  (71,80 / 83,57 / 58,62) menos um ponto, para um arquivo de teste novo nunca
  falhar o CI e um apagado falhar.
- O CI publica o relatório `coverage-<sha>` (14 dias) no `ci.yml` e no
  `deploy.yml`; abaixo do piso, nenhuma imagem é construída.
- **E2E**: `yarn test:coverage:e2e` roda em lotes de 8 arquivos (cada lote
  escreve `coverage/e2e/NN`; um lote que morre sem relatório é refeito em duas
  metades) e junta tudo em `coverage/e2e-only` e, com a unitária, em
  `coverage/all`. Rode numa árvore parada: o script recusa juntar se `src/`
  mudou durante os lotes.

## Mutação

Stryker 8.7 com o runner do Vitest (`stryker.config.mjs`,
`vitest.mutation.config.mts`; decisão 13.5) sobre as regras críticas, em
quatro lotes:

| Lote     | O que muta                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `guards` | middlewares de autorização e tenant, entitlements, acesso ao chat, lockout de login, 2FA, chaves de API |
| `states` | máquinas de estado de entrega, rota, dia de operação, ticket e pausas                                   |
| `outbox` | chaves de idempotência e de submissão, outbox, regras do pipeline e do dispatcher de webhooks           |
| `lists`  | parsing de listagem, paginação e dia de negócio                                                         |

`MUTATION_BATCH=<lote> yarn test:mutation` roda um lote (~45 min num host de
16 threads; relatório em `reports/mutation/<lote>`). Para um arquivo só:
`MUTATION_TESTS=<globs> yarn test:mutation --mutate <arquivo>`. Só a suíte
unitária entra (o E2E não roda num processo só); parte dela toca o Postgres e
o Redis de teste.

## Os guardas do pipeline e da infraestrutura

Testes unitários que protegem decisões de deploy — se um deles falhar depois
de mudar um workflow ou um script, a mudança provavelmente quebrou
uma garantia:

| Teste                                       | Guarda                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle/promote-workflow.test.ts`        | build só no `staging` (push ou _Run workflow_ lá); tags só `sha-<sha>` (e `src-<hash>` na IA); PR para `main` exige o marcador `staged-<sha>`; a promoção só a partir de `main`, resolve o 2º pai do merge, valida a tag antes de tudo, nunca constrói, move `stable` por digest antes do deploy; deploy pulado com aviso sem os secrets do Dokploy e falha com configuração parcial; `environment: production` |
| `lifecycle/release-migrations.test.ts`      | o job de migrations só aceita `trajetto-api:sha-<sha>`/`main-<sha>`, roda uma vez, sem healthcheck, e o workflow o chama antes de `stable`                                                                                                                                                                                                                                                                      |
| `lifecycle/compose-rollout-verify.test.ts`  | a conferência da convergência (script e posição nos workflows da API e da web); exatamente uma conferência por valor de `ROLLOUT_VERIFY` (liveness pública por padrão no staging, SSH na produção, nenhuma só com `off`); um deploy por vez; staging só pelo head da branch                                                                                                                                     |
| `lifecycle/supply-chain.test.ts`            | actions por SHA, bases por digest, audit, SBOM/proveniência, Trivy                                                                                                                                                                                                                                                                                                                                              |
| `lifecycle/secrets-hygiene.test.ts`         | gitleaks igual no `ci.yml` e no `deploy.yml`; nenhum build antes dele; `.env*` fora do git                                                                                                                                                                                                                                                                                                                      |
| `lifecycle/compose-ci-siblings.test.ts`     | o checkout dos repositórios irmãos na mesma branch                                                                                                                                                                                                                                                                                                                                                              |
| `lifecycle/migration-safety.test.ts`        | expandir/contrair nas migrations novas                                                                                                                                                                                                                                                                                                                                                                          |
| `lifecycle/dokploy-deploy.test.ts`          | o script de deploy contra um Dokploy falso (`application.deploy` de uma Application por chamada; segue o deployment criado; repete o que termina em erro até 6 vezes com espera dobrando até o teto; escreve o motivo do Dokploy sem credenciais; id opcional vira aviso; nunca imprime a chave)                                                                                                                |
| `lifecycle/staging-deploy-workflow.test.ts` | os passos do staging e da promoção executados com o GHCR simulado: a IA reaproveitada pelo hash de `infra/ai-ocr` e reimplantada só quando o digest muda (ou com `force_ai_build`); cada tag `staging` movida logo antes do próprio deploy e devolvida quando o deploy falha; o marcador `staged-<sha>` escrito por último e exigido pelo PR e pela promoção no mesmo digest                                    |
| `lifecycle/wait-for-version.test.ts`        | a conferência pela liveness pública contra uma API falsa: passa só depois de o commit novo responder pela janela inteira, recomeça a janela quando uma réplica antiga responde, aceita o `sha-<7>` da promoção, recusa build sem commit; a janela é maior que o monitor de rollback do Swarm                                                                                                                    |
| `lifecycle/image-layers.test.ts`            | as camadas das imagens: um arquivo de requisitos com hash por camada, na ordem em que mudam, cada pacote num só; os modelos da IA num stage próprio e copiados com `COPY --link`; o commit (`GIT_SHA`) declarado depois do último `RUN`; o `prisma generate` antes do `COPY . .`                                                                                                                                |
| `security/env-example.test.ts`              | o `.env.example` tem toda variável do env-schema                                                                                                                                                                                                                                                                                                                                                                |
| `quality/coverage-config.test.ts`           | a configuração de cobertura e o piso no CI                                                                                                                                                                                                                                                                                                                                                                      |

## O que roda onde (local × CI)

|                               | Local (antes de dizer "pronto")                    | `ci.yml` (branch)  | `deploy.yml` (staging e PR para `main`) |
| ----------------------------- | -------------------------------------------------- | ------------------ | --------------------------------------- |
| typecheck                     | `yarn prisma:generate && yarn typecheck`           | sim                | sim                                     |
| unitários + piso              | `yarn test` (ou o arquivo tocado)                  | sim, com cobertura | sim, com cobertura                      |
| E2E                           | os arquivos tocados, contra o Postgres descartável | não                | **sim**, a suíte inteira                |
| lint, build                   | ficam com o CI                                     | lint               | lint (o build é o da imagem)            |
| audit, gitleaks, pytest da IA | —                                                  | sim                | sim                                     |
| contrato com a IA real        | opt-in                                             | só _Run workflow_  | não                                     |
| carga, mutação                | sob demanda                                        | não                | não                                     |

## Regras para escrever testes

1. **Títulos em inglês**, no presente, dizendo o comportamento
   (`it("refuses a delivery of another company with 404", …)`). Comentários de
   código também em inglês; mensagens de erro do produto em pt-BR.
2. **Vermelho antes de verde.** Escreva o teste que falha pelo motivo certo,
   veja falhar, e só então corrija. Um teste que nunca falhou não prova nada.
3. **Pelo caminho real.** A rota pela pilha inteira (guards, schema, usecase,
   repositório, SQL) em vez de chamar o usecase com dublês, quando a regra
   depende de autorização, tenant ou SQL; o script `.sh` executado (com
   stubs), não lido como texto; o bloco `run:` do workflow extraído e rodado.
   Mock só na fronteira com o mundo de fora (Meta, Resend, Expo, R2, IA).
4. **Isolamento entre empresas em todo recurso novo**: um caso com id de outra
   empresa (404) e um com campo de empresa no corpo (recusado).
5. **Gêmeos in-memory com a semântica do Prisma.** Mudou o repositório Prisma?
   Mude o gêmeo e o contrato de repositório no mesmo commit.
6. **Contratos com os clientes não se ajustam ao código.** Se
   `outbox-body-contract` falha, a correção é no servidor. Rota removida entra
   em `retired-routes.ts`.
7. **Datas pelo dia de negócio** (`business-day.ts`), nunca `setHours` no
   relógio do servidor; datas `@db.Date` como `YYYY-MM-DD`.
8. **Nada de dados reais nem segredos** em fixtures. Senhas e tokens de teste
   ficam em `tests/` (o gitleaks silencia só a regra genérica ali); uma chave
   de provedor de verdade falha o job.
9. **Um teste por garantia, com o porquê.** O bloco de comentário no topo de
   cada arquivo conta o incidente ou a decisão que o teste protege; mantenha
   esse hábito.
10. Não aumente o orçamento de tempo de um teste para fazê-lo passar numa
    máquina ocupada sem entender o motivo; o boot da API já tem o seu.

## Windows

- **E2E em lotes de no máximo 8 arquivos.** Com o Prisma 6, 12 ou mais
  arquivos na mesma execução derrubavam o query engine com um _napi panic_
  ("failed to delete napi ref", exit 127/139). O Prisma 7 não tem engine
  nativo; o limite fica até que lotes maiores sejam medidos. O
  `yarn test:coverage:e2e` já executa em lotes.
- Os testes de script precisam de um `bash`/`sh` que leia caminhos `C:/...`
  (o Git Bash serve; um `bash` que resolve para o WSL faz esses testes se
  pularem).
- Line endings: os scripts copiados para as imagens são normalizados no
  `Dockerfile` (`sed -i "s/\r$//"`), mas os testes de script rodam o arquivo
  do disco — mantenha `LF` nos `.sh` (`.gitattributes`).

## Suítes dos outros repositórios que dependem da API

- **Web (Playwright)**: `trajetto-ui/tests/ui`, `tests/a11y` e
  `tests/responsive` rodam contra esta API com o banco `load_test` semeado
  por `tests/load/seed.ts`, `mint-master.ts` e `mint-browser-users.ts`
  (senha `WEB_E2E_PASSWORD`). A CI noturna da web
  (`trajetto-ui/.github/workflows/browser-suites.yml`) roda os três nessa
  ordem. Detalhes em `trajetto-ui/docs/testes.md`.
- **App (Maestro)**: a suíte do app (`trajetto-mobile/docs/testes.md`) entra
  com as contas que o `seed.ts` cria com `LOAD_MOBILE_E2E=1`
  (`MOBILE_E2E_EMAIL`, `MOBILE_E2E_PASSWORD`, `MOBILE_E2E_TWOFA_EMAIL`,
  `MOBILE_E2E_NOFLEET_EMAIL`).
- **Contrato de rotas**: `tests/unitaires/contract/client-routes.test.ts` lê
  as URLs que a web e o app constroem (`../trajetto-ui`, `../trajetto-mobile`)
  e falha se alguma não existir na API.
