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
| E2E                      | `tests/E2E` (~300 arquivos)       | `yarn test:e2e` (duas fases)                         | Postgres 16 e Redis 7 reais                                                                                                    | HTTP de ponta a ponta, SQL real, autorização e isolamento entre empresas, planos de consulta, filas, crons, réplicas |
| Contrato de repositórios | `tests/contract`                  | junto com o E2E (os `*-repository-contract.test.ts`) | Postgres                                                                                                                       | o gêmeo in-memory e o repositório Prisma respondem igual                                                             |
| Serviço de IA (Python)   | `infra/ai-ocr/tests`              | `docker build --target test infra/ai-ocr`            | Docker                                                                                                                         | o servidor de OCR, dentro da imagem que vai para produção                                                            |
| Contrato com a IA real   | `tests/ai-local`                  | `AI_LOCAL_E2E=1 npx vitest run tests/ai-local`       | Docker, ~1 GiB                                                                                                                 | o leitor e as regras da API contra o contêiner `trajetto-ai` de verdade                                              |
| Carga                    | `tests/load`                      | ver `tests/load/README.md`                           | Docker e k6                                                                                                                    | capacidade por réplica, gargalos, multi-réplica, injeção de falha                                                    |
| Mutação                  | `stryker.config.mjs`              | `yarn test:mutation`                                 | Postgres e Redis de teste                                                                                                      | que os testes das regras críticas matam mutantes                                                                     |

