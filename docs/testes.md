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
- [Simulação do dia de entregas (`tests/simulation`)](#simulação-do-dia-de-entregas-testssimulation)
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
| E2E, fase infra          | `tests/E2E/infra`                 | `yarn test:e2e:infra`                                | Docker (a pilha própria do script)                                                                                             | PgBouncer em modo transaction e standby em streaming reais, como o código conta que estão                            |
| Contrato de repositórios | `tests/contract`                  | junto com o E2E (os `*-repository-contract.test.ts`) | Postgres                                                                                                                       | o gêmeo in-memory e o repositório Prisma respondem igual                                                             |
| Serviço de IA (Python)   | `infra/ai-ocr/tests`              | `docker build --target test infra/ai-ocr`            | Docker                                                                                                                         | o servidor de OCR, dentro da imagem que vai para produção                                                            |
| Contrato com a IA real   | `tests/ai-local`                  | `AI_LOCAL_E2E=1 npx vitest run tests/ai-local`       | Docker, ~1 GiB                                                                                                                 | o leitor e as regras da API contra o contêiner `trajetto-ai` de verdade                                              |
| Carga                    | `tests/load`                      | ver `tests/load/README.md`                           | Docker e k6                                                                                                                    | capacidade por réplica, gargalos, multi-réplica, injeção de falha                                                    |
| Simulação do dia         | `tests/simulation`                | ver `tests/simulation/README.md`                     | os containers de teste; a web para filmar                                                                                      | o fluxo de Entregas inteiro pela API HTTP, com réplicas                                                              |
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

| Comando                        | O que faz                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `yarn test`                    | unitários (`vitest run --dir tests/unitaires`)                                                                                       |
| `yarn test:watch`              | unitários em modo watch                                                                                                              |
| `yarn test:e2e`                | E2E em duas fases (`infra/scripts/run-e2e.mjs`): o resto em paralelo, depois as réplicas, um por vez                                 |
| `yarn test:e2e:infra`          | a fase infra do E2E (`tests/E2E/infra/run.sh`): sobe primário, standby e PgBouncer descartáveis, roda `tests/E2E/infra` e apaga tudo |
| `yarn test:e2e:watch`          | E2E em modo watch                                                                                                                    |
| `yarn test:coverage`           | unitários com cobertura e **piso** (`coverage/unit`)                                                                                 |
| `yarn test:coverage:e2e`       | cobertura do E2E em lotes de 8, juntada com a unitária em `coverage/all` (`infra/scripts/coverage-e2e.sh`)                           |
| `yarn test:mutation`           | Stryker nas regras críticas (`MUTATION_BATCH=guards\|states\|outbox\|lists`)                                                         |
| `yarn test:ui`                 | interface do Vitest                                                                                                                  |
| `yarn typecheck`               | `tsc --noEmit` (gere o client antes: `yarn prisma:generate`)                                                                         |
| `yarn validate`                | `prisma:generate`, `typecheck` e `test`                                                                                              |
| `npx vitest run <arquivo>`     | um arquivo só (unitário ou E2E)                                                                                                      |
| `npx vitest run -t "<título>"` | só os testes com aquele título                                                                                                       |

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

| Pasta                                            | O que guarda                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `contract/`                                      | contratos com os clientes: rotas que a web e o app chamam (`client-routes`, lê `../trajetto-ui` e `../trajetto-mobile` quando existem), rotas aposentadas (`retired-routes`, compara com `origin/main`), corpos do outbox do app (`outbox-body-contract`, fixtures `mobile-outbox-v1`/`-v2`), OpenAPI, NDJSON, exemplos de resposta, classes de erro, defaults dos gêmeos in-memory                                                                                                |
| `lifecycle/`                                     | infra executada de verdade: workflows (`promote-workflow`, `staging-deploy-workflow`, `supply-chain`, `secrets-hygiene`, `compose-ci-siblings`, `ci-stability`), imagens (`image-layers`, `image-scan`), scripts (`release-migrations`, `dokploy-release`, `migrate-source`, `compose-rollout-verify`, `backup-scripts`, `dokploy-deploy`, `wait-for-version`, `ghcr-script`, `staged-build`, `audit-gate`), migrations (`migration-safety`, `migration-prebuild`), boot e workers |
| `security/`                                      | JWT, 2FA, mensagens de unicidade, `.env.example` contra o schema                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `integration/`                                   | API pública, portal de documentação, webhooks                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `env/`                                           | o env-schema e a URL do banco de teste                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `quality/`                                       | a configuração de cobertura                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `time/`                                          | dia de negócio; varre `src/` atrás de conta de dia com o relógio do servidor                                                                                                                                                                                                                                                                                                                                                                                                       |
| `health/`, `logging/`, `socket/`, `resilience/`… | o resto do que atravessa domínios                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Os testes de usecase usam os gêmeos in-memory (`repositories/in-memory/`), que
precisam ter a mesma semântica do Prisma (filtros, ordem, nulos, unicidade,
empresa). Os testes que sobem a API (`import("@/http")` + `app.ready()`) usam
o orçamento `APP_BOOT_TIMEOUT_MS` de `tests/support/app-boot.ts` (120 s:
carregar o grafo inteiro leva ~14 s por arquivo, mais com a máquina ocupada).

Os testes de script (`tests/unitaires/lifecycle/support/shell-harness.ts`)
rodam os `.sh` do repositório e os blocos `run:` dos workflows de verdade, com
os comandos externos (`docker`, `gh`, `git`, `pg_dump`, `rclone`…) trocados por
stubs que registram cada chamada. Sem `bash`/`sh` utilizável, eles se pulam em
vez de falhar. O processo do script só é encerrado por uma trava contra
travamento (5 min, muito acima da rodada mais lenta medida), e ser encerrado
lança um erro que nomeia o script: a saída parcial nunca chega às asserções
como se o script tivesse terminado ali (com o limite antigo de 30 s, o laço de
retentativas do `ghcr.sh` numa rodada paralela cheia no Windows era cortado e
lido como resposta errada).

Nada de corrida de relógio entre trabalhos de um teste: a ordem que o teste
prova vem de uma promessa que o próprio teste resolve (um portão), não de um
`setTimeout` mais longo que o outro, que uma máquina carregada inverte (foi o
caso do "fair pool" de `webhook-dispatch-rules.test.ts`).

Nem orçamento em milissegundos para provar que algo é barato ou imediato: o
custo se mede pelo que o código faz, não pelo relógio de uma máquina que pode
estar ocupada. O relatório de pausas conta as leituras de cada rota, pausa e
linha, que dobram quando a frota dobra (`pause-report-rules.test.ts`), e a
prontidão responde com o relógio parado, sem tocar no pool principal
(`readiness-pool.test.ts`). Os dois tinham limites de 1,5 s e 1 s e falharam
numa rodada paralela cheia em 03/11/2026, sem defeito no código. Pelo mesmo
motivo, no mesmo dia, mais dois: a varredura de texto não armazenável conta as
operações de um corpo com 200 000 níveis e as coletas de lixo de um com
20 000, em vez de um limite de 2 s (`unstorable-text.test.ts`), e as métricas
de runtime leem a janela nova no mesmo tick do `rotate`, em vez de exigir que
os 80 ms seguintes ficassem abaixo de 100 ms, o que falhou com 101,91 ms
(`runtime-metrics.test.ts`).

## E2E (`tests/E2E`)

O ambiente `prisma/vitest-environment-prisma` cria **um banco por arquivo de
teste** no servidor apontado por `TEST_DATABASE_URL` (ou `DATABASE_URL`) e o
apaga no fim. Um banco por arquivo, e não um schema, porque a extensão
`pg_trgm` é por banco. Aponte para um Postgres descartável, nunca para o de
desenvolvimento:

```bash
# Postgres e Redis descartáveis (portas próprias para não colidir com o dev)
docker run -d --name trajetto-test-pg -p 127.0.0.1:54321:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=trajetto postgres:16-alpine \
  -c max_connections=200 -c shared_preload_libraries=pg_stat_statements -c compute_query_id=on
docker run -d --name trajetto-test-redis -p 127.0.0.1:63790:6379 redis:7-alpine

DATABASE_URL="postgresql://postgres:postgres@localhost:54321/trajetto?schema=public" \
REDIS_URL="redis://localhost:63790" \
  npx vitest run tests/E2E/delivery-export-http.test.ts
```

O `max_connections=200` não é enfeite: `health-metrics.test.ts` exige um
valor fora do padrão (100), senão um painel com 100 fixo passaria. O
`pg_stat_statements` pré-carregado também não: a extensão vem de uma
migration, mas a view só responde com a biblioteca carregada no boot do
servidor, e `pg-stat-statements-state.test.ts` exige o estado `ready` (sem
o `-c`, ele fica `not_loaded`, como a produção até a imagem nova do
Postgres); `pgss-snapshot.test.ts` lê a view de verdade. No CI (os jobs de E2E do `validate.yml`) o contêiner de serviço
não aceita comando, e um passo aplica os mesmos valores com `ALTER SYSTEM`
e reinicia o contêiner. O `socket.io-client` dos testes de socket é devDependency da API
(mesma versão da web): basta o `yarn install` daqui.

### O banco molde

Cada arquivo rodava o próprio `yarn prisma migrate deploy` no banco novo: o
yarn, a CLI do Prisma, o schema engine e mais de 160 migrations, de 4 a 7 s
por arquivo antes do primeiro teste (4,66 s em média no CI de 04/11/2026,
em 351 arquivos). Desde 10/11/2026 as migrations rodam **uma vez por
servidor** num banco molde, e o banco de cada arquivo é um
`CREATE DATABASE … TEMPLATE` dele: uma cópia do catálogo e dos dados em
~0,12 s (`prisma/vitest-environment-prisma/template.ts`).

- O nome do molde é `trajetto_tpl_<hash>` do que o `migrate deploy` lê:
  `prisma/migrations`, o `schema.prisma`, o `prisma.config.ts` e a versão da
  CLI (`node_modules/prisma/package.json`), mais os passos que a etapa de
  release roda depois dele (`infra/sql`, `prisma/post-deploy` e o
  `infra/scripts/release-steps.ts` que os roda), sem contar fim de linha.
  Uma migration ou um passo novo é outro molde; os de outras chaves são
  apagados (`env/prisma-test-template.test.ts`).
- Depois das migrations o construtor roda `yarn release:steps`, como a etapa
  de release: o molde sai como uma release deixa o banco, com a
  `release_step_state` preenchida (`E2E/release-steps.test.ts`). Um passo
  que falha deixa o molde sem marca. O `prisma/concurrent` não roda ali: num
  banco novo ele pula, e as migrations criam os índices.
- Um construtor por servidor: todo arquivo pega o mesmo _advisory lock_ no
  banco `postgres` antes de olhar, então o primeiro migra e os outros
  esperam e o acham pronto (a ordem dos comandos, o molde não marcado
  refeito, a poda e o construtor único estão em
  `env/prisma-test-template.test.ts`, com o `pg` e o `migrate` simulados).
  O molde só é marcado (`IS_TEMPLATE`,
  `ALLOW_CONNECTIONS false`) depois da última migration: um run que morreu
  no meio deixa um banco não marcado, que o próximo apaga e refaz. Ninguém
  conecta num molde marcado, que é o que o `CREATE DATABASE … TEMPLATE`
  exige.
- O clone é idêntico ao que o `migrate deploy` deixava: o `pg_trgm` (vem
  de uma migration), os dados que as migrations inserem e o
  `_prisma_migrations` inteiro (`E2E/test-database-template.test.ts`).
  Nenhuma migration mexe fora do próprio banco (role, `ALTER DATABASE`,
  `ALTER SYSTEM`), então nada se perde na cópia; os roles que o `infra/sql`
  cria são do servidor, ao lado de todo clone, e os grants vão no catálogo
  copiado. Só o `finished_at` das migrations é a hora do molde, minutos
  antes.
- **Duas execuções ao mesmo tempo, com migrations diferentes, no mesmo
  Postgres** quebram uma à outra (cada uma apaga o molde da outra). No CI
  cada job tem o próprio Postgres; na máquina, não rode duas árvores
  diferentes contra o mesmo servidor ao mesmo tempo.
- O ambiente é a dependência `file:` que o Yarn copia para o
  `node_modules` ([Comandos](#comandos)): depois de puxar esta mudança, rode
  `yarn install --force`, senão o E2E segue com a cópia antiga (que migra
  por arquivo, mais lento, mas certo).

### O gate de drift do schema

`E2E/schema-drift.test.ts` roda
`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
(as flags do Prisma 7.10.1; `--from-migrations` exigiria um banco sombra) do
banco do arquivo, um clone do molde, até o `schema.prisma`. Todo statement
que o diff imprime precisa estar na lista comentada de
`E2E/support/schema-drift-allowlist.ts`, com o porquê. Um `@@index` no
schema sem a migration dele reprova (o próprio teste prova), e também uma
entrada que não casa com nada (tire da lista) ou passada da data `until`,
que toda entrada de um estado temporário leva (as tabelas `*_legacy` da
janela do histórico, uma coluna entre expandir e contrair). Hoje a lista tem
três índices que o Prisma não sabe declarar (trigrama e `NULLS LAST`).

### Processos e os jobs paralelos do CI

O `vite.config.mts` roda **pelo menos 2 arquivos ao mesmo tempo**
(`poolOptions.forks`, `FORKS = max(2, CPUs − 1)`): o padrão do Vitest
(CPUs − 1) dava um processo só no runner de 2 vCPU, com a CPU ociosa
esperando o Postgres. Medido em 2 núcleos: unitários 560 → 360 s, uma
amostra de 30 arquivos de E2E 151 → 103 s (3 processos: 127 s). De 4 CPUs
para cima nada muda. Só o teto é fixado: o piso fica em 1 processo, e o
Vitest abre mais conforme os arquivos esperam. Por isso `VITEST_MAX_FORKS`
sozinho funciona em qualquer máquina (`VITEST_MAX_FORKS=1` roda um arquivo
por vez; com o piso no teto, o Tinypool recusava a configuração), e
`VITEST_MIN_FORKS` continua valendo por cima. A fase de réplicas continua um
arquivo por vez.

No CI o E2E roda em **3 jobs paralelos** (`E2E (1/3)`, `E2E (2/3)`,
`E2E (3/3)` no `validate.yml`), cada um com o próprio Postgres e Redis. O
`yarn test:e2e` recebe `E2E_SHARD=<i>/<n>` (`infra/scripts/run-e2e.mjs`): os
jobs 1 a n−1 dividem a fase `shared` com o `--shard` do próprio Vitest, e o
job n roda a fase de réplicas inteira, sozinha (os arquivos dela sobem
processos que o Vitest não conta). `quality/e2e-shards.test.ts` confere,
pelo sequenciador do próprio Vitest, que a matriz roda cada arquivo
exatamente uma vez e que nenhum job fica vazio. O job 1, depois da fatia
dele, roda também a fase infra ([abaixo](#a-fase-infra-yarn-teste2einfra)).
Para rodar um job como o CI, na máquina:

```bash
E2E_SHARD=2/3 yarn test:e2e --run --reporter=basic
```

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

A mesma fase de um arquivo por vez recebe os arquivos que medem algo que o
cluster inteiro perturba (`SERIAL_E2E_FILES`, no mesmo arquivo): o Postgres só
limpa as versões mortas de uma página abaixo da transação mais velha ainda
aberta em **qualquer** banco do cluster, e não só no banco do arquivo. Uma
escrita aberta no banco de outro arquivo segura a limpeza de que o update HOT
precisa (`driver-last-position-hot.test.ts`, plano de escala F2-13), e
segura o horizonte do feed da integração pela ordem de commit
(`integration-feed-commit-order.test.ts`, F2-05: as transações abertas de
propósito dele também segurariam as dos outros arquivos).

A fase de réplicas é a que mais pede memória: `resilience-replica-drain.test.ts`
sobe 10 réplicas ao mesmo tempo. Numa réplica Linux do CI (11/11/2026) o job
chegou a 2,8 GB contando o cache de páginas, contra 1,3 GB na fase `shared`;
com o contêiner limitado a 1,3 GB, o OOM killer matou uma réplica e o teste
falhou com "a réplica não subiu (morta por SIGKILL)". O runner do GitHub tem
7 GB; num Docker com limite de memória, dê ao menos 3 GB a esse job.

### A fase infra (`yarn test:e2e:infra`)

Os arquivos de `tests/E2E/infra` (plano de escala F4-38) medem o que o código
assume do PgBouncer e do standby, contra os de verdade:
`pgbouncer-transaction-mode.test.ts` (o pool por transação, o login SCRAM
pelo `auth_query` com os tetos do próprio role, o dono recusado, um `SET` de
sessão que chega ao próximo cliente e o `SET LOCAL` que não chega, o cliente
da API com transação interativa), `pgbouncer-busy-errors.test.ts` (o pool
cheio de verdade: o `query_wait_timeout` que o cliente da API recebe numa
query crua, numa de modelo e numa transação interativa vira 503
`SERVICE_BUSY`, F4-32), `pgbouncer-stats.test.ts` (o login de estatística
recusado em `PAUSE`, `KILL` e `SHUTDOWN`, e os pools, o tráfego e as
conexões de servidor lidos do console de verdade, F4-36),
`readiness-probe-pool.test.ts` (com o pool das requisições cheio, a
readiness no alias `trajetto_probe` responde "sim" e no pool das
requisições, "não", F4-37), `pgbouncer-session-names.test.ts` (a sessão
do `auth_query` e as do cliente da API chegam ao banco com nome, para a
checagem das contrações não as ler como a imagem antiga),
`streaming-standby.test.ts` (o standby em
recuperação, recusando escrita e mostrando um commit do primário) e
`replication-hba.test.ts` (o `pg_hba` da imagem: as regras oficiais e uma
linha de replicação só para o endereço do standby, de onde vem o
streaming; o mesmo login, com a senha certa, recusado de fora dele; o
standby clonado pelo ramo da imagem, com a senha só no passfile, F4-40). As fases
`shared` e de réplicas deixam esses arquivos de fora (`INFRA_E2E_GLOB`, em
`tests/E2E/support/replica-files.ts`).

`tests/E2E/infra/run.sh` sobe uma pilha descartável só dela, roda a fase e
apaga a pilha no fim:

- o primário: a imagem `trajetto-postgres` sem o pgBackRest
  (`infra/postgres`, `--target wrapper`: o `postgres:16-alpine` dos
  serviços do CI iniciado pelo `trajetto-entrypoint.sh`, como o Database),
  com o banco `trajetto` como uma release deixa (`prisma migrate deploy` e
  `yarn release:steps`), os logins que o dono dá à mão (`pgbouncer_auth`,
  `trajetto_http` e `trajetto_replication`, com senha) e o
  `POSTGRES_REPLICATION_CIDR` no endereço do standby, `/32`;
- o standby: a mesma imagem, clonada pelo ramo standby dela
  (`POSTGRES_STANDBY_PRIMARY_HOST`), em streaming como
  `trajetto_replication` por um slot físico, de um endereço fixo da rede
  da pilha (que tem sub-rede própria; esta máquina chega às portas pelo
  gateway dela, fora do `/32`);
- o PgBouncer: a imagem `trajetto-pgbouncer` (`infra/pgbouncer`) na frente
  do primário, com o Environment da Application e senhas descartáveis.

É um cluster próprio, nunca o de teste compartilhado: a fase dá login e
senha a roles e segura um slot de replicação, e isso é do cluster inteiro.
As portas são publicadas só em 127.0.0.1, escolhidas pelo Docker; as senhas
são aleatórias e nunca impressas. Os arquivos recebem cinco URLs
(`E2E_INFRA_PRIMARY_URL`, `E2E_INFRA_STANDBY_URL`, `E2E_INFRA_PGBOUNCER_URL`,
`E2E_INFRA_PGBOUNCER_STATS_URL` e `E2E_INFRA_REPLICATION_URL`) por `infraUrl`
(`tests/E2E/infra/support/infra-urls.ts`), que **falha** quando uma falta,
quando sai do loopback ou quando aponta para o cluster compartilhado: o
arquivo nunca é pulado. Rodam um por vez (qual conexão de servidor um
cliente recebe é o que eles medem) e no ambiente `node`, sem banco clonado
do molde.

Os nomes começam por `E2E_INFRA_PREFIX` (`trajetto-e2e-infra-`) e levam o
label `trajetto.purpose=e2e-infra`; um nome da pilha ocupado por algo sem
esse label para o script (saída 2) sem remover nada. Sem
`E2E_INFRA_PGBOUNCER_IMAGE`, o script constrói a imagem de `infra/pgbouncer`,
e sem `E2E_INFRA_POSTGRES_IMAGE`, o estágio `wrapper` de `infra/postgres`
(segundos: só copia os arquivos do wrapper sobre a base), e as remove no
fim (`docker build --load`, que serve também ao builder em contêiner do CI);
`E2E_INFRA_KEEP=1` deixa a pilha de pé para olhar.

No CI, o job `E2E (1/3)` roda a fase depois da fatia dele, mesmo se a fatia
falhou, com a imagem do PgBouncer do próprio commit construída antes, com o
cache dos jobs do PgBouncer. Na máquina do dono, com a imagem pronta, a pilha
sobe em 28 s e a fase inteira leva 34 s. `quality/e2e-infra-isolation.test.ts`
confere a separação das fases, o `infraUrl`, o script e os passos do CI. O
`coverage-e2e.sh` deixa `tests/E2E/infra` de fora.

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

### O Redis é de todos os arquivos

Cada arquivo tem o seu banco, mas o Redis é um só: os arquivos da fase
`shared` rodam em paralelo sobre ele, o que gravam sobrevive à execução, e o
mesmo Redis pode servir duas execuções ao mesmo tempo (duas locais, réplicas
em paralelo). Uma chave por empresa ou por usuário (ids novos por execução)
já fica isolada. O que é da plataforma, não: a vaga por segundo e por minuto
do provedor de endereços, as pausas da conta e as contagens do dia são uma
chave só em produção, de propósito, porque todas as réplicas contam juntas.
Nessas chaves, a chamada de outra execução no mesmo segundo responde a busca
com `503 ADDRESS_SEARCH_BUSY`, e uma pausa ou uma contagem do dia que outra
deixou (a pausa `QUOTA` vale até a meia-noite UTC) muda a resposta da busca
(503 ou 429), o `address_lookup` da rota e o orçamento do job. Com
`REVERSE_GEOCODER_URL` no `.env` local, as escritas de entrega dos outros
arquivos também tomam a vaga, na busca logo depois do commit.

Por isso, um arquivo que usa as chaves do geocodificador usa as da própria
execução, de `geocodingTestKeys()` (`tests/E2E/support/geocoding-test-keys.ts`),
e as apaga no fim com `clear`:

- **roda o portão**: `address-search-http`, pela busca
  (`configureAddressSearch(redis, keys)` depois do `import("@/http")`, numa
  conexão de `readyRequestPathRedis()`, do mesmo tipo da `http.ts`), e
  `geocoding-gate-redis`, direto em `createRedisGeocodingGate`,
  `createRedisProofGate` e `createRedisAddressSearchStore`;
- **grava a pausa e lê a pausa e o orçamento do dia**:
  `delivery-geocoding-routes-http`, pela `geocoding-hold`
  (`createRedisGeocodingHold(redis, teto, keys)`, entregue a
  `configureGeocodingHold` depois do `import("@/http")`);
- **gasta o orçamento do job**: `import-geocoding-volume` e
  `provider-quota-contract` (`createGeocodingBudget` com a chave da
  imagem anterior em `keys.budget`; o dia mesmo fica no banco do arquivo).

Num E2E, nunca grave nem apague uma chave de produção.
`delivery/geocoding-keys.test.ts` prova que a produção continua nas chaves
compartilhadas.

### Esperar por estado, nunca por tempo

Um `setTimeout` fixo esperando o servidor "terminar" é chute: numa máquina
carregada o caso positivo lê como "nunca chegou" e o negativo passa pelo
motivo errado. As ferramentas:

- **Salas do Socket.IO** (`tests/E2E/support/socket-waits.ts`):
  `waitForRoom(io, socketId, sala, dentro)` lê o índice de salas do próprio
  servidor; `emitHandled(socket, evento, payload)` espera o
  _acknowledgement_ vazio de `operationsSubscribe`/`chatSubscribe` e dos
  unsubscribes (tratado, sem dizer o veredito); `waitForDisconnect`;
  `waitUntil` para o resto. Numa réplica de outro processo,
  `replica.waitForRoom(...)` pergunta à réplica (`MEMBERS`, em
  `socket-replica.ts`).
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
- **Prazo do produto** (cada sonda do `/health` tem 500 ms): o primeiro uso de
  um cliente paga a abertura dele (a primeira conexão do pool e a primeira
  query do Prisma, a conexão do Redis). Nenhuma réplica abre o Redis do cache
  antes do `listen`, e o banco só é tocado antes dele numa réplica com
  workers, pela primeira varredura do despacho de webhooks, sem esperar por
  ela: o primeiro `/health` de uma réplica recém-subida paga essas aberturas.
  Um teste que julga a resposta da sonda, e não essa partida a frio, paga a
  abertura antes da primeira chamada medida, como o `beforeAll` de
  `health-under-failure.test.ts` e o de `database-reconnect.test.ts`: dentro
  da sonda, com os dois processos de teste ocupados, elas levaram 0,46 s
  (Redis) e mais de 0,5 s (banco), e o `/health` respondeu 503 com o banco de
  pé.

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
  `infra/ai-ocr/models`) e roda como o usuário 10001. Roda no job `AI OCR`
  do `validate.yml` (branches e staging), pelo Buildx com o cache do GitHub
  (um código que já passou leva segundos), e é pulado quando o GHCR já tem a
  imagem de mesmo `infra/ai-ocr` (`src-<hash>`), construída só depois de o
  mesmo pytest passar; o build só fala com o Docker Hub e o PyPI.
- **Contrato com o contêiner real** (opt-in):
  `AI_LOCAL_E2E=1 npx vitest run tests/ai-local`. Constrói `infra/ai-ocr` (ou
  usa `AI_LOCAL_E2E_IMAGE`), sobe como na produção (só leitura, sem
  capabilities, 2 CPUs, 1 GiB, `AI_MAX_QUEUE=0`) e passa seis fotos sintéticas
  do benchmark pelo `LocalOcrReader` e pelas regras da API. No CI, só por _Run
  workflow_ do `ci.yml` (job `ai-local-e2e` do `validate.yml`, com o mesmo
  `env` de teste dos outros jobs).
- O benchmark de precisão e latência está em `scripts/ai-benchmark/`.

## Carga, estresse, soak e multi-réplica (`tests/load`)

O harness `tests/load/compose.load.yaml` reproduz a produção numa máquina:
Traefik v3 (com o health check de readiness que a produção tinha até as
Applications do Dokploy; ver [`deploy.md`](./deploy.md#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)), N réplicas da imagem real
(`LOAD_REPLICAS`), Postgres 16 e Redis 7 descartáveis e k6 na mesma rede.
Cenas: `smoke.js` (sempre primeiro: prova que as outras medem algo real),
`load.js`, `spike.js`, `stress.js`, `soak.js`; mais `multi-replica.sh`,
`failure-injection.sh`, `socket-hold.mjs` e `socket-across-replicas.mjs`.
`swarm-rolling.sh` ensaia o deploy da API num Swarm descartável de um nó,
com as flags do Dokploy (start-first, rollback, 40 s de grace, o healthcheck
da imagem): um _Redeploy_ sob 50 req/s do `rolling.js` com zero 5xx e cada
réplica antiga saindo com 0, e a escala de 3 para 6 com máximo/média ≤ 1,3;
recusa um nó que já está num Swarm com serviços, e o
`swarm-rolling-script.test.ts` confere as flags contra o guia.
`staging-burn-in.sh` é o burn-in curto da staging, no host da VPS (até 30
req/s, 10 min e 200 sockets, só na `load-window`, com a readiness da
produção e o `vmstat` do host abortando tudo), e a `staging-fixture.mjs`
prepara pela API os dados da empresa 'Carga (staging)';
`staging-burn-in.test.ts` e `staging-fixture.test.ts` executam os dois com
stubs ([`deploy.md`](./deploy.md#ensaio-de-carga-na-staging-burn-in)).
`socket-fleet.mjs` (LOAD-05) segura uma frota de sockets de várias origens,
com cada origem e cada token abaixo dos orçamentos de handshake da API, e
mede a conexão, as quedas e a volta depois de um restart; pela borda
(`--via-edge`), com os tetos dela (20 handshakes/s, 10 min, a `load-window`,
1.000 sockets na VPS única) e as sondas do burn-in.
`socket-fleet.test.ts` roda a frota contra um Socket.IO no loopback, com 8
origens e um restart ([`deploy.md`](./deploy.md#frota-de-sockets-pela-borda-load-05)).
`gate.sh` (LOAD-08) roda um portão de capacidade a partir do gerador, que
nunca é o alvo (recusa um `TARGET_HOST_IP` desta máquina e os hosts da
produção e da staging), e escreve o relatório em `docs/desempenho`;
`gate-script.test.ts` o executa com stubs, e `performance-reports.test.ts`
recusa um relatório sem o commit, sem o digest ou sem o gerador.
`cpu-abba.sh` (LOAD-10) alterna duas imagens da API no harness em ABBAAB,
cada corrida numa cópia nova do banco, e escreve em
`docs/desempenho/bancada` a CPU (do cgroup) e os statements (do
`pg_stat_statements`) por requisição, com o controle A=B abaixo de 5%;
`cpu-profile.sh` grava o perfil de CPU das réplicas sob carga e imprime o
topo por função e por pacote; os dois recusam um docker de outra máquina e
um servidor do Dokploy, e o `cpu-bench.test.ts` os executa com stubs. O
`seed.ts` prepara o banco `load_test` (empresas, motoristas, histórico); com
`LOAD_TIER` (`tiny`, `100k`, `1m`, `5m` ou `prod-like`, plano de escala
LOAD-02) a população vem em SQL de massa, com cauda longa de Zipf, as 150 mil
paradas abertas e as filas assentadas (`load-tier-presets.test.ts` guarda os
números e o contrato entre o TypeScript e o SQL). Os
`mint-*.ts` criam as contas das suítes de navegador da web e do app. Medido em
07/10/2026 com a imagem de produção: o joelho é ~110–120 req/s por réplica com
histórico. Tudo em `tests/load/README.md`.

**API pública (plano de 02/11/2026, L10).** O que já é guardado por teste a
cada push: o plano de cada página de `/integration/v1` não varre o histórico
da empresa (`integration-events-plan` e `integration-updated-since-plan`, este
com 300 mil entregas: o `updated_since` de meia hora lê só a janela), a chave
é conferida com uma consulta só (`ensure-api-key-unit`), e cada exemplo de
resposta publicado em `/integration/docs` tem as mesmas chaves e tipos do corpo
real (`public-docs-contract`, "the published response examples"). O que
ainda é medido à mão, fora do horário de teste do cliente, e anotado aqui
com a data:

1. O harness com `LOAD_REPLICAS=2`: p95 e erros de `integrationDeliveries`
   (`lib/mix.js`), do POST idempotente e de `/events`.
2. No staging, uma chave a 2 req/s (o teto de 120/min) por 10 min: nenhum
   5xx, e 429 com `retry-after` só acima do teto.
3. No portal: abrir `/integration/docs` sem login, mandar uma requisição pelo
   console com uma chave de staging, gerar um cliente do `openapi.json`
   (openapi-generator) e compilá-lo. O `limit` sai `integer` (L2).

Ainda sem números registrados: os três pedem a imagem de produção, o staging
e ferramentas que não rodam no CI.

## Simulação do dia de entregas (`tests/simulation`)

Um dia inteiro do módulo de Entregas pela API HTTP de verdade, com os mesmos
cabeçalhos e corpos do app e da web: cinco motoristas (quatro por CPF e
senha, um pelo QR Code), cinco rotas de seis paradas saindo do CD da Vila
Leopoldina, GPS ao longo das ruas reais (geometria do OSRM sobre dados do
OpenStreetMap, ODbL), geocerca em ALERTAR, comprovantes por PUT
pré-assinado, "Cliente ausente", autorização da torre, 3 minutos sem sinal
com a fila do app, entrega adicionada em rota (K12), parada cancelada pelo
despacho e rota encerrada com pendências (K11). Os telefones se dividem entre
as réplicas (`SIM_API_URLS`) e a torre fica na réplica A: todo evento causado
pela réplica B tem de chegar lá.

```bash
npx tsx tests/simulation/scripts/prepare-database.ts   # o banco trajetto_sim, do zero
npx tsx tests/simulation/scripts/start-replicas.ts     # réplicas em 3341 e 3342
SIM_API_URLS=http://127.0.0.1:3341,http://127.0.0.1:3342 npx tsx tests/simulation/delivery-day.ts
```

Só escreve no banco `trajetto_sim` do container de teste (127.0.0.1:54321)
e só fala com réplicas desta máquina, nunca nas portas 3333 e 3001; o env
das réplicas sai das chaves do `.env.example`, com valores descartáveis, e
nenhum processo da simulação lê o `.env`: as réplicas e o Prisma CLI sobem
com `tests/simulation/lib/no-env-file.cjs` pré-carregado, porque o
dotenv-expand copiaria o valor do arquivo por cima de toda chave deixada
vazia. Tudo o que o telefone manda é horário de
parede; `SIM_SPEED` (padrão 8) acelera o caminhão e o tempo na porta. Toda
resposta fora do planejado vai para o log JSONL (`SIM_LOG`) e termina o
processo com código 1. O log alimenta o gravador da web
(`trajetto-ui/tests/simulation`, que filma a torre e tira uma foto a cada
marco) e um futuro replay. Os testes da própria simulação
(`npx vitest run --config tests/simulation/vitest.config.mts`) ficam fora do
CI; o typecheck cobre a pasta. Passo a passo, variáveis, cenas e o formato do
log em `tests/simulation/README.md`.

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
- O CI publica o relatório `coverage-<sha>` (14 dias) no job `Validate` do
  `validate.yml` (branches e staging); abaixo do piso, o `Gate` do staging
  fica vermelho e nenhuma imagem é construída.
- **E2E**: `yarn test:coverage:e2e` roda em lotes de 8 arquivos (cada lote
  escreve `coverage/e2e/NN`; um lote que morre sem relatório é refeito em duas
  metades) e, depois deles, os arquivos da fase de um arquivo por vez (os
  que sobem réplicas e os sensíveis ao cluster, `SERIAL_E2E_FILES`), um por
  lote (a mesma separação do `yarn test:e2e`); junta tudo em
  `coverage/e2e-only` e, com a unitária, em `coverage/all`. Rode numa árvore parada: o script recusa
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

| Teste                                                                    | Guarda                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle/promote-workflow.test.ts`                                     | build só no `staging` (push ou _Run workflow_ lá); tags só `sha-<sha>` (e `src-<hash>` na IA); PR para `main` exige o marcador `staged-<sha>` (ou a regra de documentação, por `staged-build.sh`); a promoção só a partir de `main`, resolve o 2º pai do merge (repetindo a API do GitHub que falha), valida a tag antes de tudo, decide o build pelo marcador ou pela regra de documentação antes de qualquer outro passo, nunca constrói, move `stable` por digest antes do deploy; deploy pulado com aviso sem os secrets do Dokploy e falha com configuração parcial                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lifecycle/release-migrations.test.ts`                                   | a etapa de release nos dois workflows: decide (o digest da imagem de migração contra `staging-applied`/`stable-applied`), move a tag do ambiente, roda pela Application `trajetto-api-migrate` e só depois grava `-applied`, tudo antes de a API ou a IA andar; as decisões executadas com o GHCR simulado (inclusive o build sem imagem de migração: pulado só se for anterior a ela); nada de `RUN_MIGRATIONS_ON_BOOT`, `MIGRATIONS_VIA_JOB` nem SSH                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lifecycle/dokploy-release.test.ts`                                      | o `dokploy-release.mjs` contra um Dokploy falso: recusa uma Application mal configurada antes de qualquer deploy (imagem, _Restart Policy_ `none`, _Health Check_, réplicas, `stop-first`); só tarefas novas contam (a antiga ociosa segue `Running` depois de um rollback); `Running`/`Complete` = sucesso, `Failed`/`Rejected`/`Orphaned` = falha com o motivo do Swarm; prazo sem interromper a etapa; nunca imprime a chave nem o Environment                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lifecycle/migrate-source.test.ts`                                       | a chave `src-<hash>` da imagem de migração: empacota os scripts que o entrypoint roda na etapa (como o tsup) e reprova se algum importar arquivo fora da lista do `migrate-source.sh`, ou se o estágio `migrate` copiar um; a chave muda com uma migration, um seed, um arquivo que ele importa, a planilha, o `yarn.lock` ou o entrypoint, e não muda com o resto da API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `E2E/schema-guard.test.ts`, `E2E/import-violation-codes.test.ts`         | contra um Postgres de verdade: a API recusa o banco a que falte qualquer migration do build (inclusive uma mais antiga que a mais nova aplicada, de um branch mesclado depois); o import de infrações da etapa de release é tudo ou nada (um lote que falha no meio sai com erro e deixa a tabela vazia, e a execução seguinte a preenche)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lifecycle/compose-rollout-verify.test.ts`                               | a conferência da convergência (o script, e a posição dela na ação `.github/actions/deploy` da API e da web, com o digest e o commit que o `Deploy` do `staging.yml` e do `production.yml` entrega); exatamente uma conferência por valor de `ROLLOUT_VERIFY` (o `Pick the rollout check` executado; liveness pública por padrão no staging, SSH na produção, nenhuma só com `off`); por SSH, uma chamada por serviço implantado na ordem do deploy (os papéis antes da API, a API, os de borda depois) e o `grace=` de cada um, com `ROLLOUT_REQUIRE_GRACE=true` reprovando a API e o PgBouncer abaixo de 40 s; um deploy por vez; staging só pelo head da branch                                                                                                                                                                                                                                                                                                                                                                                 |
| `lifecycle/supply-chain.test.ts`                                         | actions por SHA, bases por digest, audit (pelo `audit-gate.sh`), SBOM/proveniência, Trivy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lifecycle/secrets-hygiene.test.ts`                                      | gitleaks igual no `ci.yml`, no `staging.yml` e no `pr.yml`; nenhum build antes dele e do `Gate`; `.env*` fora do git                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lifecycle/compose-ci-siblings.test.ts`                                  | toda sonda `Pick the sibling branches` dos três repositórios, achada em todos os workflows e ações compostas de cada um (no formato antigo ou no novo), executada: a mesma branch quando o irmão a tem; só "a branch não existe" (código 2) cai na `staging`, com aviso; erro de rede repete e falha; todo checkout de irmão usa a resposta da sonda do mesmo job; todo checkout de outro repositório com a organização e o nome por extenso (sem expressão, em qualquer caixa); a da API ao pé da letra (3 tentativas, pausas de 10 e 20 s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lifecycle/migration-safety.test.ts`                                     | expandir/contrair nas migrations novas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lifecycle/migration-lock-timeout.test.ts`                               | todo `lock_timeout` das migrations, do `prisma/concurrent` e do `prisma/post-deploy` passa do `deadlock_timeout` padrão (1 s) ou é calculado dele: o Postgres só cancela um autovacuum que segura a tabela na checagem de deadlock de quem espera, e um `lock_timeout` do mesmo tamanho desiste antes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lifecycle/migration-prebuild.test.ts`                                   | o roteiro de pré-construir o índice com `CONCURRENTLY` nas migrations desta leva: tipos em `DO $$ ... EXCEPTION WHEN duplicate_object`, `ADD COLUMN IF NOT EXISTS` e o comentário dizendo para criar tipos e colunas antes; o par arquivo de `prisma/concurrent` e migration para índice novo em tabela quente; e, para a coluna que chega na mesma release do índice, o `-- requires-column` no arquivo e o índice na migration só com a tabela vazia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lifecycle/dokploy-deploy.test.ts`                                       | o script de deploy contra um Dokploy falso (`application.deploy` de uma Application por chamada; segue o deployment criado; repete o que termina em erro até 6 vezes com espera dobrando até o teto; cada retentativa — pedido, consulta ou deploy — é `::warning::` com a contagem, e o resumo do job lista cada tentativa que falhou com o motivo do Dokploy; escreve o motivo sem credenciais; id opcional vira aviso; nunca imprime a chave)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `lifecycle/staging-deploy-workflow.test.ts`                              | os passos do staging e da promoção executados com o GHCR simulado: a IA reaproveitada pelo hash de `infra/ai-ocr` e reimplantada só quando o digest muda (ou com `force_ai_build`); o GHCR sem resposta falha o passo em vez de virar "não existe"; cada tag `staging` movida logo antes do próprio deploy e devolvida quando o deploy falha; o marcador `staged-<sha>` escrito por último e exigido pelo PR e pela promoção, que espera até 20 min um deploy de staging em andamento                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lifecycle/wait-for-version.test.ts`                                     | a conferência pela liveness pública contra uma API falsa: passa só depois de o commit novo responder pela janela inteira, recomeça a janela quando uma réplica antiga responde, não recomeça numa sondagem sem resposta (5xx/52x, timeout, corpo que não é a liveness) e avisa com a contagem, aceita o `sha-<7>` da promoção, recusa build sem commit; a janela é maior que o monitor de rollback do Swarm                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `lifecycle/wait-for-roles.test.ts`                                       | a conferência por papel (plano de escala F3-31b) contra uma API falsa: passa só com cada papel de `ROLLOUT_ROLES_EXPECTED` no commit novo pela janela inteira, toda fila com consumidor, um processo com o cron e uma impressão só; `all` cobre api, worker e scheduler; reprova um worker que não sobe, Environments que divergem e um processo de outro ambiente; sem o token ou a variável não roda; um build anterior aos papéis e a rota que responde 404 são pulados com aviso                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lifecycle/shared-release-order.test.ts`                                 | a seção "Os três repositórios juntos" do `docs/deploy.md` (a que a web e o app copiam byte a byte) escreve as Applications na ordem em que a ação de deploy as implanta (os passos da `.github/actions/deploy` e as listas de papéis do `deploy-roles.sh`), nenhuma outra ordem delas, e as regras que essa ordem pede: a contração que espera em `prisma/post-deploy`, o `CLIENT_CONTRACT` e o `MIN_MOBILE_CONTRACT` (plano de escala X-43)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lifecycle/ci-stability.test.ts`                                         | um vermelho é sempre do código: todo job com `timeout-minutes`; `bash -eo pipefail` em todo workflow e todo `run:` com sintaxe válida; o Node da base do `Dockerfile` em todo `setup-node`; toda imagem dos jobs por digest, o mesmo digest em todo lugar; BuildKit fixado; `cache-to` com `ignore-error=true`; GHCR só pelo `ghcr.sh`; cache dos engines do Prisma e a conferência do engine antes do E2E; o download do banco do Trivy com cache e o scan que só reprova um achado (executados com `docker` simulado); a guarda de cabeça da ação de deploy; nenhum nome de job ou passo com `?`; todo job depois de um que roda apesar de um pulado (o `Gate`, o `validate.yml`) com `!cancelled()` e o resultado (ou uma saída) de cada job do `needs`; o `Result` do `validate.yml` executado em cada combinação e com todo job do arquivo no `needs`, e nenhum workflow lendo o resultado de quem chama o `validate.yml`; só a validação é cancelada por um push novo; o `Gate` e o que o `Build` espera; os workflows e as ações compostas |
| `lifecycle/ghcr-script.test.ts`                                          | `.github/scripts/ghcr.sh`: só o "not found" do GHCR é resposta vazia; erro passageiro repete com pausa dobrando e aviso com a contagem; persistente falha nomeando o GHCR; resposta ilegível não vira digest; mover tag repete e falha na hora se a origem não existe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lifecycle/staged-build.test.ts`                                         | `.github/scripts/staged-build.sh` contra um histórico git de verdade: o próprio commit com o marcador; o ancestral mais próximo com o marcador quando só documentação (`*.md`, `docs/**`) mudou desde ele; recusa (listando os arquivos) quando mudou outra coisa; marcador em outro digest recusado; GHCR fora falha em vez de "não rodou"; o `.dockerignore` sem `**/*.md` nem `docs/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lifecycle/audit-gate.test.ts`                                           | `.github/scripts/audit-gate.sh` contra um histórico git de verdade: bloqueia o push que muda `package.json`/`yarn.lock`/`package-lock.json` (em qualquer pasta) ou o `audit-ci.jsonc`, ou que não tem base; nos outros, a reprovação vira aviso e relatório no resumo; um audit que não rodou (rede) repete e nunca é lido como aviso                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lifecycle/image-layers.test.ts`                                         | as camadas das imagens: um arquivo de requisitos com hash por camada, na ordem em que mudam, cada pacote num só; os modelos da IA versionados em `infra/ai-ocr/models` (só o par que a roda não traz, nos hashes do `models.sha256`) e conferidos num `RUN --network=none`, copiados com `COPY --link`; o commit (`GIT_SHA`) declarado depois do último `RUN`; o `prisma generate` antes do `COPY . .`; a conferência do schema engine do Prisma nos dois `yarn install`, executada numa árvore                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `security/env-example.test.ts`                                           | o `.env.example` tem toda variável do env-schema                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `quality/coverage-config.test.ts`                                        | a configuração de cobertura e o piso no CI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `quality/e2e-replica-isolation.test.ts`                                  | os arquivos que sobem réplicas estão todos na lista da segunda fase do `yarn test:e2e`, e só eles; as fases do `vite.config.mts` e do `infra/scripts/run-e2e.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `quality/e2e-infra-isolation.test.ts`                                    | a fase infra: os arquivos de `tests/E2E/infra` só nela, um por vez, no ambiente `node`, sem `skip`, só pelas URLs do `infraUrl` (que falha sem URL, fora do loopback ou no cluster compartilhado); o `run.sh` só remove o que leva o label dele; o CI roda a fase só no job 1, depois da fatia, com a imagem do PgBouncer do commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `quality/e2e-shards.test.ts`                                             | os jobs `E2E (i/n)` do `validate.yml` rodam cada arquivo E2E exatamente uma vez, pelo sequenciador do próprio Vitest; nenhum job vazio; a fase de réplicas inteira no último                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `env/prisma-test-template.test.ts`, `E2E/test-database-template.test.ts` | o nome do banco molde muda com o que o `migrate deploy` lê e só com isso; o construtor migra sob o _advisory lock_ e marca o molde só depois da última migration, refaz um molde não marcado, poda os de outras chaves (nunca o próprio), não marca um molde cujo migrate falhou e constrói uma vez só com vários arquivos ao mesmo tempo; o banco de um arquivo E2E tem todas as migrations, o `pg_trgm`, e o molde marcado sem conexões                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lifecycle/changes-script.test.ts`                                       | `.github/scripts/changes.sh` contra um histórico git de verdade: push só de documentação, código, sem intervalo; na branch, a branch inteira desde que saiu da staging decide (um push de documentação por cima de código ainda valida o código); a base do audit no último build servido pela staging (um push cancelado fica no intervalo; sem login no GHCR, o push anterior), na branch o ponto em que saiu da staging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lifecycle/check-gate.test.ts`                                           | `.github/scripts/check-gate.sh` com o `gh` simulado: só o `Gate` concluído com sucesso de um run do `staging.yml` na branch `staging` passa (de outro workflow ou branch, não); o job antigo vale para builds antigos, só do `deploy.yml`; um `Gate` em andamento ou ausente é "ainda não" e pode ser esperado; a API do GitHub sem resposta falha como do GitHub, nunca como Gate vermelho                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `quality/outbound-network-guard.test.ts`                                 | a trava de rede dos testes: loopback e bancos configurados passam; o resto é recusado antes do DNS e lembrado para falhar o arquivo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mail/mail-provider-for.test.ts`                                         | o transporte de e-mail por `NODE_ENV`: a caixa em memória só com `test`, e ela se recusa a existir com outro valor ou num build feito para produção                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## O que roda onde (local × CI)

|                               | Local (antes de dizer "pronto")                                        | `ci.yml` (branch)                                          | `staging.yml` (push em `staging`)                                   |
| ----------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| typecheck                     | `yarn prisma:generate && yarn typecheck`                               | sim                                                        | sim                                                                 |
| unitários + piso              | `yarn test` (ou o arquivo tocado)                                      | sim, com cobertura                                         | sim, com cobertura                                                  |
| E2E                           | os arquivos tocados, contra o Postgres descartável                     | só _Run workflow_ com **e2e**                              | **sim**, a suíte inteira, em 3 jobs paralelos                       |
| E2E, fase infra               | `yarn test:e2e:infra` quando mexer no PgBouncer, no standby ou no pool | junto com o E2E, no job 1                                  | **sim**, no job 1                                                   |
| lint, build                   | ficam com o CI                                                         | lint                                                       | lint (o build é o da imagem)                                        |
| audit, gitleaks, pytest da IA | —                                                                      | sim (o audit bloqueia só quando a branch muda dependência) | sim (bloqueia quando muda dependência desde o último build servido) |
| push só de documentação       | —                                                                      | gitleaks e `Docs` (unitários sem cobertura)                | gitleaks e `Docs`, sem build nem deploy                             |
| contrato com a IA real        | opt-in                                                                 | só _Run workflow_                                          | não                                                                 |
| carga, mutação                | sob demanda                                                            | não                                                        | não                                                                 |
| simulação do dia de entregas  | sob demanda                                                            | não                                                        | não                                                                 |

O PR `staging → main` (`pr.yml`) não roda nada disso de novo: confere o
`staged-<7>`, o `Gate` do staging e que a `main` só traz documentação.

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
   relógio do servidor; datas `@db.Date` como `YYYY-MM-DD`. Um instante que
   precisa cair "hoje" deriva da meia-noite da empresa, não de um
   deslocamento fixo: "6 horas atrás" cai no dia anterior entre 00:00 e 06:00
   de São Paulo (`query-plans.test.ts`).
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
13. **Valor único em seed sem sorteio de poucos bits.** Coluna única (razão
    social, CNPJ, CPF, CNH, placa) recebe o id inteiro ou um contador do
    arquivo, nunca uma fatia de um id aleatório nem um número sorteado de
    poucos dígitos: cinco empresas com o último caractere do id colidiam em
    quase metade das execuções (`ai-usage-http.test.ts`, CI de 04/11/2026).

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
  (senha `WEB_E2E_PASSWORD`). As suítes de navegador da web (os jobs
  `Browser suites (1/2)` e `(2/2)` do `trajetto-ui/.github/workflows/validate.yml`,
  passo `Prepare the API`, num push de código em staging e no _Run workflow_
  do `ci.yml` com `image_tag`) rodam os três nessa ordem. A API sobe ali
  com `NODE_ENV=test`, então o 2FA e a criação de usuário guardam o e-mail na
  caixa em memória do processo: nenhuma rede de saída. Detalhes em `trajetto-ui/docs/testes.md`.
- **App (Maestro)**: a suíte do app (`trajetto-mobile/docs/testes.md`) entra
  com as contas que o `seed.ts` cria com `LOAD_MOBILE_E2E=1`
  (`MOBILE_E2E_EMAIL`, `MOBILE_E2E_PASSWORD`, `MOBILE_E2E_TWOFA_EMAIL`,
  `MOBILE_E2E_NOFLEET_EMAIL`, `MOBILE_E2E_CHECKLIST_EMAIL`,
  `MOBILE_E2E_GEOFENCE_BLOCK_EMAIL`, `MOBILE_E2E_GEOFENCE_ALERT_EMAIL`). As
  três últimas são das empresas de configuração: "E2E Checklist" (Frotas +
  Entregas, `checklist_requirement` `ROUTE_START_AND_END`), "E2E Geocerca
  Bloquear" (`BLOCK`, raio de 500 m, duas paradas com ponto `MANUAL` e uma
  sem ponto, `geocode_status` `NOT_FOUND`) e "E2E Geocerca Alertar"
  (`ALERT`, raio de 500 m).
- **Contrato de rotas**: `tests/unitaires/contract/client-routes.test.ts` lê
  as URLs que a web e o app constroem (`../trajetto-ui`, `../trajetto-mobile`)
  e falha se alguma não existir na API. No app, lê as chamadas de
  `apiClient` com o caminho escrito (`get`, `post`… e `request`, por onde
  passa a maior parte) e as que passam uma constante `const NOME = "/caminho"`
  (o `MAP_CONFIG_PATH` do `GET /config/map`, onda 5).
- **Modelo de tiles do app**: `tests/unitaires/map/map-tiles.test.ts` tem
  uma tabela de paridade com os modelos que o app aceita e recusa
  (`isTileTemplate` de `trajetto-mobile/features/live-map/map-config-rules.ts`)
  e, com `../trajetto-mobile` presente, roda a mesma tabela contra a função
  do app: uma regra apertada só no app aparece aqui, e não como mapa sem
  fundo em campo. A função vem de uma cópia do arquivo fora do app: o
  checkout do app no CI não tem `node_modules`, e o `tsconfig.json` dele
  estende o `expo/tsconfig.base`, que está neles. Por isso o arquivo do app
  não pode importar nada em tempo de execução (só tipos), e o mesmo teste
  confere isso.
- **Jornada da pausa**: `tests/unitaires/driver-pause/fixtures/pause-journey-cases.json`
  são os casos de "pausa liberada agora" (decisão 14.4, revista em
  12/11/2026: só com a rota iniciada) que `pause-journey-rules.test.ts` roda
  aqui. O app guarda uma cópia (`trajetto-mobile/tests/fixtures/`) e o
  `pause-journey-parity.test.ts` dele confere que ela é igual a esta (pulado
  sem a API ao lado) e roda o portão do botão "Pausa" sobre cada caso. Mude
  um caso só junto com a cópia, e a API sobe antes: o CI do app lê a
  `staging` da API.