Tudo com Vitest 1.6 (`vite.config.mts`): `setupTests.ts` carrega o
`reflect-metadata` e instala a trava de rede (abaixo,
[Nenhuma rede de fora](#nenhuma-rede-de-fora)); arquivos em `tests/E2E/**` usam o ambiente
`prisma` (um banco por arquivo). Todo arquivo, unitário ou E2E, roda no pool
`forks` (um processo por arquivo). Com o pool `threads` (um processo, uma
thread por arquivo), a rodada inteira morria sem mensagem nenhuma, com exit
127: o E2E no Prisma 6 (o engine nativo entrava em pânico quando vários
arquivos dividiam um processo) e, em 30/10/2026, a suíte unitária no
Windows, 3 rodadas em 10, cada uma registrada pelo Windows como corrupção de
heap do `node.exe` (0xc0000374). Com `forks`: 0 em 8, no mesmo tempo. Todo `PrismaClient` dos testes nasce em
`createPrismaClient` (`src/shared/database/database-client.ts`), o mesmo
caminho da aplicação: o Prisma 7 exige o driver adapter.

## Comandos

| Comando                        | O que faz                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `yarn test`                    | unitários (`vitest run --dir tests/unitaires`)                                                             |
| `yarn test:watch`              | unitários em modo watch                                                                                    |
| `yarn test:e2e`                | E2E em duas fases (`infra/scripts/run-e2e.mjs`): o resto em paralelo, depois as réplicas, um por vez       |
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

**Depois de puxar uma mudança em `prisma/vitest-environment-prisma`** (como a
do Prisma 7), rode `yarn install --force`. O ambiente do E2E é uma dependência
`file:` que o Yarn 1 copia para `node_modules` e não recopia num
`yarn install` comum; sem o `--force`, o E2E roda a cópia antiga (no Prisma 7,
todo arquivo cai com `Unknown property datasources provided to PrismaClient
constructor`). O CI e a imagem instalam do zero e não precisam disso.

## Unitários (`tests/unitaires`)

Uma pasta por domínio (`delivery/`, `route/`, `chat/`, `fuel/`…) e pastas
transversais:

| Pasta                                            | O que guarda                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract/`                                      | contratos com os clientes: rotas que a web e o app chamam (`client-routes`, lê `../trajetto-ui` e `../trajetto-mobile` quando existem), rotas aposentadas (`retired-routes`, compara com `origin/main`), corpos do outbox do app (`outbox-body-contract`, fixtures `mobile-outbox-v1`/`-v2`), OpenAPI, NDJSON, exemplos de resposta, classes de erro, defaults dos gêmeos in-memory                                                                          |
| `lifecycle/`                                     | infra executada de verdade: workflows (`promote-workflow`, `staging-deploy-workflow`, `supply-chain`, `secrets-hygiene`, `compose-ci-siblings`, `ci-stability`), imagens (`image-layers`, `image-scan`), scripts (`release-migrations`, `dokploy-release`, `migrate-source`, `compose-rollout-verify`, `backup-scripts`, `dokploy-deploy`, `wait-for-version`, `ghcr-script`, `staged-build`, `audit-gate`), migrations (`migration-safety`), boot e workers |
| `security/`                                      | JWT, 2FA, mensagens de unicidade, `.env.example` contra o schema                                                                                                                                                                                                                                                                                                                                                                                             |
| `integration/`                                   | API pública, portal de documentação, webhooks                                                                                                                                                                                                                                                                                                                                                                                                                |
| `env/`                                           | o env-schema e a URL do banco de teste                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `quality/`                                       | a configuração de cobertura                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `time/`                                          | dia de negócio; varre `src/` atrás de conta de dia com o relógio do servidor                                                                                                                                                                                                                                                                                                                                                                                 |
| `health/`, `logging/`, `socket/`, `resilience/`… | o resto do que atravessa domínios                                                                                                                                                                                                                                                                                                                                                                                                                            |

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

### As duas fases do `yarn test:e2e`

Os arquivos que sobem réplicas inteiras da API como processos próprios
(`pipeline-replica-process.ts`, `replica-process.ts`) estão listados em
`tests/E2E/support/replica-files.ts`. O Vitest conta um processo por arquivo;
uma réplica é mais um, dois ou três que ele não vê. Rodando ao lado do resto
num runner de 2 ou 4 vCPU (o GitHub dá 2 vCPU a repositório privado e 4 a
público), eles amplificavam a carga sobre todo teste que depende de tempo.
Por isso o `yarn test:e2e` roda em duas fases, escolhidas pela variável
`E2E_PHASE` no `vite.config.mts`:

1. `shared`: todos os outros arquivos, em paralelo;
2. `replicas`: os da lista, **um arquivo por vez**, depois da primeira fase.

A segunda fase roda mesmo se a primeira falhou (um run do CI mostra todas as
falhas), e o código de saída é o primeiro diferente de zero. Os argumentos vão
para as duas fases (o CI passa `--run --reporter=basic`). Com um filtro
(`yarn test:e2e route`), a fase que não tiver arquivo correspondente passa
vazia; sem filtro, uma fase sem arquivo falha. Para um arquivo só, continue com
`npx vitest run tests/E2E/<arquivo>.test.ts` (sem `E2E_PHASE`, tudo entra
como antes). `quality/e2e-replica-isolation.test.ts` falha se um arquivo que
sobe réplicas ficar fora da lista ou se a lista citar um que não sobe mais.

### Nenhuma rede de fora

Decisão D7 da auditoria do CI (30/10/2026): um pipeline só pode falhar por
defeito do código, e um teste que fala com um terceiro falha quando o
terceiro falha. O `setupTests.ts` instala
`tests/support/outbound-network-guard.ts` em todo arquivo (unitário e E2E):
toda conexão TCP vai para o loopback ou para os hosts de `DATABASE_URL`,
`TEST_DATABASE_URL`, `REDIS_URL`, `REDIS_HOST`, `AI_LOCAL_URL` e
`MINIO_TEST_ENDPOINT`; qualquer outra
é recusada antes de resolver o nome (quando quem conecta traz a própria
resolução, como o cliente de webhooks, vale o endereço que ela devolve;
`ECONNREFUSED` com a explicação), e o
arquivo **falha no fim** com a lista, mesmo quando a conexão era "dispare e
esqueça" e nenhuma asserção perceberia. As réplicas que um teste sobe não
carregam a trava: apontam cada provedor para o falso local do teste
(`pipeline-replica.ts`).

O caso que motivou a trava foi o e-mail: com `NODE_ENV=test`, a API mandava
tudo pelo Ethereal (uma conta criada em `api.nodemailer.com` e uma sessão SMTP
com `smtp.ethereal.email` a cada run). Agora, com `NODE_ENV=test`, o
`MailProvider` é a caixa em memória do processo
(`src/shared/providers/mail-provider/implementations/test-inbox-mail-provider.ts`):
renderiza o template como os provedores reais e não envia nada. Ela só existe
com `NODE_ENV=test`, conferido duas vezes no construtor: o `NODE_ENV` do
ambiente (lido em tempo de execução, então um `NODE_ENV=test` posto numa
Application passaria sozinho) e o do build (a expressão `process.env.NODE_ENV`
escrita por extenso, que o tsup troca por `"production"` na imagem). Numa
imagem ela nunca liga, diga o contêiner o que disser.
`mail/mail-provider-for.test.ts` prova a escolha (produção → Resend,
desenvolvimento → Ethereal, teste → caixa em memória) e as duas travas. O
Turnstile da API fica desligado sem `TURNSTILE_SECRET_KEY`, o WhatsApp sem
`META_WHATSAPP_*`, e o push só sai para tokens que o teste cadastra (com o
cliente da Expo trocado por um falso).

### Esperar por estado, nunca por tempo

Um `setTimeout` fixo esperando o servidor "terminar" é chute: numa máquina
carregada o caso positivo lê como "nunca chegou" e o negativo passa pelo
motivo errado. As ferramentas:

- **Salas do Socket.IO** (`tests/E2E/support/socket-waits.ts`):
  `waitForRoom(io, socketId, sala, dentro)` lê o índice de salas do próprio
  servidor; `emitHandled(socket, evento, payload)` espera o
  _acknowledgement_ vazio de `operationsSubscribe`/`chatSubscribe` (tratado,
  sem dizer o veredito); `waitForDisconnect`; `waitUntil` para o resto. Numa
  réplica de outro processo, `replica.waitForRoom(...)` pergunta à réplica
  (`MEMBERS`, em `socket-replica.ts`).
- **Pipeline de notificações**: chamar `runOutboxCycle()`/`runDeliveryCycle()`
  com um ciclo já rodando entra nele e espera a passada extra (ver
  [`arquitetura.md`](./arquitetura.md), "Outbox, filas e efeitos externos").
  Num arquivo que dirige o pipeline à mão, segure o despertar automático
  (`vi.spyOn(pipeline, "wake").mockImplementation(() => undefined)`), como
  `route-stop-on-the-way.test.ts` e `notification-pipeline.test.ts`.
- **Réplicas do pipeline**: `startPipelineReplica({ expandFirst: true })`
  expande o outbox inteiro antes de as raias de entrega começarem, para um
  teste de lote não medir até onde a expansão chegou;
  `resilience-crash-after-accept.test.ts` mata a réplica só quando os 5 envios
  estão no provedor e as 20 entregas reivindicadas.
- **Estado que o produto grava em dois passos** (a falha do webhook na linha,
  depois no contador e no desligamento do endpoint): `vi.waitFor` com prazo,
  como `resilience-provider-outage.test.ts`.
- **Duração**: meça na própria linha (o backoff é `availableAt` menos
  `updated_at`, gravados no mesmo UPDATE) ou afirme a propriedade em vez do
  tempo (as sondas em paralelo de `health/provider-readiness.test.ts` seguram a
  resposta até a última começar; `delivery/proof-pdf-isolation.test.ts` espia
  o pdfkit e o zlib desta thread em vez de medir o travamento do event loop).

Uma janela negativa ("não pode chegar em N s") só vale depois de confirmado o
estado que torna a resposta certa (o socket na sala, o pedido tratado).

### O relógio do banco

As filas comparam o `now()` do Postgres com horários que o processo gravou
(`availableAt` vem do cliente do Prisma, e todo backoff é
`new Date(Date.now() + atraso)`). Com o banco atrasado, uma linha gravada
"agora" ainda não venceu para o claim, e o teste lê a linha intocada. Nos
runners Linux (o CI) o contêiner usa o relógio do próprio host e a diferença
é zero. No Docker Desktop a VM atrasa: segundos depois de a máquina dormir, e
dezenas de milissegundos numa rodada longa e pesada (medido em 30/10/2026:
21 a 43 ms atrás durante a fase das réplicas, zero de novo com a máquina
parada). O ambiente `prisma` mede antes de criar cada banco: com mais de 1 s
de diferença ele **recusa começar**; com mais de 20 ms atrás, escreve um aviso
no arquivo (um teste que reivindica uma linha logo depois de gravá-la pode
falhar ali sem defeito no código). Nos dois casos: `wsl --shutdown` (ou
reiniciar o Docker Desktop) e rodar de novo. Gravar `availableAt` pelo relógio
do banco (`@default(dbgenerated(...))`) foi avaliado e descartado: o
`prisma migrate diff` passa a apontar diferença para sempre nessas colunas.

### O padrão de um E2E HTTP

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
  stage `test` parte da mesma base do `runtime` (rodas com hash; os modelos
  conferidos por SHA-256 sem rede, o par PP-OCRv5 vindo de
  `infra/ai-ocr/models`) e roda como o usuário 10001. Roda no `ci.yml` e no
  `deploy.yml`, pelo Buildx com o cache do GitHub (um código que já passou
  leva segundos); o build só fala com o Docker Hub e o PyPI.
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
  metades) e, depois deles, os arquivos que sobem réplicas, um por lote (a
  mesma separação do `yarn test:e2e`); junta tudo em `coverage/e2e-only` e,
  com a unitária, em `coverage/all`. Rode numa árvore parada: o script recusa
  juntar se `src/` mudou durante os lotes.

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

| Teste                                                            | Guarda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lifecycle/promote-workflow.test.ts`                             | build só no `staging` (push ou _Run workflow_ lá); tags só `sha-<sha>` (e `src-<hash>` na IA); PR para `main` exige o marcador `staged-<sha>` (ou a regra de documentação, por `staged-build.sh`); a promoção só a partir de `main`, resolve o 2º pai do merge (repetindo a API do GitHub que falha), valida a tag antes de tudo, decide o build pelo marcador ou pela regra de documentação antes de qualquer outro passo, nunca constrói, move `stable` por digest antes do deploy; deploy pulado com aviso sem os secrets do Dokploy e falha com configuração parcial |
| `lifecycle/release-migrations.test.ts`                           | a etapa de release nos dois workflows: decide (o digest da imagem de migração contra `staging-applied`/`stable-applied`), move a tag do ambiente, roda pela Application `trajetto-api-migrate` e só depois grava `-applied`, tudo antes de a API ou a IA andar; as decisões executadas com o GHCR simulado (inclusive o build sem imagem de migração: pulado só se for anterior a ela); nada de `RUN_MIGRATIONS_ON_BOOT`, `MIGRATIONS_VIA_JOB` nem SSH                                                                                                                   |
| `lifecycle/dokploy-release.test.ts`                              | o `dokploy-release.mjs` contra um Dokploy falso: recusa uma Application mal configurada antes de qualquer deploy (imagem, _Restart Policy_ `none`, _Health Check_, réplicas, `stop-first`); só tarefas novas contam (a antiga ociosa segue `Running` depois de um rollback); `Running`/`Complete` = sucesso, `Failed`/`Rejected`/`Orphaned` = falha com o motivo do Swarm; prazo sem interromper a etapa; nunca imprime a chave nem o Environment                                                                                                                        |
| `lifecycle/migrate-source.test.ts`                               | a chave `src-<hash>` da imagem de migração: empacota os scripts que o entrypoint roda na etapa (como o tsup) e reprova se algum importar arquivo fora da lista do `migrate-source.sh`, ou se o estágio `migrate` copiar um; a chave muda com uma migration, um seed, um arquivo que ele importa, a planilha, o `yarn.lock` ou o entrypoint, e não muda com o resto da API                                                                                                                                                                                                |
| `E2E/schema-guard.test.ts`, `E2E/import-violation-codes.test.ts` | contra um Postgres de verdade: a API recusa o banco a que falte qualquer migration do build (inclusive uma mais antiga que a mais nova aplicada, de um branch mesclado depois); o import de infrações da etapa de release é tudo ou nada (um lote que falha no meio sai com erro e deixa a tabela vazia, e a execução seguinte a preenche)                                                                                                                                                                                                                               |
| `lifecycle/compose-rollout-verify.test.ts`                       | a conferência da convergência (script e posição nos workflows da API e da web); exatamente uma conferência por valor de `ROLLOUT_VERIFY` (liveness pública por padrão no staging, SSH na produção, nenhuma só com `off`); um deploy por vez; staging só pelo head da branch                                                                                                                                                                                                                                                                                              |
| `lifecycle/supply-chain.test.ts`                                 | actions por SHA, bases por digest, audit (pelo `audit-gate.sh`), SBOM/proveniência, Trivy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `lifecycle/secrets-hygiene.test.ts`                              | gitleaks igual no `ci.yml` e no `deploy.yml`; nenhum build antes dele; `.env*` fora do git                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lifecycle/compose-ci-siblings.test.ts`                          | o checkout dos repositórios irmãos na mesma branch; no `ci.yml` da API, só "a branch não existe" (código 2) cai na padrão, com aviso, e erro de rede repete 3 vezes e falha                                                                                                                                                                                                                                                                                                                                                                                              |
| `lifecycle/migration-safety.test.ts`                             | expandir/contrair nas migrations novas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lifecycle/dokploy-deploy.test.ts`                               | o script de deploy contra um Dokploy falso (`application.deploy` de uma Application por chamada; segue o deployment criado; repete o que termina em erro até 6 vezes com espera dobrando até o teto; cada retentativa — pedido, consulta ou deploy — é `::warning::` com a contagem, e o resumo do job lista cada tentativa que falhou com o motivo do Dokploy; escreve o motivo sem credenciais; id opcional vira aviso; nunca imprime a chave)                                                                                                                         |
| `lifecycle/staging-deploy-workflow.test.ts`                      | os passos do staging e da promoção executados com o GHCR simulado: a IA reaproveitada pelo hash de `infra/ai-ocr` e reimplantada só quando o digest muda (ou com `force_ai_build`); o GHCR sem resposta falha o passo em vez de virar "não existe"; cada tag `staging` movida logo antes do próprio deploy e devolvida quando o deploy falha; o marcador `staged-<sha>` escrito por último e exigido pelo PR e pela promoção, que espera até 20 min um deploy de staging em andamento                                                                                    |
| `lifecycle/wait-for-version.test.ts`                             | a conferência pela liveness pública contra uma API falsa: passa só depois de o commit novo responder pela janela inteira, recomeça a janela quando uma réplica antiga responde, não recomeça numa sondagem sem resposta (5xx/52x, timeout, corpo que não é a liveness) e avisa com a contagem, aceita o `sha-<7>` da promoção, recusa build sem commit; a janela é maior que o monitor de rollback do Swarm                                                                                                                                                              |
| `lifecycle/ci-stability.test.ts`                                 | um vermelho é sempre do código: todo job com `timeout-minutes`; `bash -eo pipefail` em todo workflow e todo `run:` com sintaxe válida; o Node da base do `Dockerfile` em todo `setup-node`; toda imagem dos jobs por digest, o mesmo digest em todo lugar; BuildKit fixado; `cache-to` com `ignore-error=true`; GHCR só pelo `ghcr.sh`; cache dos engines do Prisma e a conferência do engine antes do E2E; o download do banco do Trivy com cache e o scan que só reprova um achado (executados com `docker` simulado); a guarda de cabeça do `deploy-staging`          |
| `lifecycle/ghcr-script.test.ts`                                  | `.github/scripts/ghcr.sh`: só o "not found" do GHCR é resposta vazia; erro passageiro repete com pausa dobrando e aviso com a contagem; persistente falha nomeando o GHCR; resposta ilegível não vira digest; mover tag repete e falha na hora se a origem não existe                                                                                                                                                                                                                                                                                                    |
| `lifecycle/staged-build.test.ts`                                 | `.github/scripts/staged-build.sh` contra um histórico git de verdade: o próprio commit com o marcador; o ancestral mais próximo com o marcador quando só documentação (`*.md`, `docs/**`) mudou desde ele; recusa (listando os arquivos) quando mudou outra coisa; marcador em outro digest recusado; GHCR fora falha em vez de "não rodou"; o `.dockerignore` sem `**/*.md` nem `docs/`                                                                                                                                                                                 |
| `lifecycle/audit-gate.test.ts`                                   | `.github/scripts/audit-gate.sh` contra um histórico git de verdade: bloqueia o push que muda `package.json`/`yarn.lock`/`package-lock.json` (em qualquer pasta) ou o `audit-ci.jsonc`, ou que não tem base; nos outros, a reprovação vira aviso e relatório no resumo; um audit que não rodou (rede) repete e nunca é lido como aviso                                                                                                                                                                                                                                    |
| `lifecycle/image-layers.test.ts`                                 | as camadas das imagens: um arquivo de requisitos com hash por camada, na ordem em que mudam, cada pacote num só; os modelos da IA versionados em `infra/ai-ocr/models` (só o par que a roda não traz, nos hashes do `models.sha256`) e conferidos num `RUN --network=none`, copiados com `COPY --link`; o commit (`GIT_SHA`) declarado depois do último `RUN`; o `prisma generate` antes do `COPY . .`; a conferência do schema engine do Prisma nos dois `yarn install`, executada numa árvore                                                                          |
| `security/env-example.test.ts`                                   | o `.env.example` tem toda variável do env-schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `quality/coverage-config.test.ts`                                | a configuração de cobertura e o piso no CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `quality/e2e-replica-isolation.test.ts`                          | os arquivos que sobem réplicas estão todos na lista da segunda fase do `yarn test:e2e`, e só eles; as fases do `vite.config.mts` e do `infra/scripts/run-e2e.mjs`                                                                                                                                                                                                                                                                                                                                                                                                        |
| `quality/outbound-network-guard.test.ts`                         | a trava de rede dos testes: loopback e bancos configurados passam; o resto é recusado antes do DNS e lembrado para falhar o arquivo                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mail/mail-provider-for.test.ts`                                 | o transporte de e-mail por `NODE_ENV`: a caixa em memória só com `test`, e ela se recusa a existir com outro valor ou num build feito para produção                                                                                                                                                                                                                                                                                                                                                                                                                      |

## O que roda onde (local × CI)

|                               | Local (antes de dizer "pronto")                    | `ci.yml` (branch)                                      | `deploy.yml` (staging e PR para `main`) |
| ----------------------------- | -------------------------------------------------- | ------------------------------------------------------ | --------------------------------------- |
| typecheck                     | `yarn prisma:generate && yarn typecheck`           | sim                                                    | sim                                     |
| unitários + piso              | `yarn test` (ou o arquivo tocado)                  | sim, com cobertura                                     | sim, com cobertura                      |
| E2E                           | os arquivos tocados, contra o Postgres descartável | não                                                    | **sim**, a suíte inteira, em duas fases |
| lint, build                   | ficam com o CI                                     | lint                                                   | lint (o build é o da imagem)            |
| audit, gitleaks, pytest da IA | —                                                  | sim (o audit bloqueia só um push que muda dependência) | sim (idem)                              |
| contrato com a IA real        | opt-in                                             | só _Run workflow_                                      | não                                     |
| carga, mutação                | sob demanda                                        | não                                                    | não                                     |

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
    máquina ocupada sem entender o motivo; o boot da API já tem o seu. Prazo
    generoso só para **esperar uma condição** (o processo sair, a sala ter o
    socket), nunca no lugar dela.
11. **Nada de rede de fora.** Todo terceiro (Meta, Expo, Resend, SMTP,
    Turnstile, mapas, CEP) vira um falso local; a trava do `setupTests.ts`
    falha o arquivo que tentar.
12. **Espere por estado, não por tempo** (seção
    [Esperar por estado, nunca por tempo](#esperar-por-estado-nunca-por-tempo)).
    Sem `setTimeout` fixo esperando o servidor; uma janela negativa só depois
    de confirmado o estado que a torna válida.

## Windows

- **O relógio do Docker Desktop**: se o E2E recusar começar ou avisar "O
  relógio do Postgres de teste está … atrás", rode `wsl --shutdown` (ou
  reinicie o Docker Desktop) e rode de novo (seção
  [O relógio do banco](#o-relógio-do-banco)).
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
  (senha `WEB_E2E_PASSWORD`). As suítes de navegador da web
  (`trajetto-ui/.github/workflows/browser-suites.yml`, num push em staging,
  num PR para main e sob demanda) rodam os três nessa ordem. A API sobe ali
  com `NODE_ENV=test`, então o 2FA e a criação de usuário guardam o e-mail na
  caixa em memória do processo: nenhuma rede de saída. Detalhes em `trajetto-ui/docs/testes.md`.
- **App (Maestro)**: a suíte do app (`trajetto-mobile/docs/testes.md`) entra
  com as contas que o `seed.ts` cria com `LOAD_MOBILE_E2E=1`
  (`MOBILE_E2E_EMAIL`, `MOBILE_E2E_PASSWORD`, `MOBILE_E2E_TWOFA_EMAIL`,
  `MOBILE_E2E_NOFLEET_EMAIL`).
- **Contrato de rotas**: `tests/unitaires/contract/client-routes.test.ts` lê
  as URLs que a web e o app constroem (`../trajetto-ui`, `../trajetto-mobile`)
  e falha se alguma não existir na API.
