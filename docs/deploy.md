# Deploy da API — staging e produção

> Documento de referência do caminho de um commit até a produção, e da
> operação do que está no ar: os workflows do GitHub Actions, as imagens no
> GHCR, as Applications e os Databases no Dokploy (Docker Swarm), o serviço de
> IA, o banco, o Redis, o backup, a borda (Cloudflare e Traefik), as
> migrations, o rollback e os alertas. Vive dentro do `trajetto-api` porque
> descreve arquivos deste repositório (`.github/workflows/`, `.github/scripts/`,
> `infra/`) e precisa mudar junto com eles.
>
> Documentos irmãos: [`arquitetura.md`](./arquitetura.md) (como o sistema é
> por dentro), [`variaveis-de-ambiente.md`](./variaveis-de-ambiente.md) (cada
> variável, para que serve e onde mora), [`testes.md`](./testes.md) (o que a
> validação do pipeline roda) e [`infraestrutura.md`](./infraestrutura.md) (o
> mapa das contas e dos painéis — Contabo, Dokploy, Cloudflare, GitHub, Expo,
> Resend —, o que foi configurado à mão em cada um e por quê). A web tem o próprio guia em
> `trajetto-ui/docs/deploy.md`; o app, em `trajetto-mobile/docs/deploy.md`.

## Sumário

1. [Visão geral](#1-visão-geral)
2. [Branches e pull requests](#2-branches-e-pull-requests)
3. [Os workflows em detalhe](#3-os-workflows-em-detalhe)
4. [A topologia no servidor](#4-a-topologia-no-servidor)
5. [Applications em vez de Compose: o que mudou e o que ficou de fora](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)
6. [Preparar o servidor (uma vez)](#6-preparar-o-servidor-uma-vez)
7. [Montar o Dokploy do zero (staging e produção)](#7-montar-o-dokploy-do-zero-staging-e-produção)
8. [Primeiro deploy, na ordem, com conferências](#8-primeiro-deploy-na-ordem-com-conferências)
9. [O serviço de IA (`trajetto-ai`)](#9-o-serviço-de-ia-trajetto-ai)
10. [Postgres e Redis](#10-postgres-e-redis)
11. [Domínios, TLS e a borda](#11-domínios-tls-e-a-borda)
12. [Health checks](#12-health-checks)
13. [Configurar o GitHub](#13-configurar-o-github)
14. [Conferir a convergência](#14-conferir-a-convergência)
15. [Migrations](#15-migrations)
16. [Promover para produção](#16-promover-para-produção)
17. [Rollback](#17-rollback)
18. [Backup e restauração](#18-backup-e-restauração)
19. [Papéis da mesma imagem](#19-papéis-da-mesma-imagem)
20. [Alertas e monitoramento](#20-alertas-e-monitoramento)
21. [Cadeia de suprimentos e segredos](#21-cadeia-de-suprimentos-e-segredos)
22. [Bucket R2 e retenção no GHCR](#22-bucket-r2-e-retenção-no-ghcr)
23. [Recursos da VPS e logs](#23-recursos-da-vps-e-logs)
24. [Migrar do Portainer para o Dokploy](#24-migrar-do-portainer-para-o-dokploy)
25. [Checklist do primeiro deploy](#25-checklist-do-primeiro-deploy)
26. [Os três repositórios juntos](#26-os-três-repositórios-juntos)
27. [PITR com pgBackRest](#27-pitr-com-pgbackrest)

---

## 1. Visão geral

```
branch de trabalho ──push──▶ ci.yml: Changes ─▶ Secret scan + Validate (validate.yml, sem E2E; E2E só no Run workflow)
        │
        └─ merge/push ─▶ staging ──▶ staging.yml
                                     ├─ Changes: só documentação? (então só Secret scan e Docs, sem build)
                                     ├─ Secret scan + Validate (validate.yml), em paralelo:
                                     │    Validate (audit, lint, tsc, unitários + piso) · E2E (1/3) · E2E (2/3) · E2E (3/3) · AI OCR
                                     ├─ Gate (tudo acima verde; é o check que o PR e a promoção conferem)
                                     ├─ Build: as 3 imagens UMA vez ─▶ GHCR  sha-<7>  (imutável)
                                     │  (API, migração e IA; a migração e a IA são reaproveitadas, sem rebuild, se o que rodam não mudou)
                                     ├─ Image scan (Trivy, por digest)
                                     └─ Deploy (environment staging, ação .github/actions/deploy):
                                          migrations, só se o banco não aplicou essa imagem (Application trajetto-api-migrate)
                                          ─▶ trajetto-ai (só se o digest mudou) ─▶ trajetto-api, cada tag `staging` movida por digest
                                          ─▶ a API pública responde este commit (/health/liveness)
                                          ─▶ marcador staged-<7> (o que o PR e a promoção exigem)

PR staging → main ──▶ pr.yml: Secret scan + Staging evidence (staged-<7>, Gate verde, a main só traz documentação)
                      Não valida de novo: o staging já validou o commit que o merge promove.

merge em main ──▶ production.yml: PROMOÇÃO (sem build)
                  ├─ Staging evidence: o build do commit mergeado (2º pai do merge commit), staged-<7>, Gate, digests
                  ├─ Deploy [aprovação do environment production] (a mesma ação do staging, com `stable`):
                  │    migrations, se preciso ─▶ trajetto-ai ─▶ trajetto-api ─▶ convergência (Swarm por SSH)
                  └─ Release (tag semver, CHANGELOG, GitHub Release)

Run workflow do Production na main ──▶ a mesma promoção com uma tag antiga: o botão de ROLLBACK
Run workflow do Staging ──▶ o caminho de staging de novo (force_ai_build: testa, reconstrói e reimplanta a IA)
```

Princípios que não mudam:

- **Uma imagem por serviço para os dois ambientes, construída uma vez e
  promovida por digest** (decisão 12.2). A API lê toda a configuração em
  tempo de execução: staging e produção diferem só no _Environment_ de cada
  Application no Dokploy. O que o staging validou é, byte a byte, o que a
  produção roda.
- **Três imagens**, construídas (ou reaproveitadas) no mesmo job e
  promovidas juntas (o backup do banco não tem imagem: é o do próprio
  Dokploy, [seção 18](#18-backup-e-restauração)):

  | Imagem                                               | De onde                                     | Para quê                                                                                                                    | Application no Dokploy                                                |
  | ---------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
  | `ghcr.io/trajetto-organization/trajetto-api`         | `Dockerfile` (estágio `runner`)             | a API (HTTP, Socket.IO, workers, crons); **nunca migra**                                                                    | `trajetto-api`                                                        |
  | `ghcr.io/trajetto-organization/trajetto-api-migrate` | `Dockerfile` (estágio `migrate`)            | a etapa de release: `prisma migrate deploy` e os seeds, antes do rollout, só quando o banco ainda não aplicou aquela imagem | `trajetto-api-migrate`, uma por ambiente ([seção 15](#15-migrations)) |
  | `ghcr.io/trajetto-organization/trajetto-ai`          | `infra/ai-ocr/Dockerfile` (stage `runtime`) | o OCR local das leituras de IA                                                                                              | `trajetto-ai`                                                         |

  A imagem da API roda em Alpine com só o binário do `node` da imagem
  oficial (sem npm, yarn, corepack nem os headers de C) e só os pacotes que
  os binários usam (`libstdc++`, `libssl3`, `ca-certificates`, `dumb-init`;
  `libssl3` e `ca-certificates` servem ao schema engine da imagem de
  migração, que usa a mesma base). Ela **não traz o CLI do Prisma**, o
  schema, as migrations nem os seeds: só a lista das migrations do build
  (`build/schema-version.json`), e o boot recusa um banco a que falte
  qualquer uma delas. O estágio
  `prod-deps` instala só as `dependencies` (de um manifesto derivado do
  `package.json`, com o `yarn.lock` como está; o `prisma` é
  `devDependency`) e tira o que nada carrega em execução (sourcemaps,
  typings, READMEs, `@types`, o bundle de navegador do ExcelJS e os
  compiladores de query de todos os bancos: o cliente gerado traz o próprio
  compilador de PostgreSQL). As camadas vão da mais estável para a menos
  estável: um commit só de código reenvia só `build/` (~1 MB comprimido).

  A imagem de migração é a da API mais, em camadas por cima, a árvore
  própria do CLI (`/app/migrate/node_modules`, do estágio `migrate-deps`:
  `prisma`, `dotenv`, `dotenv-expand`, sem o `pglite` do `prisma dev` nem os
  compiladores da CLI; `@prisma/studio-core` e `@prisma/dev` ficam porque a
  CLI os carrega na partida), o `prisma.config.ts`, o schema, as migrations,
  os seeds e a tabela de infrações. O servidor baixa só essas camadas para
  rodar a etapa. O comando padrão dela (`release`) migra, roda os seeds e
  fica parado; o `HEALTHCHECK` dela só passa depois disso, e é assim que o
  Swarm diz se a etapa terminou ([seção 15](#15-migrations)). Ela só é
  reconstruída quando muda o que roda (tag `src-<hash>`, como a da IA).

  Medido em 31/10/2026, Prisma 7.10.1: a imagem da API foi de 431 para
  **239 MB** descompactados e de 114,8 para **~68 MB** comprimidos (o que o
  registry transfere; o `node_modules` dela, de 317 para 91 MB). A de
  migração soma ~170 MB descompactados por cima. Antes, em 28/10/2026, no
  Prisma 6.1: 115 → 88 MB comprimidos, 417 → 285 MB descompactados
  ([ADR 0011](./adr/0011-orm-prisma-6-7-8.md#integração-sobre-a-staging)).

- **Tags**:

  | Tag                                                                                                                             | Quem cria/move                                                                                                                                              | Muda?                                                                                                                  |
  | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | `sha-<7 primeiros do commit>`                                                                                                   | o build de cada push em `staging`                                                                                                                           | **nunca** (imutável)                                                                                                   |
  | `staging`                                                                                                                       | o Deploy do `staging.yml` (job `deploy-staging`), por digest                                                                                                | a cada push em `staging`                                                                                               |
  | `staged-<7>`                                                                                                                    | o Deploy do `staging.yml`, **por último**: depois do scan, do deploy e da conferência                                                                       | nunca; sem ele o PR e a promoção recusam o commit (salvo um commit só de documentação, que usa o de um ancestral)      |
  | `src-<hash git de infra/ai-ocr>` (só `trajetto-ai`)                                                                             | o build da IA                                                                                                                                               | nunca; é por ela que um push acha a imagem da IA de mesmo código e a reaproveita                                       |
  | `src-<hash de migrate-source.sh>` (só `trajetto-api-migrate`)                                                                   | o build da imagem de migração                                                                                                                               | nunca; é por ela que um push sem mudança nas migrations, nos seeds e no que eles rodam reaproveita a imagem            |
  | `staging-applied`, `stable-applied` (só `trajetto-api-migrate`)                                                                 | o Deploy de cada ambiente (`.github/actions/deploy`), **depois** de a etapa de release terminar                                                             | a cada etapa que roda; dizem qual imagem de migração o banco do ambiente já aplicou, e a etapa é pulada se for a mesma |
  | `stable`                                                                                                                        | o Deploy do `production.yml` (job `promote-production`), por digest                                                                                         | a cada promoção ou rollback                                                                                            |
  | `staging-<papel>`, `stable-<papel>` (só `trajetto-api`; papel = `worker`, `scheduler`, `worker-external`, `ingest`, `realtime`) | o Deploy de cada ambiente (`.github/scripts/deploy-roles.sh`), por digest, logo antes do deploy daquela Application; sem a Application, no fim do run verde | a cada deploy; sempre o digest da API do mesmo run (plano de escala F3-31a)                                            |
  | `main-<sha>`                                                                                                                    | builds antigos, de antes da branch `staging`                                                                                                                | nunca; aceitos só como alvo de rollback                                                                                |

  Não existem `latest`, `main` nem `pr-*`. As Applications de produção rodam
  `stable`; as de staging, `staging` (a `trajetto-api-migrate` também). O pipeline **nunca** muda a imagem
  configurada numa Application: ele move a tag no GHCR e pede ao Dokploy um
  novo deploy, que puxa a tag de novo.

- **O Dokploy dizer `done` não é convergência.** `done` quer dizer que o
  Dokploy puxou a imagem e o Swarm **aceitou** a nova especificação do
  serviço. A troca das réplicas acontece depois, e uma imagem que falha no
  healthcheck é revertida pelo próprio Swarm. Por isso o deploy da API tem um
  passo seguinte que espera o estado real: no staging, a liveness pública
  responder o commit deste build; na produção, o Swarm por SSH
  ([seção 14](#14-conferir-a-convergência)).
- **Só vai para a produção o que o staging rodou.** O `sha-<7>` existe assim
  que o build sobe, mesmo que o scan, o deploy de staging ou a conferência
  falhem depois; o marcador `staged-<7>` só é escrito quando tudo isso passou,
  e o check do PR e a promoção o exigem no mesmo digest. A única exceção é um
  commit que só muda documentação: ele vai com o build do commit mais
  próximo que o staging rodou, que tem o mesmo conteúdo de imagem
  ([seção 16](#16-promover-para-produção), "Commits só de documentação").
- **Antes de o Dokploy existir, nada quebra.** Sem os secrets do Dokploy nos
  environments do GitHub, os jobs movem as tags (`staging`, `stable`) e pulam
  o deploy com um aviso (`::notice::`). Configuração parcial (um secret
  obrigatório sim, outro não) falha o job, para não parecer "ainda não
  configurado".

## 2. Branches e pull requests

| Branch                | Papel                                                              | Quem escreve                                            |
| --------------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `feat/...`, `fix/...` | trabalho                                                           | qualquer pessoa; o `ci.yml` valida cada push            |
| `staging`             | integração; todo push vira imagem e vai para o ambiente de staging | merge das branches de trabalho (ou push direto do dono) |
| `main`                | produção; só recebe PR **de `staging`**                            | merge do PR, com aprovação                              |

O fluxo normal:

1. Trabalhe numa branch e faça push: o `ci.yml` roda (a validação sem o E2E;
   o E2E inteiro só por _Run workflow_ com **e2e** marcado).
2. Leve para `staging` (PR para `staging` ou merge/push). O `staging.yml`
   roda a validação completa (com o E2E em 3 jobs paralelos), constrói as
   imagens e faz o deploy do staging. Um push só de documentação roda o
   secret scan e o job `Docs`, e não constrói nada.
3. Confira o staging ([seção 16](#16-promover-para-produção), "O que conferir
   no staging").
4. Abra o PR `staging → main`. O PR **não valida de novo** (o staging já
   validou o commit que o merge promove; o merge ref que um PR testaria nem é
   o que vai para a produção). O check _Staging evidence_ confirma três
   coisas: a `main` só traz documentação que o head não tem; o staging
   **rodou** o commit do head (o marcador `staged-<7>` das duas imagens, no
   mesmo digest de `sha-<7>`; espera até 45 min, porque o PR costuma abrir
   enquanto o staging ainda constrói e implanta o mesmo commit); e o `Gate`
   do run de staging desse build está verde. Um commit cujo scan, deploy de
   staging ou conferência falhou tem a imagem, mas não o marcador, e o check
   falha. Um head que só muda documentação desde um commit que o staging
   rodou passa com o marcador (e o `Gate`) desse commit
   ([seção 16](#16-promover-para-produção), "Commits só de documentação").
5. **Merge com "Create a merge commit".** Nunca _Squash and merge_ nem
   _Rebase and merge_: os dois criam um commit que o staging nunca construiu,
   e a promoção falha de propósito ("não passou pelo pipeline de staging"). O
   merge commit também preserva os SHAs que a baseline do gitleaks usa. Para
   não errar, deixe só essa opção ligada ([seção 13](#13-configurar-o-github),
   "Proteção das branches").
6. O push em `main` dispara a promoção (`production.yml`): o _Staging
   evidence_ confere tudo antes, e o job _Deploy_, com revisores
   obrigatórios no environment `production`, espera a aprovação.

**Mudança que atravessa repositórios** (uma rota nova que a web chama, um
evento de socket que o app ouve): uma branch com **o mesmo nome** em cada
repositório. O contrato de rotas da API (a ação `.github/actions/siblings`,
passo _Pick the sibling branches_, no `Validate` e no `Docs` do
`validate.yml`) testa a branch contra a web e o app de mesmo nome, e as
sondas da web e do app fazem o mesmo com a API; sem branch de mesmo nome, a
sonda usa a `staging` do irmão. A regra, com o mesmo texto nos três manuais,
está na [seção 26, "O CI dos três"](#o-ci-dos-três-desde-10112026).

**Hotfix**: a mesma estrada, mais curta — branch `fix/...` → `staging`
(espera o verde) → PR `staging → main`. Não existe caminho que pule o
staging, porque a produção só roda imagens construídas lá.

**Depois de cada release**: o `semantic-release` faz um commit
`chore(release): x.y.z` (com a marcação de pular CI do próprio
`@semantic-release/git`) com o `CHANGELOG.md` em `main`. Traga `main` de
volta para `staging` de vez em quando (`git merge origin/main` em
`staging`) para as duas não divergirem. Como esse merge só traz o
`CHANGELOG.md`, o `staging.yml` o classifica como documentação: roda o
secret scan e o `Docs`, sem build e sem deploy
([seção 16](#16-promover-para-produção), "Commits só de documentação").

O Dependabot abre os PRs dele contra `staging` (`target-branch: staging` em
`.github/dependabot.yml`), pelo mesmo motivo.

## 3. Os workflows em detalhe

### O mapa

Desde 10/11/2026 o CI/CD da API está em um arquivo por gatilho, com a mesma
forma e os mesmos nomes nos três repositórios. A validação está num
workflow reutilizável só (`validate.yml`), que o `ci.yml` e o `staging.yml`
chamam; o setup e o deploy são ações compostas.

| Arquivo                    | Gatilho                                                                                          | Jobs (o nome do check)                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`                   | push em branch de trabalho (todas menos `main`, `master` e `staging`); _Run workflow_ (`e2e`)    | `Changes` → `Secret scan` + `Validate` (o `validate.yml`, sem E2E; no _Run workflow_, com o E2E se pedido e o `AI local contract (manual)`)                                                                                |
| `staging.yml`              | push em `staging`; _Run workflow_ **na `staging`** (`force_ai_build`; em outra branch nada roda) | `Changes` → `Secret scan` + `Validate` (o `validate.yml`, com E2E) → `Gate` → `Build` → `Image scan` → `Deploy`                                                                                                            |
| `validate.yml`             | `workflow_call` (do `ci.yml` e do `staging.yml`)                                                 | `Validate`, `E2E (1/3)`, `E2E (2/3)`, `E2E (3/3)`, `AI OCR`; num push só de documentação, só `Docs`; no _Run workflow_ do `ci.yml`, também `AI local contract (manual)`; depois de todos, `Result` (o veredito da chamada) |
| `pr.yml`                   | pull request para `main`                                                                         | `Secret scan`, `Staging evidence`                                                                                                                                                                                          |
| `production.yml`           | push em `main`; _Run workflow_ (o rollback: `image_tag`, `force_ai_build`)                       | `Staging evidence` → `Deploy` (a aprovação do environment `production`) → `Release` (só no push)                                                                                                                           |
| `cloudflare-ranges.yml`    | toda segunda, 06:00 de São Paulo; _Run workflow_                                                 | `Cloudflare ranges` ([seção 6.1](#61-firewall-da-vps-contabo))                                                                                                                                                             |
| `.github/actions/setup`    | ação composta                                                                                    | Node `22.21.1` com o cache do yarn, o cache dos engines do Prisma, `yarn install --frozen-lockfile`, o schema engine (no E2E) e o `prisma generate`                                                                        |
| `.github/actions/deploy`   | ação composta, chamada pelo `Deploy` do `staging.yml` e do `production.yml`                      | o deploy de um ambiente, igual nos dois (abaixo)                                                                                                                                                                           |
| `.github/actions/siblings` | ação composta, chamada pelo `Validate` e pelo `Docs`                                             | a web e o app ao lado da API (`../trajetto-ui`, `../trajetto-mobile`), na branch de mesmo nome ou na `staging` deles: o contrato de rotas e os links da documentação os leem                                               |

Na tela do GitHub, um job de workflow reutilizável aparece com o nome do job
que o chamou na frente: `Validate / Validate`, `Validate / E2E (1/3)`,
`Validate / AI OCR`, `Validate / Docs`, `Validate / Result`. Os nomes são afirmações curtas, em
inglês, iguais nos três repositórios quando é a mesma coisa, e nunca
perguntas (o `ci-stability.test.ts` recusa `?` em nome de job ou de passo).

### `ci.yml` — branch de trabalho

Um push novo na mesma branch cancela o run anterior, e pode: o run novo
valida tudo o que a branch muda desde que saiu da `staging`, um push de
documentação por cima de um de código inclusive. Sem imagem e sem deploy: a
pergunta é só "esse código pode ir para o staging?".

| Job                          | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Changes`                    | `.github/scripts/changes.sh branch`: a branch **inteira** (do ponto em que saiu da `staging` ao commit, `docs-only.sh`) só muda documentação? Não o push sozinho: como um push novo cancela o run anterior, um push de documentação por cima de um de código ainda valida o código. _Run workflow_ roda tudo. A base do audit é o mesmo ponto (o que a branch muda). O job `Postgres image` do `validate.yml` só roda quando a branch muda `infra/postgres` desde a `staging` (ou sem intervalo para comparar), e o `PgBouncer image`, do mesmo jeito, quando ela muda `infra/pgbouncer` |
| `Secret scan`                | gitleaks em todo o histórico, imagem fixada por digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Validate`                   | o `validate.yml` com `e2e` só no _Run workflow_ com **e2e** marcado (os 3 jobs de E2E, uns 30 min cobrados); num push só de documentação, só o `Docs`                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AI local contract (manual)` | job do `validate.yml` (`ai_local`), ligado só no _Run workflow_ do `ci.yml`: o contrato da API contra o contêiner real de IA (`tests/ai-local`), com o mesmo `env` de teste dos outros jobs                                                                                                                                                                                                                                                                                                                                                                                              |

### `validate.yml` — a validação, num lugar só

Todos os jobs correm em paralelo, e o `Result`, depois deles, dá o veredito
da chamada: a saída `passed`, que o `Gate` do `staging.yml` lê.

| Job                                   | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Validate`                            | serviço `redis:7-alpine` por digest (um teste unitário do adapter do Socket.IO precisa dele); checkout com histórico completo (o teste de rotas aposentadas compara com `origin/main`); os repositórios irmãos pela ação `.github/actions/siblings` (`trajetto-ui` e `trajetto-mobile`, na branch de mesmo nome quando ela existe lá, senão na `staging` deles) para o contrato de rotas, se o secret `CLIENT_REPOS_READ_TOKEN` existir — só "a branch não existe" (código 2 do `git ls-remote`) cai na `staging`, com aviso; erro de rede repete 3 vezes e falha. No push em `staging` o contrato roda contra a `staging` da web e do app (antes ele era pulado ali). Depois a ação `setup`; auditoria de dependências (`audit-gate.sh`, com a base que o `Changes` escolheu); Prettier; `tsc` (heap fixo de 4 GB); unitários com o piso de cobertura (`yarn test:coverage`, 2 processos); publica `coverage-<sha>`                                                                                                                                                                                                                                                                                     |
| `E2E (1/3)`, `E2E (2/3)`, `E2E (3/3)` | serviços `postgres:16-alpine` (com `max_connections=200` e o `pg_stat_statements` pré-carregado, por `ALTER SYSTEM` e restart) e `redis:7-alpine`, um par por job; a ação `setup` conferindo o schema engine; `yarn test:e2e` com `E2E_SHARD=<i>/3` (`infra/scripts/run-e2e.mjs`): os jobs 1 e 2 dividem a fase `shared` com o `--shard` do próprio vitest (1/2 e 2/2), e o job 3 roda a fase de réplicas inteira, um arquivo por vez. O job 1, depois da fatia dele (mesmo vermelha), roda a fase infra (`yarn test:e2e:infra`, plano de escala F4-38): `tests/E2E/infra` contra um PgBouncer de verdade (a imagem de `infra/pgbouncer` do próprio commit, construída ali com o cache dos jobs do PgBouncer) e um standby em streaming, numa pilha própria que `tests/E2E/infra/run.sh` sobe e apaga ([`testes.md`](./testes.md#a-fase-infra-yarn-teste2einfra)). Cada job migra o banco molde uma vez e clona um banco por arquivo ([`testes.md`](./testes.md#e2e-testse2e)), com 2 processos. O resumo do job traz arquivos, testes e duração de cada fase. Um job vermelho não para os outros (`fail-fast: false`). O `e2e-shards.test.ts` confere que a matriz roda cada arquivo exatamente uma vez |
| `AI OCR`                              | o pytest do serviço de IA dentro da imagem (stage `test`, Buildx com cache do GitHub no escopo `ai-test`; o build só fala com o Docker Hub e o PyPI). Pulado quando o GHCR já tem `trajetto-ai:src-<hash git de infra/ai-ocr>`: essa imagem só foi construída depois de o mesmo pytest passar nos mesmos arquivos. O GHCR sem resposta não é "não tem": o job avisa e testa — inclusive quando é o login que falha (`ghcr.sh login`, que repete; o `docker/login-action` derrubava o job antes da alternativa). `force_ai_build` testa sempre                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Postgres image`                      | a imagem do Database (`infra/postgres`, plano de escala F1-01/F1-03), só quando o `Changes` diz que a fonte não tem imagem publicada (`postgres`), e de novo pulado se o próprio job acha `trajetto-postgres:src-<hash git de infra/postgres>` no GHCR. Roda o stage `test` (sem rede: os parâmetros lidos de volta com `SHOW`, um PITR de ida e volta e o descarte da fila num repositório posix, e o `trajetto-backup` e o `trajetto-restore-drill` de verdade) e a prova S3 (`infra/postgres/test/s3-proof.sh`): a imagem, pelo digest local, contra uma MinIO fixada por digest, com TLS, URL em path style e região `auto`, como no R2 (stanza, arquivamento, check, full e diff, archive-get e o ensaio até um instante com uma chave só de leitura). Buildx com cache do GitHub no escopo `postgres-test`, que o `Build` também lê. Timeout de 25 min                                                                                                                                                                                                                                                                                                                                             |
| `PgBouncer image`                     | a imagem do PgBouncer (`infra/pgbouncer`, plano de escala F4-34/F4-35), pela mesma regra: só quando o `Changes` diz que a fonte não tem imagem publicada (`pgbouncer`), e de novo pulado se o próprio job acha `trajetto-pgbouncer:src-<hash git de infra/pgbouncer>` no GHCR. Roda o stage `test`: o PgBouncer de verdade, sem rede e com o usuário da imagem, a partir do `entrypoint.sh` que ela leva, com cada valor lido de volta pelo console (`SHOW CONFIG`, `SHOW DATABASES`). Buildx com cache do GitHub no escopo `pgbouncer-test`, que o `Build` também lê. Timeout de 15 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Docs`                                | só num push de documentação: os irmãos (a mesma ação do `Validate`), o Prettier (`yarn lint:check`, que lê `*.md` e `docs/`) e os unitários sem cobertura (`yarn test`), porque há testes que leem a documentação (`tests/unitaires/docs`, os guias de agente, as seções deste guia) e os links dela para os irmãos. Um vermelho cai no commit que o causou, não no próximo push de código                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `AI local contract (manual)`          | só com `ai_local` (o _Run workflow_ do `ci.yml`): `tests/ai-local` contra o contêiner real de IA, timeout de 45 min                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Result`                              | depois de todos (`!cancelled()`): confere o resultado de cada job desta chamada contra o que ela pediu (verde se pedido, pulado se não: o `Docs` num push de código, o E2E sem `e2e`, o contrato manual sem `ai_local`, o `Postgres image` sem `postgres`, o `PgBouncer image` sem `pgbouncer`) e só então grava `passed=true`, a saída do `validate.yml`. Um job a mais aqui entra no `needs` dele (`ci-stability.test.ts`). Ver "O veredito do `validate.yml`" no `staging.yml`, abaixo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### `staging.yml` — push em `staging`

| Job           | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Changes`     | `.github/scripts/changes.sh staging`: o push (`before` → commit) só muda documentação? Sem `before` (_Run workflow_) é código e roda tudo. A base do audit é o **último build que a staging serviu** (o ancestral mais próximo, pelo primeiro pai, com `staged-<7>` no digest de `sha-<7>`), e não o push anterior: um push cujo run foi cancelado ou falhou entra no intervalo do seguinte, e uma mudança de dependência dele passa pelo audit que bloqueia. Sem ancestral servido em 50 commits, a base fica vazia e o audit bloqueia; o GHCR sem resposta (inclusive no login, que repete e não derruba o job) volta ao push anterior, com aviso. Também decide o job `Postgres image`: ele só roda quando o GHCR não tem `trajetto-postgres:src-<hash git de infra/postgres>` (ou não respondeu); um push que não muda `infra/postgres` não gasta nem o runner dele. O job `PgBouncer image` segue a mesma regra, com `trajetto-pgbouncer:src-<hash git de infra/pgbouncer>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Secret scan` | o mesmo gitleaks do `ci.yml` (mesma imagem, flags, `.gitleaksignore`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Validate`    | o `validate.yml` com o E2E inteiro (todo push de código). Concorrência própria, `cancel-in-progress: true`: um push novo **de código** cancela a validação do run anterior (grupo `staging-validate`), que nunca faria deploy (só a cabeça da branch implanta). Um push de documentação valida num grupo só do próprio run (`staging-docs-<run>`) e não cancela nada: ele não constrói, e quem implanta é o run de código embaixo dele (a conferência da cabeça deixa)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Gate`        | junta tudo o que bloqueia o deploy: `Changes`, `Secret scan` e o veredito do `validate.yml` (a saída `passed` do `Result`, que só existe com o `Validate`, os 3 E2E e o `AI OCR` verdes, ou com o `Docs` num push de documentação; nunca o `needs.validate.result`, abaixo). É o check que o _Staging evidence_ confere no commit promovido (e só o deste workflow, na branch `staging`, vale). Uma validação cancelada por um push novo **pula** o `Gate` (o run fica cancelado, cinza, sem build)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Build`       | só depois do `Gate` e do `Secret scan` (nenhuma imagem sai do runner antes deles: INFRA-21 e o piso de cobertura), e nunca num push de documentação. Buildx com cache do GitHub (um escopo por imagem); publica `sha-<7>` das três imagens (API, migração e IA) com SBOM e proveniência (`provenance: mode=max`; o único build arg é o commit, `GIT_SHA`, que vai para a imagem e sai na liveness). A IA só é reconstruída se o código dela mudou: toda imagem da IA leva também a tag `src-<hash git de infra/ai-ocr>`, e um push que encontra essa tag reaproveita a imagem (mesmo digest) e só acrescenta o `sha-<7>` dele; `force_ai_build` reconstrói mesmo assim. A imagem de migração segue a mesma regra, com a tag `src-<hash>` de `.github/scripts/migrate-source.sh`. Smoke test das imagens antes do push (abaixo). Exporta os três digests. A imagem do Database (`trajetto-postgres`, de `infra/postgres`) só é publicada quando o GHCR não tem `src-<hash git de infra/postgres>` e o job `Postgres image` testou essa fonte: tags `src-<hash>` e `sha-<7>`, nenhuma nos commits que a reaproveitam (o espaço do GHCR conta); smoke test com o teto da staging, SBOM e proveniência; o digest vai no resumo para a troca do Database, que é ação do dono. Nenhum passo implanta o Database, e o GHCR sem resposta sobre essa imagem só avisa. A imagem do PgBouncer (`trajetto-pgbouncer`, de `infra/pgbouncer`, plano de escala F4-35) segue as regras da IA, porque o deploy a implanta: reaproveitada por `src-<hash git de infra/pgbouncer>`, com o `sha-<7>` de cada commit acrescentado ao mesmo digest; construída só para uma fonte que o job `PgBouncer image` testou, a partir do cache dele; smoke test com o teto de 32 MiB da staging, sem rede (saudável pelo próprio HEALTHCHECK, uid 6432, o commit na partida e `pool_mode=transaction` pelo login de estatística), SBOM e proveniência. O GHCR sem resposta nessa busca falha o passo, como nas outras imagens que vão para o ar; uma fonte que sumiu do GHCR depois do `Changes`, sem teste, não é publicada, e o build segue sem imagem do PgBouncer (o deploy o deixa onde está) |
| `Image scan`  | o Trivy nas três imagens, pelos digests que o `Build` publicou, na `trajetto-pgbouncer` deste build (construída ou reaproveitada; ela vai para o ar, então o achado dela reprova como o das outras), e na `trajetto-postgres` quando o run a publicou (sempre só relata: nenhum job a implanta, e o achado dela não segura o deploy da API) (CRITICAL corrigível; só relata até `IMAGE_SCAN_ENFORCE=true`, e só um achado reprova: o banco de vulnerabilidades é baixado uma vez por run, com cache diário, e falha no download ou erro do Trivy viram aviso). Um achado com a variável ligada para o `Deploy`: o build nunca ganha `staged-<7>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Deploy`      | job `deploy-staging`, environment `staging`, um por vez (`concurrency: deploy-staging`, nunca cancelado no meio): a ação `.github/actions/deploy` com a tag `staging`, os digests do `Build`, a conferência pela liveness pública como padrão, só da cabeça da branch, as tags devolvidas depois de um deploy do Dokploy que falhou, e o `staged-<7>` no fim (o do PgBouncer também, quando o build tem a imagem dele)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Só na branch `staging`.** O _Run workflow_ aceita qualquer branch, e o
formulário vem com a `main` (a branch padrão) marcada. Deixado ali, ou numa
branch de trabalho, ele construiria aquele ref, rodaria a migração dele no
banco de staging e gravaria `staged-<7>` e um `Gate` verde num commit que a
staging nunca teve, que o _Staging evidence_ de um PR dessa branch aceitaria.
Por isso todo job confere `github.ref == 'refs/heads/staging'` (ou precisa
de um que confere): fora da `staging`, o run sai inteiro pulado, como o
botão do `production.yml` fora da `main`. O `check-gate.sh` também só aceita
o `Gate` de um run do `staging.yml` na branch `staging`
(`ci-stability.test.ts`, "the staging road"; `check-gate.test.ts`).

**Função de status explícita.** O `Build`, o `Image scan` e o `Deploy` dizem
na própria condição `!cancelled()` e o resultado de que precisam
(`needs.gate.result == 'success'` e assim por diante). Sem uma função de
status, o GitHub acrescenta um `success()` que enxerga todo job acima, os de
dentro do `validate.yml` inclusive, e um job pulado em qualquer ponto (o
`Docs` num push de código, o `AI local contract (manual)` na staging)
pularia o build mesmo com o `Gate` verde
([actions/runner#2205](https://github.com/actions/runner/issues/2205)). O
`ci-stability.test.ts` ("a job downstream of one that runs past a skip")
recusa, depois de um job que roda apesar de um pulado, um job sem
`!cancelled()` e um que não cite o resultado (ou uma saída) de cada job do
`needs`: só o `!cancelled()` rodaria o build depois de um `Gate` vermelho.
É a mesma regra dos testes da web e do app.

**O veredito do `validate.yml`.** O `Gate` lê `needs.validate.outputs.passed`,
e nunca `needs.validate.result`. Algum job do `validate.yml` é sempre
pulado (o `Docs` num push de código; o `Validate`, os E2E e o `AI OCR` num
push de documentação), um job pulado dentro de um workflow reutilizável
vaza para quem o chama
([community/discussions/189172](https://github.com/orgs/community/discussions/189172)),
e o valor que isso deixa em `needs.validate.result` não é contrato: se fosse
`skipped`, o `Gate` ficaria vermelho em todo push e nada seria implantado.
Lá dentro, o resultado de cada job é confiável, e o job `Result` do
`validate.yml` o confere (abaixo de todos, com `!cancelled()`) e só então
grava `passed=true`. O E2E em matriz impede o jeito do app, em que cada job
grava a própria saída: a saída de um job em matriz é a do último shard que
escreve. Uma validação cancelada por um push novo cancela o `Result` junto,
e o `Gate` fica pulado (`!contains(needs.*.result, 'cancelled')`). O
`ci-stability.test.ts` executa o passo do `Result` em cada combinação, exige
que o `needs` dele tenha todo job do arquivo e recusa, nos workflows que
chamam o `validate.yml`, qualquer leitura do resultado do job que o chama.

Antes do push, o `Build` carrega as imagens da API e de migração no runner e
roda um smoke test contra um Postgres e um Redis descartáveis, numa rede
interna sem saída para a internet (a CLI do Prisma não pode baixar engine):
confere que a imagem da API não traz o CLI, migrations nem seeds e traz
`build/schema-version.json`; sobe a API no banco vazio e exige que ela
**recuse** (a trava de schema); roda a imagem de migração como a Application
dela a roda (comando `release`, só com o Environment daquela Application:
`DATABASE_URL`, `ALLOW_EMPTY_DATABASE_BOOTSTRAP` e as duas `MASTER_USER_*`),
que aplica todas as migrations e os seeds e precisa ficar saudável (o próprio
`HEALTHCHECK`); e sobe a API de novo, que precisa passar no próprio
HEALTHCHECK, responder este commit em `/health/liveness` e 200 em
`/health/readiness`. Se falhar, nada vai para o GHCR. Os pushes seguintes
publicam os mesmos builds, do cache do builder. Uma imagem de migração
reaproveitada é baixada do GHCR por digest e é ela que roda no smoke test: é
a que o deploy vai rodar. A imagem da IA passa pelo mesmo: sobe sem rede,
com a raiz só de leitura, e precisa ficar saudável e responder este commit.

### `pr.yml` — pull request para `main`

O PR não valida de novo: o staging já validou, no commit que o merge
promove, e o merge ref que um PR testaria nem é o que vai para a produção (a
promoção envia o build da cabeça). Um push novo no PR cancela o run anterior.

| Job                | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Secret scan`      | o mesmo gitleaks, no histórico que a `main` receberia                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Staging evidence` | (1) a `main` só traz documentação que a cabeça do PR não tem (`docs-only.sh` do ponto em comum até a `main`): código ali chegaria à produção no merge sem build de staging; (2) espera (até 45 min) o marcador `staged-<head do PR>` das duas imagens, no mesmo digest de `sha-<head do PR>`, ou que o head só mude documentação desde um commit que o staging rodou (`.github/scripts/staged-build.sh`); (3) o `Gate` do run de staging desse build está verde (`.github/scripts/check-gate.sh`, pela API do GitHub: só o `Gate` de um run do `staging.yml` na branch `staging` conta, lido pela suíte do check, por isso `actions: read`; builds de antes de 10/11/2026 têm, no lugar, o job antigo _Lint, type-check, unit (coverage floor) and E2E_ do `deploy.yml`, que valia o mesmo); (4) num head só de documentação, também o `Gate` do run do próprio head (o `Docs` dele), esperando até 20 min um run ainda no `Docs`. Timeout de 75 min |

`Secret scan` e `Staging evidence` são os checks exigidos na `main`
([seção 13](#13-configurar-o-github), "Proteção das branches").

### `production.yml` — promoção e rollback

| Job                | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Staging evidence` | sem environment, **antes** da aprovação; só a partir de `main`. Resolve o build (2º pai do merge commit; fast-forward = o próprio commit; _Run workflow_ = a tag digitada, que é obrigatória), valida o formato (`sha-<hex>` ou `main-<hex>`), confere num merge que o staging rodou o build — o marcador `staged-<7>` no mesmo digest, esperando até 20 min um deploy de staging ainda em andamento, ou o build do commit mais próximo que o staging rodou, quando o merge só muda documentação desde ele — e que o `Gate` dele está verde, e, nesse caso de documentação, também o `Gate` do commit mergeado (o rollback é isento dos três), confere que a imagem existe no GHCR, compara com o que o staging roda (só informa) e lê os digests a promover (API, migração, IA e PgBouncer, este pelo `sha-<7>`, como o da IA: o `staged-build.sh` exige o `staged-<7>` dele no mesmo digest), mais o da `trajetto-postgres` da mesma `infra/postgres` (`src-<hash>`), só como referência. A imagem de migração: um build anterior a ela (`main-<sha>`, ou um rollback para uma árvore sem `infra/scripts/schema-guard.ts`) segue sem ela, marcado; um posterior sem ela reprova aqui, antes de qualquer coisa andar |
| `Deploy`           | job `promote-production`, environment `production` (revisores obrigatórios = aprovação); um por vez (`concurrency: promote-production`, nunca cancelado no meio). A ação `.github/actions/deploy` com a tag `stable`, os digests do _Staging evidence_, a conferência pelo Swarm por SSH como padrão (`ROLLOUT_VERIFY=http` usa a liveness pública), só as tags da IA e do PgBouncer devolvidas depois de um deploy que falhou (uma promoção que falhou se corrige promovendo de novo) e sem marcador. Depois do deploy, move `trajetto-postgres:stable` para aquele digest, só como referência do que o Database da produção deve rodar com essa API (o GHCR sem resposta só avisa; o Database nunca é implantado pela CI)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Release`          | depois do deploy, só no push em `main`: `semantic-release` cria a tag, o `CHANGELOG.md` e o GitHub Release. O commit do CHANGELOG leva a marcação de pular CI do `@semantic-release/git` e não dispara outra promoção                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### `.github/actions/deploy` — o deploy de um ambiente

O mesmo código para o staging e a produção, chamado pelo job que carrega o
environment: uma aprovação só, e os secrets e as variáveis continuam no
environment, com os mesmos nomes de sempre. Uma ação composta não lê
`secrets` nem `vars` sozinha: o job entrega cada um como entrada
(`dokploy-url: ${{ secrets.DOKPLOY_URL }}` etc.), e nos passos eles chegam ao
script por `env`, nunca colados no `run:`. Os passos, em ordem:

1. **Check run is branch head** (só no staging): runs terminam fora de ordem,
   e o mais velho não volta a tag, a menos que a cabeça nova só acrescente
   documentação (`docs-only.sh`: um push de documentação não faz deploy, e o
   build deste run é o conteúdo dela). Só um sha válido decide; a leitura
   repete 3 vezes. Todo passo seguinte depende da resposta.
2. **Read what the environment runs now**: para onde as tags `staging` (ou
   `stable`) da API e da IA apontam; a IA só é reimplantada se o digest
   mudou ou com `force_ai_build`, e nunca se o build não tem imagem de IA.
3. **Check deploy settings**: os quatro secrets obrigatórios do Dokploy;
   nenhum = pula o deploy com aviso (as tags andam); alguns = falha. Logo
   depois, **Pick the rollout check**: qual conferência roda (passo 9),
   escolhida antes de qualquer deploy, porque a do PgBouncer vem antes das
   migrations e a dos papéis, antes da API.
4. **Decide migrations**: compara a imagem de migração do build com
   `trajetto-api-migrate:<tag>-applied`; um build anterior à imagem de
   migração pula a etapa. Em seguida, o PgBouncer (plano de escala F4-35),
   antes das migrations e de qualquer código que rode por ele: **Decide
   the PgBouncer deploy** compara o digest da `trajetto-pgbouncer` do build
   com o que `trajetto-pgbouncer:<tag>` aponta, e só um digest novo segue
   (um push que não muda `infra/pgbouncer` entrega o mesmo digest e não
   reimplanta nada; um build sem a imagem deixa o PgBouncer onde está);
   **Move the PgBouncer tag to this build** move a tag por digest, com ou
   sem Dokploy; **Deploy the PgBouncer (Dokploy)**, só com o secret
   `DOKPLOY_PGBOUNCER_APPLICATION_ID` (sem ele, aviso, e só a tag andou);
   e **Wait for the PgBouncer to converge**, no modo `ssh`, o
   `verify-rollout.sh` da imagem dele no serviço de `SWARM_PGBOUNCER_SERVICE`
   (sem a variável, aviso; no modo `http`, que não tem conferência pública
   para ele, um aviso). Um deploy ou uma conferência do PgBouncer que falha
   para tudo o que vem depois, as migrations inclusive.
5. **Move the release image tag to this build**, **Run the database
   migrations (Dokploy)** (`dokploy-release.mjs`, espera o Swarm dizer que a
   etapa terminou ou falhou) e **Record the migrations as applied**, só
   quando é preciso, e antes de qualquer tag da API ou da IA andar.
6. **Move the AI tag to this build** e **Deploy the AI service (Dokploy)**
   (a IA vai antes, porque a API a chama; só se o digest mudou).
7. **Deploy the worker roles (Dokploy)** (plano de escala F3-31a,
   `.github/scripts/deploy-roles.sh before-api`): as Applications de papel
   que vão antes da API, na ordem `trajetto-worker` → `trajetto-scheduler`
   → `trajetto-worker-external`. Cada uma roda
   `trajetto-api:<tag>-<papel>` (`staging-worker`, `stable-worker`…), e
   essa tag anda para o digest da API logo antes do deploy dela: uma tag só
   para todas deixaria o Swarm puxar o build novo fora de ordem num
   reinício de task. Papel sem o secret `DOKPLOY_<PAPEL>_APPLICATION_ID` =
   aviso, e não é implantado; um deploy de papel que falha para tudo o que
   vem depois, a API inclusive. Em seguida, **Wait for the worker roles to
   converge**: o `done` do Dokploy só diz que o Swarm aceitou a spec, e um
   worker cuja task nova recusa o boot (um erro de digitação em
   `WORKER_QUEUES`, que o boot recusa de propósito) volta ao build anterior
   pelo Swarm. Por isso, antes de a tag da API andar, cada papel implantado
   aqui precisa estar no build novo: no modo `ssh`, pelo `verify-rollout.sh`
   de cada um; no `http`, pelo `/health/rollout` da API ainda no build
   anterior (`wait-for-roles.mjs` só com esses papéis, abaixo). Um papel
   que não sobe falha o run, e a API não é implantada.
8. **Move the API tag to this build** e **Deploy the API (Dokploy)**. Na
   produção, `stable` da API passou a andar só depois do deploy da IA, como
   no staging.
9. A conferência da API, a escolhida no passo 3: **Wait for the API to
   serve this build** (`http`, a liveness pública), **Wait for the rollout
   to converge** (`ssh`, o Swarm) ou **Report the rollout as unverified**
   (`off`). Valor vazio ou desconhecido de `ROLLOUT_VERIFY` = o padrão do
   ambiente (staging `http`, produção `ssh`), com aviso no desconhecido:
   exatamente uma conferência roda, salvo `off`.
10. **Deploy the edge roles (Dokploy)** (`deploy-roles.sh after-api`):
    `trajetto-ingest` → `trajetto-realtime`, com as regras do passo 7, só
    depois de a conferência da API passar.
11. **Move the tags of the roles not deployed**
    (`deploy-roles.sh follow`): com tudo verde, os papéis sem Application (ou sem Dokploy)
    ficam com a tag no digest da API, para uma Application criada depois
    subir no build do ambiente; o GHCR sem resposta aqui só avisa. Sem
    nenhum secret novo, o run implanta exatamente o que implantava antes.
    Um rollback (`production.yml` com `image_tag`) leva todos os papéis
    junto com a API, porque todos rodam o digest dela.
12. **Mark this build as staged** (só no staging, por último; o
    `staged-<7>` da `trajetto-pgbouncer` também, quando o build tem a imagem
    dela).
13. **Put the tags back after a failed deploy**: depois de um deploy do
    Dokploy que falhou, a tag daquele serviço volta ao digest anterior (no
    staging a do PgBouncer, a da IA, a da API e a do papel que falhou; na
    produção só a do PgBouncer e a da IA).

### Concorrência e cancelamento

| Grupo                | Onde                                                | Cancela o run anterior?                                             |
| -------------------- | --------------------------------------------------- | ------------------------------------------------------------------- |
| `ci-<ref>`           | `ci.yml` inteiro                                    | sim (a branch de trabalho)                                          |
| `pr-<número>`        | `pr.yml` inteiro                                    | sim                                                                 |
| `staging-validate`   | job `Validate` do staging, num push de código       | sim: só a validação; o `Build` e o `Deploy` que começaram terminam  |
| `staging-docs-<run>` | job `Validate` do staging, num push de documentação | não: um grupo por run, que não cancela o run de código embaixo dele |
| `deploy-staging`     | job `Deploy` do staging                             | **nunca**: um por vez                                               |
| `promote-production` | job `Deploy` da produção                            | **nunca**: um por vez                                               |

Rodar de novo, à mão, um run antigo de código da staging enquanto um mais
novo valida cancela a validação do mais novo (o grupo é o mesmo). O mesmo
acontece, raramente, sem ninguém tocar em nada: o GitHub resolve o grupo
pela ordem de chegada do job, não pela dos commits, e se dois pushes de
código chegam em segundos e o `Changes` do mais velho atrasa (fila de
runner, a leitura do GHCR repetindo), o `Validate` dele entra no grupo
depois e cancela o do mais novo. O run do topo fica cancelado, sem `Gate`
nem `staged-<7>`, e o mais velho para no `Check run is branch head` sem
implantar: nada chega ao staging sem validação, mas o PR para `main` espera.
**Reexecute sempre o run mais novo, nunca um antigo** (um run cancelado não
é vermelho, e reexecutá-lo não é o re-run de instabilidade que a regra do
pipeline proíbe). A web fecha essa corrida com o `Check run is current` no
fim do `Changes`, do `Build` e do `Gate`; na API e no app, onde o `Changes`
leva segundos, ela fica com esta regra.

### Permissões

Todo workflow tem `contents: read` no topo. `packages: read` no `Changes` do
staging, nos dois jobs que chamam o `validate.yml` (o `Validate` do
`ci.yml` e o do `staging.yml`, para o `AI OCR`), no `AI OCR`, no `Image
scan` e nos _Staging evidence_; `checks: read` e `actions: read` nos
_Staging evidence_ (o `check-gate.sh` lê os checks do commit e o workflow e
a branch do run de cada `Gate`); `packages: write` só no `Build` e nos dois
`Deploy`; `release` pede `contents`, `issues` e `pull-requests: write`. Só os dois `Deploy` têm
environment. Todas as actions de fora são fixadas por SHA de commit, com a
versão em comentário (o `supply-chain.test.ts` recusa uma tag solta); as
ações e o workflow reutilizável deste repositório vêm do mesmo commit.

### Tempos e minutos

Medido numa réplica Linux (`node:22.21.1`, 2 núcleos com `--cpuset-cpus`,
como o runner de 2 vCPU de repositório privado), em 10/11/2026, com os
mesmos Postgres e Redis dos serviços:

| Medida                                            | Antes (CI de 04/11/2026, 2 vCPU)          | Agora (réplica, 10/11/2026)                                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E inteiro (`yarn test:e2e`), um job só          | ~47 min (1 processo, migrate por arquivo) | **24,4 min** (1.462 s, molde e 2 processos): fase `shared` 1.178 s (347 arquivos), fase de réplicas 281 s (10 arquivos)                                                                               |
| custo de cada arquivo E2E antes do primeiro teste | 4,66 s                                    | 0,35 s (122 s de _environment_ do Vitest em 347 arquivos)                                                                                                                                             |
| `E2E (1/3)`: metade da fase `shared`              | —                                         | ~9,3 min (174 arquivos, 47 % do tempo somado dos arquivos); mais a fase infra (F4-38), com teto de 3 min: 34 s na máquina do dono com a imagem pronta, mais o Buildx e o build do PgBouncer no runner |
| `E2E (2/3)`: a outra metade                       | —                                         | ~10,4 min (173 arquivos, 53 %)                                                                                                                                                                        |
| `E2E (3/3)`: a fase de réplicas inteira           | —                                         | 4,7 min (281 s)                                                                                                                                                                                       |
| unitários com o piso de cobertura                 | ~10 min (1 processo)                      | 7 min (421 s, 631 arquivos, 2 processos, com o host carregado por outros contêineres; cobertura 79,4 / 85,79 / 69,46 / 79,4 %, acima do piso)                                                         |

Os tempos dos jobs 1 e 2 saem do E2E inteiro (a parte de cada um na soma
dos tempos dos arquivos, pela divisão exata do `--shard` do Vitest); cada
job também rodou sozinho na réplica, com o próprio Postgres, para conferir
que passa: `E2E (1/3)` com 173 arquivos verdes em 647 s, `E2E (2/3)` com 173
em 670 s e `E2E (3/3)` com 10 em 335 s, os três com o host carregado por
outros contêineres (por isso acima da estimativa). Numa primeira rodada do
`E2E (1/3)`, com o host ainda mais carregado (cada arquivo 2 a 4 vezes mais
lento), dois testes com orçamento de tempo estouraram:
`assignment-atomicity` (o limite padrão de 5 s por teste) e
`webhook-held-release` (um `statement_timeout` fixo de 600 ms num lote de
2.000 linhas, ~80 ms normalmente). Os dois mediam a máquina, não o código, e
foram corrigidos na causa: o `assignment-atomicity` tem 30 s por teste (uma
trava contra travamento, como os outros E2E que fazem várias chamadas HTTP),
e o `webhook-held-release` mede no próprio teste quanto a liberação de um
lote leva naquela hora e põe o limite em 5 vezes isso, nunca abaixo de
600 ms (ainda reprova uma liberação numa instrução só sobre as 40.000
linhas, 20 lotes). Depois disso, na réplica de 2 núcleos sem outros
contêineres, o `E2E (1/3)` passou duas vezes seguidas (173 arquivos verdes e
1 pulado, em 514 s e 604 s), e os dois arquivos passaram 4 rodadas seguidas
com 4 processos gastando CPU nos mesmos 2 núcleos. Os unitários com
cobertura, na mesma imagem, em 2 núcleos: 396 s, 7.594 testes, cobertura
79,41 / 85,94 / 69,38 / 79,41 %. Num runner do GitHub, some uns 2 min de cada job
(checkout, Node, `yarn install` do cache, serviços, `prisma generate`).

Estimativa por run (relógio / minutos cobrados, cada job arredondado para
cima), no ritmo de novembro de 2026:

| Run                                  | Antes (`deploy.yml` único)                  | Agora                                                                                                                                                                 |
| ------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| push de código na `staging`          | ~72 / ~75 (o job `test` sozinho, ~60)       | ~25 / ~61 (o caminho crítico: `Changes` → `E2E (2/3)` ~12,5 → `Result` → `Gate` → `Build` ~6,5 → `Image scan` ~1,5 → `Deploy` ~4)                                     |
| push só de documentação na `staging` | ~72 / ~75 (ou 0 com a marcação de pular CI) | ~9 / ~12 (`Changes`, `Secret scan`, `Docs` com o Prettier e os irmãos, `Result`, `Gate`)                                                                              |
| PR `staging → main`                  | ~62 / ~66, mais a espera do `staging-image` | ~1 / ~2 (mais a espera, se o staging ainda roda o mesmo commit)                                                                                                       |
| merge em `main` (promoção)           | ~8 / ~10, mais a aprovação                  | ~9 / ~11, mais a aprovação (o _Staging evidence_ é um job à parte)                                                                                                    |
| push numa branch de trabalho         | ~10 / ~13                                   | ~9 / ~12 (`Changes` ~1, `Secret scan` ~1, `Validate` ~8 com os unitários em 2 processos, `AI OCR` ~1, `Result` ~1; sem E2E). Numa branch só de documentação, ~9 / ~11 |

Cobrados num push de código na `staging`: `Validate` ~11, os três E2E
~12 + ~13 + ~7, `Build` ~7, `Image scan` ~2, `Deploy` ~4, e `Changes`,
`Secret scan`, `AI OCR`, `Result` e `Gate` ~1 cada. O `Result` é o minuto
que custa o `Gate` não depender do resultado de quem chama o
`validate.yml` ("O veredito do `validate.yml`", acima). Os jobs em paralelo custam uns 11
min a mais por push do que um job só de validação com o molde (uns 36 min:
o push inteiro em uns 47 de relógio e 50 cobrados), para caber nos ~25 min. Um lint vermelho não para mais o E2E
(rodam juntos): custa o run inteiro em vez de ~6 min, raro se o lint roda
antes do push.

No mês, no ritmo de novembro de 2026 (uns 22 pushes de código e 5 de
documentação na `staging`, 5 runs de PR, 3 promoções, 7 pushes de branch e
13 do Dependabot): de uns **2.450 min** para uns **1.750 min** só da API.
Somando a web e o app, a organização fica acima da cota grátis de 2.000 min:
a conta dos três, com o mesmo texto nos três manuais, está na
[seção 26, "O CI dos três"](#o-ci-dos-três-desde-10112026).

### Ações do dono

As ações comuns aos três repositórios (os Rulesets, o orçamento, a limpeza
do GHCR, os runs antigos, os nomes novos dos runs, a ordem do primeiro push
com o CI novo e o que acompanhar nele) estão na
[seção 26, "O CI dos três"](#o-ci-dos-três-desde-10112026), com o mesmo
texto nos três manuais; o orçamento tem o detalhe em
[`infraestrutura.md`, seção 7.2](./infraestrutura.md#72-visibilidade-e-a-cota-do-actions).
Aqui, só o que é da API:

- **No primeiro run da API, além da lista comum**: os secrets de
  environment chegando à ação composta de deploy, o grupo de concorrência
  do `Validate`, que lê o `needs` (`staging-validate` num push de código,
  um grupo do próprio run num de documentação), e a leitura do workflow de
  cada `Gate` pelo `check-gate.sh` (`actions: read`): só um run de verdade
  confirma.
- **Na máquina**: depois de puxar esta mudança, `yarn install --force` (o
  ambiente do E2E é uma dependência `file:`; [`testes.md`](./testes.md#o-banco-molde)).
- **Comentários que ainda citam o `deploy.yml`**: os do `Dockerfile` e do
  `infra/ai-ocr/Dockerfile` ficaram de propósito. Mudar só o comentário troca
  a chave da imagem de migração (`migrate-source.sh` lê o `Dockerfile`) e a
  árvore da IA (`src-<hash de infra/ai-ocr>`), o que força rebuild e
  redeploy das duas. Corrija-os (para `staging.yml` e a ação de deploy) na
  próxima mudança de verdade de cada arquivo.

### Um vermelho é sempre do código

Regra dos três repositórios desde 30/10/2026: um pipeline vermelho quer
dizer que o código (ou uma dependência que o próprio commit mudou) está
errado — nunca a rede, um registry, uma tag que andou ou um passo que travou.
"Rodar de novo" não é correção. O que garante isso aqui (e os testes que
guardam cada item, em `tests/unitaires/lifecycle`):

| Causa de vermelho (ou verde) falso                                                                                                                      | O que o pipeline faz agora                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Teste                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Um aviso CRITICAL publicado hoje reprovava o push de qualquer commit, até de documentação                                                               | `.github/scripts/audit-gate.sh`: o `audit-ci` bloqueia só o run cujo intervalo (desde a base que o `Changes` escolheu: no staging, o último build servido) muda `package.json`, `yarn.lock` ou `package-lock.json` (em qualquer pasta) ou o `audit-ci.jsonc`, ou que não tem base para comparar (nenhum build servido nos 50 commits anteriores, base fora do checkout). Nos outros, roda e relata: `::warning::` e o relatório no resumo do job. O vigia contínuo é o Dependabot | `audit-gate.test.ts`                                                    |
| Uma consulta ao GHCR com erro passageiro virava "a tag não existe" (`2>/dev/null \|\| true`)                                                            | `.github/scripts/ghcr.sh`: só o "not found" do GHCR é resposta vazia; qualquer outro erro repete (5 tentativas, pausa de 5 s dobrando, `::warning::` com a contagem) e depois falha dizendo que o GHCR está fora. Mover uma tag também repete (é idempotente)                                                                                                                                                                                                                     | `ghcr-script.test.ts`, `staging-deploy-workflow.test.ts`                |
| O login no GHCR (`docker/login-action`) falhava antes da alternativa "o GHCR não respondeu" dos jobs que podem seguir sem ele                           | no `AI OCR` e no `Changes` do staging, o login é o `ghcr.sh login` (5 tentativas, aviso no fim): sem login, o `AI OCR` testa e a base do audit volta ao push anterior, com aviso. Os jobs que precisam do GHCR (`Build`, `Image scan`, `Deploy`, _Staging evidence_) continuam falhando nele                                                                                                                                                                                      | `ci-stability.test.ts`, `ghcr-script.test.ts`, `changes-script.test.ts` |
| O download do banco do Trivy (com limite de taxa) duas vezes por run, escondido junto com os achados                                                    | um download por run, com retentativa, num diretório que o cache do Actions guarda por dia; o scan usa `--skip-db-update`. Falha no download usa a cópia do cache; sem cópia, o scan não roda e o resumo diz isso. Só um achado reprova, e só com `IMAGE_SCAN_ENFORCE=true`                                                                                                                                                                                                        | `ci-stability.test.ts`                                                  |
| Os pesos PP-OCRv5 da IA baixados de `www.modelscope.cn` em todo build sem cache (um pedido, sem retentativa)                                            | versionados em `infra/ai-ocr/models` (4,8 e 7,9 MB) e conferidos pelo `models.sha256` num `RUN --network=none`; o job `AI OCR` usa o Buildx com o cache do GitHub                                                                                                                                                                                                                                                                                                                 | `image-layers.test.ts`, `ci-stability.test.ts`                          |
| O `postinstall` do `@prisma/engines` baixa o schema engine de `binaries.prisma.sh` e falha calado                                                       | cache de `~/.cache/prisma` pela versão dos engines; a ação `setup` confere o engine nos jobs de E2E e baixa de novo (até 3 vezes); o `Dockerfile` faz o mesmo no `yarn install` da imagem de migração (a única que leva o CLI) e para o build com a causa                                                                                                                                                                                                                         | `ci-stability.test.ts`, `image-layers.test.ts`                          |
| Um erro de rede no `git ls-remote` dos irmãos caía calado na branch padrão                                                                              | só o código 2 ("a branch não existe") cai na padrão, com `::notice::`; outro código repete 3 vezes (10 s, 20 s) e falha                                                                                                                                                                                                                                                                                                                                                           | `compose-ci-siblings.test.ts`                                           |
| `git ls-remote \| cut` sem `pipefail`: uma falha virava "este run não é o head" e o deploy de staging era pulado, verde                                 | `defaults.run.shell: bash` (`-eo pipefail`) em todo workflow, e `shell: bash` em todo passo das ações compostas; a leitura do head repete 3 vezes e só um sha válido decide; a leitura dos pais do merge (`gh api`) também repete                                                                                                                                                                                                                                                 | `ci-stability.test.ts`, `promote-workflow.test.ts`                      |
| Um job pulado dentro do `validate.yml` (o `Docs` num push de código) pulava, pelo `success()` implícito, o `Build` e o deploy depois de um `Gate` verde | o `Build`, o `Image scan` e o `Deploy` do `staging.yml` declaram `!cancelled()` e o resultado de que precisam ([actions/runner#2205](https://github.com/actions/runner/issues/2205)), como na web e no app                                                                                                                                                                                                                                                                        | `ci-stability.test.ts`                                                  |
| Um erro passageiro da borda zerava a janela de 90 s da conferência pela liveness                                                                        | só uma resposta de outro commit zera; sondagem sem resposta não zera, e cada sequência delas vira `::warning::` com a contagem ([seção 14](#14-conferir-a-convergência))                                                                                                                                                                                                                                                                                                          | `wait-for-version.test.ts`                                              |
| As retentativas do deploy no Dokploy só apareciam no log                                                                                                | cada retentativa (pedido, consulta, deploy) é `::warning::` com a contagem, e o resumo do job lista cada tentativa que falhou com o motivo do Dokploy                                                                                                                                                                                                                                                                                                                             | `dokploy-deploy.test.ts`                                                |
| Uma exportação de cache que falhava (429 ou 5xx do serviço de cache) derrubava o build já publicado                                                     | todo `cache-to: type=gha` com `ignore-error=true`                                                                                                                                                                                                                                                                                                                                                                                                                                 | `ci-stability.test.ts`                                                  |
| Um passo travado segurava o runner até 6 h                                                                                                              | `timeout-minutes` em todo job, com folga sobre o pior medido: `Validate` 30, cada `E2E` 30, `AI OCR` 30, `Docs` 20, `Changes` 5 (10 no staging), `Secret scan` 10, `Gate` 5, `Build` 45, `Image scan` 20, os dois `Deploy` 120, _Staging evidence_ 75 no PR e 50 na promoção, `Release` 20, `AI local contract` 45. Um job que chama o `validate.yml` não aceita timeout: os jobs dele têm o seu                                                                                  | `ci-stability.test.ts`                                                  |
| Um commit `[skip ci]` só de documentação na ponta da `staging` travava a promoção                                                                       | a regra de documentação abaixo ([seção 16](#16-promover-para-produção)); e o run do commit de código logo abaixo de uma ponta só de documentação implanta mesmo assim (`docs-only.sh`, testado no `ci-stability.test.ts`)                                                                                                                                                                                                                                                         | `staged-build.test.ts`, `promote-workflow.test.ts`                      |
| Uma mudança de dependência cujo run foi cancelado por um push mais novo ficava fora do audit que bloqueia                                               | a base do audit no staging é o último build servido (`staged-<7>`), não o push anterior; o push cancelado continua no intervalo até um build ser servido (`changes.sh`)                                                                                                                                                                                                                                                                                                           | `changes-script.test.ts`, `audit-gate.test.ts`                          |
| Um run **failed** sem nenhum job vermelho, com jobs que nem aparecem                                                                                    | não é do código: o job não começou. A causa está em _Summary → Annotations_ do run ("The job was not started because recent account payments have failed or your spending limit needs to be increased": a cota do Actions acabou, ou o limite de gasto). Quando houver minutos, _Re-run failed jobs_ refaz só o que não rodou. Ver as ações do dono abaixo ([Tempos e minutos](#tempos-e-minutos))                                                                                | —                                                                       |

A base do audit (decisão D1 de 10/11/2026): no staging, o último build que a
staging **serviu** (`staged-<7>`), e não o push anterior. Antes, uma mudança
de dependência cujo run foi cancelado pelo push seguinte (ou que falhou) não
entrava no diff do push seguinte, e ali um achado só avisava. Agora ela
continua no intervalo até um build ser servido, e o audit bloqueia de
verdade (`changes.sh`, testado no `changes-script.test.ts`). Numa branch de
trabalho, a base é o ponto em que ela saiu da `staging`: o que a branch muda.

O que continua dependendo de fora, de propósito: o npm (instalação e o
endpoint de auditoria; o `audit-gate.sh` repete 3 vezes um audit que não
rodou e nunca o confunde com aviso de segurança), o PyPI, o
Docker Hub, o GHCR e o GitHub. Os testes não falam com mais ninguém (a trava
de rede do `setupTests.ts`, [`testes.md`](./testes.md#nenhuma-rede-de-fora)).

### Versões fixas

O mesmo commit testa e publica sempre nas mesmas versões:

- **Node**: `node-version: "22.21.1"` em todo `actions/setup-node` (nas
  ações `setup` e `deploy` e no `cloudflare-ranges.yml`), a mesma versão da
  base do `Dockerfile` (`node:22.21.1-alpine`). Antes era `"22"`, que andava
  com o _toolcache_ do runner. Quando o Dependabot sobe a base do
  `Dockerfile`, suba o `node-version` no mesmo PR: o `ci-stability.test.ts`
  falha enquanto não batem.
- **Runner**: `runs-on: ubuntu-24.04` em todo job dos três repositórios,
  nunca `ubuntu-latest`. O `ubuntu-latest` passou a migrar para o 26.04 em
  19/10/2026, sem commit nosso, e o Playwright 1.56 recusou o 26.04 nas
  suítes da web. Troque à mão, nos três no mesmo dia, quando o GitHub
  anunciar o fim do 24.04 (o `ci-stability.test.ts` recusa `ubuntu-latest`).
- **Imagens dos jobs**, por digest do índice multi-arquitetura, com a tag ao
  lado em comentário: `postgres:16-alpine` (16.15) e `redis:7-alpine`
  (7.4.12) nos serviços e no smoke test; o BuildKit do Buildx
  (`moby/buildkit:v0.33.1`, a versão que o `buildx-stable-1` apontava em
  30/10/2026); gitleaks e Trivy. Os digests do Postgres e do Redis são os
  mesmos nos três repositórios. O Dependabot não lê imagens dentro dos
  workflows: para subir, pegue o digest novo do índice
  (`docker buildx imagetools inspect postgres:16-alpine`, a linha `Digest:`)
  e troque em todos os lugares de uma vez, nos três repositórios. O
  `ci-stability.test.ts` recusa uma imagem sem digest e o mesmo nome com dois
  digests.
- **O `docker buildx` dos jobs** é o que vem no runner (só o BuildKit é
  fixado), e ele muda com a imagem do runner. Uma diferença entre versões já
  medida: o `--format '{{.Manifest.Digest}}'` que o `ghcr.sh` usa devolve o
  digest puro no buildx dos runners, mas o cabeçalho inteiro ("Name:",
  "MediaType:", "Digest:" e a lista de manifests) no buildx 0.30 (medido em
  30/10/2026). O `ghcr.sh` lê as duas formas, para uma atualização do runner
  não virar "o GHCR não respondeu" em todo passo (`ghcr-script.test.ts`).

### Como o pipeline fala com o Dokploy

O deploy é uma chamada à API do Dokploy feita por
`.github/scripts/dokploy-deploy.mjs` (testado contra um Dokploy falso em
`tests/unitaires/lifecycle/dokploy-deploy.test.ts`), uma vez para cada
Application:

1. `GET /api/deployment.all?applicationId=<id>` — anota os deployments que já
   existem.
2. `POST /api/application.deploy` com `{"applicationId": "<id>"}` e o
   cabeçalho `x-api-key` — pede o deploy. O Dokploy puxa de novo a tag
   configurada na Application (`:staging` ou `:stable`) e atualiza o serviço
   do Swarm.
3. Repete o passo 1 a cada 10 s (até 900 s) e acompanha o deployment **novo**,
   o que este run criou: `done` = ok; `cancelled` = o run falha; `error` = o
   script escreve no log o motivo que o Dokploy gravou no deployment
   (`errorMessage`, numa linha, sem a chave nem credenciais de URL; sem
   motivo, aponta para _Deployments_ da Application no painel) e dispara de
   novo, com espera crescente, até esgotar as tentativas.

| Variável do script                                                       | De onde vem no workflow                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOKPLOY_URL`                                                            | secret `DOKPLOY_URL` do environment (precisa ser `https://`; a chave vai no cabeçalho)                                                                                                                                                                                                                                                                                                                                            |
| `DOKPLOY_API_KEY`                                                        | secret `DOKPLOY_API_KEY` do environment (nunca é impressa)                                                                                                                                                                                                                                                                                                                                                                        |
| `DOKPLOY_APPLICATION_ID`                                                 | `DOKPLOY_AI_APPLICATION_ID`, `DOKPLOY_API_APPLICATION_ID` ou `DOKPLOY_MIGRATE_APPLICATION_ID`, conforme o passo                                                                                                                                                                                                                                                                                                                   |
| `DOKPLOY_APP_LABEL`                                                      | `trajetto-ai`, `trajetto-api` ou `trajetto-api-migrate` (só para as mensagens)                                                                                                                                                                                                                                                                                                                                                    |
| `DOKPLOY_OPTIONAL`                                                       | `true` no passo da IA: sem o id, o passo termina verde com aviso ("a Application ainda não existe"); no passo da API o id é obrigatório                                                                                                                                                                                                                                                                                           |
| `DOKPLOY_WAIT`, `DOKPLOY_TIMEOUT_SECONDS`, `DOKPLOY_POLL_SECONDS`        | não definidas: valem `true`, 900 e 10                                                                                                                                                                                                                                                                                                                                                                                             |
| `DOKPLOY_ATTEMPTS`, `DOKPLOY_RETRY_SECONDS`, `DOKPLOY_RETRY_MAX_SECONDS` | não definidas: valem 6, 20 e 160. Um deployment que termina em `error` é disparado de novo, com a espera dobrando a cada falha até o teto (20, 40, 80, 160, 160 s: até ~8 min de espera somada). O pull do GHCR que cai no meio (a rota IPv6 da VPS) passa numa tentativa seguinte, e o Docker guarda as camadas que já baixou. Com espera fixa de 20 s, o run 40551925038 falhou 3/3 na imagem da IA. `cancelled` não é repetido |

A Application `trajetto-api-migrate` passa por
`.github/scripts/dokploy-release.mjs` (testado em
`tests/unitaires/lifecycle/dokploy-release.test.ts`), que antes confere a
configuração dela (`application.one`), anota as tarefas do serviço
(`docker.getServiceContainersByAppName`), chama este mesmo script para o
deploy e depois espera a tarefa **nova** terminar a etapa
([seção 15](#15-migrations), "Como a etapa roda"): o `done` do Dokploy só diz
que o Swarm aceitou a spec, não que as migrations rodaram.

A ordem importa: as migrations vão antes de tudo (a API nova recusa um banco
sem elas), e a IA vai antes da API porque a API a chama.
Os passos são sequenciais, e a tag `staging` de cada serviço só se move logo
antes do deploy dele: **um deploy da IA que falha para o job antes de tocar
na API** (a API antiga continua no ar, e a tag `staging` da API continua no
build que o staging roda). Um deploy do Dokploy que falha devolve a tag
`staging` daquele serviço ao digest anterior (último passo da ação de
deploy). O que o
script pega e um webhook não pegaria: imagem que o Dokploy não consegue
puxar (credencial do GHCR errada, tag inexistente), chave ou id errados. Por
isso a API usa a chave de API e o id de cada Application, e não o webhook de
redeploy (que responde assim que enfileira e nunca diz se deu certo). A web
usa o mesmo script, numa cópia que um teste dela compara com esta
(`trajetto-ui/docs/deploy.md`).

**A IA só é reimplantada quando muda.** A imagem `trajetto-ai` era
reconstruída a cada push e ganhava um digest novo toda vez (labels), e o
passo de deploy dela não tinha condição: todo push da API reiniciava a IA e
mandava ~200 MB pela rota instável da VPS. Agora o `Build` acha a
imagem pelo hash git de `infra/ai-ocr` (tag `src-<hash>`) e a reaproveita
quando o código da IA não mudou, e o `Deploy` pula o deploy da IA
quando o digest é o mesmo que a tag `staging` já aponta; a promoção faz o
mesmo com a tag `stable` (a mesma ação de deploy). Um deploy da IA que falha devolve a tag do
ambiente ao digest anterior, para a comparação seguinte não pular um deploy
que não aconteceu. Para forçar (correção que chegou à imagem base sem mudar
o digest, IA fora do lugar): _Actions_ → _Staging_ → _Run workflow_ com
**force_ai_build** marcado testa, reconstrói e reimplanta a IA de staging;
_Actions_ → _Production_ → _Run workflow_ (na `main`), junto com o
`image_tag`, reimplanta a IA de produção. Do mesmo jeito,
**force_realtime** implanta a `trajetto-realtime` mesmo sem mudança no
código que ela executa (ver o papel `realtime`, na seção 19).

## 4. A topologia no servidor

```
navegador / app / ERP ─TLS─▶ Cloudflare (proxy) ─▶ Traefik do Dokploy (contêiner dokploy-traefik, :443)
                                                     │  arquivo dinâmico gerado pela aba Domains
                                                     ▼
              rede dokploy-network (overlay do Swarm, compartilhada por tudo do Dokploy)
   ┌──────────────────────────────┬────────────────────────────┬──────────────────────────────┐
   │ projeto trajetto-api         │                            │ projeto trajetto-ui          │
   │  trajetto-api ×2  (:3333) ───┼─▶ trajetto-postgres (:5432)│  trajetto-ui (:3000)         │
   │       │                      ├─▶ trajetto-redis (:6379)   │                              │
   │       └──────────────────────┼─▶ trajetto-ai (:8080)      │                              │
   └──────────────────────────────┴────────────────────────────┴──────────────────────────────┘
```

Cada environment do Dokploy (`staging` e `production`) tem o mesmo desenho,
com nomes internos (o _App Name_ de cada serviço) diferentes. Os nomes
`trajetto-*-production` e `trajetto-*-staging` deste documento são marcadores:
os serviços reais têm o sufixo aleatório que o Dokploy gerou
([seção 7.2](#72-nomes-name-e-app-name)). Dentro da rede
`dokploy-network`, um serviço encontra o outro pelo **App Name**: a API fala
com `trajetto-postgres-production:5432`, `trajetto-redis-production:6379` e
`http://trajetto-ai-production:8080`. Só a API (e a web) têm domínio; nenhum
serviço publica porta no host. O backup do banco é o do próprio Database
PostgreSQL (aba _Backups_), que envia as cópias ao Cloudflare R2
([seção 18](#18-backup-e-restauração)); o PITR vem do pgBackRest da imagem
`trajetto-postgres`, na staging desde a onda 3 e na produção desde a onda 6
([seção 27](#27-pitr-com-pgbackrest)).

| Serviço (App Name em produção)    | Tipo no Dokploy       | Imagem                                                                                                                | Porta interna  | Réplicas                              | Health                                                                       | Limites                                         |
| --------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------- | ------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- |
| `trajetto-api-production`         | Application (Docker)  | `trajetto-api:stable`                                                                                                 | 3333 (domínio) | 2, rolling `start-first` com rollback | liveness no Swarm (`/health/liveness`)                                       | memória 1 GiB, heap 768 MB                      |
| `trajetto-ai-production`          | Application (Docker)  | `trajetto-ai:stable`                                                                                                  | 8080           | 1                                     | `GET /health` (200 depois do aquecimento)                                    | memória 1 GiB, 2 CPUs                           |
| `trajetto-api-migrate-production` | Application (Docker)  | `trajetto-api-migrate:stable`                                                                                         | nenhuma        | 1, _Restart Policy_ `none`            | o da imagem: saudável quando a etapa de release terminou; depois fica parado | nenhum (alguns MB parado)                       |
| `trajetto-postgres-production`    | Database → PostgreSQL | `trajetto-postgres` por digest ([seção 27](#27-pitr-com-pgbackrest)); antes da troca, `postgres:16-alpine` por digest | 5432           | 1                                     | do Dokploy                                                                   | 2 GiB desde a troca da imagem (antes, sem teto) |
| `trajetto-redis-production`       | Database → Redis      | `redis:7-alpine`                                                                                                      | 6379           | 1                                     | do Dokploy                                                                   | memória 512 MiB (dados 256 MB)                  |

Em staging, troque `-production` por `-staging` e `:stable` por `:staging`.

### Nós, labels e placement (onda 17)

Cada ambiente roda num nó só, e o Swarm põe tudo nele. Desde a onda 17
(plano de escala F4-52, decisão D59), o nó leva os labels `trajetto.app`,
`trajetto.db`, `trajetto.ai` e `trajetto.edge`, e cada serviço leva a
constraint que diz em que tipo de nó ele pode rodar (_Advanced → Swarm
Settings → Placement_): o banco e o PgBouncer em `trajetto.db`, com o
banco e o Redis presos também ao hostname do nó do volume; a IA em
`trajetto.ai`; a API, os papéis, a migração e a web em `trajetto.app`, a
API com até 4 réplicas por nó. No nó único nada muda de lugar (medido num
Swarm descartável: as tasks ficam no mesmo nó), e o segundo nó passa a ser
só adicionar. A tabela de cada serviço, a ordem (os labels antes das
constraints; os Databases só na janela do Postgres), o que foi medido e o
procedimento de um nó novo estão em
[runbooks/swarm-multi-no.md](./runbooks/swarm-multi-no.md).

## 5. Applications em vez de Compose: o que mudou e o que ficou de fora

Até 21/10/2026 a API subia como **um app Compose do tipo Docker Stack** com o
arquivo `compose.production.yaml` (apagado). Desde 22/10/2026 a decisão do
dono é: **cada serviço é um recurso próprio do Dokploy** — Applications
com provider **Docker** puxando a imagem pronta do GHCR, e dois Databases
(PostgreSQL e Redis) criados pela função _Database_ do Dokploy. Sem Compose,
sem template. O Dokploy roda cada um como um serviço do Swarm atrás do Traefik
dele.

O que isso muda no dia a dia:

- **Tudo é clicável no painel**: imagem, variáveis, domínio, réplicas,
  limites e healthcheck ficam nas abas de cada Application; não há arquivo
  para versionar e colar.
- **Cada valor compartilhado é digitado em mais de um lugar.** O compose
  ligava as variáveis sozinho; agora é você quem garante que são iguais (a
  [seção 7](#7-montar-o-dokploy-do-zero-staging-e-produção) diz onde cada uma
  vai):

  | Valor                           | Onde precisa estar, igual                                                                    |
  | ------------------------------- | -------------------------------------------------------------------------------------------- |
  | token da IA                     | `AI_TOKEN` na Application `trajetto-ai` **e** `AI_LOCAL_TOKEN` na Application `trajetto-api` |
  | usuário/senha/banco do Postgres | o Database PostgreSQL, a `DATABASE_URL` da API e a `DATABASE_URL` da `trajetto-api-migrate`  |
  | senha do Redis                  | o Database Redis (e o comando dele, se personalizado) **e** o `REDIS_URL` da API             |
  | App Name da IA                  | `AI_LOCAL_URL` da API                                                                        |
  | App Name da API                 | variável `SWARM_API_SERVICE` do environment do GitHub (só a conferência por SSH)             |

- **Variáveis que o compose montava ou fixava agora são explícitas** na API:
  `AI_LOCAL_URL`, `NODE_OPTIONS`, `RATE_LIMIT_TRUSTED_PROXY`, `APP_ENV`. E
  toda variável que a API lê pode ser definida direto na Application (antes,
  uma variável que o compose não repassava não chegava ao contêiner).

### O que cada proteção do compose virou

| O compose fazia                                                                                      | Agora                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| variáveis obrigatórias (`${VAR:?mensagem}`) derrubavam o deploy                                      | **API**: o schema de ambiente derruba o boot sem `DATABASE_URL`, `REDIS_URL`, `JWT_*`, `MASTER_USER_*`, `HTTP_REQUEST` e, em produção, sem `RATE_LIMIT_TRUSTED_PROXY` e as `R2_*`. **IA**: o serviço recusa subir com `AI_TOKEN` ausente ou curto. **`APP_ENV`: nada obriga.** Vazia, a API segue o `NODE_ENV=production` da imagem e se comporta como produção; confira no staging                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `AI_LOCAL_URL=http://trajetto-ai:8080` fixo                                                          | `AI_LOCAL_URL=http://<App Name da IA>:8080` no Environment da API. **Faltando, a IA fica desligada em silêncio** (a API trata como `none`); confira em _Sistema → Provedores_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `NODE_OPTIONS` montada de `API_HEAP_MB`; `RATE_LIMIT_TRUSTED_PROXY` com padrão `cloudflare`          | as duas digitadas no Environment da API (`NODE_OPTIONS=--max-old-space-size=768`, `RATE_LIMIT_TRUSTED_PROXY=cloudflare`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| labels do Traefik (`Host()`, `websecure`, certificado, porta 3333, `passHostHeader`)                 | aba _Domains_ da Application: o Dokploy gera o arquivo `/etc/dokploy/traefik/dynamic/<App Name>.yml` com tudo isso (e o redirecionamento HTTP→HTTPS). `ROUTER_PREFIX` não existe mais: os roteadores levam o App Name, único por servidor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| health check do balanceador do Traefik em `/health/readiness` (tirava uma réplica sem banco do ar)   | **lacuna**. O Traefik do Dokploy fala com o endereço virtual do serviço do Swarm (um só destino para as duas réplicas), então um health check ali tiraria o serviço inteiro do ar quando uma réplica falhasse. Não configure. O Swarm só põe uma réplica nova no balanceamento depois de ela passar no healthcheck (liveness), e tira a réplica que está desligando                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `priority=1` no roteador                                                                             | desnecessário: cada ambiente tem o próprio host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| bloco `deploy:` (réplicas, `update_config`, `rollback_config`, `restart_policy`, `resources`)        | _Advanced_ da Application: _Replicas_, _Swarm Settings_ (JSON pronto na [seção 7](#7-montar-o-dokploy-do-zero-staging-e-produção)) e _Resources_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `stop_grace_period` (40 s na API, 60 s no Postgres)                                                  | API: campo _Stop Grace Period_ do _Swarm Settings_, se a sua versão do Dokploy tiver. Sem ele, o Swarm mata o processo 10 s depois do SIGTERM: **lacuna**, com o contorno `docker service update --stop-grace-period 40s <App Name da API>` no host, que vale até o próximo deploy (o Dokploy reaplica a spec dele). O desligamento ordenado segue a variável `STOP_GRACE_PERIOD_MS` (sem ela, 10 s, e ele termina em menos de 9 s); ela só sobe para `40000` depois de o grace de 40 s aparecer no `inspect`, e o `verify-rollout` reprova o deploy quando ela passa do grace do serviço ([seção 19](#19-papéis-da-mesma-imagem)). Postgres: o Dokploy dá 30 s ao Database, e o F0-01 põe 120 s onde o painel tiver o campo; rode `CHECKPOINT` antes de qualquer parada planejada ([seção 27](#grace-e-placement-do-database)) |
| `logging: json-file` com rotação por serviço                                                         | rotação **global** no `/etc/docker/daemon.json` do host ([seção 6](#6-preparar-o-servidor-uma-vez)), que vale para todo contêiner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `docker stack deploy` resolvia a tag para o digest e o fixava na spec                                | o Dokploy faz `pull` da tag e força a atualização do serviço, mas a spec guarda **a tag**, não o digest. Consequências: (1) o rollback automático do Swarm protege só o momento do deploy (as réplicas antigas continuam de pé), mas uma réplica antiga que reinicie depois sobe a imagem nova, que já está no host; (2) `docker service rollback` não volta a imagem ([seção 17](#17-rollback)); (3) a conferência da convergência passou a ler o digest do contêiner de cada task, e não a spec ([seção 14](#14-conferir-a-convergência))                                                                                                                                                                                                                                                                                     |
| rede interna `backend` (`internal: true`): Postgres, Redis e IA inalcançáveis por outros contêineres | **lacuna**. Tudo fica na `dokploy-network`, junto com a web, o staging e o que mais rodar no Dokploy. A proteção passa a ser: nenhuma porta externa, senha forte no Postgres e no Redis, token na IA, segredos diferentes entre staging e produção                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| volume do Postgres com nome fixo (`POSTGRES_VOLUME`)                                                 | o Dokploy cria e nomeia o volume do Database (aparece em _Advanced → Volumes_). A guarda da API contra banco vazio em produção continua valendo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Postgres preso no manager (`node.role == manager`)                                                   | com um nó só, nada muda. O Dokploy já põe `node.role==manager` em todo serviço com volume, o Database incluído; desde a onda 17, o Database fica preso ao label `trajetto.db` e ao hostname do nó do volume, antes de qualquer nó novo ([swarm-multi-no](./runbooks/swarm-multi-no.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| imagem do Postgres fixada (`POSTGRES_IMAGE`)                                                         | campo _Docker Image_ do Database com o digest (`trajetto-postgres@sha256:…` desde a troca da onda 3; antes, `postgres:16-alpine@sha256:…`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| tuning do Postgres e `/dev/shm` em tmpfs (comentados no compose)                                     | tuning: os parâmetros vêm da imagem `trajetto-postgres` e a memória do teto, com _Command_ e _Args_ vazios ([seção 27](#27-pitr-com-pgbackrest)). `/dev/shm`: **lacuna**, contornada pela imagem, que desliga os workers paralelos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Redis sem persistência, `--maxmemory 256mb --maxmemory-policy allkeys-lru`, senha obrigatória        | senha: o Database Redis sempre tem. O resto: comando personalizado do Database ([seção 10](#10-postgres-e-redis)); se a sua versão não tiver o campo, **lacuna** (Redis com snapshot em disco e sem teto de memória)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| IA com `read_only`, `/tmp` em tmpfs e `cap_drop: ALL`                                                | **lacuna**: a Application não tem esses campos. Continua valendo o usuário 10001 (não root) da imagem, sem domínio e sem porta publicada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `REDIS_ENFORCE_AUTH` (transição de um Redis sem senha)                                               | não existe mais: o Redis do Dokploy nasce com senha                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| job de migrations na rede `<stack>_backend`, lendo o env de `<stack>_api`                            | a Application `trajetto-api-migrate` de cada ambiente, na `dokploy-network`, com o próprio _Environment_ (só a URL do banco) e o deploy pedido pelo pipeline antes da API ([seção 15](#15-migrations))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## 6. Preparar o servidor (uma vez)

Feito uma vez por VPS (staging e produção dividem a mesma VPS e o mesmo
Dokploy, em environments diferentes).

1. **VPS** amd64 com Docker (as imagens são `linux/amd64`; numa VPS ARM seria
   preciso build multi-arquitetura). Tamanho: [seção 23](#23-recursos-da-vps-e-logs).
2. **Instalar o Dokploy** (o instalador inicia o Swarm e sobe o Traefik nas
   portas 80/443). Conferir pelo SSH:
   ```sh
   docker exec dokploy-traefik traefik version        # v3.x
   docker network ls | grep dokploy-network            # a rede de todos os serviços
   grep -A3 certificatesResolvers /etc/dokploy/traefik/traefik.yml   # o nome do resolver (letsencrypt)
   ```
3. **Rotação de log do Docker** — antes de criar qualquer serviço. O driver
   `json-file` nunca apaga log sozinho, e o disco que enche é o mesmo do
   banco. Crie (ou complete) `/etc/docker/daemon.json`:
   ```json
   {
     "log-driver": "json-file",
     "log-opts": { "max-size": "50m", "max-file": "5" }
   }
   ```
   e reinicie o Docker: `sudo systemctl restart docker`. Isso reinicia
   **todos** os contêineres do host (inclusive o Dokploy), e a regra só vale
   para contêineres criados depois — por isso o momento certo é logo após
   instalar o Dokploy. Conferir:
   `docker info --format '{{.LoggingDriver}}'` (`json-file`) e, num contêiner
   novo, `docker inspect <contêiner> --format '{{json .HostConfig.LogConfig}}'`.
   (O compose antigo dava 100 MB × 5 à API; 50 MB × 5 para todos é o meio-termo
   possível com uma regra só.)
4. **Traefik**: aplicar `infra/traefik/` (redirect :80→:443, `readTimeout` de
   120 s no `websecure`, TLS ≥ 1.2) — passo a passo em
   `infra/traefik/README.md`.
5. **DNS na Cloudflare** (proxy laranja), na zona `intrajetto.com`: o host
   da API de staging (`api-staging.intrajetto.com`) e o de produção
   (`api.intrajetto.com`, no ar desde 29/10/2026) apontando para o IP da VPS;
   _SSL/TLS_ em **Full (strict)**, _Minimum TLS Version_ 1.2, _Always Use
   HTTPS_ ligado. Detalhes da borda na [seção 11](#11-domínios-tls-e-a-borda).
6. **Credencial do GHCR** ([seção 7.3](#73-credencial-do-ghcr)): um token do
   GitHub que o Dokploy usa para puxar as imagens privadas.
7. **Usuário de deploy** no host, no grupo `docker`, **só** se for usar a
   conferência do rollout por SSH (`ROLLOUT_VERIFY=ssh`,
   [seção 14](#14-conferir-a-convergência)); aí o SSH do host precisa aceitar
   os runners do GitHub. As migrations não usam SSH: rodam pela Application
   `trajetto-api-migrate` do Dokploy ([seção 15](#15-migrations)). Com
   `ROLLOUT_VERIFY=http` (o que está em uso), nada do CI entra no host.
8. **Firewall da VPS** ([6.1](#61-firewall-da-vps-contabo)) e **downloads do
   GHCR pelo IPv4** ([6.2](#62-downloads-do-ghcr-pelo-ipv4-preferência-do-sistema)).

### 6.1 Firewall da VPS (Contabo)

A VPS só recebe conexões da Cloudflare (e o SSH). No painel da Contabo,
_Network Services → Firewall_, regras de entrada, aplicadas à VPS:

| Nome              | Ação   | Protocolo | Porta    | Fonte(s)                                              |
| ----------------- | ------ | --------- | -------- | ----------------------------------------------------- |
| HTTPS Cloudflare  | ACCEPT | TCP       | 443      | as faixas IPv4 da Cloudflare (abaixo)                 |
| HTTP Cloudflare   | ACCEPT | TCP       | 80       | as mesmas faixas                                      |
| SSH               | ACCEPT | TCP       | 22       | Qualquer IPv4                                         |
| Block all traffic | DROP   | Qualquer  | Qualquer | Qualquer (a regra fixa da Contabo, sempre por último) |

- **Por quê.** Com a 443 aberta a qualquer IPv4, o Traefik respondia direto
  no IP da VPS, inclusive pelo nome automático que a Contabo dá à VPS (o DNS
  reverso do IP): o painel do Dokploy abria ali, e `staging.intrajetto.com/login` pedido direto à origem
  respondia 200, sem o Cloudflare Access (pela Cloudflare, 302). Medido em
  28/10/2026. Com as regras, nada responde direto na origem, nem por IPv4 nem
  por IPv6, e tudo pela Cloudflare segue respondendo (29/10/2026).
- **A 80** é da renovação do Let's Encrypt (desafio HTTP-01, que chega pela
  Cloudflare). Fechada, a renovação falha em silêncio e, quando o certificado
  vence, a Cloudflare responde 526 (_Full (strict)_). Os certificados de
  staging vencem entre 19 e 22/01/2027.
- **A 3000** (o painel direto) fica fechada pelo DROP: o painel é só
  `https://dokploy.intrajetto.com`, pela Cloudflare. Por isso o secret
  `DOKPLOY_URL` do GitHub tem de ser esse endereço, nunca o IP.
- **Sem IPv6 de entrada**: a Cloudflare chega à origem por IPv4; o IPv6 dos
  usuários termina na borda da Cloudflare (`api-staging` e `staging`
  respondem por IPv6 normalmente).
- O campo _Fonte(s)_ aceita CIDR **separado por vírgula** (cada um vira uma
  tag). Uma faixa por linha é recusada com "forneça um ou mais endereços IPv4
  ou IPv6 válidos". As faixas são as IPv4 de `src/config/trusted-edge.ts`
  (<https://www.cloudflare.com/ips-v4>), prontas para colar:
  ```
  173.245.48.0/20,103.21.244.0/22,103.22.200.0/22,103.31.4.0/22,141.101.64.0/18,108.162.192.0/18,190.93.240.0/20,188.114.96.0/20,197.234.240.0/22,198.41.128.0/17,162.158.0.0/15,104.16.0.0/13,104.24.0.0/14,172.64.0.0/13,131.0.72.0/22
  ```
- **Lista que muda**: o workflow `cloudflare-ranges.yml` compara toda
  segunda-feira a lista publicada pela Cloudflare com `trusted-edge.ts` e
  falha com as faixas a acrescentar ou tirar (o GitHub avisa por e-mail).
  Faixa nova: acrescente em `trusted-edge.ts` e nas duas regras.
- O DNS reverso da Contabo é só o nome do IP: não abre caminho nenhum e não
  precisa ser mexido.

### 6.2 Downloads do GHCR pelo IPv4 (preferência do sistema)

As camadas das imagens vêm de `pkg-containers.githubusercontent.com`, que
também responde em IPv6 (`2606:50c0:800x::154`); o `ghcr.io` em si (login e
manifestos) só tem IPv4. A rota IPv6 da VPS até o GitHub derruba downloads
longos no meio. Em 28/10/2026 o deploy da API perdeu a camada de 46 MB do
Node nas 6 tentativas:

```
failed to copy: read tcp [<IPv6 da VPS>]:53884->[2606:50c0:8002::154]:443: read: connection reset by peer
❌ Pulling image failed
```

(Em 27/10, na imagem da IA: duas falhas no log do Dokploy, e o run
40551925038 falhou 3/3.) O login no GHCR deu certo nas seis
tentativas: não é credencial nem o Dokploy, é a rede. A mesma assinatura
aparece em outras VPS que puxam do GHCR, inclusive na Contabo (IPv6 cai,
IPv4 nunca). Repetir o deploy e dividir as camadas só melhoram as chances.

**Configuração**, a padrão do sistema, sem desligar o IPv6: o servidor passa
a preferir IPv4 quando o destino tem os dois endereços.

1. `/etc/gai.conf`, a tabela de preferência de endereços do sistema
   (RFC 6724). A linha é a que o próprio arquivo traz comentada "para sites
   que preferem IPv4":
   ```
   precedence ::ffff:0:0/96 100
   ```
2. O Docker é escrito em Go, e o resolvedor próprio do Go ignora o
   `gai.conf`. A variável `GODEBUG=netdns=cgo`, documentada no pacote `net`
   do Go, faz o daemon usar o resolvedor do sistema, que lê o arquivo. Num
   _drop-in_ do systemd, `/etc/systemd/system/docker.service.d/prefer-ipv4.conf`:
   ```
   [Service]
   Environment="GODEBUG=netdns=cgo"
   ```

Aplicar, uma vez, como root. Reiniciar o Docker reinicia todos os contêineres
por alguns segundos (como na rotação de log, passo 3): faça fora do horário
de uso.

```sh
grep -qxF 'precedence ::ffff:0:0/96 100' /etc/gai.conf || echo 'precedence ::ffff:0:0/96 100' >> /etc/gai.conf
mkdir -p /etc/systemd/system/docker.service.d
printf '[Service]\nEnvironment="GODEBUG=netdns=cgo"\n' > /etc/systemd/system/docker.service.d/prefer-ipv4.conf
systemctl daemon-reload && systemctl restart docker
```

Conferir:

```sh
ldd "$(command -v dockerd)" | grep -q libc.so && echo "dockerd usa a libc: o GODEBUG vale"
systemctl show docker --property=Environment          # GODEBUG=netdns=cgo
getent ahosts pkg-containers.githubusercontent.com | head -n 1   # 185.199.x.x primeiro
docker pull ghcr.io/containerd/busybox:1.36 & sleep 2; ss -tnp | grep dockerd; wait
docker rmi ghcr.io/containerd/busybox:1.36
```

O `ss` deve mostrar o `dockerd` conectado a endereços `185.199.x.x:443`
(IPv4). A prova final é o próximo deploy do pipeline.

Aplicado na VPS em 29/10/2026. Conferido no mesmo dia: o `getent` devolve
`185.199.x.x` primeiro, o `systemctl show` mostra o `GODEBUG` e um
`docker pull` de teste só abriu conexões IPv4.

O que não muda: o IPv6 continua configurado e funcionando, destinos que só
têm IPv6 seguem por IPv6, e a entrada (já restrita à Cloudflare pelo
firewall) não é afetada. Junto disso, o pipeline repete um deploy que termina
em erro (até 6 vezes, `DOKPLOY_ATTEMPTS`), e o Docker guarda as camadas que
já baixou. Desfazer: tirar a linha do `gai.conf`, apagar o _drop-in_ e
`systemctl daemon-reload && systemctl restart docker`.

## 7. Montar o Dokploy do zero (staging e produção)

Staging e produção são **os mesmos passos**, feitos duas vezes: uma no
environment `staging` e outra no `production`, cada uma no projeto
`trajetto-api`. Faça staging primeiro, inteiro, e só depois produção.

Antes do primeiro serviço, o nó recebe os quatro labels, e cada serviço
criado abaixo (os Databases, a IA, a API, a migração, o PgBouncer e os
papéis, mais a web no projeto `trajetto-ui`) leva a constraint dele em
_Advanced → Swarm Settings → Placement_, pela tabela de
[runbooks/swarm-multi-no.md](./runbooks/swarm-multi-no.md) (onda 17).

### 7.1 O que muda entre staging e produção

| Item                                                                                                   | Staging                                                                                                                               | Produção                                                                                          |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| environment do Dokploy                                                                                 | `staging`                                                                                                                             | `production`                                                                                      |
| sufixo dos App Names                                                                                   | aleatório, gerado pelo Dokploy ([seção 7.2](#72-nomes-name-e-app-name))                                                               | aleatório, gerado pelo Dokploy                                                                    |
| tag das imagens (`trajetto-api`, `trajetto-ai`, `trajetto-api-migrate`)                                | `:staging`                                                                                                                            | `:stable` (crie antes: [seção 8](#8-primeiro-deploy-na-ordem-com-conferências))                   |
| domínio da API                                                                                         | `api-staging.intrajetto.com`                                                                                                          | `api.intrajetto.com`                                                                              |
| `APP_ENV`                                                                                              | `staging`                                                                                                                             | `production`                                                                                      |
| `HTTP_REQUEST` / `API_HTTP_REQUEST`                                                                    | `https://staging.intrajetto.com` / `https://api-staging.intrajetto.com`                                                               | `https://www.intrajetto.com` / `https://api.intrajetto.com`                                       |
| `AI_LOCAL_URL`                                                                                         | `http://<App Name da IA de staging>:8080`                                                                                             | `http://<App Name da IA de produção>:8080`                                                        |
| segredos (senhas do Postgres e do Redis, `JWT_*`, token da IA, `WEBHOOK_SECRETS_KEY`, `DOCS_PASSWORD`) | **próprios**                                                                                                                          | **outros**; nunca compartilhe entre ambientes                                                     |
| `R2_*`                                                                                                 | bucket de staging (CORS para a web de staging)                                                                                        | bucket de produção                                                                                |
| backup do banco (aba _Backups_ do PostgreSQL, [seção 18](#18-backup-e-restauração))                    | prefixo `trajetto-staging/` no bucket `trajetto-backups`                                                                              | prefixo `trajetto-production/`; recomendado um bucket próprio (`trajetto-backups-prod`)           |
| `META_WHATSAPP_*`, `RESEND_*`                                                                          | **de teste** (número de teste da Meta; domínio de teste)                                                                              | reais                                                                                             |
| Application `trajetto-api-migrate` ([seção 15](#15-migrations))                                        | App Name `trajetto-api-migrate-staging`, imagem `:staging`                                                                            | App Name `trajetto-api-migrate-production`, imagem `:stable`                                      |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                                                       | `true` **só** na `trajetto-api-migrate`, ao preparar o banco vazio (seção 8, passo 4); a API fica com `false`                         | `false` (`true` na `trajetto-api-migrate` só numa instalação nova sem dados a restaurar, uma vez) |
| IA                                                                                                     | opcional: sem a Application `trajetto-ai`, use `AI_PROVIDER=none` na API (economiza ~1 GiB)                                           | `trajetto-ai` com `AI_PROVIDER=local`                                                             |
| `PROOF_SIGNING_*`                                                                                      | o certificado **de teste** ([seção 7.11](#711-certificado-do-comprovante-a1-icp-brasil)), ou vazio (sem assinatura, e o PDF diz isso) | o certificado A1 (e-CNPJ)                                                                         |
| réplicas da API                                                                                        | 1 (hoje; 2 para testar duas réplicas)                                                                                                 | 2                                                                                                 |
| environment do GitHub                                                                                  | `staging` (sem revisores)                                                                                                             | `production` (revisores obrigatórios)                                                             |
| `SWARM_API_SERVICE` (GitHub)                                                                           | `trajetto-api-staging`                                                                                                                | `trajetto-api-production`                                                                         |

### 7.2 Nomes: Name e App Name

Toda vez que o Dokploy pede para criar um serviço, o diálogo tem dois nomes:
**Name** (o rótulo no painel) e **App Name** (o nome do serviço no Swarm e o
**nome de rede** pelo qual os outros serviços o encontram). O App Name precisa
ser único no servidor inteiro, então o Dokploy sugere o Name com um sufixo
aleatório. Na montagem de 10/2026 os App Names ficaram com esse sufixo
aleatório, e o Dokploy instalado (v0.30.10) não deixa editar o App Name depois
de criado. **Os nomes da tabela abaixo, usados no resto deste documento, são
marcadores**: troque-os pelo App Name que o painel mostra (o sufixo não causa
problema e evita colisão entre staging e produção). Na criação, mantenha o App
Name sugerido (com o sufixo) ou digite o da tabela, se o diálogo deixar; depois
de criado, ele não muda. Os passos 7.4 a 7.7 dizem `<o App Name sugerido>`
para esse campo.

| Serviço                     | Onde criar                               | Name                   | App Name (staging)             | App Name (produção)               |
| --------------------------- | ---------------------------------------- | ---------------------- | ------------------------------ | --------------------------------- |
| banco                       | _Create Service → Database → PostgreSQL_ | `trajetto-postgres`    | `trajetto-postgres-staging`    | `trajetto-postgres-production`    |
| Redis                       | _Create Service → Database → Redis_      | `trajetto-redis`       | `trajetto-redis-staging`       | `trajetto-redis-production`       |
| IA                          | _Create Service → Application_           | `trajetto-ai`          | `trajetto-ai-staging`          | `trajetto-ai-production`          |
| API                         | _Create Service → Application_           | `trajetto-api`         | `trajetto-api-staging`         | `trajetto-api-production`         |
| migrations                  | _Create Service → Application_           | `trajetto-api-migrate` | `trajetto-api-migrate-staging` | `trajetto-api-migrate-production` |
| web (projeto `trajetto-ui`) | `trajetto-ui/docs/deploy.md`             | `trajetto-ui`          | `trajetto-ui-staging`          | `trajetto-ui-production`          |

Onde ver depois: o App Name aparece no topo da página do serviço (e na aba
_General_ dos Databases, como _Internal Host_). No host, `docker service ls`
lista os serviços com esse nome.

### 7.3 Credencial do GHCR

As imagens em `ghcr.io/trajetto-organization/` são privadas. A conexão do
Dokploy com o GitHub (a GitHub App de _Settings → Git_) serve para clonar
repositório — **não** dá acesso ao registry de imagens. Para o Dokploy puxar
as imagens:

1. No GitHub, com uma conta que tem acesso aos pacotes da organização:
   _Settings → Developer settings → Personal access tokens → Tokens
   (classic) → Generate new token (classic)_. Nome `dokploy-ghcr-pull`,
   validade a seu critério (anote a data para renovar), **só** o escopo
   `read:packages`. O GHCR não aceita tokens _fine-grained_. Copie o token.
2. Ele vai em **cada** Application (seções 7.6, 7.7 e 7.12), na aba
   _General_ → _Provider_ → _Docker_: _Registry URL_ `ghcr.io`, _Username_ =
   o usuário do GitHub dono do token, _Password_ = o token.
3. O mesmo token serve para a web (`trajetto-ui/docs/deploy.md`). No host,
   ninguém precisa de `docker login`: o Dokploy puxa com a credencial da
   Application. Só quem for puxar uma imagem à mão (o `resolve` de um P3009
   numa máquina que não a tem, [seção 15](#15-migrations)) faz um
   `docker login ghcr.io` com ele.

Se os pacotes forem públicos, os três campos ficam vazios. Sinal de que falta
a credencial: o deployment da Application termina em `error` com
`unauthorized` ou `denied` no log do pull.

### 7.4 PostgreSQL (Database)

1. No projeto `trajetto-api` do environment: **Create Service → Database →
   PostgreSQL**.
2. Preencha:

   | Campo             | Valor                                                                                                                                                                         |
   | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Name              | `trajetto-postgres`                                                                                                                                                           |
   | App Name          | `<o App Name sugerido>` (marcador neste documento: `trajetto-postgres-staging` ou `-production`; seção 7.2)                                                                   |
   | Database Name     | `trajetto`                                                                                                                                                                    |
   | Database User     | `trajetto`                                                                                                                                                                    |
   | Database Password | `openssl rand -hex 24` (hex: entra na URL da API sem precisar de escape); guarde no gerenciador de senhas                                                                     |
   | Docker Image      | `ghcr.io/trajetto-organization/trajetto-postgres@sha256:<digest>` ([seção 27](#27-pitr-com-pgbackrest); o Postgres 16 do CI; nunca outra versão maior sem migração planejada) |

3. **Create**, abra o serviço e clique em **Deploy** (o Database só sobe
   depois disso).
4. Na aba _General_, confira em _Internal Credentials_: _Internal Host_ = o
   App Name, _Internal Port_ = 5432. Em _External Credentials_, **deixe
   _External Port_ vazio**: o banco não pode ter porta no host.
5. A imagem vai sempre por digest (uma tag flutuante reiniciaria e
   atualizaria o banco num redeploy), copiado do resumo do run que publicou
   a `trajetto-postgres`. Um Database criado antes da onda 3 roda a
   `postgres:16-alpine@sha256:…` e troca de imagem pela
   [seção 27](#27-pitr-com-pgbackrest).
6. _Environment_ e _Resources_ da coluna do ambiente na
   [seção 27](#valores-por-ambiente) (no mínimo `POSTGRES_MEMORY_LIMIT_MB`
   igual ao _Memory Limit_), com _Command_ e _Args_ vazios; **Deploy**.
7. O backup do banco é a aba _Backups_ deste Database (seção 7.9): diário,
   para o Cloudflare R2, configurado na
   [seção 18](#18-backup-e-restauração). O PITR, onde já estiver ligado,
   segue a [seção 27](#27-pitr-com-pgbackrest).

### 7.5 Redis (Database)

1. **Create Service → Database → Redis**.
2. Preencha: Name `trajetto-redis`; App Name `<o App Name sugerido>`
   (marcador: `trajetto-redis-staging` ou `-production`; seção 7.2); Database
   Password `openssl rand -hex 32` (guarde); Docker Image `redis:7-alpine`.
3. **Create** e **Deploy**. _External Port_ vazio.
4. **Sem persistência e com teto de memória** (era o comando do compose): o
   Redis só guarda chaves que expiram sozinhas (contadores do rate limit,
   tickets de socket, o intervalo do "esqueci minha senha", fotos de 5–60 s
   das leituras do MASTER e as chaves do geocodificador, `geocoding:*`, entre
   elas o cache cifrado, por empresa, de até 48 h da busca de endereço) e o
   pub/sub do Socket.IO ([ADR 0002](./adr/0002-redis-descartavel.md) e o
   adendo de 10/11/2026); um snapshot só traria de volta chaves que deviam ter expirado, e o
   padrão `noeviction` de um Redis cheio desliga todo limitador de uma vez. Em
   _Advanced_, no campo de comando personalizado (_Command_ ou _Run Command_,
   conforme a versão), ponha **numa linha só**:
   ```
   redis-server --requirepass <a senha do passo 2> --save "" --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru
   ```
   A senha precisa estar aqui: o comando personalizado substitui o padrão do
   Dokploy, que é quem passava o `--requirepass`. Salve, **Deploy**, e confira:
   ```sh
   docker exec -it $(docker ps -q -f name=trajetto-redis-production | head -n 1) \
     redis-cli -a '<senha>' --no-auth-warning CONFIG GET maxmemory-policy   # allkeys-lru
   ```
   Se a sua versão não tiver campo de comando nos Databases, deixe o padrão:
   funciona, só fica sem o teto e com snapshot em disco (lacuna da
   [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)).
5. Em _Advanced → Resources_, _Memory Limit_ `536870912` (512 MiB: os 256 MB
   de dados mais os buffers das conexões de pub/sub de cada réplica). Os
   campos de recursos do Dokploy recebem bytes (confira a dica do campo; se ele
   aceitar `512M`, tanto faz).

### 7.6 `trajetto-ai` (Application)

1. **Create Service → Application**. Name `trajetto-ai`; App Name
   `<o App Name sugerido>` (marcador: `trajetto-ai-staging` ou `-production`;
   seção 7.2). **Create**.
2. Aba _General_ → _Provider_ → **Docker**:

   | Campo        | Valor                                                                     |
   | ------------ | ------------------------------------------------------------------------- |
   | Docker Image | `ghcr.io/trajetto-organization/trajetto-ai:staging` (produção: `:stable`) |
   | Registry URL | `ghcr.io`                                                                 |
   | Username     | o usuário do token (seção 7.3)                                            |
   | Password     | o token `read:packages`                                                   |

   **Save**.

3. Aba _Environment_ (uma variável por linha, sem aspas) → **Save**:
   ```
   AI_TOKEN=<openssl rand -hex 32 — o MESMO valor vai em AI_LOCAL_TOKEN da API>
   OCR_THREADS=2
   AI_MAX_QUEUE=2
   ```
   `OCR_THREADS` igual ao limite de CPU do passo 6. O serviço recusa subir
   com `AI_TOKEN` de menos de 32 caracteres.
4. Aba _Domains_: **nada**. O serviço não pode ter endereço público.
5. _Advanced → Ports_: **nada** (nenhuma porta publicada; a API o alcança pela
   rede `dokploy-network`, na 8080).
6. _Advanced → Resources_: _Memory Limit_ `1073741824` (1 GiB; pico medido de
   0,60–0,63 GiB) e _CPU Limit_ `2000000000` (2 CPUs em nano-CPUs: o OCR
   satura todo núcleo que recebe, e o teto protege o Postgres). Confira a dica
   dos campos; **Save**.
7. _Advanced → Cluster Settings_: _Replicas_ `1`.
8. _Advanced → Swarm Settings_: cole cada bloco no campo de mesmo nome e
   salve. Os tempos vão em **nanossegundos** (o formato da API do Docker:
   30 s = `30000000000`). Os campos não citados ficam vazios.

   _Health Check_ (o mesmo da imagem; colar deixa explícito):

   ```json
   {
     "Test": [
       "CMD",
       "python",
       "-c",
       "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3)"
     ],
     "Interval": 30000000000,
     "Timeout": 5000000000,
     "StartPeriod": 30000000000,
     "Retries": 3
   }
   ```

   _Restart Policy_ (sem limite de tentativas: sem estado, reiniciar não perde
   nada; a fila do Postgres guarda o trabalho):

   ```json
   { "Condition": "any", "Delay": 5000000000, "MaxAttempts": 0 }
   ```

   _Update Config_ (sobe a nova, espera o healthcheck, só então derruba a
   antiga; falhou = volta):

   ```json
   {
     "Parallelism": 1,
     "Delay": 5000000000,
     "FailureAction": "rollback",
     "Monitor": 30000000000,
     "Order": "start-first"
   }
   ```

   _Rollback Config_:

   ```json
   {
     "Parallelism": 1,
     "Delay": 5000000000,
     "Monitor": 30000000000,
     "Order": "start-first"
   }
   ```

9. Clique em **Deploy** e acompanhe em _Deployments_ (verde = `done`) e em
   _Logs_.
10. Anote o **applicationId** (seção 7.10).

Em staging com `AI_PROVIDER=none` na API, pule esta seção inteira (o
pipeline avisa "deploy de trajetto-ai pulado" e segue).

### 7.7 `trajetto-api` (Application)

1. **Create Service → Application**. Name `trajetto-api`; App Name
   `<o App Name sugerido>` (marcador: `trajetto-api-staging` ou `-production`;
   seção 7.2). **Create**.
2. Aba _General_ → _Provider_ → **Docker**: _Docker Image_
   `ghcr.io/trajetto-organization/trajetto-api:staging` (produção:
   `:stable`), _Registry URL_ `ghcr.io`, _Username_ e _Password_ da seção 7.3.
   **Save**. Não ligue _Autodeploy_: quem decide o deploy é o workflow.
3. Aba _Environment_ → cole e preencha → **Save**. A lista completa, com o
   valor de cada ambiente e o porquê de cada uma, está em
   [`variaveis-de-ambiente.md`](./variaveis-de-ambiente.md); este é o conjunto
   de produção (em staging, os valores da tabela 7.1):

   ```
   APP_ENV=production
   NODE_OPTIONS=--max-old-space-size=768
   LOG_LEVEL=info

   DATABASE_URL=postgresql://trajetto:<SENHA_DO_POSTGRES>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=10&pool_timeout=5&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=-c%20statement_timeout%3D30000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000
   ALLOW_EMPTY_DATABASE_BOOTSTRAP=false
   RUN_MIGRATIONS_ON_BOOT=false

   REDIS_URL=redis://:<SENHA_DO_REDIS>@trajetto-redis-production:6379

   HTTP_REQUEST=https://www.intrajetto.com
   API_HTTP_REQUEST=https://api.intrajetto.com
   JWT_SECRET=<openssl rand -base64 48>
   JWT_SECRET_REFRESH_TOKEN=<openssl rand -base64 48, outro valor>
   MASTER_USER_EMAIL=<e-mail da equipe>
   MASTER_USER_INITIAL_PASSWORD=<senha forte>

   RATE_LIMIT_TRUSTED_PROXY=cloudflare
   RATE_LIMIT_FORWARDER_SECRET=<o MESMO valor da web deste ambiente>

   UPLOAD_STORAGE_TYPE=r2
   UPLOAD_LOCAL_PATH=./tmp
   R2_ACCOUNT_ID=<id da conta Cloudflare>
   R2_BUCKET_NAME=<bucket de fotos deste ambiente>
   R2_ACCESS_KEY_ID=<token R2>
   R2_SECRET_ACCESS_KEY=<token R2>
   UPLOAD_ORPHAN_GC=dry-run

   AI_PROVIDER=local
   AI_LOCAL_URL=http://trajetto-ai-production:8080
   AI_LOCAL_TOKEN=<o MESMO valor do AI_TOKEN da Application trajetto-ai>

   WEBHOOK_SECRETS_KEY=<openssl rand -base64 32>
   HEALTHCHECK_PING_URL=<URL do check de 1 min>
   DOCS_USER=<usuário>
   DOCS_PASSWORD=<20+ caracteres>

   META_WHATSAPP_ACCESS_TOKEN=<token>
   META_WHATSAPP_PHONE_NUMBER_ID=<id>
   META_WHATSAPP_API_VERSION=v23.0
   META_WHATSAPP_BUSINESS_ACCOUNT_ID=<id da WABA>
   EXPO_ACCESS_TOKEN=<token de acesso do projeto na Expo>
   RESEND_SECRET_KEY=<re_…>
   RESEND_FROM_EMAIL=<remetente do domínio verificado>
   ```

   Os nomes dos 21 modelos de WhatsApp são fixos no código
   ([whatsapp-modelos.md](./whatsapp-modelos.md)): `META_WHATSAPP_TEMPLATE_NAME`
   e `META_WHATSAPP_CUSTOMER_TEMPLATE_NAME` não são mais lidas e podem sair do
   _Environment_. Defina `EXPO_ACCESS_TOKEN` nos dois ambientes **antes** de
   ligar a "segurança reforçada de push" no projeto da Expo (D43).

   Mais, quando forem usadas: `META_WHATSAPP_APP_SECRET`,
   `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `RESEND_WEBHOOK_SECRET`,
   `TURNSTILE_SECRET_KEY` (definida, o formulário de orçamento exige o token
   do Turnstile), `RATE_LIMIT_EDGE_SECRET`, o
   certificado do comprovante (`PROOF_SIGNING_*`), mapa e geocoder
   (`PROOF_MAP_*`, `REVERSE_GEOCODER_*`), `MIN_MOBILE_CONTRACT`,
   `MOBILE_STORE_URL`, `ACTIVITY_RETENTION_DAYS`.

   Mapa de fundo do app (onda 5, `GET /config/map`): o dono define no
   Dokploy `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `MAP_TILE_URL_DARK` e
   `MAP_TILE_ATTRIBUTION_DARK` com **os mesmos valores do web** do mesmo
   ambiente (copie do _Environment_ da Application da web). Sem elas, o mapa
   do app mostra os marcadores sem mapa de fundo e avisa; um modelo inválido
   derruba o boot da réplica nova (o _Update Config_ do passo 8 volta para
   a anterior). A
   chave do MapTiler dentro da URL é restrita por _Allowed HTTP Origins_; o
   app carrega a página do mapa sob a origem da web do build
   (`EXPO_PUBLIC_WEB_APPLICATION_URL`), e os tiles levam o `Referer` dela:
   confira no primeiro teste no aparelho se os tiles carregam no WebView do
   app ([`infraestrutura.md` §11.2](./infraestrutura.md#112-credenciais-de-provedores),
   "Chave do MapTiler").

   Cuidados:

   - Os parâmetros depois do `?` da `DATABASE_URL` são os mesmos do compose
     antigo, um a um: o pool e os tetos de runtime
     ([`arquitetura.md`](./arquitetura.md#conexão-com-o-postgres)). Copie
     inteira; troque só a senha, o host e, se mudou, usuário e banco.
   - A URL **sem tetos** (`...?schema=public&connection_limit=2&connect_timeout=10`,
     a antiga `MIGRATION_DATABASE_URL`) não vai aqui: é a `DATABASE_URL` da
     Application `trajetto-api-migrate` (seção 7.12), porque um
     `CREATE INDEX` cancelado no meio é uma migration falhada. Numa API
     montada antes de 31/10/2026, a `MIGRATION_DATABASE_URL` pode sair: com
     `RUN_MIGRATIONS_ON_BOOT=false`, nenhum build a lê na API (seção 15).
   - `ALLOW_EMPTY_DATABASE_BOOTSTRAP` fica `false` na API sempre: quem prepara
     um banco vazio é a etapa de release (seção 8, passo 4).
   - `RUN_MIGRATIONS_ON_BOOT=false` não muda nada nas imagens de agora (elas
     a ignoram), mas os builds de antes de 31/10/2026 (`main-<sha>` e os
     `sha-<7>` anteriores à imagem de migração), que ainda servem de alvo de
     rollback, a leem com padrão `true` e voltariam a migrar no boot. Não a
     apague enquanto um deles puder voltar ([seção 15](#15-migrations)).
   - Senha com `@`, `/`, `:`, `#` ou `%` quebra a URL. As senhas geradas com
     `openssl rand -hex` não têm nenhum deles.
   - Não ponha aspas nem espaços em volta do `=`.
   - `PORT` e `NODE_ENV` não se definem: a imagem já traz `3333` e
     `production`.
   - `API_HTTP_REQUEST` é a URL **pública** da API (a mesma do _Domains_): o
     logo dos e-mails é montado a partir dela
     (`<API_HTTP_REQUEST>/assets/trajetto-logo.png`, servido pela própria API)
     e buscado pelo cliente de e-mail, de fora. Endereço interno ou errado deixa
     o logo quebrado; vazia, os e-mails saem sem logo.

4. Aba _Domains_ → **Add Domain**:

   | Campo                | Valor                                                                 |
   | -------------------- | --------------------------------------------------------------------- |
   | Host                 | produção: `api.intrajetto.com`; staging: `api-staging.intrajetto.com` |
   | Path                 | `/`                                                                   |
   | Container Port       | `3333`                                                                |
   | HTTPS                | ligado                                                                |
   | Certificate Provider | `Let's Encrypt`                                                       |

   **Create**. O Dokploy escreve `/etc/dokploy/traefik/dynamic/<App Name>.yml`
   com o roteador `web` (redireciona para HTTPS), o roteador `websecure` com o
   certificado e o serviço apontando para `http://<App Name>:3333` com
   `passHostHeader: true` — exatamente o que os labels do compose faziam
   (seção 7.8).

5. _Advanced → Ports_: **nada**.
6. _Advanced → Cluster Settings_: _Replicas_ `2` → **Save**. Duas réplicas
   idênticas; o Redis leva os eventos de tempo real entre elas (ADR 0007/0008).
7. _Advanced → Resources_: _Memory Limit_ `1073741824` (1 GiB por réplica; o
   heap de 768 MB do `NODE_OPTIONS` é ~75 % disso, e o resto fica para
   Buffers de uploads e planilhas). **Sem** limite de CPU (o throttling piora o
   p99) e sem reserva. Suba os dois juntos, se precisar.
8. _Advanced → Swarm Settings_ (tempos em nanossegundos; campos não citados
   ficam vazios):

   _Health Check_ — **liveness**, nunca a readiness. No Swarm, falhar aqui
   **destrói** a réplica; apontada para a readiness, um soluço do Postgres já
   derrubou as duas réplicas ao mesmo tempo. A imagem traz o mesmo teste com 3
   tentativas; o compose usava 5:

   ```json
   {
     "Test": [
       "CMD",
       "wget",
       "-q",
       "-O",
       "/dev/null",
       "http://127.0.0.1:3333/health/liveness"
     ],
     "Interval": 30000000000,
     "Timeout": 10000000000,
     "StartPeriod": 30000000000,
     "Retries": 5
   }
   ```

   _Restart Policy_ (sem limite de tentativas: um limite só transforma um
   crash loop em 0/2 permanente):

   ```json
   { "Condition": "any", "Delay": 5000000000, "MaxAttempts": 0 }
   ```

   _Update Config_ (uma réplica por vez, a nova antes de derrubar a velha,
   30 s de observação, rollback automático):

   ```json
   {
     "Parallelism": 1,
     "Delay": 5000000000,
     "FailureAction": "rollback",
     "Monitor": 30000000000,
     "Order": "start-first"
   }
   ```

   _Rollback Config_:

   ```json
   {
     "Parallelism": 1,
     "Delay": 5000000000,
     "Monitor": 30000000000,
     "Order": "start-first"
   }
   ```

   _Stop Grace Period_ (se existir na sua versão): `40000000000` (40 s). Sem
   o campo, o contorno é `docker service update --stop-grace-period 40s
trajetto-api-production` no host depois de cada deploy (o deploy seguinte
   o desfaz); ver a lacuna na
   [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora).
   Só quando o grace aparecer no serviço,

   ```bash
   docker service inspect trajetto-api-production \
     --format '{{json .Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}'
   # 40000000000
   ```

   ponha `STOP_GRACE_PERIOD_MS=40000` no _Environment_ (passo 3) →
   **Save** → **Deploy**: o desligamento passa a ter teto de 35 s. Sem a
   variável, ele cabe nos 10 s do Docker.

   _Placement_ (onda 17, depois dos labels do nó; até 4 réplicas por nó,
   [runbooks/swarm-multi-no.md](./runbooks/swarm-multi-no.md)):
   `{ "Constraints": ["node.labels.trajetto.app==true"], "MaxReplicas": 4 }`.

9. **Deploy**, depois de a `trajetto-api-migrate` ter rodado a etapa de
   release (seção 7.12; num banco vazio, a seção 8, passo 4). No primeiro
   deploy de um ambiente, quem faz esse Deploy é o pipeline, logo depois da
   etapa: em staging, o run da seção 8, passo 4; em produção, o primeiro
   promote com os quatro `DOKPLOY_*` (seção 8, "Produção", passo 4). Não
   clique antes. Acompanhe _Deployments_ e _Logs_: o boot espera o Postgres,
   confere que o banco tem todas as migrations do build e só então escuta
   a 3333. Ele nunca migra.
10. Anote o **applicationId** e confirme o App Name (seção 7.10).

### 7.8 O Traefik da API (o que os labels faziam)

Não há nada a editar à mão. Para conferir, no host:

```sh
cat /etc/dokploy/traefik/dynamic/trajetto-api-production.yml
```

Deve ter dois roteadores com a regra ``Host(`<host da API>`)`` (em produção,
`api.intrajetto.com`)
(um no entrypoint `web`, que redireciona para HTTPS, e um no `websecure`, com
`certResolver: letsencrypt`) e o serviço com
`url: http://trajetto-api-production:3333` e `passHostHeader: true`. O mesmo
arquivo também é editável no painel (_Advanced_ → _Traefik_, nas versões que
mostram), mas o Dokploy o reescreve quando a aba _Domains_ muda: não guarde
ajuste manual ali.

O que os labels faziam e **não** foi copiado, de propósito: o health check do
balanceador em `/health/readiness` (ver a lacuna na
[seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora))
e a prioridade do roteador. O compose da API não tinha middlewares de borda
(rate limit e HSTS da web ficam no manual da web); o rate limit da API é da
própria API.

O registro DNS do host nasce **já com proxy** (nuvem laranja): o firewall só
admite a Cloudflare ([seção 6.1](#61-firewall-da-vps-contabo)), e o desafio
HTTP-01 do Let's Encrypt chega ao Traefik pela Cloudflare, na porta 80. Nunca
crie um registro sem proxy apontando para a VPS: ele não passa pelo firewall e
publica o IP da origem no DNS público. O procedimento e o teste do desafio
estão em [`infraestrutura.md` → 5.5](./infraestrutura.md#55-domínios-e-certificados-lets-encrypt).

Se o certificado não sai (o domínio responde com o certificado padrão do
Traefik e a Cloudflare dá erro 526): primeiro rode o teste do desafio (o
caminho `/.well-known/acme-challenge/` em `http://` tem de responder 404 sem
redirect). Saída simples: uma _Configuration Rule_ só para o hostname novo,
com _SSL_ = _Full_, até o certificado aparecer no log do Traefik
(`docker logs dokploy-traefik 2>&1 | grep -i acme`); depois apague a regra.
**Não** mude a zona inteira para _Full_ (sem strict): enfraquece a produção
toda. Outras saídas, não testadas aqui: um _Origin Certificate_ da Cloudflare
como certificado próprio do domínio, ou o desafio DNS-01 com um token da
Cloudflare restrito a _Zone · DNS · Edit_ na zona.

### 7.9 Backup do PostgreSQL (aba Backups do Database)

O backup do banco **não é uma Application**: é o _Backup_ do próprio
Database PostgreSQL (7.4), que o Dokploy roda na agenda e envia ao
Cloudflare R2 por um _S3 Destination_. É o único mecanismo de backup do banco
(decisão de 26/10/2026; o antigo serviço `trajetto-backup` saiu do código e
do pipeline).

Faça depois que o Database estiver de pé, seguindo o passo a passo da
[seção 18](#18-backup-e-restauração) (destino S3, agenda diária, prefixo do
ambiente, retenção de 30 cópias e a notificação de falha), rode um backup
manual e confira o arquivo no bucket.

### 7.10 Anotar o applicationId e o App Name

O pipeline precisa, por ambiente, do **applicationId** de cada uma das três
Applications e do **App Name** da API (este só para a conferência por SSH).

- **applicationId**: abra a Application no painel e olhe a barra de
  endereços. A URL termina em `.../services/application/<applicationId>`: é
  esse último pedaço (letras, números, `-` e `_`). O script recusa outro
  formato.
- **App Name**: o que ficou na criação, em geral o sugerido pelo Dokploy,
  com sufixo (seção 7.2); confira no topo da página da Application ou com
  `docker service ls` no host.

| Anotação                                | Vira no GitHub (environment do ambiente) |
| --------------------------------------- | ---------------------------------------- |
| applicationId da `trajetto-api`         | secret `DOKPLOY_API_APPLICATION_ID`      |
| applicationId da `trajetto-ai`          | secret `DOKPLOY_AI_APPLICATION_ID`       |
| applicationId da `trajetto-api-migrate` | secret `DOKPLOY_MIGRATE_APPLICATION_ID`  |
| App Name da `trajetto-api`              | variable `SWARM_API_SERVICE`             |

A chave de API do Dokploy (`DOKPLOY_API_KEY`) é uma só para o painel inteiro:
_Settings → Profile → API/CLI → Generate_ (o nome do menu varia entre
versões). Copie na hora: o Dokploy não mostra de novo.

### 7.11 Certificado do comprovante (A1 ICP-Brasil)

O comprovante de entrega em PDF pode sair **assinado** com um certificado
ICP-Brasil A1 (e-CNPJ), o que lhe dá validade jurídica (MP 2.200-2/2001). O
certificado é **opcional**: sem ele o PDF sai inteiro (fotos, assinatura do
recebedor, GPS, QR, código de verificação) e diz "sem assinatura digital
ICP-Brasil", o que é verdade. O estado aparece em _Sistema → Provedores
externos_ ("Certificado do comprovante") e em `/health/metrics`
(`proof_signing`).

**De onde vem cada valor.** Só o arquivo `.pfx` vem de uma certificadora; o
resto é texto do próprio sistema. O Trajetto nunca se conecta ao ICP: a API
assina cada PDF no servidor, com a chave que está dentro do `.pfx`, e quem
abre o PDF (Adobe, validar.iti.gov.br) confere se o certificado foi emitido
dentro da cadeia ICP-Brasil.

| Variável                     | O que é                                                         | Staging                               | Produção                                               |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `PROOF_SIGNING_PFX_BASE64`   | o `.pfx` (certificado + chave privada) em base64, numa linha só | o certificado **de teste** (abaixo)   | o A1 **real**, entregue pela certificadora             |
| `PROOF_SIGNING_PFX_PASSWORD` | a senha que protege o `.pfx`                                    | a do certificado de teste             | a que **você escolhe** ao baixar o A1 na certificadora |
| `PROOF_SIGNER_LOCATION`      | onde foi assinado (gravado na assinatura)                       | ex. `Rio de Janeiro, RJ`              | o mesmo                                                |
| `PROOF_SIGNER_CONTACT`       | contato gravado na assinatura (uma caixa que alguém lê)         | ex. `contato@intrajetto.com`          | o mesmo                                                |
| `PROOF_ISSUER_LEGAL_NAME`    | quem gerou um comprovante **sem** assinatura                    | `Trajetto`                            | a razão social                                         |
| `PROOF_ISSUER_CNPJ`          | o CNPJ desses comprovantes; vazio = omitido                     | vazio (a API recusa um CNPJ inválido) | o CNPJ                                                 |

Com o certificado carregado, o signatário que aparece vem do **próprio
certificado** (o CN do e-CNPJ, "RAZAO SOCIAL:CNPJ"), não dessas variáveis. Use
`PROOF_SIGNING_PFX_BASE64` **ou** `PROOF_SIGNING_PFX_PATH` (arquivo montado em
_Advanced → Volumes_), nunca os dois.

#### Staging: certificado de teste

O A1 só é emitido para um CNPJ e é pago. Para provar em staging que a
assinatura funciona, gere um certificado de teste. A API assina com qualquer
`.pfx` com chave RSA, uso de assinatura e validade em curso, mas só afirma a
validade ICP-Brasil quando a cadeia do certificado chega, por assinaturas, a
uma raiz oficial do ITI (AC Raiz v5/v10/v11; ver
[arquitetura](./arquitetura.md#comprovante-de-entrega)). O certificado de
teste não chega: o PDF sai assinado (CMS simples), diz que o certificado não
pertence à cadeia ICP-Brasil, e o log da API mostra uma vez
`proof_signing_not_icp_brasil`. É o mesmo tipo de certificado que os testes
automáticos geram (`tests/support/test-signing-certificate.ts`).

No Git Bash, numa pasta **fora** dos repositórios (o `.pfx` contém a chave
privada e nunca vai para o git):

```bash
mkdir -p ~/certificados-trajetto && cd ~/certificados-trajetto

# 1. Chave e certificado, válidos por 1 ano, que dizem no nome que são de teste.
#    Sem MSYS_NO_PATHCONV, o Git Bash trata "/C=BR/..." como caminho.
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -sha256 -days 365 -nodes \
  -keyout teste.key -out teste.crt \
  -subj "/C=BR/O=ICP-Brasil/OU=TESTE - NAO E UM CERTIFICADO REAL/CN=TRAJETTO TESTE STAGING" \
  -addext "keyUsage=critical,digitalSignature,nonRepudiation"

# 2. O .pfx com senha. As três opções do fim usam o formato que o node-forge
#    abre; o padrão do OpenSSL 3 (PBES2/AES) pode não abrir (PFX_UNREADABLE).
SENHA=$(openssl rand -hex 24)
openssl pkcs12 -export -inkey teste.key -in teste.crt \
  -out trajetto-staging-teste.pfx -passout "pass:$SENHA" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1

# 3. Base64 numa linha só, a senha num arquivo, e a chave solta apagada.
base64 -w0 trajetto-staging-teste.pfx > pfx-base64.txt
printf '%s' "$SENHA" > senha.txt && unset SENHA
rm teste.key teste.crt
```

Cole o conteúdo de `pfx-base64.txt` em `PROOF_SIGNING_PFX_BASE64` e o de
`senha.txt` em `PROOF_SIGNING_PFX_PASSWORD` no _Environment_ da
`trajetto-api` de staging, com as outras variáveis da tabela; **Save** e
**Deploy**. Em _Provedores externos_ → **Atualizar**, o certificado aparece
pronto, com a validade.

O PDF sai assinado, mas Adobe e validar.iti.gov.br dizem "origem
desconhecida" ou "inválida": nenhuma autoridade emitiu esse certificado. Por
isso o PDF não afirma a validade ICP-Brasil (só o A1 real, com a cadeia
verificada, faz isso), o certificado de teste **nunca** vai para produção, e
um comprovante de staging não serve como documento. Renove-o com os mesmos
comandos antes de 1 ano.

#### Produção: o A1 real

1. Com o CNPJ aberto, compre um **e-CNPJ A1** numa certificadora credenciada
   (Certisign, Serasa Experian, Valid, Soluti etc.). Precisa ser o A1, em
   arquivo: o A3, em token ou cartão, não serve para um servidor. A compra
   pede os documentos da empresa (CNPJ, contrato social, documento do
   representante legal) e uma validação por vídeo ou presencial. Vale 1 ano.
2. Na emissão, a certificadora pede que você **escolha a senha** e entrega o
   `.pfx`. Se ela instalar no navegador ou no Windows, exporte **com a chave
   privada**.
3. Rode `base64 -w0 <arquivo>.pfx > pfx-base64.txt` e troque, na
   `trajetto-api` de produção, `PROOF_SIGNING_PFX_BASE64` e
   `PROOF_SIGNING_PFX_PASSWORD`; ponha `PROOF_ISSUER_LEGAL_NAME` e
   `PROOF_ISSUER_CNPJ` reais. **Save**, **Deploy**, _Provedores externos_ →
   **Atualizar**.
4. Confira um comprovante novo no validar.iti.gov.br: deve dizer "aprovado".
5. **Renovação**: o alerta "Certificado ICP do comprovante vence em" avisa
   antes do vencimento ([seção 20](#20-alertas-e-monitoramento)). Renove o A1,
   troque as duas variáveis e faça **Deploy**. Vencido, os comprovantes voltam
   a sair sem assinatura (e dizem isso); a API não cai.

Estados que o painel pode mostrar: `PFX_UNREADABLE` (senha errada, arquivo
corrompido ou formato que o node-forge não abre), `KEY_CERTIFICATE_MISMATCH`,
`KEY_USAGE`, `NOT_YET_VALID` e vencido. O antigo `NOT_ICP_BRASIL` (emissor sem
`O=ICP-Brasil`) deixou de existir: um certificado fora da cadeia ICP-Brasil
fica pronto e assina, mas sem o texto de validade jurídica, e o log da API
mostra uma vez `proof_signing_not_icp_brasil` com o motivo
(`UNTRUSTED_CHAIN`, `LEAF_IS_CA`, `OUTSIDE_VALIDITY`). Com o A1 real esse aviso
não pode aparecer: se aparecer, falta o intermediário no `.pfx` (exporte com a
cadeia completa).

### 7.12 `trajetto-api-migrate` (Application)

A Application que roda as migrations e os seeds antes de cada deploy que os
muda. O passo a passo, os quatro campos que importam (imagem, `DATABASE_URL`,
_Restart Policy_ `none` e o applicationId no GitHub) e o porquê de cada um
estão na [seção 15](#15-migrations), "Configurar a Application
`trajetto-api-migrate`". Crie-a antes da `trajetto-api` (ou junto): a API não
sobe num banco sem as migrations do build dela.

## 8. Primeiro deploy, na ordem, com conferências

A ordem é **bancos → IA → migrations → API → backup do banco → web → app**. Cada passo só começa
quando o anterior passou na conferência. Faça tudo em staging; depois repita
em produção.

1. **Imagens existem.** O primeiro push em `staging` (com o environment
   `staging` do GitHub ainda sem os secrets do Dokploy) termina verde e
   publica `sha-<7>` das três imagens e `staging` da API e da IA; o deploy
   aparece como "pulado". (A tag `staging` da imagem de migração só nasce no
   primeiro deploy com o Dokploy configurado: é o pipeline que a move, logo
   antes de rodar a etapa.) Confira em _GitHub → Trajetto-Organization → Packages_.
2. **Postgres e Redis** (seções 7.4 e 7.5), com **Deploy** em cada um.
   Conferir:
   ```sh
   docker service ls | grep -E 'trajetto-(postgres|redis)-staging'   # 1/1 cada
   docker exec $(docker ps -q -f name=trajetto-postgres-staging | head -n 1) \
     pg_isready -U trajetto -d trajetto                               # accepting connections
   ```
3. **`trajetto-ai`** (seção 7.6). Conferir: `docker service ls` mostra
   `trajetto-ai-staging 1/1` (o healthcheck leva até ~1 min no aquecimento).
4. **`trajetto-api-migrate` e `trajetto-api`** (seções 7.12 e 7.7), sem
   Deploy manual: a API não migra e recusa um banco sem as migrations do
   build, e quem as aplica é a etapa de release, que o pipeline roda antes da
   API. Crie a `trajetto-api-migrate` ([seção 15](#15-migrations),
   "Configurar a Application `trajetto-api-migrate`"); num **banco vazio**,
   ponha no Environment dela, só para este primeiro deploy,
   `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true`, `MASTER_USER_EMAIL` e
   `MASTER_USER_INITIAL_PASSWORD`. Crie a `trajetto-api` (seção 7.7, até o
   passo 8). Configure o environment do GitHub ([seção 13](#13-configurar-o-github),
   com os quatro `DOKPLOY_*`) e rode o pipeline (_Actions → Pipeline →
   Run workflow_ na `staging`, ou um push): ele move
   `trajetto-api-migrate:staging`, faz o deploy da Application de migração,
   espera a etapa terminar (prepara o banco vazio e cria o usuário master) e
   só então faz o deploy da IA e da API. Depois apague as três variáveis da
   `trajetto-api-migrate` (Save; vale no próximo deploy). Em produção com
   dados vindos do Portainer, **não** ligue a flag: siga a
   [seção 24](#24-migrar-do-portainer-para-o-dokploy) e restaure antes.
   Conferir (o passo do pipeline termina com "Migrations:
   trajetto-api-migrate concluiu a etapa de release"):

   ```sh
   docker service ls | grep trajetto-api-staging                    # 2/2
   curl -s -o /dev/null -w '%{http_code}\n' https://api-staging.intrajetto.com/health/readiness   # 200
   # a IA é alcançável DE DENTRO da API (nome de rede + porta):
   docker exec $(docker ps -q -f name=trajetto-api-staging | head -n 1) \
     wget -q -O - http://trajetto-ai-staging:8080/health               # resposta 200 do serviço
   ```

   E, logado como MASTER na web, _Sistema → Provedores_: a linha "Leitura de
   fotos (trajetto-ai)" sem erro (401 = os tokens dos dois lados diferem).

   **Banco trocado depois** (Database recriado ou restaurado, servidor
   refeito): a tag `staging-applied` (na produção, `stable-applied`)
   registra o que rodou no banco **antigo**, e o pipeline pula a etapa para
   o mesmo digest. Dê **Deploy** na `trajetto-api-migrate` do ambiente (num
   ambiente que já rodou o pipeline, a tag `:staging` ou `:stable` dela
   existe) e espere `Running` antes do deploy da API; num banco vazio, com
   as três variáveis acima de novo. Não apague a versão de `-applied` no
   GHCR para forçar o pipeline: ela é o mesmo digest de `sha-<7>`,
   `src-<hash>` e da tag do ambiente da imagem de migração, e apagar a versão
   apaga todas essas tags ([seção 22](#22-bucket-r2-e-retenção-no-ghcr)).

5. **Backup do banco** (seção 7.9, passo a passo na
   [seção 18](#18-backup-e-restauração)): crie o backup na aba _Backups_ do
   Database PostgreSQL e rode um manual. Conferir o arquivo novo no bucket,
   sob o prefixo `trajetto-staging/`.
6. **GitHub** ([seção 13](#13-configurar-o-github)): confira os secrets e
   variáveis do environment `staging` (configurados no passo 4). Um push em
   `staging` faz o deploy sozinho (migrations, se mudaram → IA → API) e
   termina com "convergiu".
7. **Web e app de staging**: `trajetto-ui/docs/deploy.md` e
   `trajetto-mobile/docs/deploy.md` (resumo na
   [seção 26](#26-os-três-repositórios-juntos)).

**Produção**, depois de o staging estar verde:

1. **Crie a tag `stable` antes de montar as Applications de produção**: no
   GitHub, _Actions → Production → Run workflow_ (branch `main`),
   `image_tag = sha-<7>` de um build verde de staging, e aprove o
   environment `production`. Como o environment `production` ainda não tem os
   secrets do Dokploy, o job move `stable` da API e da IA e pula o deploy
   com um aviso. Assim as Applications de produção já nascem em `:stable`. A
   `trajetto-api-migrate:stable` nasce no primeiro promote com os secrets: o
   pipeline a move antes de rodar a etapa.
2. Seções 7.4 a 7.9 e 7.12 no environment `production`, com os valores de
   produção (tabela 7.1); a `trajetto-api` até o passo 8 da seção 7.7,
   **sem Deploy** (a etapa de release ainda não rodou na produção, e ela
   recusaria o banco). Num banco vazio de verdade, as três variáveis do
   passo 4 do staging vão na `trajetto-api-migrate` de produção. Vindo do
   Portainer, a [seção 24](#24-migrar-do-portainer-para-o-dokploy) diz em
   que ponto restaurar o banco.
3. As conferências do Postgres, do Redis e da `trajetto-ai` (passos 2 e 3 do
   staging), com `-production`. A da API vem no passo 5.
4. Os secrets do environment `production` no GitHub (com revisores
   obrigatórios, e os quatro `DOKPLOY_*`) e, então, o **primeiro promote**:
   o merge do PR `staging → main`, ou _Run workflow_ na `main` com o mesmo
   `sha-<7>` do passo 1. Ele move `trajetto-api-migrate:stable` (que só
   então passa a existir), roda a etapa de release na produção (um banco com
   dados: só os seeds idempotentes, ou as migrations que faltarem; um banco
   vazio: a preparação e o usuário master, e as três variáveis saem depois)
   e só então faz o deploy da IA e da API. A partir daí, todo merge em `main`
   promove e faz o deploy.
5. As conferências da API, as do staging (passo 4) com `-production` e o
   host de produção: `2/2`, `/health/readiness` 200, a IA alcançável de
   dentro da API e _Sistema → Provedores_ sem erro.
6. Web de produção **depois** da API; app por último.

## 9. O serviço de IA (`trajetto-ai`)

A leitura de fotos (número e data do canhoto, odômetro) roda num serviço
próprio: RapidOCR sobre ONNX Runtime, só CPU, modelos embutidos na imagem e
conferidos por SHA-256 (o boot não precisa de rede). Ele só transcreve; quem
decide o que a foto diz é a API (ADR 0010; ver
[`arquitetura.md`](./arquitetura.md#ia-local)).

**Como é criado**: uma Application própria do Dokploy, sem domínio
([seção 7.6](#76-trajetto-ai-application)). A imagem `trajetto-ai` é
construída no job `Build` do `staging.yml` (do stage `runtime`, depois de o
pytest passar no stage `test`, no job `AI OCR`) e promovida junto com a API
(`staging` e `stable`).
Antes do push, essa mesma imagem sobe no runner sem rede, com a raiz só
leitura e um token descartável: precisa passar no próprio HEALTHCHECK (os
dois perfis carregados e a leitura do `warmup.jpg`) e informar o commit em
`/health`; se falhar, ela não vai para o GHCR e a staging não é atualizada
(a imagem da API, publicada antes no mesmo job, fica sem o `staged-<sha>`).
O pipeline faz o deploy dela **antes** da API, e só quando o digest muda
([seção 3](#como-o-pipeline-fala-com-o-dokploy)): um push que não mexe em
`infra/ai-ocr` reaproveita a imagem anterior e não reinicia a IA.

**Camadas da imagem** (`infra/ai-ocr/Dockerfile`): a VPS de staging puxava
as camadas do GHCR por uma rota IPv6 que derruba a conexão no meio do
download (a correção no host, que leva os downloads do GitHub ao IPv4, está
na [seção 6.2](#62-downloads-do-ghcr-pelo-ipv4-preferência-do-sistema)), e o Docker
recomeça do zero só a camada que quebrou, guardando as que terminaram. A imagem tinha **uma** camada de pip de ~145 MB (comprimida):
nada sobrevivia entre as tentativas do Dokploy, e um bump do Pillow
reenviava tudo, junto com os modelos (que ficavam na mesma camada do
`server.py`). Agora:

| Camada (em ordem)              | Conteúdo                                                                                                                | Muda quando                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| base                           | `python:3.12-slim` por digest                                                                                           | o Dependabot move o digest                          |
| `requirements-opencv.txt`      | OpenCV headless                                                                                                         | nova medição (o Dependabot ignora)                  |
| `requirements-onnxruntime.txt` | ONNX Runtime                                                                                                            | nova medição (o Dependabot ignora)                  |
| `requirements-rapidocr.txt`    | RapidOCR (com os modelos PP-OCRv6 da roda)                                                                              | nova medição (o Dependabot ignora)                  |
| `requirements-numpy.txt`       | numpy                                                                                                                   | minor/patch do numpy                                |
| `requirements.txt`             | as bibliotecas pequenas (Pillow, certifi, urllib3, requests, protobuf, shapely…)                                        | os bumps de segurança e do Dependabot, quase sempre |
| modelos                        | o par PP-OCRv5, versionado em `infra/ai-ocr/models` e conferido sem rede no stage `models`, com dono, modo e data fixos | `models.sha256` (troca deliberada de modelo)        |
| código                         | `models.sha256`, `fetch_models.py`, `warmup.jpg`; depois, sozinho, `server.py`                                          | cada mudança no serviço                             |

Cada arquivo de requisitos é instalado com `--require-hashes --no-deps` no
seu próprio `RUN` (montado, não copiado: um `COPY` de todos poria cada
camada atrás do arquivo mais editado). Os modelos e o código entram com
`COPY --link`: são camadas independentes das de cima, então um bump de
biblioteca não muda o digest delas. Estimativa, sem medição (28/10/2026): um
bump de segurança numa biblioteca pequena reenvia ~12 MB em vez de ~157 MB;
uma edição do `server.py`, alguns KB. Pacote novo vai no arquivo da
frequência de mudança dele, e nunca em dois
(`tests/unitaires/lifecycle/image-layers.test.ts`).

**Os pesos**: o par PP-OCRv5 do perfil do canhoto fica versionado em
`infra/ai-ocr/models` (4,8 e 7,9 MB; a roda do RapidOCR traz os outros
três). O build os confere contra `models.sha256` num `RUN --network=none` e
não baixa nada: até 30/10/2026 eles vinham de `www.modelscope.cn` em todo
build sem cache, e uma queda desse host derrubava o job `ai-ocr`. A camada
gerada é a mesma de antes (mesmos bytes, dono, modo e datas), então a VPS não
puxa os modelos de novo. Trocar um modelo é decisão com benchmark (ADR 0010);
o passo a passo está no cabeçalho de `infra/ai-ocr/fetch_models.py`.

**Versão no ar**: `GET /health` responde também `version` (7 caracteres) e
`commit` (o commit do build, gravado na imagem pelo build arg `GIT_SHA`;
`dev` num build local). A IA não tem endereço público, então o pipeline não
confere o commit dela de fora (lacuna na
[seção 14](#14-conferir-a-convergência)); à mão, de dentro da API:
`wget -q -O - http://trajetto-ai-staging:8080/health`.

**Como fica conectado**:

| Do lado da API (Application `trajetto-api`)                    | Do lado da IA (Application `trajetto-ai`)                        | Observação                                                                                      |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AI_PROVIDER=local`                                            | —                                                                | `local` é o padrão; `none` desliga as leituras                                                  |
| `AI_LOCAL_URL=http://<App Name da IA>:8080`                    | escuta na 8080                                                   | o App Name é o nome de rede na `dokploy-network`                                                |
| `AI_LOCAL_TOKEN`                                               | `AI_TOKEN`                                                       | **o mesmo valor**, digitado nas duas Applications                                               |
| `AI_LOCAL_TIMEOUT_MS` (15 000), `AI_LOCAL_MAX_CONCURRENCY` (1) | `AI_MAX_QUEUE` (2), `OCR_THREADS` (2), `OCR_DIGITS_MAX_SIDE` (0) | opcionais; `OCR_THREADS` = o limite de CPU da Application da IA; `OCR_DIGITS_MAX_SIDE` fica `0` |

Trocar o token: gere outro (`openssl rand -hex 32`), salve em `AI_TOKEN` da
IA e em `AI_LOCAL_TOKEN` da API e faça **Deploy** das duas, IA primeiro.
Entre os dois deploys a leitura que estiver em andamento falha com 401, sem
nova tentativa, e a API pausa os envios por 5 minutos (dobrando até 1 hora)
para não falhar o resto da fila, que espera em `PENDING` e anda quando o
token volta a bater. Faça os dois deploys em seguida.

Dimensionamento: pico medido de 0,60–0,63 GiB e p95 de 3,1 s por foto a
2 CPU / 1 GiB. Mais CPU = suba _CPU Limit_ e `OCR_THREADS` juntos.
`OCR_DIGITS_MAX_SIDE` reduziria só a foto do odômetro (896 px gasta 44% menos
CPU por leitura), mas o benchmark de 18/11/2026 perdeu 3 km exatas em 15
(`scripts/ai-benchmark/results-2026-11.md`): não defina a variável. Ela só
muda com o conjunto-ouro de fotos reais medido de novo.

Ligue a IA por empresa no `/admin` (limite mensal
`Business.ai_analysis_limit`; 0 desliga).

Isolamento: sem domínio, sem porta publicada, usuário 10001 na imagem. A
rede `dokploy-network` é compartilhada (lacuna da
[seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)):
o token é o que impede outro contêiner de usar o OCR.

Comportamento sob carga e falha: o serviço lê uma foto por vez com uma fila
curta (`AI_MAX_QUEUE`); cheio (ou 10 s esperando), responde 503 `busy` e o
pedido volta para a fila do Postgres em 5–15 s sem gastar tentativa. Com o
serviço fora do ar, cada pedido tenta de novo em 30 s, 2 min e 10 min; depois
de 5 falhas seguidas a API para de enviar (o disjuntor de
`src/shared/ai/provider-circuit.ts`) e a fila espera em `PENDING`, sem gastar
tentativa, com um pedido de teste a cada 1 a 10 minutos. Quando o serviço
volta, a fila anda sozinha. Numa queda longa, os pedidos de teste gastam
tentativas e alguns podem acabar como falha depois da quarta. A cota só é
consumida quando a leitura acontece. `AI_PROVIDER=none`, ou `local` sem URL
ou sem token, desliga as leituras: nada entra na fila e os registros saem
"não analisado".

Problemas comuns: toda leitura falha com 401 → `AI_LOCAL_TOKEN` (API) e
`AI_TOKEN` (IA) diferentes; pedidos parados em `PENDING` → serviço fora ou
`AI_LOCAL_URL` errado (URL ausente ou `AI_PROVIDER=none` não deixam nada em
`PENDING`: os registros saem "não analisado"); `AI_PROVIDER=anthropic` → o boot falha com o motivo (o
provedor externo foi removido).

## 10. Postgres e Redis

Os dois são **Databases do Dokploy** ([seções 7.4](#74-postgresql-database)
e [7.5](#75-redis-database)), sem porta externa, alcançados pela API pelo
App Name na `dokploy-network`. O backup do Postgres é o do próprio Dokploy
([seção 18](#18-backup-e-restauração)).

### Postgres

- **Volume**: o Dokploy cria um volume para o Database (veja o nome em
  _Advanced → Volumes_ ou com `docker volume ls`). Apagar o Database pelo
  painel pode apagar o volume: nunca apague o Database de produção sem um
  backup conferido.
- **A API recusa banco vazio em produção**: o boot consulta
  `_prisma_migrations` e para com "Banco vazio em produção" se nenhuma
  migration foi aplicada (volume novo, Database recriado), e a etapa de
  release também. Numa instalação nova de verdade,
  `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` só na `trajetto-api-migrate`, no
  primeiro deploy dela ([seção 8](#8-primeiro-deploy-na-ordem-com-conferências),
  passo 4). Em recuperação de desastre, restaure o dump **antes** de subir a
  API. Depois de recriar ou restaurar o Database (ou refazer o servidor),
  dê **Deploy** na `trajetto-api-migrate` do ambiente e espere `Running`
  antes do deploy da API: a tag `<ambiente>-applied` registra o que rodou no
  banco antigo, e o pipeline pularia a etapa para o mesmo digest
  ([seção 8](#8-primeiro-deploy-na-ordem-com-conferências), passo 4;
  [seção 18](#18-backup-e-restauração)).
- **Imagem fixada** por digest no campo da imagem
  ([seção 7.4](#74-postgresql-database), passo 5): a `trajetto-postgres`
  ([seção 27](#27-pitr-com-pgbackrest)). Trocar a versão maior
  (16 → 17) não é trocar a imagem: exige dump e restore.
- **Conexões**: cada réplica abre `connection_limit=10` + 1 da readiness.
  Mantenha `réplicas × 11 + migrations (2) + ferramentas` abaixo do
  `max_connections` (200 na `trajetto-postgres`, por
  `POSTGRES_MAX_CONNECTIONS`; 100 na `postgres:16-alpine` de antes da
  troca). Os parâmetros da URL estão em
  [`arquitetura.md`](./arquitetura.md#conexão-com-o-postgres).
- **Parada planejada**: o Dokploy dá 30 s de _Stop Grace Period_ ao Database
  (120 s depois do F0-01, onde o painel tiver o campo) antes do SIGKILL; um
  Postgres morto volta por _crash recovery_
  ([seção 27](#grace-e-placement-do-database)). Antes de
  qualquer _Stop_, _Redeploy_ ou mudança no Database, force o checkpoint:
  ```sh
  docker exec $(docker ps -q -f name=trajetto-postgres-production | head -n 1) \
    psql -U trajetto -d trajetto -c 'CHECKPOINT'
  ```
  e junte numa janela só toda mudança (imagem, comando, recursos), porque
  cada uma recria o contêiner.
- **Mais de um nó no Swarm**: o volume é local, e o Dokploy prende o
  Database a um manager (`node.role==manager`), não a um nó. Desde a onda
  17 o Placement dele pede o label `trajetto.db` e o hostname do nó do
  volume, aplicado na janela do Postgres e antes de qualquer nó novo
  ([seção 27](#grace-e-placement-do-database);
  [runbooks/swarm-multi-no.md](./runbooks/swarm-multi-no.md)).

#### Tuning do Postgres

Os parâmetros vêm da imagem `trajetto-postgres`
([seção 27](#27-pitr-com-pgbackrest)), versionados em
`infra/postgres/postgres.params` (logs sem dado pessoal, `jit` e
paralelismo desligados, `random_page_cost=1.1`, `pg_stat_statements`
pré-carregado), e toda a memória sai do teto, `POSTGRES_MEMORY_LIMIT_MB`,
pelo `infra/postgres/trajetto-entrypoint.sh`:

| Teto (MiB) | `shared_buffers` | `effective_cache_size` | `maintenance_work_mem` | `autovacuum_work_mem` | `work_mem` |
| ---------- | ---------------- | ---------------------- | ---------------------- | --------------------- | ---------- |
| 576        | 108MB            | 302MB                  | 54MB                   | 27MB                  | 4MB        |
| 2048       | 448MB            | 1254MB                 | 224MB                  | 112MB                 | 13MB       |
| 3072       | 704MB            | 1971MB                 | 352MB                  | 176MB                 | 21MB       |

**_Command_ e _Args_ do Database ficam vazios**: eles passam por cima do
wrapper que soma esses parâmetros. Mudar um valor é mudar o
`postgres.params` (ou o teto) e trocar o digest, com `CHECKPOINT` antes e
numa janela combinada. Os workers paralelos ficam desligados porque o
Docker dá 64 MB de `/dev/shm` e o Database não tem como aumentar (um VACUUM
paralelo falhou com "could not resize shared memory segment" na medição de
10/2026). Confira depois: `psql -c 'SHOW shared_buffers'`. Até a troca da
imagem, o banco de produção roda com os padrões da imagem oficial
(`shared_buffers` 128MB).

### Roles do banco: logins, URLs e conexões

Até o corte (plano de escala, onda 6), o runtime conecta como o usuário do
Database, superusuário e dono de todas as tabelas: uma injeção de SQL ali
leria as chaves do PITR e apagaria os backups. O corte troca as URLs do
runtime por logins que só têm o que cada processo precisa. A etapa de
release cria os roles e os grants em toda release
(`infra/sql/20-runtime-roles.sql`), sempre **NOLOGIN**; o login e a senha
são do dono, à mão, e nunca entram num arquivo do repositório nem num SQL
com a senha escrita.

| Role                   | O que pode                                                                                                                                                                                                                        | Quem usa                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `trajetto_app`         | o grupo (nunca um login): lê e grava toda tabela, menos a trilha das entregas e as tabelas da etapa de release, que só lê                                                                                                         | ninguém direto; os três abaixo são membros                                                         |
| `trajetto_http`        | o grupo; na trilha (`delivery_event`), lê, insere e preenche o endereço do GPS do comprovante; `statement_timeout` de 30 s                                                                                                        | as requisições (API, tempo real, ingestão)                                                         |
| `trajetto_worker`      | igual ao `trajetto_http`                                                                                                                                                                                                          | os workers (onda 12)                                                                               |
| `trajetto_batch`       | o grupo; na trilha, lê, altera e apaga; membro do `trajetto_partitions` e dos roles de estatística; `statement_timeout` de 30 min                                                                                                 | o cron: expurgos, partições, métricas pesadas                                                      |
| `trajetto_read`        | só SELECT, fora do grupo; `statement_timeout` de 10 s                                                                                                                                                                             | as leituras pesadas (onda 12)                                                                      |
| `trajetto_partitions`  | dono das tabelas particionadas e das partições (`infra/sql/10-partitions.sql`); no schema, só cria, altera e apaga tabelas (`infra/sql/15-untrusted-code.sql`)                                                                    | só por `SET ROLE`, a partir do `trajetto_batch`                                                    |
| `pgbouncer_auth`       | só executa `pgbouncer.user_lookup(text)` (`infra/sql/30-pgbouncer-auth.sql`), que devolve o verificador SCRAM de um login do runtime e nada para superusuário, replicação, o dono das tabelas, `trajetto_replication` e ele mesmo | o PgBouncer (onda 17), pelo `auth_query`                                                           |
| `trajetto_replication` | só REPLICATION (`infra/sql/40-replication.sql`): clona o cluster inteiro e segue o WAL; entra só pela linha de replicação do `pg_hba` da imagem (`POSTGRES_REPLICATION_CIDR`), nunca pelo PgBouncer                               | o standby (o do ensaio de failover; o do prod-db-2 na onda 23), com login dado só quando houver um |

Todos levam `lock_timeout` de 5 s e `idle_in_transaction_session_timeout`
de 60 s no próprio role, além dos da URL. Cada URL, com o login, o
`connection_limit` e o destino de cada Application, está em
[`variaveis-de-ambiente.md`](./variaveis-de-ambiente.md#2-banco-de-dados); o
formato é o mesmo de hoje, trocando só o usuário, a senha e o
`connection_limit`:

```
DATABASE_URL=postgresql://trajetto_http:<SENHA>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=10&pool_timeout=5&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=-c%20statement_timeout%3D30000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000
BATCH_DATABASE_URL=postgresql://trajetto_batch:<SENHA>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=3
```

Na staging, `-staging` no lugar de `-production`, com senhas diferentes
por ambiente. A `trajetto-api-migrate` continua com o usuário do Database:
é ela que cria as tabelas e roda o `infra/sql`.

**A conta das conexões** (`max_connections` 200 na `trajetto-postgres`): no
papel `all`, cada réplica abre até 10 (requisições) + 3 (batch) + 1 (a
readiness). Com as 2 réplicas de hoje, mais a `trajetto-api-migrate` (2) e
as ferramentas (8: `psql`, o backup do Dokploy, o pgBackRest, o
monitoramento), 2 × (10 + 3 + 1) + 2 + 8 = 38 de 200. O pool de leitura
(`databaseRead`, onde rodam as exportações e as listas pesadas desde a
onda 12, F3-17) abre até mais 3 por réplica enquanto uma delas roda, mesmo
sem `DATABASE_READ_URL`: 2 × 17 + 10 = 44. Depois da separação (onda 12),
some cada linha da tabela de
[`variaveis-de-ambiente.md`](./variaveis-de-ambiente.md#2-banco-de-dados)
vezes as réplicas da Application, e mantenha a soma abaixo de 200 com
folga.

**O corte, na staging** (uma semana antes da produção):

1. Um `psql` no Database, no host:

   ```sh
   docker exec -it $(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging) psql -U trajetto -d trajetto
   ```

2. Para `trajetto_http`, `trajetto_worker`, `trajetto_batch` e
   `trajetto_read`: `ALTER ROLE <role> LOGIN;` e depois o meta-comando
   `\password <role>`, que pede a senha duas vezes e a envia já cifrada.
   Nunca escreva a senha num SQL: ela ficaria no histórico e nos logs.
   Gere cada senha com `openssl rand -hex 32` e guarde no cofre.
3. `trajetto-api` → _Environment_: a `DATABASE_URL` com `trajetto_http` e
   `connection_limit=10` (as `options` ficam como estão) e a
   `BATCH_DATABASE_URL` com `trajetto_batch` e `connection_limit=3`,
   direta. A `trajetto-api-migrate` fica como está.
4. **Deploy**. No log do boot, `database role checked` com
   `superuser: false` e `tablesOwner: false`, e nenhuma linha "O runtime
   conecta ao banco como …". No `psql`, nenhuma conexão do runtime como
   `trajetto`:

   ```sql
   SELECT usename, application_name, count(*) FROM pg_stat_activity GROUP BY 1, 2;
   ```

5. Exercite login, criação de entrega, posições do app, comprovante,
   planilha e webhook. Uma rota com 500 e `permission denied` (42501) no
   log é um grant que faltou: volte a URL (abaixo) e abra o problema.
6. `DATABASE_REQUIRE_RUNTIME_ROLE=true` → **Deploy**. A partir daí, um boot
   como o dono, ou com o cron sem a `BATCH_DATABASE_URL`, é recusado.
7. No dia seguinte, depois das 04:10 UTC, a partição de amanhã existe e é
   do `trajetto_partitions`, criada pelo `trajetto_batch`:
   `partitions.driver_position.owner_ok` em `/health/metrics`, ou

   ```sql
   SELECT relname, pg_get_userbyid(relowner) FROM pg_class
    WHERE relname LIKE 'driver_position_%' ORDER BY relname DESC LIMIT 3;
   ```

**Na produção**: promova a onda 6 e, uma semana depois do corte na
staging, os mesmos passos com `trajetto-postgres-production`. O PITR da
produção ([seção 27](#f1b-o-pitr-na-produção-fim-da-onda-6)) só depois de
7 dias com `DATABASE_REQUIRE_RUNTIME_ROLE=true` sem erro novo.

**Reversão**: primeiro `DATABASE_REQUIRE_RUNTIME_ROLE=false` (com ela
`true`, um boot como o dono é recusado), depois as URLs de volta ao
usuário do Database → **Deploy**. Os roles e os logins ficam, sem uso;
para tirar o acesso de um login, `ALTER ROLE <role> NOLOGIN;` à mão.

### PgBouncer: a imagem `trajetto-pgbouncer` (onda 17)

Da onda 17 em diante, as Applications chegam ao Postgres pela Application
`trajetto-pgbouncer`, e o failover troca só o host para onde ela aponta.
Nada usa a imagem antes de o dono criar a Application. A imagem
(`infra/pgbouncer`, plano de escala F4-34) é o PgBouncer compilado da
fonte sobre Alpine, por digest, rodando com um usuário sem privilégio:

- **Versão**: 1.26.1 ou mais nova, nunca abaixo. A 1.26.1 corrige o laço
  infinito com um nome de opção vazio no `options` da partida
  (CVE-2026-107349, alcançável antes do login com esta configuração) e a
  troca de identidade no SCRAM por um segundo pacote de partida
  (CVE-2026-107350). A versão e o SHA-256 do código-fonte ficam num `ARG`
  só do `Dockerfile` e sobem à mão, juntos, a partir do arquivo `.sha256`
  da própria release; a base Alpine sobe pelo Dependabot.
- **Configuração gerada a cada partida** pelo `entrypoint.sh`, a partir
  das variáveis do _Environment_
  ([variaveis-de-ambiente.md → PgBouncer](./variaveis-de-ambiente.md#pgbouncer-application-trajetto-pgbouncer-onda-17)):
  `pool_mode=transaction`; o banco (`trajetto`) e o alias
  `trajetto_probe`, no mesmo banco, com pool de 2 (a readiness nunca
  espera atrás do tráfego); `max_client_conn` 2000, `default_pool_size`
  20 e `max_db_connections` 60 por padrão; `query_wait_timeout` de 5 s,
  `server_lifetime` de 3600 s e `ignore_startup_parameters` só com
  `extra_float_digits`. O `options` da partida passa só com o que o
  PgBouncer rastreia (o TimeZone): um `-c statement_timeout` ali é
  recusado, e os timeouts vêm do `ALTER ROLE` de cada login.
- **Senhas fora do PgBouncer**: o verificador SCRAM de cada login vem do
  próprio banco, pelo `auth_query`
  (`SELECT * FROM pgbouncer.user_lookup($1)`, a função fechada do
  `infra/sql/30-pgbouncer-auth.sql`), lido com o login `pgbouncer_auth`. O
  `auth_file` guarda só a senha do `pgbouncer_auth` (em claro: sem ela o
  PgBouncer não entra no banco) e os dois logins de console:
  `pgbouncer_admin` (PAUSE, RESUME e KILL), só quando a senha dele está no
  _Environment_, e `pgbouncer_stats` (só `SHOW`), sempre; sem a senha de
  estatística, ele fica com uma senha aleatória que ninguém tem.
- **Quem entra por onde** (`pg_hba.conf` gerado): SCRAM para todos; o
  console de administração só de dentro do contêiner (`127.0.0.1`), nunca
  pela rede; o de estatística pela rede (a API lê as métricas por ele);
  replicação física recusada; `pgbouncer_auth` e os dois logins de console
  nunca chegam ao banco da aplicação; um banco fora do `trajetto` e do
  alias não existe. Uma replicação lógica (`replication=database`) chega
  ao banco como no Postgres e é recusada lá, porque nenhum login do
  runtime tem `REPLICATION`.
- **Partida recusada (saída 64)** quando falta ou está malformado o que
  decide para onde as conexões vão e quem entra: host, porta e banco, a
  senha do `pgbouncer_auth` (em claro, 16 caracteres ou mais), as senhas
  de console com menos de 16 caracteres ou a de administração igual à de
  estatística. Num rolling start-first, a tarefa antiga continua servindo.
  Um número inválido volta ao padrão, com aviso no log. Nenhuma senha
  aparece no log, e nenhuma fica no ambiente do processo do PgBouncer.
- **HEALTHCHECK**: `pg_isready` no console da porta local 6432, sem senha
  e sem tocar o Postgres: o PgBouncer continua saudável enquanto o banco
  reinicia (sob PAUSE ou num failover), e o Swarm não derruba o endpoint
  de todas as Applications por causa do banco. A checagem não deixa linha
  no log.
- **Desligamento**: o SIGTERM do Swarm é o `SHUTDOWN WAIT_FOR_CLIENTS`: a
  tarefa antiga recusa conexões novas, termina as que tem e sai quando o
  último cliente vai embora (os pools do runtime renovam cada conexão em
  até um minuto), dentro do _Stop Grace Period_ de 90 s da Application.
- **Log**: sem as linhas de login e de desconexão (seriam centenas por
  minuto, com cada conexão renovada a cada minuto). Os erros mandados aos
  clientes, o login recusado inclusive, e as falhas de login no Postgres
  continuam no log; as contagens ficam no `SHOW STATS`.

Conferência sem Docker: `tests/unitaires/lifecycle/pgbouncer-image.test.ts`
roda o `entrypoint.sh` com o PgBouncer simulado e compara os arquivos
gerados. Com Docker, `docker build --target test infra/pgbouncer` sobe o
PgBouncer de verdade, sem rede, e lê cada valor de volta pelo console
(`SHOW CONFIG`, `SHOW DATABASES`).

**No CI e no deploy** (plano de escala F4-35), pela regra da IA, porque o
deploy a implanta:

- **Teste e build só para uma fonte nova.** A chave é o hash git de
  `infra/pgbouncer`. O job `PgBouncer image` do `validate.yml` roda o
  stage `test` só quando o GHCR não tem
  `trajetto-pgbouncer:src-<hash>` (o `changes.sh` decide). O `Build` do
  `staging.yml` publica a imagem só para uma fonte que esse job testou, a
  partir do cache dele, com smoke test no teto da staging, SBOM e
  proveniência; as tags são `src-<hash>` e `sha-<7>`. Uma fonte que já tem
  imagem é reaproveitada: o mesmo digest ganha o `sha-<7>` do commit, no
  registro, sem download.
- **Varredura.** O Trivy lê a imagem do build, construída ou
  reaproveitada. Como ela vai para o ar, um achado reprova com
  `IMAGE_SCAN_ENFORCE=true`, como nas outras.
- **Deploy só com digest novo, antes das migrations.** A ação de deploy
  compara o digest do build com o de `trajetto-pgbouncer:<tag>` (`staging`
  ou `stable`). Igual: nada é reimplantado, e um push que não muda
  `infra/pgbouncer` não reinicia o endpoint de todas as Applications.
  Diferente: a tag anda por digest e a Application é implantada, antes das
  migrations; no modo `ssh` o `verify-rollout.sh` confere a convergência
  dela. Sem o secret `DOKPLOY_PGBOUNCER_APPLICATION_ID`, só a tag anda, e
  uma Application criada depois sobe no build do ambiente. Um build sem a
  imagem deixa o PgBouncer onde está.
- **Marcador e promoção.** O staging grava o `staged-<7>` dela junto com o
  da API e o da IA, e o `staged-build.sh` exige o marcador no mesmo digest
  do `sha-<7>`. A promoção lê o `sha-<7>` dela e move `stable` só se a
  produção roda outro digest. Um rollback (`image_tag`) leva o PgBouncer
  do build escolhido, como a IA. Um deploy do Dokploy que falha devolve a
  tag dela nos dois ambientes.

**A adoção** (plano de escala F4-39) é um passo a passo do dono, no
[runbook do PgBouncer](./runbooks/pgbouncer.md): a Application
`trajetto-pgbouncer` (32 MiB e 0,1 CPU na staging do 2º VPS; 64 MiB e
0,25 CPU na produção da VPS 1, só depois de a staging sair dela; uma
réplica start-first, com _Stop Grace Period_ de 90 s), as URLs trocadas
uma Application por vez, a semana de observação, o reinício planejado do
Postgres (`PAUSE trajetto`, `CHECKPOINT`, redeploy do Database,
`RESUME trajetto`, no console de administração que só o dono abre), o
rolling sob o burn-in e a volta ao Postgres direto. O que a API faz com
ele:

- **A URL pelo PgBouncer** (porta 6432 com `pgbouncer=true`) leva só o
  `TimeZone` no `options`, e cada conexão vive até 60 s, para a tarefa
  antiga de um rolling ficar sem cliente antes dos 90 s; o boot recusa o
  resto (F4-31).
- **As recusas dele** viram 503 com `Retry-After`, nunca 500: o pool cheio
  (`query_wait_timeout`, 5 s) e o teto de clientes são `SERVICE_BUSY`; o
  PgBouncer sem entrar no Postgres, a conexão de servidor que morreu e a
  tarefa antiga recusando login são `SERVICE_UNAVAILABLE` (F4-32).
- **As métricas**: o processo com o cron lê o console de cada tarefa por
  `pgbouncer_stats` (só `SHOW`), uma vez por minuto, e o `/health/metrics`
  mostra `pgbouncer`, com os alertas `pgbouncer-down`,
  `pgbouncer-clients-waiting` e `pgbouncer-server-saturation` (F4-36).
  Variáveis: `PGBOUNCER_STATS_URL` e `PGBOUNCER_STATS_HOSTS`, na
  Application que roda o cron.
- **A readiness** vai ao alias `trajetto_probe`, com 2 conexões só dela,
  pela `READINESS_DATABASE_URL`: um pool das requisições saturado não tira
  todas as réplicas do ar juntas (F4-37).
- **As sessões do PgBouncer têm nome**: a do `auth_query` chega como
  `trajetto-pgbouncer-auth`, por um padrão do role, para a checagem das
  contrações da etapa de release não a ler como a imagem antiga.
- **Nunca pelo PgBouncer**: a `BATCH_DATABASE_URL` e a URL da
  `trajetto-api-migrate`, que usam sessão própria; o boot e a etapa de
  release as recusam na porta 6432.

### Standby: o `pg_hba` da imagem e o ramo standby (onda 17)

A imagem `trajetto-postgres` já sai pronta para um standby (plano de
escala, F4-40). Nada muda num Database sem as variáveis abaixo, a não ser
de onde o Postgres lê o `pg_hba`:

- **O `pg_hba` vem da imagem** (`infra/postgres/pg_hba.conf`): as mesmas
  regras que a imagem oficial escreveu no volume (confiança só dentro do
  contêiner, `scram-sha-256` de qualquer endereço), copiadas a cada partida
  para `/etc/trajetto/run/pg_hba.conf`, para onde aponta o `hba_file`. O
  arquivo do volume fica como estava: voltar o digest volta a ele. O
  primário aceita as mesmas conexões de antes, e o teste da imagem compara
  as regras com as do volume que a imagem oficial cria.
- **Replicação pela rede só de um endereço**: com
  `POSTGRES_REPLICATION_CIDR`, o wrapper soma uma linha só,
  `host replication trajetto_replication <cidr> scram-sha-256`. Só IPv4, de
  /16 a /32; `all`, `0.0.0.0/0`, uma máscara mais larga ou um nome não
  abrem nada (o log avisa e o banco sobe). Use o endereço mais estreito de
  onde o standby conecta: o IP privado dele, `/32`, quando ele vem pela
  rede privada; pela `dokploy-network`, cujo endereço de cada tarefa muda a
  cada deploy, a sub-rede dela
  (`docker network inspect dokploy-network -f '{{(index .IPAM.Config 0).Subnet}}'`).
- **O role** `trajetto_replication` vem da etapa de release, NOLOGIN e
  com REPLICATION ([roles do banco](#roles-do-banco-logins-urls-e-conexões)).
  Só quando houver standby, no `psql` do primário:
  `ALTER ROLE trajetto_replication LOGIN;` e `\password trajetto_replication`
  (senha de `openssl rand -hex 32`, no cofre).
- **O ramo standby**, num Database da mesma imagem e do mesmo digest, com
  `POSTGRES_STANDBY_PRIMARY_HOST` (o App Name do primário),
  `POSTGRES_REPLICATION_PASSWORD` e, de preferência, `POSTGRES_STANDBY_SLOT`:
  - volume vazio: o wrapper clona o primário (`pg_basebackup` pelo slot,
    criado se faltar) e sobe o clone em recuperação, só leitura, seguindo o
    primário. A senha vai para um passfile, nunca para o
    `primary_conninfo` nem para o volume. Sem a senha, com um host ou um
    slot inválido, ou com o clone falhando, o contêiner para (código 64):
    um volume vazio nunca vira um primário novo no lugar do standby;
  - volume que já é standby (tem `standby.signal`): segue o primário, sem
    clonar de novo; com o repo1 do PITR completo, o WAL que o streaming
    não tem mais vem do repositório (`restore_command`);
  - volume que é primário, ou um standby promovido depois: sobe como
    **primário**, com aviso no log. A imagem nunca rebaixa um primário.
    Os mesmos `POSTGRES_MAX_CONNECTIONS` (e o resto do _Environment_ de
    memória) do primário: a recuperação recusa valores menores. Sem
    _Domain_, e sem `PITR_ARCHIVE` nem `PGBACKREST_*` num standby de ensaio:
    promovido, ele arquivaria na stanza do primário.
- **Promover** é à mão, no `psql` do standby: `SELECT pg_promote();` e
  depois `CHECKPOINT;`. O failover inteiro (o primário parado, a etapa de
  release subindo a época do cluster direto no promovido e só então o
  `infra/pgbouncer/retarget.sh`, que devolve o tráfego)
  está em [failover-standby](./runbooks/failover-standby.md), e o
  calendário dos ensaios em [drills](./runbooks/drills.md).

**Trocar o digest no primário** (a imagem com este `pg_hba`), numa janela,
a staging antes: no console de administração do PgBouncer (só o dono tem a
senha), `PAUSE trajetto;`; no Database, `CHECKPOINT;`; _Deploy_ do
Database com o digest novo; `RESUME trajetto;`. Sem o PgBouncer, o
`CHECKPOINT` e o _Deploy_ de sempre ([Postgres](#postgres)). Depois,
`SHOW hba_file` responde `/etc/trajetto/run/pg_hba.conf`.

### Redis

- **Senha obrigatória**: o Database Redis sempre nasce com senha. Qualquer
  contêiner que alcançasse um Redis aberto poderia publicar nos canais do
  adapter do Socket.IO. A API recebe `REDIS_URL=redis://:<senha>@<App Name do
Redis>:6379`.
- **Nada durável**: o comando personalizado da [seção 7.5](#75-redis-database)
  desliga RDB/AOF e põe o teto de 256 MB com `allkeys-lru`. Só guarda
  chaves que expiram sozinhas, entre elas as do geocodificador (`geocoding:*`,
  com o cache cifrado de até 48 h da busca de endereço), e o pub/sub do
  Socket.IO ([ADR 0002](./adr/0002-redis-descartavel.md)); não precisa de
  backup nem de restore.
- **Trocar a senha**: nova senha no Database (e no comando, se personalizado)
  e no `REDIS_URL` da API; **Deploy** do Redis e logo em seguida da API.
  Entre os dois, a API segue em modo degradado (rate limit local, tempo real
  sem cruzar réplicas).

## 11. Domínios, TLS e a borda

```
navegador / app ──TLS──▶ Cloudflare (proxy laranja) ──▶ Traefik do Dokploy (VPS, :443) ──▶ API (dokploy-network)
                                                         │
                          web (Next) ◀────────────────────┘  (o servidor da web chama a API de volta)
```

**Roteamento**: a aba _Domains_ da Application `trajetto-api` cria o roteador
do host (`api-staging.intrajetto.com` em staging; `api.intrajetto.com` em
produção),
entrypoint `websecure`, certificado do resolver `letsencrypt`, serviço na
porta 3333 com `passHostHeader` ([seção 7.8](#78-o-traefik-da-api-o-que-os-labels-faziam)).
Sem cookie sticky: o socket é só WebSocket, e o adapter Redis leva os eventos
entre réplicas. Staging e produção no mesmo Traefik não colidem: hosts
diferentes e roteadores nomeados pelo App Name.

**Endereço do cliente** (o balde do rate limit de login, 2FA, recuperação de
senha, refresh e handshake do socket) — `RATE_LIMIT_TRUSTED_PROXY`:

| Valor        | Chave dos limites anônimos                                                                          | Quando usar                                    |
| ------------ | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `none`       | socket (o Traefik, na produção)                                                                     | só sem proxy nenhum                            |
| `xff`        | última entrada do `X-Forwarded-For`                                                                 | quando o Traefik/nginx **é** a borda           |
| `cloudflare` | `CF-Connecting-IP` **se** o par (última entrada do XFF) é da Cloudflare; senão o par, igual a `xff` | **produção e staging** (defina no Environment) |

- As faixas da Cloudflare ficam em `src/config/trusted-edge.ts` (de
  <https://www.cloudflare.com/ips-v4> e `/ips-v6`). Uma faixa nova que falte só
  faz os usuários daquela borda dividirem um balde; nunca deixa passar
  cabeçalho forjado. Confira de tempos em tempos.
- IPv6 é contado por /64. O servidor da web repassa, com o segredo
  `RATE_LIMIT_FORWARDER_SECRET`, o par que o Traefik dele viu
  (`x-trajetto-client-ip`) e o `CF-Connecting-IP` que recebeu
  (`x-trajetto-client-edge-ip`).
- **`RATE_LIMIT_EDGE_SECRET`** (opcional, recomendado): um Worker de qualquer
  conta sai das faixas da Cloudflare e pode escrever `CF-Connecting-IP`. Com o
  segredo, a API só acredita no cabeçalho quando vem junto de
  `x-trajetto-edge-secret`. Para ligar: `openssl rand -hex 32`; na zona
  `intrajetto.com` (a da web e a da API), _Rules → Transform Rules →
  Modify Request Header → Set static_ `x-trajetto-edge-secret = <valor>`; só
  **depois** de as regras estarem ativas, o mesmo valor em
  `RATE_LIMIT_EDGE_SECRET` no Environment da API e **Deploy**.
- O Turnstile é só do formulário público e da web. **Não** exija Turnstile na
  API: o login do app quebraria.

**O que a borda precisa garantir**:

1. O Traefik recebe o endereço real do par: o `dokploy-traefik` é um contêiner
   com portas publicadas (`-p`), e o DNAT preserva a origem. Um Traefik como
   serviço do Swarm no modo `ingress` não preserva (SNAT do routing mesh):
   todo mundo cairia num balde. Conferir:
   `docker inspect dokploy-traefik --format '{{json .HostConfig.PortBindings}}'`.
   **Nunca** inclua faixas da overlay (`10.0.0.0/8`) como confiáveis.
2. Trava da origem (defesa em profundidade): firewall aceitando 80/443 só das
   faixas da Cloudflare (feito em 29/10/2026,
   [seção 6.1](#61-firewall-da-vps-contabo)), ou Authenticated Origin Pulls. **Não** use Cloudflare
   Tunnel sem mudar o código antes: o par passaria a ser o `cloudflared` e todo
   mundo cairia num balde só.
3. `readTimeout` de 120 s no entrypoint `websecure` (a API também corta em
   120 s o recebimento de uma requisição). Não use os 60 s padrão do Traefik
   v3: o app espera até 120 s por um upload multipart de até 5 MB. O
   `readTimeout` não derruba WebSocket já aberto (medido no Traefik 3.7.13).
4. Opcional: regras de rate limiting da Cloudflare para `/user/session`,
   `/user/forgot*`, `/user/two-factor*` e `/socket.io`.

**Verificar**:

```sh
# 1. A API está atrás da Cloudflare
curl -sI https://api-staging.intrajetto.com/health/liveness | grep -iE '^(server|cf-ray)'

# 2. Cabeçalho forjado direto na origem NÃO dá balde novo: depois de 8 tentativas, 429
for n in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    --resolve api-staging.intrajetto.com:443:<IP_DO_VPS> \
    -H "Cf-Connecting-Ip: 1.2.3.$n" -H 'Content-Type: application/json' \
    -d '{"email":"x@x.com","password":"x"}' \
    https://api-staging.intrajetto.com/user/session
done

# 3. Duas redes diferentes (4G e fibra) veem x-ratelimit-remaining independentes
curl -si -X POST https://api-staging.intrajetto.com/user/session \
  -H 'Content-Type: application/json' -d '{"email":"x@x.com","password":"x"}' \
  | grep -i x-ratelimit-remaining
```

Integradores (`/integration/v1`): o teto `rate_limit_per_minute` de uma chave
é um balde para todas as rotas v1 juntas; cada endereço tem 30 falhas de
autenticação por minuto antes de 429 `RATE_LIMITED`.

## 12. Health checks

| Onde                                                                           | Sonda                                                        | Para quê                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swarm (_Health Check_ da Application `trajetto-api` e `HEALTHCHECK` da imagem) | `wget http://127.0.0.1:3333/health/liveness` a cada 30 s     | **liveness**: o processo está vivo. Não toca dependência nenhuma: no Swarm, falhar aqui **destrói** a réplica; apontar para a readiness já fez um soluço do Postgres derrubar as duas réplicas. Uma réplica nova só entra no balanceamento depois de passar aqui |
| Pipeline (o `Deploy` do staging; na promoção com `ROLLOUT_VERIFY=http`)        | `GET <API_PUBLIC_URL>/health/liveness` a cada 5 s, até 600 s | a mesma liveness responde `version` e `commit` (o commit do build); o deploy só fica verde depois de a API pública responder o commit novo por 90 s seguidos ([seção 14](#14-conferir-a-convergência))                                                           |
| `/health/readiness`                                                            | consultada pelo monitor externo e pelo desligamento          | **readiness**: pode receber tráfego. Banco fora → 503. Vira 503 durante o desligamento ordenado (12 s antes de fechar). O Traefik não a consulta mais (lacuna da [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora))                 |
| Swarm (`trajetto-ai`)                                                          | `GET http://127.0.0.1:8080/health`                           | 200 só depois de carregar os dois perfis e ler a foto de aquecimento; responde também `version` e `commit`                                                                                                                                                       |
| Databases (Postgres e Redis)                                                   | o que o Dokploy configura                                    | conferência manual: `pg_isready`; `redis-cli -a … ping`                                                                                                                                                                                                          |
| Monitor externo                                                                | `/health/readiness` da API e `/api/health` da web, 1/min     | uptime ([seção 20](#20-alertas-e-monitoramento))                                                                                                                                                                                                                 |

Outras rotas: `/health/metrics` (filas, workers, crons, pool, certificado e
os números do próprio banco: xid, cache, escrita e snapshot mais antigos,
arquivamento, `pg_wal`, tabelas quentes, tamanhos e `pg_stat_statements`) e
`/health/providers` (prontidão dos provedores), ambas só MASTER. O tamanho do
`pg_wal` só aparece quando o usuário do banco é superusuário ou tem
`pg_monitor`; as idades das sessões dos outros usuários, com superusuário ou
`pg_read_all_stats` (depois do corte dos roles, na onda 6 do plano de escala,
essa leitura passa ao role de manutenção).

## 13. Configurar o GitHub

### Environments

No repositório `Trajetto-Organization/trajetto-api`: _Settings →
Environments_. Para cada nome abaixo: _New environment_ (se não existir) →
_Add environment secret_ / _Add environment variable_.

**`staging`** (sem revisores; o deploy de staging é automático):

| Tipo      | Nome                                                                                                                                                                              | Valor                                                                                                                                                                                                                                                         | Obrigatório?                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| secret    | `DOKPLOY_URL`                                                                                                                                                                     | URL do painel, **https**: `https://dokploy.intrajetto.com`, pela Cloudflare (nunca o IP, que o firewall fecha; o script recusa http)                                                                                                                          | sim (com os três abaixo; nenhum dos quatro = deploy pulado com aviso)                      |
| secret    | `DOKPLOY_API_KEY`                                                                                                                                                                 | a chave da seção 7.10                                                                                                                                                                                                                                         | sim                                                                                        |
| secret    | `DOKPLOY_API_APPLICATION_ID`                                                                                                                                                      | applicationId da `trajetto-api` de staging                                                                                                                                                                                                                    | sim                                                                                        |
| secret    | `DOKPLOY_MIGRATE_APPLICATION_ID`                                                                                                                                                  | applicationId da `trajetto-api-migrate` de staging ([seção 15](#15-migrations))                                                                                                                                                                               | sim                                                                                        |
| secret    | `DOKPLOY_AI_APPLICATION_ID`                                                                                                                                                       | applicationId da `trajetto-ai` de staging                                                                                                                                                                                                                     | não (sem ele: aviso e a IA não é atualizada)                                               |
| secret    | `DOKPLOY_PGBOUNCER_APPLICATION_ID`                                                                                                                                                | applicationId da `trajetto-pgbouncer` de staging (onda 17), só depois de ela existir: o deploy a implanta antes das migrations, e só quando o digest da imagem mudou                                                                                          | não (sem ele: aviso, e só a tag `staging` da `trajetto-pgbouncer` anda)                    |
| secrets   | `DOKPLOY_WORKER_APPLICATION_ID`, `DOKPLOY_SCHEDULER_APPLICATION_ID`, `DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID`, `DOKPLOY_INGEST_APPLICATION_ID`, `DOKPLOY_REALTIME_APPLICATION_ID` | opcionais: o applicationId de cada Application de papel de staging, só depois de ela existir; sem o secret, o papel não é implantado e a tag `<tag>-<papel>` segue a da API (plano de escala F3-31a)                                                          |
| variable  | `API_PUBLIC_URL`                                                                                                                                                                  | a origem pública da API de staging, `https://api-staging.intrajetto.com` (sem barra no fim): o pipeline espera a `/health/liveness` dela responder o commit novo ([seção 14](#14-conferir-a-convergência))                                                    | sim, enquanto `ROLLOUT_VERIFY` não for `off` nem `ssh` (é a conferência padrão do staging) |
| variable  | `SWARM_API_SERVICE`                                                                                                                                                               | `trajetto-api-staging` (o App Name da API)                                                                                                                                                                                                                    | só com `ROLLOUT_VERIFY=ssh`                                                                |
| variables | `SWARM_WORKER_SERVICE`, `SWARM_SCHEDULER_SERVICE`, `SWARM_WORKER_EXTERNAL_SERVICE`, `SWARM_INGEST_SERVICE`, `SWARM_REALTIME_SERVICE`                                              | o App Name de cada Application de papel de staging (`trajetto-worker-staging`…), junto com o secret dela: a conferência por SSH confere cada papel implantado ([seção 14](#pelo-swarm-por-ssh-padrão-na-produção-rollout_verifyssh-no-staging))               | só com `ROLLOUT_VERIFY=ssh` e o papel implantado (sem ela, aviso)                          |
| variable  | `SWARM_PGBOUNCER_SERVICE`                                                                                                                                                         | `trajetto-pgbouncer-staging` (o App Name do PgBouncer), junto com o secret dele: a conferência por SSH confere o PgBouncer antes das migrations                                                                                                               | só com `ROLLOUT_VERIFY=ssh` e o PgBouncer implantado (sem ela, aviso)                      |
| secret    | `ROLLOUT_STATUS_TOKEN`                                                                                                                                                            | o mesmo valor do `ROLLOUT_STATUS_TOKEN` da `trajetto-api` de staging (`openssl rand -hex 32`): o deploy lê os passos pendentes da etapa de release em `<API_PUBLIC_URL>/health/rollout` ([seção 15](#quando-a-etapa-roda)); sem ele, aviso e a regra de antes |
| variable  | `ROLLOUT_ROLES_EXPECTED`                                                                                                                                                          | os papéis que o deploy espera no commit novo ([seção 14](#os-papéis-da-mesma-imagem-rollout_roles_expected)): `all` enquanto só existe a `trajetto-api`; `api,worker` quando a `trajetto-worker` de staging existir (onda 12)                                 | não (sem ela, a conferência por papel não roda)                                            |
| variable  | `RELEASE_SERIALIZE_WITH_APPLICATION_ID`                                                                                                                                           | o applicationId da `trajetto-api-migrate` de **produção**: na VPS única a etapa de staging espera a de produção terminar. Sai quando a staging for para o 2º VPS                                                                                              |
| variable  | `RELEASE_TIMEOUT_SECONDS`                                                                                                                                                         | opcional (vazio = 1800, teto 3600): quanto a etapa de release pode levar no deploy, a espera pela do outro ambiente incluída                                                                                                                                  |
| secrets   | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY`                                                                                           | conferência do rollout ([seção 14](#14-conferir-a-convergência)); podem ficar no repositório, já que os dois ambientes dividem o host                                                                                                                         | só com `ROLLOUT_VERIFY=ssh`                                                                |

Sem o `DOKPLOY_MIGRATE_APPLICATION_ID`, com os outros três definidos, o job
falha logo no começo ("configuração parcial"), antes de qualquer tag andar: a
imagem da API não migra e não sobe num banco sem as migrations dela.

**`production`** — marque **Required reviewers** (você e quem mais puder
aprovar uma ida para produção) e, em _Deployment branches and tags_,
_Selected branches and tags_ → `main` (o _Run workflow_ de rollback também
roda a partir de `main`):

| Tipo      | Nome                                                                                                                                                                              | Valor                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| secret    | `DOKPLOY_URL`, `DOKPLOY_API_KEY`                                                                                                                                                  | os mesmos do staging (um painel só)                                                                                                                                                                    |
| secret    | `DOKPLOY_API_APPLICATION_ID`                                                                                                                                                      | applicationId da `trajetto-api` de produção                                                                                                                                                            |
| secret    | `DOKPLOY_MIGRATE_APPLICATION_ID`                                                                                                                                                  | applicationId da `trajetto-api-migrate` de produção ([seção 15](#15-migrations))                                                                                                                       |
| secret    | `DOKPLOY_AI_APPLICATION_ID`                                                                                                                                                       | applicationId da `trajetto-ai` de produção                                                                                                                                                             |
| secret    | `DOKPLOY_PGBOUNCER_APPLICATION_ID`                                                                                                                                                | opcional: applicationId da `trajetto-pgbouncer` de produção, só depois de ela existir (uma semana depois da staging); sem ele, só a tag `stable` dela anda                                             |
| secrets   | `DOKPLOY_WORKER_APPLICATION_ID`, `DOKPLOY_SCHEDULER_APPLICATION_ID`, `DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID`, `DOKPLOY_INGEST_APPLICATION_ID`, `DOKPLOY_REALTIME_APPLICATION_ID` | opcionais: o applicationId de cada Application de papel de produção, só depois de ela existir; sem o secret, o papel não é implantado e a tag `<tag>-<papel>` segue a da API (plano de escala F3-31a)  |
| variable  | `API_PUBLIC_URL`                                                                                                                                                                  | a origem pública da API de produção; lida com `ROLLOUT_VERIFY=http` e para os passos pendentes da etapa de release (com o `ROLLOUT_STATUS_TOKEN`)                                                      |
| variable  | `SWARM_API_SERVICE`                                                                                                                                                               | `trajetto-api-production`                                                                                                                                                                              |
| variables | `SWARM_WORKER_SERVICE`, `SWARM_SCHEDULER_SERVICE`, `SWARM_WORKER_EXTERNAL_SERVICE`, `SWARM_INGEST_SERVICE`, `SWARM_REALTIME_SERVICE`                                              | o App Name de cada Application de papel de produção (`trajetto-worker-production`…), junto com o secret dela; lida pela conferência por SSH (o padrão da produção)                                     |
| variable  | `SWARM_PGBOUNCER_SERVICE`                                                                                                                                                         | `trajetto-pgbouncer-production`, junto com o secret dele; lida pela conferência por SSH (o padrão da produção)                                                                                         |
| secret    | `ROLLOUT_STATUS_TOKEN`                                                                                                                                                            | o mesmo valor do `ROLLOUT_STATUS_TOKEN` da `trajetto-api` de produção (outro valor, não o do staging); lido em `<API_PUBLIC_URL>/health/rollout`, então a `API_PUBLIC_URL` precisa existir aqui também |
| variable  | `ROLLOUT_ROLES_EXPECTED`                                                                                                                                                          | `all` até a `trajetto-worker` de produção existir (onda 14); depois, `api,worker` ([seção 14](#os-papéis-da-mesma-imagem-rollout_roles_expected)). Sem ela, a conferência por papel não roda           |
| variable  | `RELEASE_SERIALIZE_WITH_APPLICATION_ID`                                                                                                                                           | o applicationId da `trajetto-api-migrate` de **staging**                                                                                                                                               |
| variable  | `RELEASE_TIMEOUT_SECONDS`                                                                                                                                                         | opcional (vazio = 1800, teto 3600)                                                                                                                                                                     |
| secrets   | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY`                                                                                           | conferência do rollout (só sem `ROLLOUT_VERIFY=http`)                                                                                                                                                  |

Os quatro `DOKPLOY_*` obrigatórios de um environment (`DOKPLOY_URL`,
`DOKPLOY_API_KEY`, `DOKPLOY_API_APPLICATION_ID` e
`DOKPLOY_MIGRATE_APPLICATION_ID`): todos = deploy; nenhum =
o job move a tag e pula o deploy com aviso; só alguns = o job falha
("configuração parcial"). O `DOKPLOY_BACKUP_APPLICATION_ID` não existe
mais (o backup é do Dokploy, sem Application): apague-o dos dois
environments, se ficou lá.

### Variáveis e secrets do repositório

_Settings → Secrets and variables → Actions_, abas _Secrets_ e _Variables_
(nível do repositório):

| Tipo     | Nome                      | Para quê                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| variable | `ROLLOUT_VERIFY`          | como o run prova o rollout da API: `http` (padrão no staging) = a liveness pública responde o commit novo por 90 s; `ssh` (padrão na produção) = o Swarm, por SSH; `off` = nenhuma (só em emergência; fica registrado no resumo). Valor vazio ou desconhecido = o padrão do ambiente. Pode ser definida só num environment para valer só nele. Em uso em 29/10/2026: `http` nos dois ambientes (o SSH não está configurado) |
| variable | `IMAGE_SCAN_ENFORCE`      | `true` faz um CRITICAL corrigível no Trivy falhar o build                                                                                                                                                                                                                                                                                                                                                                   |
| secret   | `CLIENT_REPOS_READ_TOKEN` | token só leitura de `Trajetto-Organization/trajetto-ui` e `Trajetto-Organization/trajetto-mobile` (fine-grained, _Contents: Read-only_), para o contrato de rotas do `validate.yml` (nas branches e na `staging`)                                                                                                                                                                                                           |

**Apague se existirem** (não são mais lidos por nada):
`DOKPLOY_COMPOSE_ID` (dos dois environments: era o id do app Compose), as
variáveis `STAGING_ENABLED` e `MIGRATIONS_VIA_JOB` (as migrations rodam pela
Application `trajetto-api-migrate` desde 31/10/2026), o secret
`DEPLOY_SSH_KEY` (a chave do antigo caminho por SSH das migrations, se chegou
a ser criada) e os secrets `PORTAINER_WEBHOOK_URL` e
`PORTAINER_STAGING_WEBHOOK_URL`.

### Proteção das branches

- `main` (o Ruleset da branch, em _Settings → Rules → Rulesets_): exigir PR
  e exigir os checks **`Secret scan`** e **`Staging evidence`**, os dois do
  `pr.yml` (o _Staging evidence_ já prova o `staged-<7>` e o `Gate` da
  validação do staging, então a validação não precisa ser exigida de novo, e
  um head só de documentação não fica preso esperando um check que não
  roda). Os quatro nomes antigos (_Lint, type-check, unit (coverage floor)
  and E2E_, _AI OCR service (image + pytest)_, _Secret scan (gitleaks)_ e
  _The PR head was built on staging_) deixaram de existir em 10/11/2026:
  **troque o Ruleset no primeiro PR para `main` depois da virada**, senão o
  PR fica esperando checks que ninguém mais publica. Permitir só **merge
  commit**: em
  _Settings → General → Pull Requests_, deixe marcado só _Allow merge
  commits_ e desmarque _Allow squash merging_ e _Allow rebase merging_. Se a
  proteção impedir o push do `semantic-release` (o commit do CHANGELOG),
  permita que o GitHub Actions faça bypass ou desligue o plugin
  `@semantic-release/git`.
- `staging`: sem exigência de PR (o dono faz push direto); bloquear force-push.

## 14. Conferir a convergência

O passo que prova que o deploy trocou a versão. Roda depois do Dokploy em
staging e na promoção, e **falha o run** quando o Swarm reverteu o update,
quando ele não termina no prazo ou quando as réplicas não rodam o build
promovido. São dois jeitos, escolhidos pela variável `ROLLOUT_VERIFY`
([seção 13](#13-configurar-o-github)):

| `ROLLOUT_VERIFY`        | Staging                   | Produção                  |
| ----------------------- | ------------------------- | ------------------------- |
| vazia (ou desconhecida) | liveness pública (`http`) | Swarm por SSH (`ssh`)     |
| `http`                  | liveness pública          | liveness pública          |
| `ssh`                   | Swarm por SSH             | Swarm por SSH             |
| `off`                   | nenhuma (aviso no resumo) | nenhuma (aviso no resumo) |

### Pela liveness pública (padrão no staging, sem SSH)

- O quê: `.github/scripts/wait-for-version.mjs`, no runner do GitHub (testado
  em `tests/unitaires/lifecycle/wait-for-version.test.ts`).
- Lê: `GET <API_PUBLIC_URL>/health/liveness` pela borda de verdade
  (Cloudflare, Traefik), a cada 5 s, com uma query nova por pedido (nenhum
  cache responde no lugar da API). A liveness devolve `commit`, o commit de
  onde a imagem saiu (build arg `GIT_SHA` → `APP_COMMIT_SHA`), sem tocar em
  nenhuma dependência.
- Passa quando: a API responde o commit deste run por **90 s seguidos** —
  mais que o monitor de rollback do Swarm (30 s, _Update Config_ da
  Application). Cada pedido cai numa réplica qualquer, então uma réplica
  antiga ainda no balanceamento zera a janela. Só uma **resposta** zera:
  outro commit, ou um build sem commit. Uma sondagem sem resposta (timeout,
  conexão derrubada, 5xx/52x ou outro status de erro da borda, um corpo que
  não é o JSON da liveness) não diz qual build serve, então não zera nem
  abre a janela; cada sequência delas vira `::warning::` com a contagem, e o
  total vai para o resumo. A janela só fecha numa resposta do commit
  esperado.
- Falha quando: 600 s sem a janela fechar (rollback do Swarm, réplica nova
  que não sobe, `API_PUBLIC_URL` errada) ou `API_PUBLIC_URL` ausente.
- Não vê: a IA (sem endereço público; a API não expõe a versão dela sem
  login de MASTER — `/health/providers` mostra só o motor e a versão do
  RapidOCR) e uma réplica para a qual a borda nunca manda tráfego. A IA fica
  coberta pelo `done` do Dokploy e pelo healthcheck do Swarm; para ver o
  commit dela, à mão: `wget -q -O - http://trajetto-ai-staging:8080/health`
  de dentro da API.
- Na produção, com `ROLLOUT_VERIFY=http`, o commit esperado é o da tag
  promovida (`sha-<7>`). Um rollback para um build anterior a esta
  conferência (sem `commit` na liveness) nunca passa: use `ssh` ou `off`
  nele.

À mão: `curl -s https://api-staging.intrajetto.com/health/liveness`
→ `{"status":"alive","version":"<7>","commit":"<40>"}`.

### Pelo Swarm, por SSH (padrão na produção; `ROLLOUT_VERIFY=ssh` no staging)

- O quê: `infra/scripts/verify-rollout.sh` no host do Dokploy, por SSH com
  chave restrita (forced command).
- Entrada: `<SWARM_API_SERVICE> ghcr.io/trajetto-organization/trajetto-api@sha256:<digest>`
  — o App Name da API e o digest que este run publicou.
- Uma chamada por serviço implantado, na ordem do deploy (plano de escala
  X-07): o PgBouncer, quando este run o implantou (antes das migrations,
  com a imagem dele, `trajetto-pgbouncer@sha256:<digest>`, e o App Name de
  `SWARM_PGBOUNCER_SERVICE`; sem a variável, aviso), os papéis implantados
  antes da API (`trajetto-worker`,
  `trajetto-scheduler`, `trajetto-worker-external`), antes de a tag da API
  andar, a API e, depois do deploy deles, os de borda (`trajetto-ingest`,
  `trajetto-realtime`). Cada
  papel entra pelo App Name da variável `SWARM_<PAPEL>_SERVICE` do
  environment, com o digest da API (todos rodam a imagem dela), por
  `.github/scripts/deploy-roles.sh verify`. Um papel que o run não
  implantou não é conferido; um implantado sem a variável é um aviso; um
  que não converge falha o run, e os seguintes não são conferidos.
- Imagens aceitas: `trajetto-api`, `trajetto-ui`, `trajetto-backup`,
  `trajetto-pgbouncer` e os nomes dos papéis, sempre por digest.
- Lê: o `UpdateStatus` do serviço, as tasks e o digest da imagem do
  contêiner de cada task. Na API, depois de convergir, também o _Stop Grace
  Period_ da spec (ausente = os 10 s do Docker) e só a variável
  `STOP_GRACE_PERIOD_MS` do _Environment_ (ausente = 10000): o filtro roda
  dentro do template do `docker`, e nenhum outro valor do _Environment_
  chega ao script.
- Passa quando: o update terminou (`completed`), toda task em execução roda
  o digest esperado, na quantidade de réplicas, e (na imagem da API, papéis
  inclusive) o grace cobre a variável. Vai no log a linha
  `grace: … cobre STOP_GRACE_PERIOD_MS=…`, e a do `ok:` termina com
  `grace=<s>s`, o _Stop Grace Period_ que o serviço tem de fato (em
  qualquer imagem).
- Com `ROLLOUT_REQUIRE_GRACE=true` no forced command (abaixo), a imagem da
  API (e dos papéis) e a do PgBouncer falham com grace abaixo de 40 s, o
  piso do plano; a web e o backup só imprimem o valor. Sem a variável, o
  grace só é impresso e conferido contra o `STOP_GRACE_PERIOD_MS`.
- Falha quando: `rollback_*`/`paused`, uma task com outra imagem, 600 s sem
  convergir (`ROLLOUT_TIMEOUT_SECONDS`) ou, na API, `STOP_GRACE_PERIOD_MS`
  acima do grace do serviço (contado em segundos inteiros, como o daemon
  faz). Nesse caso a imagem nova já está no ar, mas cada deploy seguinte
  mataria o desligamento ordenado no meio: suba o _Stop Grace Period_
  ([seção 7.7](#77-trajetto-api-application), passo 8) ou baixe a variável.

Como o Dokploy atualiza o serviço com a **tag** (`…:staging`/`…:stable`) e
não grava o digest na spec, o script não compara a spec: ele lê o digest da
imagem do contêiner de cada task em execução. Limite: só enxerga contêineres
do próprio nó (o manager). Com a VPS única, são todas as tasks; com mais nós
no Swarm, o script precisa ser revisto.

Instalação, uma vez, no host do Dokploy, e de novo sempre que o script
mudar no repositório (o host roda a cópia instalada; a de 15/11/2026 passou
a conferir o grace; a da onda 12 aceita os papéis e o PgBouncer, imprime
`grace=` e entende `ROLLOUT_REQUIRE_GRACE`):

```sh
sudo install -m 755 infra/scripts/verify-rollout.sh /usr/local/bin/trajetto-verify-rollout
```

E uma chave **só para isso** no `~/.ssh/authorized_keys` do usuário de deploy
— ela só lê:

```
command="/usr/local/bin/trajetto-verify-rollout",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... verify-trajetto
```

Para exigir os 40 s de grace (depois de todas as Applications da API, dos
papéis e do PgBouncer terem o _Stop Grace Period_ do plano), a mesma linha
com a variável na frente do comando:

```
command="ROLLOUT_REQUIRE_GRACE=true /usr/local/bin/trajetto-verify-rollout",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... verify-trajetto
```

Gere com `ssh-keygen -t ed25519 -f verify-trajetto -N ''`; a privada vai em
`DEPLOY_VERIFY_SSH_KEY`, e `ssh-keyscan -t ed25519 <host>` vai em
`DEPLOY_SSH_KNOWN_HOSTS`. A única entrada que o CI manda é a linha acima; o
script recusa qualquer outra coisa. À mão, no host:

```sh
trajetto-verify-rollout trajetto-api-production ghcr.io/trajetto-organization/trajetto-api@sha256:<digest>
# conferência manual equivalente:
docker service ps trajetto-api-production --filter desired-state=running --no-trunc --format '{{.Image}} {{.CurrentState}}'
docker service inspect trajetto-api-production --format '{{.UpdateStatus.State}}'   # completed
docker service inspect trajetto-api-production --format '{{json .Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}'   # 40000000000 (null = 10 s)
```

Desligar (só numa emergência, e fica registrado no resumo do run): variável
`ROLLOUT_VERIFY=off`.

### Os papéis da mesma imagem (`ROLLOUT_ROLES_EXPECTED`)

As duas conferências acima provam a API. Com o worker (e, depois, os outros
papéis) como Application própria, um worker cuja task nova não passou no
healthcheck volta ao build anterior pelo Swarm e continua consumindo as
filas nele, com a API já no commit novo. Por isso, depois do deploy dos
papéis de borda, roda mais um passo (plano de escala F3-31b):

- O quê: `.github/scripts/wait-for-roles.mjs`, no runner do GitHub (testado
  em `tests/unitaires/lifecycle/wait-for-roles.test.ts`).
- Lê: `GET <API_PUBLIC_URL>/health/rollout`, com o `ROLLOUT_STATUS_TOKEN`
  do environment, a cada 5 s. A resposta traz os processos vivos do
  `process_heartbeat`, contados por papel, ambiente, commit, impressão da
  configuração, filas, cron e sockets, sem nome de máquina, réplica ou nó.
- Passa quando, por **90 s seguidos**: cada papel de
  `ROLLOUT_ROLES_EXPECTED` tem um processo vivo no commit deste run; nenhum
  processo deste ambiente roda outro commit; toda fila tem consumidor e
  algum processo roda o cron (contados pela união dos processos no commit
  novo); e todos os processos vivos têm a mesma impressão da configuração.
- O papel `all` vale por api, worker e scheduler, dos dois lados: um
  processo em `all` cobre `ROLLOUT_ROLES_EXPECTED=api,worker`, e o valor
  `all` pede os três cobertos. A produção usa `all` até ter o worker dela
  (onda 14); a staging, `api,worker` desde que o worker existe.
- Falha quando: 600 s sem a janela fechar (um papel que não sobe, uma fila
  sem consumidor, ninguém com o cron), Environments que divergem (duas
  impressões), um processo do outro ambiente apontado para este banco, ou
  um papel desconhecido na variável.
- Não roda: sem o secret `ROLLOUT_STATUS_TOKEN` ou sem a variável
  `ROLLOUT_ROLES_EXPECTED` (aviso, e o run é o de antes), com
  `ROLLOUT_VERIFY=off`, num build anterior a esta conferência (a resposta
  sem os processos: aviso) e quando a rota responde 404 três vezes seguidas
  (um build anterior à rota, ou um token diferente do da API: aviso).
- Antes da API, sem SSH (`ROLLOUT_VERIFY=http`, o padrão da staging): o
  mesmo script, com `WAIT_ROLES_SCOPE=roles`, espera só os papéis que o
  run acabou de implantar antes da API (`deploy-roles.sh verify`, passo 7
  da lista acima). A API que responde ainda é a do build anterior, então
  só esses papéis são julgados: cada um com um processo vivo no commit
  novo e nenhum em outro, pelo nome do papel (o `all` da API anterior não
  vale por um worker). Uma API anterior a esta conferência só avisa, e o
  primeiro deploy que traz o passo não confere os papéis antes da API.

À mão (o token nunca vai para a linha de comando de outra pessoa nem para
um log):

```sh
curl -s -H "Authorization: Bearer $ROLLOUT_STATUS_TOKEN" https://api-staging.intrajetto.com/health/rollout
```

## 15. Migrations

### Onde rodam

**Nunca no boot de uma réplica.** A imagem da API não traz o CLI do Prisma,
o schema, as migrations nem os seeds. O boot (`docker-entrypoint.sh`, modo
`serve`) espera o Postgres, recusa um banco vazio em produção e recusa um
banco a que falte **qualquer** migration do build, não só a mais nova
(`build/schema-version.json` lista todas; `infra/scripts/schema-guard.ts`):
a réplica sai antes de servir, com as que faltam no log e o pedido de dar
**Deploy** na Application `trajetto-api-migrate` do ambiente (rodar o
pipeline de novo não basta depois de trocar ou restaurar o banco: ele pula
a etapa quando `<ambiente>-applied` já é aquela imagem), e o Swarm
(_start-first_, _failure action_ `rollback`) mantém as antigas.

Quem migra é a **imagem de migração** (`trajetto-api-migrate`, estágio
`migrate` do `Dockerfile`), rodando como uma **Application do Dokploy**, a
`trajetto-api-migrate` de cada ambiente, **antes do rollout** e **só quando o
banco ainda não aplicou aquela imagem**:

| Quando                                     | Quem chama                                                                                                                            | O que acontece numa migration que falha                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| deploy de staging                          | `Deploy` do `staging.yml`, passo _Run the database migrations (Dokploy)_ da ação de deploy, com a imagem de migração **deste commit** | o passo falha; nenhuma tag da API ou da IA anda, elas não são reimplantadas e o staging segue no build que roda |
| promoção (merge em `main`, _Run workflow_) | `Deploy` do `production.yml`, o mesmo passo, com a imagem de migração **do build promovido** (lida pelo _Staging evidence_)           | o passo falha; `stable` não anda, nada é reimplantado e as réplicas de produção nem percebem                    |

**Só quando precisa.** A imagem de migração é reconstruída apenas quando
muda o que ela roda, como a da IA: `.github/scripts/migrate-source.sh` faz um
hash de tudo que a etapa executa ou lê (as migrations e o `schema.prisma`, os
seeds e os arquivos que eles importam, a planilha de infrações, o
entrypoint, o `Dockerfile` e as dependências) e o build a etiqueta
`src-<hash>`. Um push que não mexe em nada disso reaproveita a imagem
anterior (mesmo digest) e só ganha a tag `sha-<7>` do commit. Cada ambiente
guarda a última imagem que **terminou** de rodar no seu banco numa tag:
`trajetto-api-migrate:staging-applied` e `:stable-applied`, movidas só depois
do sucesso. Mesmo digest = as mesmas migrations e seeds já rodaram, e a etapa
é pulada com um aviso. Uma etapa que falhou ou foi interrompida não move a
tag, e o próximo run a roda de novo. Um teste
(`tests/unitaires/lifecycle/migrate-source.test.ts`) empacota os scripts da
etapa como o tsup e reprova se algum importar um arquivo fora da lista.

Um build anterior à imagem de migração (`main-<sha>`, ou um _Run workflow_
para um commit sem `infra/scripts/schema-guard.ts`) pula a etapa com aviso:
a produção já aplicou todas as migrations que ele conhece. Um build
posterior sem ela (o push falhou) reprova o promote antes de mover
`stable`: rode o pipeline de staging desse commit de novo. Os passos só
rodam quando o deploy do ambiente está configurado (os quatro `DOKPLOY_*`,
incluindo `DOKPLOY_MIGRATE_APPLICATION_ID`).

Até 31/10/2026 cada réplica migrava no boot (`RUN_MIGRATIONS_ON_BOOT`): uma
migration que falhava, ou que passava do orçamento da liveness e era morta,
deixava `_prisma_migrations` com `finished_at` nulo, e **toda** imagem,
inclusive a antiga, passava a sair com P3009 no boot — o próximo restart de
qualquer réplica virava queda. As réplicas também migravam juntas a cada
rollout, e a imagem carregava o CLI. Os builds daquela época leem a variável
com padrão `true`: por isso ela fica `false` na API enquanto eles puderem
ser alvo de rollback ("Configurar a Application `trajetto-api-migrate`",
passo 7, abaixo).

O modo `release` do entrypoint (o comando padrão da imagem de migração) roda
`build/prebuild-online-ddl.js` (o `prisma/concurrent`, logo abaixo),
`prisma migrate deploy` (de `/app/migrate`, onde estão o CLI e o
`prisma.config.ts`), `build/seed.js` e `build/import-violation-codes.js` de
forma **estrita**, sem subir o servidor: qualquer erro reprova a etapa. Os
dois seeds são idempotentes, e a importação da tabela de infrações é tudo ou
nada: roda numa transação só, e um lote que falha desfaz a importação
inteira e reprova a etapa (o banco fica com a tabela de antes). A etapa
usa `MIGRATION_DATABASE_URL` quando existe e, sem ela, a `DATABASE_URL`,
que na Application de migração já é a URL **sem os tetos de
runtime**: a `DATABASE_URL` da API leva `statement_timeout=30s` e
`lock_timeout=5s`, e um `CREATE INDEX` cancelado no meio é uma migration
falhada.

As regras para escrever uma migration (expandir/contrair, `lock_timeout`,
índices) estão em [`arquitetura.md`](./arquitetura.md#migrations-expandir-e-contrair).

### `prisma/concurrent`: os índices antes das migrations

Um `CREATE INDEX` comum segura as escritas da tabela durante todo o build, e
o Prisma roda cada migration numa transação, onde o CREATE INDEX
CONCURRENTLY não roda. O índice de uma tabela quente vai então num arquivo
de `prisma/concurrent/` (as regras estão no `README.md` dessa pasta), que a
etapa roda **antes** do `prisma migrate deploy`, com CONCURRENTLY; a
migration mantém o `CREATE INDEX IF NOT EXISTS` com o mesmo nome, que acha o
índice pronto e não faz nada (num banco novo, o molde do E2E ou o
`yarn dev`, ela o constrói com a tabela vazia). O roteiro "construa à mão
antes" dos comentários de migration saiu daí.

O passo roda de novo logo **depois** do `prisma migrate deploy` (linhas
`[postbuild]` no log), para o arquivo que a primeira passada pulou porque a
coluna ainda não existia: uma coluna e o índice dela na mesma release. A
migration desse índice o constrói só com a tabela vazia (o bloco `DO $$`
do `README.md`, que confere se a tabela tem linha), e com linhas quem o
constrói é essa segunda passada, com CONCURRENTLY, antes de a API nova
subir. O `migration-prebuild.test.ts` cobra o bloco e a declaração da
coluna.

**Ajustes do planejador (plano de escala, F2-22).** O mesmo passo aplica o
alvo de estatística de uma coluna (`SET STATISTICS`), os parâmetros de
armazenamento (`SET (...)`, como os do autovacuum) e as estatísticas
estendidas (`CREATE STATISTICS`). Cada um pega SHARE UPDATE EXCLUSIVE, a
trava de todo vacuum e ANALYZE (as escritas seguem), e é pulado quando o
catálogo já o tem, sem pegar trava. A migration de mesmo nome faz o mesmo
só onde o catálogo não tem (banco novo, ou `PREBUILD_ONLINE_DDL=off`), num
bloco `DO $$` que confere antes de cada comando. O
`migration-prebuild.test.ts` cobra que cada comando do arquivo esteja na
migration, escrito igual, e o `prebuild-online-ddl.test.ts`, que um banco
migrado não deixa nada para o passo. Os de hoje estão em
`prisma/concurrent/20261117180000_tenant_statistics.sql`:

- alvo 1000 em `businessId` de `delivery`, `delivery_event`, `route`,
  `delivery_occurrence`, `activity` e `webhook_delivery` (o planejador
  guarda as 1000 empresas mais comuns, e não 100);
- dependências `(businessId, status)` e `(businessId, driverId)` de
  `delivery` e `route` (um motorista é de uma empresa só; sem isso a conta
  de um motorista saía de 20 a 200 vezes menor);
- autovacuum a 2% e ANALYZE a 1% das linhas em `delivery`, `route`,
  `route_stop` e `delivery_occurrence`.

Para conferir num banco:

```sql
SELECT stxname, pg_get_statisticsobjdef(oid) FROM pg_statistic_ext;
SELECT relname, reloptions FROM pg_class WHERE reloptions IS NOT NULL;
```

- Cada espera de lock tem `lock_timeout` (`PREBUILD_LOCK_TIMEOUT_MS`, 3 s) e
  é repetida (`PREBUILD_LOCK_RETRIES`, 20). Esgotadas, a etapa falha (a API
  não é implantada) e o próximo deploy a roda de novo; um CIC longo é para a
  madrugada.
- Um índice que um CIC deixou inválido é removido com DROP INDEX
  CONCURRENTLY e refeito; numa tabela particionada, o passo cria o índice
  no pai com `ON ONLY`, um CIC por partição e um `ATTACH` de cada.
- Quando a etapa desiste de um índice (duplicata num `UNIQUE`, lock que não
  veio), ela remove o que o CIC deixou antes de falhar: a API segue no
  build anterior, e um `UNIQUE` inválido recusaria as duplicatas que ele
  grava. Se a remoção também não conseguir o lock, o log da
  `trajetto-api-migrate` traz o `DROP INDEX CONCURRENTLY` para rodar à mão,
  fora do pico.
- No fim, nenhum índice que o passo administra pode estar inválido. Outros
  índices inválidos do banco aparecem como aviso no log da
  `trajetto-api-migrate` (linhas `[prebuild]`): confira e refaça à mão.
- A etapa **recusa** uma URL do PgBouncer (porta 6432 ou `pgbouncer=true`)
  e sai com 64 antes de tocar no banco: CIC, o lock do `migrate deploy` e os
  passos depois dele precisam de uma sessão própria no Postgres.
- Emergência: `PREBUILD_ONLINE_DDL=off` no _Environment_ da
  `trajetto-api-migrate` desliga as duas passadas (as migrations passam a
  construir esses índices com lock, menos o de uma coluna da mesma
  release, que fica faltando); tire depois e dê Deploy na
  `trajetto-api-migrate` para a etapa rodar de novo.
- Uma release com um índice grande pode passar dos 30 min que o deploy
  espera a etapa: suba a variável `RELEASE_TIMEOUT_SECONDS` do environment
  do GitHub antes ([seção 13](#13-configurar-o-github)), até 3600 s. É um
  prazo só para a etapa inteira, a espera pela etapa do outro ambiente
  incluída; acima do teto vale 3600, com aviso, porque o job do deploy tem
  120 min e a IA, a API e a conferência do rollout vêm depois. Um build
  maior que isso roda fora do pipeline: **Deploy** na
  `trajetto-api-migrate` pelo painel, espere `Running` e rode o pipeline
  de novo.

### Depois das migrations: `infra/sql` e `prisma/post-deploy`

A ordem inteira da etapa é `prisma/concurrent` → `prisma migrate deploy` →
`prisma/concurrent` de novo (o que a release acabou de criar) →
`infra/sql/*.sql` → `prisma/post-deploy/*.sql` → seeds
(`build/release-steps.js` roda os dois do meio; o molde do E2E e o
`yarn dev` rodam o mesmo).

- **`infra/sql`**: roles, donos e grants, em ordem de nome, em **toda**
  release. Um `pg_restore --no-owner` (restore, PITR, failover) apaga grants
  e donos, e só um arquivo reaplicado converge. Esses arquivos só criam
  roles `NOLOGIN`, e só quando faltam; nunca mexem em `LOGIN`, senha,
  validade, limite de conexões, nome nem `DROP ROLE`, nem tiram o
  `CONNECT` do banco (`tests/unitaires/lifecycle/infra-sql-rules.test.ts`
  cobra, também no SQL montado em texto).
  O login e a senha de qualquer role são sempre seus, à mão. Nenhuma
  migration do Prisma referencia um role. O `50-cluster-epoch.sql` (plano
  de escala, U-14) mantém a época do cluster na tabela `cluster_epoch`: ela
  sobe quando o `system_identifier` ou a timeline do Postgres mudam (um
  PITR, um promote, um cluster novo), e o `ops-heartbeat` alerta
  `cluster-epoch-stale` até a etapa rodar depois de um deles.
- **`prisma/post-deploy`**: DDL com pré-condição (por exemplo, a troca das
  filas, que espera todas as imagens vivas anunciarem a capability).
- Cada arquivo testa o próprio estado e termina com um `RAISE NOTICE`
  `'applied: …'`, `'skipped: …'` (já feito) ou `'pending: …'` (espera um
  estado). O resultado de cada um, e o da execução (`@release`), fica na
  tabela `release_step_state`; um arquivo sem esse aviso, ou com erro,
  reprova a etapa, e os seguintes e os seeds não rodam. Um arquivo que saiu
  do repositório vira `retired`. As regras de cada pasta estão no
  `README.md` dela.
- No log da `trajetto-api-migrate`, as linhas `[release-steps]` dizem o que
  cada passo fez.
- Emergência: `POST_DEPLOY_STEPS=off` no _Environment_ da
  `trajetto-api-migrate` pula o `prisma/post-deploy` (o estado dos passos
  fica como estava; o `infra/sql` continua). Tire depois.

### Quando a etapa roda

O passo _Decide migrations_ da ação de deploy roda a etapa quando:

1. a imagem de migração do build não é a que o banco do ambiente já aplicou
   (a tag `<ambiente>-applied`; o caso de sempre); ou
2. o _Run workflow_ veio com `force_release` (no `staging.yml`, que refaz
   o caminho todo do staging; no `production.yml`, com a `image_tag` que
   está no ar). É o que se usa depois de um restore, de um failover, ou para
   um passo pendente que não pode esperar o próximo deploy; ou
3. a última etapa deixou um passo de `infra/sql` ou `prisma/post-deploy`
   `pending` ou `failed`: o deploy lê `GET <API_PUBLIC_URL>/health/rollout`
   com o secret `ROLLOUT_STATUS_TOKEN` do environment (o mesmo valor da
   variável da `trajetto-api`) e roda a etapa de novo, com a mesma imagem.
   O resumo do run diz quais passos.

Sem o `ROLLOUT_STATUS_TOKEN` (ou quando a API não responde a rota: um build
anterior a ela, um token diferente, sem `API_PUBLIC_URL`), vale só o caso 1
e o 2, com um aviso no run. A rota responde 404, igual a uma rota que não
existe, sem o token certo; 30 pedidos por minuto, sem cache. Um passo
pendente para sempre roda a etapa a cada deploy (1 a 2 min): o resumo do run
mostra qual.

**Uma migração por vez na VPS.** Com a variável
`RELEASE_SERIALIZE_WITH_APPLICATION_ID` (o applicationId da
`trajetto-api-migrate` do **outro** ambiente), a etapa espera enquanto a do
outro ambiente está em andamento: um deployment dela `running` no Dokploy
(baixando a imagem) ou uma tarefa que ainda não chegou a `Running`
(`Preparing`, `Starting`); passado o prazo (`RELEASE_TIMEOUT_SECONDS`), o
passo falha sem tocar no banco. Um deployment `running` há mais de 15 min
é tomado como travado (aviso, sem espera). Sem a variável, ou sem
conseguir ler a outra Application, segue sem esperar (com aviso). As duas
etapas conferem uma à outra logo antes do próprio deploy; duas que leem no
mesmo segundo ainda podem rodar juntas (o Dokploy não tem trava), o que
custa memória por alguns minutos, nunca dado. Sai quando a staging for
para o próprio servidor.

### Como a etapa roda

A Application `trajetto-api-migrate` é igual às outras (provider Docker,
imagem do GHCR na tag do ambiente), com uma diferença: o comando da imagem
migra, roda os seeds, grava um marcador e **fica parado**, sem servir nada.
O `HEALTHCHECK` da imagem só passa quando o marcador existe. Assim o próprio
Swarm diz o resultado na tarefa: `Starting` enquanto migra, `Running` quando
terminou, `Failed` (com o código de saída) quando uma migration ou um seed
falhou. O contêiner parado ocupa só alguns MB de memória até o próximo
deploy.

1. O pipeline lê a Application (`application.one`) e confere a configuração
   antes de tocar no banco: a imagem certa (`:staging` ou `:stable`),
   _Restart Policy_ `{"Condition":"none"}`, nenhum _Health Check_ próprio,
   uma réplica e nenhum _Update Config_ `stop-first`. Algo diferente reprova
   o passo dizendo o que mudar no painel, e nada é migrado.
2. Anota as tarefas do serviço (`docker.getServiceContainersByAppName`, a
   mesma lista da aba _Logs_; a tag do ambiente já foi movida para a imagem
   de migração do build no passo anterior do workflow) e pede o deploy (o
   mesmo `dokploy-deploy.mjs` das outras Applications, com as retentativas
   de download). O Dokploy devolve essa lista **vazia** sempre que o
   `docker service ps` escreve algo no stderr, e uma lista vazia tomada ao pé
   da letra faria a tarefa parada da etapa anterior parecer nova: um sucesso
   que não rodou. Por isso uma lista vazia é lida até três vezes e só é aceita
   quando o histórico de `deployment.all` prova que nunca houve um deploy com
   sucesso: nenhum deployment `done` e menos de 10 no histórico (o Dokploy
   guarda só os 10 mais recentes, então um histórico cheio não prova nada).
   Nos outros casos o passo reprova **antes** do deploy, e nada é migrado; se
   o histórico encheu de falhas, um **Deploy** manual da
   `trajetto-api-migrate` (seguro) volta a pôr um `done` nele.
3. Lê as tarefas a cada 5 s até uma tarefa **nova** ficar `Running` (ou
   `Complete`: sucesso) ou `Failed`/`Rejected`/`Orphaned` (falha), por até
   30 min (`RELEASE_TIMEOUT_SECONDS`, até 60, menos o que a espera pela
   etapa do outro ambiente já gastou). Só as novas contam: com o _Update
   Config_ padrão do Dokploy (_start-first_, _rollback_), uma etapa que falha
   deixa a tarefa anterior, parada e saudável, em `Running`.
4. Sucesso: move `<ambiente>-applied` e segue para a IA e a API. Falha: o
   passo reprova, a API não é implantada, e o log da migration está no
   Dokploy, em _Application `trajetto-api-migrate` → Logs_ (o Dokploy não
   tem API de logs; o Swarm guarda o da tarefa que falhou). Estourou o
   tempo: o passo falha, mas a etapa **não é interrompida** (matá-la no meio
   de uma migration é o que gera P3009); acompanhe pela aba _Logs_.

Nenhuma credencial do banco passa pelo CI: a `DATABASE_URL` mora no
_Environment_ da Application, no Dokploy. Nenhuma chave SSH entra no host.

**Medido em 31/10/2026** num Swarm de teste com a imagem real e o _Update
Config_ padrão do Dokploy: primeira etapa num banco vazio em ~14 s; as
seguintes, sem migration nova, em ~10 s; uma `DATABASE_URL` errada e um
P3009 viraram `Failed` com o passo reprovado, mesmo com a tarefa anterior
ainda `Running`; e o deploy seguinte, corrigido, passou.

**Por que não um job do Swarm:** uma Application em modo `ReplicatedJob`
nunca sobe, porque o Dokploy sempre manda `UpdateConfig` e o Docker recusa
("Jobs may not have an update config", conferido em 31/10/2026 no Docker 27,
inclusive com `UpdateConfig` vazio). Os _Schedules_ rodam `docker exec` num
contêiner que já está de pé (a versão antiga) e seguram a requisição até o
fim (a Cloudflare corta em 100 s). E um job criado por SSH exigia um usuário
no host, uma chave por ambiente e a porta 22 aberta para o GitHub.

**_Restart Policy_ `none` é obrigatória:** sem ela o Swarm usa `any`, repete
uma migration que falhou sem parar, e o _rollback_ pode cortar uma repetição
no meio (deixando P3009). O pipeline recusa a Application sem ela.

### Configurar a Application `trajetto-api-migrate` (uma vez por ambiente)

No mesmo projeto e ambiente do Dokploy da `trajetto-api` (staging e
produção, cada um a sua):

1. **Create Service → Application**: _Name_ `trajetto-api-migrate`; _App
   Name_ `trajetto-api-migrate-staging` (produção:
   `trajetto-api-migrate-production`; [seção 7.2](#72-nomes-name-e-app-name)).
2. **General → Provider: Docker**: _Docker Image_
   `ghcr.io/trajetto-organization/trajetto-api-migrate:staging` (produção:
   `:stable`), com a mesma credencial do GHCR da API
   ([seção 7.3](#73-credencial-do-ghcr)) → **Save**.
3. **Environment** → **Save**:
   ```
   DATABASE_URL=postgresql://trajetto:<SENHA_DO_POSTGRES>@<App Name do Postgres>:5432/trajetto?schema=public&connection_limit=2&connect_timeout=10
   ```
   A URL **sem** `statement_timeout` nem `lock_timeout` (os tetos da
   `DATABASE_URL` da API): numa API montada antes de 31/10/2026, é o valor da
   `MIGRATION_DATABASE_URL` dela. Nada mais: o seed não lê o Environment da
   API. Numa **instalação nova** (banco vazio,
   [seção 8](#8-primeiro-deploy-na-ordem-com-conferências)) acrescente, só
   para o primeiro deploy, `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true`,
   `MASTER_USER_EMAIL` e `MASTER_USER_INITIAL_PASSWORD`, e apague-as depois.
4. **Advanced → Swarm Settings → Restart Policy**: `{"Condition":"none"}` →
   **Save**. Deixe _Health Check_, _Update Config_ e _Mode_ vazios, e
   _Replicas_ em 1. Sem domínio e sem porta.
5. **O id**: copie o `applicationId` da URL da Application
   ([seção 7.10](#710-anotar-o-applicationid-e-o-app-name)) para o secret
   `DOKPLOY_MIGRATE_APPLICATION_ID` do environment do GitHub (o de staging no
   `staging`, o de produção no `production`; [seção 13](#13-configurar-o-github)).
6. **Não precisa clicar em Deploy**: a tag `:staging` (ou `:stable`) da
   imagem de migração só passa a existir quando o pipeline a move, e ele faz
   o primeiro deploy. Um **Deploy** manual depois disso é seguro: roda a
   etapa de novo (migrations já aplicadas não mudam nada). É o que se faz
   depois de trocar o banco do ambiente
   ([seção 18](#18-backup-e-restauração)): a tag `<ambiente>-applied` diz
   o que rodou no banco antigo, e o pipeline pularia a etapa.
7. **Nas duas Applications `trajetto-api`** (staging e produção): ponha
   `RUN_MIGRATIONS_ON_BOOT=false` no _Environment_ (**Save** basta; as
   imagens de depois de 31/10/2026 a ignoram) e **não a apague** enquanto um
   build anterior a 31/10/2026 (`main-<sha>` e os `sha-<7>` de antes da
   imagem de migração) puder ser alvo de rollback: eles leem a variável com
   padrão `true` e voltariam a migrar no boot. A `MIGRATION_DATABASE_URL` da
   API pode sair: nenhum build a lê ali (os de agora nunca; os de antes, só
   quando migram no boot). Apague a variável de repositório
   `MIGRATIONS_VIA_JOB` e o secret `DEPLOY_SSH_KEY`, se existirem (nada mais
   os lê).

Uma variável nova que a etapa precise vai no _Environment_ da
`trajetto-api-migrate` (**Save** basta: o deploy do pipeline aplica o
Environment salvo).

### P3009: uma migration ficou pela metade

Sintoma: `migrate found failed migrations in the target database, new
migrations will not be applied`.

1. **Não reinicie réplicas.** As que estão de pé continuam servindo.
2. Achar a migration:
   ```sql
   SELECT migration_name, started_at, finished_at, rolled_back_at, logs
     FROM "_prisma_migrations"
    WHERE finished_at IS NULL AND rolled_back_at IS NULL;
   ```
3. Conferir o estado real do schema para cada objeto do `migration.sql`
   (quando o processo é morto, o Postgres pode ter dado COMMIT sem o Prisma
   registrar `finished_at`):
   ```sql
   SELECT indexname FROM pg_indexes WHERE tablename = '<tabela>';
   SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;
   SELECT column_name FROM information_schema.columns WHERE table_name = '<tabela>';
   ```
4. Decidir: tudo aplicado → `prisma migrate resolve --applied <nome>`; nada
   aplicado → `prisma migrate resolve --rolled-back <nome>` e rodar de novo;
   pela metade (ex. índice `INVALID` de um `CONCURRENTLY`) → levar à mão a um
   dos dois estados e só então resolver. `--rolled-back` sem olhar é o erro
   clássico: se o DDL tinha commitado, o próximo deploy bate em `already
exists` e volta ao P3009.
5. Onde rodar o `resolve`: no host, com a imagem de migração que falhou (a
   da API não traz o CLI; o host já a tem, porque acabou de rodá-la) e o
   Environment da Application de migração daquele ambiente:
   ```sh
   APP=<App Name da trajetto-api-migrate>
   IMAGE=$(docker service inspect --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' "$APP")
   (umask 077; docker service inspect --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' "$APP" > /tmp/release.env)
   docker run --rm --network dokploy-network --env-file /tmp/release.env \
     -w /app/migrate --entrypoint sh "$IMAGE" \
     -c 'DATABASE_URL="${MIGRATION_DATABASE_URL:-$DATABASE_URL}" ./node_modules/.bin/prisma migrate resolve --applied <nome>'
   rm /tmp/release.env
   ```
   Se o `docker run` disser que a imagem não existe no host (outra máquina),
   faça antes `docker login ghcr.io` com o token da
   [seção 7.3](#73-credencial-do-ghcr).
6. Rodar a etapa de novo: o pipeline de novo, ou **Deploy** na Application
   `trajetto-api-migrate` (e conferir a aba _Logs_).

### Contract pendente desta release

`user.whatsapp_instance_connected`, `business.ai_analysis_used` e
`business.ai_analysis_reset_at` não são mais usadas, mas continuam no banco
(campos `@ignore` no `schema.prisma`) porque a versão anterior em produção
ainda as seleciona. Os DROPs saíram de
`20260815120000_remove_whatsapp_instance_state` e
`20260815200000_add_ai_analysis_pipeline` (que nunca chegaram à produção), e
`20260924090000_keep_legacy_columns_for_rollback` devolve as colunas aos bancos
que aplicaram as versões antigas. Numa release **posterior** a esta estar em
produção: criar a migration de contract (o SQL está no cabeçalho de
`20260924090000`) com `-- contract-phase: <release> não lê mais estas
colunas` e remover os três campos `@ignore` no mesmo commit.

### Expansões que pedem a release seguinte (plano de 02/11/2026)

Duas colunas viraram opcionais por `-- nullable-expand:` e **na release que
as expandiu ninguém gravava NULL nelas**. O código daquela release já lê as
duas como opcionais (é o que permite voltar a ela depois da seguinte):

| Coluna                           | Migration                                       | O que a release seguinte faz                                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user.email`                     | `20261102120100_user_email_nullable`            | **já saiu** (D2): liga o cadastro de motorista sem e-mail, que grava NULL; o e-mail continua obrigatório para quem não é motorista. Daqui em diante, um rollback só volta até a release que expandiu a coluna                    |
| `delivery_message_template.body` | `20261102120800_message_template_body_nullable` | passa a gravar NULL no WhatsApp e roda a migração de dados que zera `body` e `subject` das linhas de WhatsApp, marcada `-- contract-phase:` (B3); o `CHECK delivery_message_template_email_body_chk` mantém o e-mail obrigatório |

No staging isso são dois pushes da API (o segundo só depois do primeiro no
ar); em produção, duas releases. Nunca as duas fases juntas: um rollback
para a imagem anterior encontraria NULL numa coluna que o client dela lê como
obrigatória (P2032). A fase seguinte do B3 está pronta como patch em
`_n1/api-b3-whatsapp-template-body-null.patch` no workspace (com o
`README.md` da pasta: ordem e testes).

**Um campo de resposta pela mesma regra (K14).** A lista de rotas
(`GET /route/list-routes`) passou a trazer `stopCounts` e, nesta release,
ainda manda `stops` só com id e status: o painel em produção lê esse campo, e
tirá-lo junto quebraria a tabela entre o deploy da API e o da web. A release
seguinte, depois da web que lê `stopCounts` no ar, tira `stops` da lista
(`_n1/api-k14-route-list-without-stops.patch`, sem migration).

**WhatsApp ao cliente desligado na migração (D35).** Esta release roda
`20261103110000_whatsapp_customer_messages_off`, que desliga todas as linhas
WHATSAPP de `delivery_message_template`: o texto passa a ser o modelo fixo
aprovado pela Meta, que nenhuma empresa viu. Avise as empresas que usam a aba
"Mensagens ao Cliente": cada uma liga de novo, na web, os momentos que quiser.
Antes, conte as linhas (Fase 0 do plano):
`SELECT "businessId", topic, is_active FROM delivery_message_template WHERE channel = 'WHATSAPP';`.

**Origem dos checklists (05/11/2026).** Esta release roda duas migrations
para a origem (e uma terceira, a do alerta de abastecimento, logo abaixo).
`20261105120000_vehicle_checklist_created_from` cria
`vehicle_checklist.created_from` (padrão `WEB_DASHBOARD`): só catálogo, e o
lock exclusivo que ela toma na tabela dura só essa mudança. Depois,
`20261105120100_vehicle_checklist_created_from_backfill` marca como
`MOBILE_APP` os checklists antigos do app (atividade "Origem: Aplicativo" ou
`client_submission_id` preenchido), numa transação à parte de propósito: na
mesma do `ADD COLUMN`, o lock exclusivo duraria o `UPDATE` inteiro e, como a
API roda com `lock_timeout=5s`, toda leitura e gravação de checklist (lista,
cadastro, edição, exclusão, análise de IA, detalhe da rota) que chegasse
nesse meio-tempo não esperaria: falharia com 500 depois de 5 s. Sozinho, o
`UPDATE` não trava leitura nem cadastro; só a edição, a exclusão ou a análise
de IA de um checklist que ele marca espera o fim dele, e falha com 500 depois
de 5 s. Ele lê a tabela `activity`, que não tem índice em `type`, a partir de
14/09/2026 (antes disso a atividade não trazia a origem). Antes do deploy,
meça a tabela inteira,
`SELECT count(*), pg_size_pretty(pg_total_relation_size('activity')) FROM activity;`,
e a parte que o `UPDATE` lê,
`SELECT count(*) FROM activity WHERE created_at >= '2026-09-14';`; se for
grande, suba fora do pico. A imagem anterior grava `WEB_DASHBOARD` em todo
checklist novo, inclusive os do app: os que ela gravar entre as migrations e
o fim do rollout (ou durante um rollback) ficam "Web". O `UPDATE` do backfill
é idempotente e não contradiz esta release, que já grava como `MOBILE_APP` o
checklist com chave e sem origem; para corrigi-los, rode-o de novo à mão no
banco depois que esta release estiver servindo.

**Alerta de abastecimento repetido (05/11/2026).** A mesma release roda
`20261105130000_fuel_recent_refuel_alert`: cria o enum `FuelAlert` (num bloco
`DO` que ignora `duplicate_object`) e, em `fuel`, `alerts` (`FuelAlert[]`,
`NOT NULL`, padrão vazio), `recent_refuel_reason` (`VARCHAR(300)`) e
`recent_refuel_previous_at`, todos com `ADD COLUMN IF NOT EXISTS` sob
`lock_timeout=5s`. Só catálogo (o padrão é constante): o lock exclusivo em
`fuel` dura a mudança do catálogo, sem reescrever nem varrer a tabela. **Sem
backfill:** os abastecimentos gravados antes não são marcados, e o filtro
"Alertas" da lista começa daqui. A imagem anterior não conhece as colunas:
o que ela gravar durante o rollout (ou depois de um rollback) fica sem
alerta, e nada mais muda para ela. A recusa `409 FUEL_RECENT_REFUEL` só vale
para o app de `contract` 5 em diante, que ainda não está nas mãos dos
motoristas: até lá todo segundo abastecimento é gravado e marcado.

**Intervalo entre pausas (05/11/2026).** Sem migration: a pausa anterior é
lida pelo índice `driver_pause (driverId, started_at)`, que já existe. O
início de uma pausa nova menos de 5 minutos depois do fim da anterior
responde `409 PAUSE_COOLDOWN` só para o app de `contract` 5 em diante num
envio direto (sem `X-Client-Queued-At`); a fila offline, o app em produção
(sem o cabeçalho) e a web continuam gravando como antes, e cada início assim
deixa a linha `warn` "Pause started inside the cooldown by a queued resend or
a build without the rule: recorded". Encerrar uma pausa nunca é recusado. A
imagem anterior não conhece a regra nem os três campos novos de
`GET /driver-pause/current` (`last_ended_at`, `next_pause_allowed_at`,
`next_pause_in_seconds`): durante o rollout (ou depois de um rollback), a
réplica com ela responde `/current` sem esses campos e grava todo início,
como antes.

**Motivo na pausa por outro motivo (09/11/2026).** Sem migration nem
variável: o tipo é lido pelo `system_key` que já existe. A API passa a dizer
`requires_note` em cada tipo de `pause_types` do dia do motorista e responde
`400 PAUSE_NOTE_REQUIRED` ao início do tipo padrão "Outra pausa" sem motivo
(menos de 3 letras, sem contar espaços) só para o app de `contract` 7 em
diante num envio direto (sem `X-Client-Queued-At`). A fila offline, o app em
produção (sem o cabeçalho), os builds de contrato 5 e 6 e a web continuam
gravando como antes, com ou sem motivo, e cada "Outra pausa" gravada assim
sem motivo deixa a linha `warn` "Generic pause started without a reason by a
queued resend or a build without the rule: recorded" (é por ela que se vê
quando a OTA do contrato 7 chegou a todos); o fim nunca é recusado por isso.
Ordem de subida livre (o recomendado: API, web e, por último, a OTA do app
com o contrato 7). A imagem anterior não conhece a regra nem
`requires_note`: durante o rollout (ou depois de um rollback), a réplica
com ela grava todo início, e o app de contrato 7 deduz a exigência sozinho
(o padrão de natureza Outra, ou o "Outra" da lista fixa) e pede o motivo do
mesmo jeito.

**Conta e acesso do motorista, onda 2 (06/11/2026).** Três migrations, pela
mesma etapa da `trajetto-api-migrate` (nada à mão no deploy):

1. `20261106120000_user_must_change_password` cria
   `user.must_change_password` (`BOOLEAN NOT NULL DEFAULT false`), sozinha e
   sob `lock_timeout=5s`: só catálogo, e o lock exclusivo em `user` (lida por
   toda requisição) dura só essa mudança. Sem backfill: as senhas que os
   gestores definiram antes não pedem troca.
2. `20261106120100_driver_trusted_device` cria a tabela
   `driver_trusted_device` (um aparelho por login, pelo SHA-256 do
   identificador, nunca o identificador; `source` `qr` ou `backfill`). A
   chave estrangeira toma um lock curto em `user`, solto ao fim desta
   migration.
3. `20261106120200_driver_trusted_device_backfill` confia, por login, nos
   aparelhos que os motoristas já usam: os de sessão presa ao aparelho ainda
   válida (`refresh_token` com `device_id`, sem revogação nem vencimento) e o
   do último QR Code lido (`driver_enrollment_token` consumido), **menos**
   esse último quando o gestor desconectou algum aparelho daquele login
   depois da leitura (a atividade "Aparelho do motorista … desconectado pelo
   gestor" não diz qual aparelho, então nenhum aparelho revogado volta a
   valer; os que ainda têm sessão entram pela primeira fonte). Numa
   transação à parte, lê essas duas tabelas e a `activity` (pelo índice
   `("businessId", created_at)`) e grava só a nova: nenhum login nem
   renovação espera por ela. Antes do deploy, se quiser o tamanho,
   `SELECT count(*) FROM refresh_token WHERE device_id IS NOT NULL AND revoked_at IS NULL AND expires_in > now();`.

**O que muda para quem está em campo.** Daqui em diante, CPF e senha só
valem num aparelho em que aquele login já entrou pelo QR Code (o backfill
cobre os aparelhos em uso hoje). Um motorista que entrava por CPF num
aparelho sem sessão viva e sem QR lido recebe `403 AUTH_DEVICE_NOT_TRUSTED`
("Não foi possível entrar com este CPF neste aparelho. Confira o CPF ou peça
ao gestor o QR Code de acesso."): o gestor gera um QR Code na tela de
usuários. O app em produção mostra essa frase da API (é o que ele faz com um
código que não conhece). **A imagem anterior** não conhece a tabela nem a
coluna: durante o rollout (ou depois de um rollback) a réplica antiga aceita
CPF em qualquer aparelho, como antes, e um QR lido nela não confia no
aparelho. **Nada a rodar à mão depois do rollout**: os aparelhos que a
imagem anterior abriu no meio-tempo (por QR Code ou por CPF) se resolvem
sozinhos no login por CPF. Quando nenhum login daquele CPF confia no
aparelho, mas o próprio login tem uma sessão viva presa a ele
(`refresh_token` com aquele `device_id`, sem revogação nem vencimento), a
API passa a confiar no aparelho (`source` `backfill`, linha `info`
`event: auth.device_trust_restored`) e segue o login; a consulta vem antes de
qualquer bcrypt e, sem sessão viva, a recusa continua a mesma. O QR Code
consumido nunca vale para isso: um QR lido antes desta release ainda aponta
para o aparelho mesmo depois de o gestor desconectá-lo. Um aparelho que o
gestor desconectou **numa réplica antiga durante o rollout** perdeu as
sessões, mas não a confiança (a imagem anterior não conhece a tabela), e sem
sessão ele não aparece mais na lista de aparelhos: se a atividade mostrar um "Aparelho do motorista …
desconectado pelo gestor" nesse intervalo, revogue e restaure o acesso
daquele motorista (tira a confiança de todos os aparelhos dele; ele entra de
novo pelo QR Code) ou espere o prazo da confiança (210 dias sem login no
aparelho).

**A troca de senha que mantém a sessão** devolve `token` e `refresh_token`
em `PATCH /user/password` (campos novos, opcionais para quem lê): a web e o
app de antes ignoram e saem na próxima requisição, como sempre saíram.

**A lista de aparelhos do gestor** (`GET /user/:userId/devices`) deixa de
devolver o Android ID: cada aparelho vem por `deviceHash` (SHA-256 do
identificador), e `deviceId` passa a levar esse mesmo hash. O `DELETE
/user/:userId/devices/:deviceId` aceita o hash e ainda o identificador. A web
da release anterior confere o identificador antes de mandar o `DELETE`
(Android ID ou UUID): entre o deploy da API e o da web, o "Revogar este
aparelho" dela recusa o hash na própria tela e o rótulo mostra o fim do hash.
A web desta release lê o hash; a ordem de sempre (API → web) fecha a janela.

**Ordens de serviço sem valores para o motorista (09/11/2026).** O histórico
de um veículo (`GET /service-order/search-service-order-by-vehicle/:vehicleId`),
que a página `/driver/vehicles/:vehicleId/service-orders` da web lê, passa a
mandar ao login de motorista a visão sem valores da onda 3: sem total, sem
preço ou desconto de peça, sem fornecedor. O escritório continua recebendo
tudo. A web desta release não mostra mais valor nem fornecedor e só lê campos
que a API anterior também manda, então pode subir antes da API. **A web da
release anterior**, contra esta API, mostra ao motorista "Valor Total R$ 0,00"
e "Fornecedor: N/A" (não quebra nem mostra NaN; mandar `null` daria o mesmo)
até a web nova estar no ar e a aba recarregar. Nunca mostra o valor real.

- **No staging**, suba a web primeiro e a API depois que a web estiver no ar.
- **Em produção**, o lote vai API → web, porque o gate de rotas da web exige
  a API das ondas 2 a 5 no ar. Promova a web logo depois da convergência da
  API: na janela entre as duas, o motorista que abrir essa página vê o total
  zerado e o fornecedor "N/A".

**Card automático da ordem de serviço sem valor (09/11/2026).** O card que
cada ordem cria no Kanban para o responsável, motorista inclusive, deixou de
trazer a linha "Valor: R$ …". O motorista lê o card inteiro em
`GET /kanban/card/:cardId`, que o app abre pelo aviso, e no WhatsApp de um
card repassado a ele. A prioridade do card continua calculada pelo total da
ordem (Urgente acima de R$ 10.000, Alta acima de R$ 5.000, Média acima de
R$ 2.000). A migration `20261109120000_kanban_service_order_card_without_amount`
tira a linha dos cards já gravados: só essa linha, e só nos cards com título
"Manutenção …" cujo texto ainda começa como a API o escreveu ("Veículo: …" e
logo depois "Valor: …"). O card que o escritório reescreveu fica como está, e
`updated_at` não muda. É um `UPDATE` simples sob `lock_timeout=5s`, que não
trava leitura nem cadastro; só mover ou editar um desses cards espera o fim
dele. A imagem anterior ainda escreve a linha nos cards das ordens criadas
durante o rollout (ou depois de um rollback). O `UPDATE` é idempotente: rode-o
de novo à mão no banco depois que esta release estiver servindo.

**Ponto do endereço sem esperar o job (09/11/2026).** Sem migration, sem
variável nova e sem rota nova. A criação, a edição do endereço e a rota pedem
o ponto logo depois do commit, e a página da rota passa a se atualizar
sozinha (`routeStopsLocated`). Uma recusa do provedor ou um 429 pausa o
geocodificador em vez de marcar as entregas. O detalhe está em
[arquitetura.md (Geocerca e coordenadas do endereço)](./arquitetura.md#geocerca-e-coordenadas-do-endereço).
A ordem entre API, web e app não importa. A web anterior ignora
`address_lookup` e o evento novo. A web nova contra a API anterior mostra
"Sem localização", como hoje. O app não muda: ele relê o dia em qualquer
`routeEvent`, inclusive no `route-stop.located` novo.

- **Durante o rollout**, a réplica com a imagem anterior grava pelas regras
  antigas (todo 404 como `NOT_FOUND`, até 5 tentativas). Isso é inofensivo: a
  imagem nova assume na reserva seguinte.
- **O teto de tentativas sobe de 5 para 8.** As entregas abertas que tinham
  falhado 5 vezes voltam para a fila uma vez, dentro do orçamento do dia.
- **O geocodificador faz no máximo 1 chamada por segundo**, somando réplicas
  e caminhos (a versão anterior fazia uma a cada 600 ms, numa réplica só). A
  outra das 2 por segundo do LocationIQ grátis fica para a geocodificação
  reversa do comprovante, que usa a mesma chave. O job continua com até 20
  entregas por minuto, as paradas abertas de rota primeiro.
- **"Localizando endereço…" tem prazo**: só até 10 min depois de o endereço
  ser gravado ou reservado, e nunca com o provedor recusando a chave, com a
  cota do dia do provedor ou com o orçamento do dia gastos. Fora disso a
  parada diz "Sem localização", como antes.
- **Depois de subir**, procure nos logs da `trajetto-api`
  `geocode-deliveries off` (o motivo vem junto) ou
  `delivery addresses geocoded`. Um `geocoding provider refused the request`
  traz o código HTTP: 401/403 é a chave, 404 é a `REVERSE_GEOCODER_URL`.
- **Com o provedor certo e esta versão servindo, reenfileire uma vez** os
  `NOT_FOUND`, `COARSE` e `FAILED` que a versão anterior gravou, com os lotes
  da mesma seção da arquitetura (`lock_timeout`, 1.000 por lote,
  `SKIP LOCKED`, até `UPDATE 0`, fora do pico). Vale mesmo que a
  configuração estivesse certa: aqueles veredictos vieram da consulta
  anterior (CEP sem hífen, sem a segunda busca), e a nova acha vários deles.

**Período das rotas (09/11/2026).** A lista de rotas
(`GET /route/list-routes`) e o quadro da Torre (`GET /route/monitoring`)
aceitam `period`, `from` e `to`, pelo dia da rota no fuso da empresa. A
regra está em
[arquitetura.md (Rotas esquecidas, a lista e a torre)](./arquitetura.md#rotas-esquecidas-a-lista-e-a-torre).
A migration `20261109150000_route_business_scheduled_date_idx` só cria um
índice (`CREATE INDEX IF NOT EXISTS` sob `lock_timeout=5s`), que a imagem
anterior não lê. Sem variável nova.

- **Ordem: API antes da web**, a de sempre. A API anterior descarta os
  parâmetros que não conhece, sem 400. Diante dela, a web nova esconde o
  filtro, e a lista e o quadro ficam como hoje.
- **A web anterior contra esta API** não manda período e recebe o mesmo de
  antes: todas as datas na lista e o dia no quadro. `searchMeta.period` e
  `data.period` chegam `null`, e ela os ignora.
- **O app não muda.** Ele não lê nenhum dos dois endpoints.
- **Banco com volume:** antes de promover, crie o índice à mão com
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "route_businessId_scheduled_date_idx" ON "route"("businessId", "scheduled_date");`.
  A migration então não faz nada. Com o volume atual não é preciso.

**CPF conferido no cadastro do motorista (10/11/2026).** Sem migration, sem
variável nova e sem rota nova. `POST /driver/create-driver` e
`PATCH /driver/update-driver` passam a recusar, com `400 VALIDATION_ERROR` e
"O CPF informado não é válido.", o CPF cujos dígitos verificadores não
conferem ou que repete um dígito só, a regra que o login já usava. Antes só o
tamanho era conferido. O detalhe está em
[arquitetura.md (Acesso do motorista)](./arquitetura.md#acesso-do-motorista).

- **A ordem não importa.** A web anterior que mandar um CPF inválido recebe o
  400 e mostra a mensagem num toast. A web nova recusa no próprio campo,
  antes de enviar, e contra a API anterior manda os mesmos 11 dígitos de
  sempre. O app não cria nem edita motorista.
- **A edição confere o CPF sempre que ele vem**, e a web manda o formulário
  inteiro. Um motorista gravado com CPF inválido só salva depois de corrigir
  o CPF (decisão do dono), **e isso vale também para inativar**: a
  inativação é essa mesma rota, e o Status fica no mesmo diálogo da web.
  Esse motorista já não conseguia entrar no app pelo CPF, mas ainda entra
  pelo QR Code e pelo e-mail. Para cortar o acesso dele sem mexer no
  cadastro, um administrador usa **Revogar Acesso** na tela Cadastro de
  usuário (`PATCH /user/revoke-access/:userId`): a próxima requisição do app
  recebe `403 AUTH_ACCESS_REVOKED`, e o QR Code ainda não usado e os aparelhos
  confiáveis caem junto (com rota aberta, a recusa é o mesmo
  `409 DRIVER_HAS_OPEN_ROUTES` da inativação). Não invente um CPF só para
  salvar: ele fica gravado como se fosse o da pessoa e pode ser o de outra.
- **Antes de subir**, conte em staging e em produção os motoristas gravados
  com CPF inválido, no psql do Database PostgreSQL do Dokploy (só leitura):
  ```sql
  SELECT "businessId", count(*) AS cpfs_invalidos
  FROM (
    SELECT "businessId",
      CASE
        WHEN cpf !~ '^[0-9]{11}$' THEN false
        WHEN cpf = repeat(left(cpf, 1), 11) THEN false
        ELSE (SELECT (sum(substr(cpf, i, 1)::int * (11 - i)) * 10 % 11) % 10
                FROM generate_series(1, 9) AS i) = substr(cpf, 10, 1)::int
         AND (SELECT (sum(substr(cpf, i, 1)::int * (12 - i)) * 10 % 11) % 10
                FROM generate_series(1, 10) AS i) = substr(cpf, 11, 1)::int
      END AS valido
    FROM driver
  ) d
  WHERE NOT valido
  GROUP BY "businessId"
  ORDER BY cpfs_invalidos DESC;
  ```
  Se aparecer algum em produção, combine a correção com as empresas antes de
  subir: esses motoristas já não entram no app pelo CPF e, depois da subida,
  editar ou inativar o cadastro deles pede o CPF certo.

**Cancelamento de entrega pela API (L9, 10/11/2026).** Rota nova
`POST /integration/v1/deliveries/:id/cancel` e escopo novo
`deliveries:cancel`. A regra está em
[arquitetura.md (Integrações externas)](./arquitetura.md#integrações-externas).
Uma migration, pela mesma etapa da `trajetto-api-migrate` (nada à mão no
deploy), e nenhuma variável nova:
`20261110120000_delivery_event_api_key` cria `delivery_event."apiKeyId"`
(nula, sem default, catálogo apenas), o índice parcial
`delivery_event_apiKeyId_partial_idx` e a chave estrangeira para `api_key`
(`ON DELETE SET NULL`), sob `lock_timeout=5s`. A imagem anterior não
seleciona nem grava a coluna. A chave estrangeira entra `NOT VALID`: toda
linha que já existe tem a coluna nula, então não há o que conferir, e
validá-la leria a tabela inteira segurando `SHARE ROW EXCLUSIVE` (chegada,
comprovante e mudança de status de todas as empresas esperariam; o índice
parcial não ajuda, porque a coluna recém-criada não tem estatística). As
linhas gravadas daqui em diante são conferidas como em qualquer chave
estrangeira. Validar depois é opcional e não muda o que ela garante:
`ALTER TABLE "delivery_event" VALIDATE CONSTRAINT "delivery_event_apiKeyId_fkey";`
lê a tabela sem bloquear escrita (`SHARE UPDATE EXCLUSIVE`).

- **Ordem: API antes da web.** A web nova oferece "Entregas — cancelamento"
  ao emitir uma chave, e a API anterior recusaria esse escopo com 400
  "Escopo desconhecido". Confira a liveness da API com o commit novo antes de
  liberar a web. O app não muda e não precisa de OTA.
- **A web anterior contra esta API** não oferece o escopo novo e mostra os
  escopos de uma chave como texto, então `deliveries:cancel` aparece sem
  quebrar nada. A linha do tempo dela já desenha o ator INTEGRATION.
- **Durante o rollout**, uma réplica anterior responde 404 ao caminho novo.
  Isso não atinge ninguém, porque só a web nova emite chave com o escopo. O
  aviso `delivery.status_overridden` e o webhook `delivery.cancelled` não
  mudam de formato, e os workers anteriores os processam como sempre.
- **As chaves existentes não ganham o escopo.** Quem for cancelar pela API
  cria uma chave nova com "Entregas — cancelamento" marcado (chave não se
  edita) e troca a antiga.
- **Banco com volume:** antes de promover, crie a coluna e o índice à mão,
  nesta ordem:
  `ALTER TABLE "delivery_event" ADD COLUMN IF NOT EXISTS "apiKeyId" TEXT;` e
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS "delivery_event_apiKeyId_partial_idx" ON "delivery_event" ("apiKeyId") WHERE "apiKeyId" IS NOT NULL;`.
  Confira `indisvalid`. A migration então só cria a chave estrangeira, sem
  ler a tabela. Com o volume atual não é preciso.

**Busca de endereço do "Fixar no mapa" (10/11/2026).** Rota nova
`GET /address-search/:businessId`, sem migration. A regra está em
[arquitetura.md (Busca de endereço)](./arquitetura.md#busca-de-endereço-fixar-no-mapa).

- **Ordem: API antes da web, na staging e na produção.** A web nova chama
  `relayUrl("/address-search/…")`, e o `scripts/check-api-routes.mjs` da web
  recusa a promoção enquanto a API do ambiente não serve a rota (o contrato
  `tests/unitaires/contract/client-routes.test.ts` diz o mesmo). Confira a
  liveness da API com o commit novo antes de liberar a web. O app não muda e
  não precisa de OTA.
- **Variáveis, no _Environment_ da Application `trajetto-api`** (staging
  primeiro, depois produção): `ADDRESS_SEARCH_URL=https://api.locationiq.com/v1`
  e `ADDRESS_SEARCH_PROTOCOL=locationiq-autocomplete`. A chave é a mesma
  `REVERSE_GEOCODER_KEY`, a menos que se defina `ADDRESS_SEARCH_KEY`.
  `ADDRESS_SEARCH_DAILY_BUDGET` (1000) e `ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT`
  (150) só se quiser outros valores. Antes, em my.locationiq.com, confira que
  o token libera o Autocomplete. Sem as variáveis, a rota responde
  `503 ADDRESS_SEARCH_UNAVAILABLE`, a web mostra a busca indisponível e o
  clique no mapa continua fixando. Nada quebra antes de configurar.
- **A web anterior contra esta API** não chama a rota. **A web nova contra a
  API anterior** (se a ordem falhar) recebe 404 pelo relay e trata como busca
  indisponível. O clique no mapa, o pino de rascunho e o "Confirmar local"
  funcionam por inteiro, porque o `PATCH /route/set-delivery-location` não
  mudou.
- **Rolling deploy.** A vaga por segundo continua na chave
  `geocoding:deliveries:rate:{segundo}`, então réplicas antigas e novas contam
  juntas. O registro dos últimos 60 s (`geocoding:provider:minute`, um
  _sorted set_) só é contado pelas réplicas novas. Durante o rollout, o job de
  uma réplica antiga não entra nele.
- **Depois de subir**, nos logs da API: uma linha `address search` por busca
  (`component: "address-search"`, com `outcome`, `status`, `ms` e `cached`,
  nunca o texto). `address search provider refused the request` (`error`)
  quer dizer chave ou URL errada: a busca pausa sozinha por 15 min e a
  localização das entregas continua.
  `address search provider rejected the text; nothing paused` (`warn`) é um
  400 do provedor para um texto: só aquela busca falhou; em série, confira se
  o provedor mudou os parâmetros do `/autocomplete`. `UNAVAILABLE_PAUSED` em
  série é a cota do dia do provedor.
  `DAILY_LIMIT_PLATFORM` com frequência é a hora de trocar de plano
  ([infraestrutura.md §14.3](./infraestrutura.md#143-servidor-e-dokploy)).
- **O cache fica cifrado** com uma chave derivada da `JWT_SECRET`. Para a
  busca, uma troca da `JWT_SECRET` só esvazia o cache: as respostas antigas
  não abrem e contam como cache vazio. Nada a fazer.

**nodemailer 10.3.1 e o e-mail do destinatário das importações e do
painel (10/11/2026).** Sem variável nova e sem rota nova. A imagem da API muda
(nodemailer 6.9.16 → 10.3.1, sem `@types/nodemailer`) e há uma migration,
pela mesma etapa da `trajetto-api-migrate` (nada à mão no deploy):
`20261110130000_customer_message_suppression_email_entries`. A regra está em
[arquitetura.md (Integrações externas)](./arquitetura.md#integrações-externas)
e em [arquitetura.md (Arquivos)](./arquitetura.md#arquivos).

- **API antes da web**, na staging e na produção. O cadastro e a edição da
  entrega pelo painel passam a aceitar a lista de e-mails que a importação
  grava (até 5, separados por `;` ou `,`, gravada com `;`), e a web desta
  release passa a mandá-la do formulário. Contra a API anterior, um cadastro
  ou uma edição com lista volta 400 "O e-mail do destinatário não é
  válido." (sem gravar nada); com um endereço só, tudo segue como antes. A
  web anterior manda um endereço só, que esta API aceita, e já mostra o
  `message` de uma linha importada (é o mesmo campo das notas de rota). O
  app não muda. A integração continua com um endereço só: o contrato público
  não mudou.
- **A migration** só insere linhas em `customer_message_suppression`: para
  cada descadastro de e-mail com `;` ou `,` (gravado pela primeira versão da
  D38 com o campo inteiro), uma linha por endereço, aparado e em minúsculas,
  com a data e a entrega do descadastro. Sem ela, quem se descadastrou de
  "a; b" voltaria a receber na próxima NF-e, que grava "a;b". É um `INSERT`
  sob `lock_timeout=5s`, numa tabela pequena, que não trava leitura nem
  descadastro. As linhas do campo inteiro ficam: a imagem anterior ainda as
  procura.
- **Rolling deploy.** Réplicas antigas e novas mandam o mesmo `Message-ID` e
  o mesmo `Resend-Idempotency-Key`, os dois tirados do id da notificação: a
  Resend continua deduplicando com réplicas misturadas. Durante o rollout (ou
  depois de um rollback), a réplica antiga ainda grava o e-mail da NF-e e da
  planilha sem conferência (a nova relê o valor na hora do envio e só escreve
  para os endereços válidos) e grava o descadastro só com o campo inteiro. O
  `INSERT` da migration é idempotente: rode-o de novo à mão no banco depois
  que esta release estiver servindo, para os descadastros desse intervalo.
- **Antes de promover, meça** em produção, no psql do Database PostgreSQL do
  Dokploy (só leitura), as entregas em aberto cujo e-mail tem lista ou nome:
  ```sql
  SELECT "businessId",
         count(*) FILTER (WHERE recipient_email LIKE '%<%') AS com_nome,
         count(*) FILTER (WHERE recipient_email ~ '[;,]') AS com_lista
  FROM delivery
  WHERE status IN ('PENDING', 'IN_TRANSIT', 'FAILED')
    AND recipient_email ~ '[<;,]'
  GROUP BY "businessId"
  ORDER BY count(*) DESC;
  ```
  As listas separadas por `;` ou `,` continuam recebendo, só nos endereços
  válidos. O formato "Nome <a@b.com>", que o nodemailer 6 entregava, não
  passa pela regra do cadastro: depois da subida, essas entregas deixam de
  mandar o aviso por e-mail, e o único rastro é o motivo `invalid_address` no
  log `debug` "notification channels suppressed" (ou a mensagem `FAILED`
  "no valid e-mail address", se já estava na fila). Se `com_nome` não for
  desprezível, combine com as empresas a correção do e-mail na edição da
  entrega antes de subir.
- **Depois de subir no staging**, antes de promover, faça o teste de e-mail
  real pela Resend:
  1. Dispare um "esqueci minha senha" e confira no painel da Resend que
     chegou. Só a chegada: o e-mail transacional não tem linha de
     notificação, e o `Message-ID` dele é um UUID novo a cada envio.
  2. Dispare um aviso ao cliente por e-mail (uma entrega com e-mail e o
     "saiu para entrega" ligado). No painel da Resend, confira que chegou e
     que o `Message-ID` é o determinístico,
     `<id-da-notificação@domínio-do-remetente>` (o `id` da linha de
     `notification_delivery`), e que o webhook de entrega casou com essa
     notificação (uma linha em `notification_provider_receipt`).
  3. Nos logs da `trajetto-api`, `e-mail send failed` com `code: "ETLS"` é
     o STARTTLS recusado (o envio para, sem mandar a chave); `code: "EAUTH"`
     com "Missing credentials" é a `RESEND_SECRET_KEY` vazia, e `EAUTH` com
     a resposta 535 é a chave errada. Nenhum deles é reprocessado. O
     `ENOAUTH` não aparece com este transporte (fica na lista por defesa).

**zod 4.6.7 e fastify-type-provider-zod 7.0.0 (10/11/2026).** Sem
migration, sem variável nova e sem rota nova. A imagem da API muda (zod
3.25.1 → 4.6.7, o type provider 4.0.2 → 7.0.0 e sai o `zod-to-json-schema`).
Fecha o alerta alto GHSA-mrhx-c7xc-m3w5: um pedido autenticado de ~7 MB no
`POST /delivery/import-xml` estourava o heap de 768 MB e derrubava a réplica.
A regra está em
[arquitetura.md (Regras transversais)](./arquitetura.md#regras-transversais).

- **A ordem não importa em produção:** a API sobe sozinha, a web e o app não
  dependem dela para isto. O corpo da recusa é o mesmo,
  `{ code: "VALIDATION_ERROR", message, issues: string[] }`, com as mesmas
  frases em pt-BR. Réplicas antigas e novas convivem no rollout.
- **No push para a `staging`, em três passos**, porque os dois CIs se leem:
  o `Validate` da API faz checkout da `staging` da web e o
  `public-docs-guide-samples` compara o `/integration/docs/openapi.json` ao
  vivo com `trajetto-ui/tests/unitaires/fixtures/public-openapi.json`
  (`toEqual`); e o CI da web roda contra a `staging` da API o
  `occurrence-form-rules` (cópia linha a linha de
  `src/modules/occurrence-type/form/occurrence-form-rules.ts`, agora na
  sintaxe do zod 4), que só passa com a API já em zod 4 e a web também, e o
  `recipient-email-api-parity`, que só passa com a API que já aceita a lista
  de e-mails do painel (deste mesmo lote, em zod 3 ou em zod 4). Com a API
  antes, o `Validate` dela fica vermelho (o documento novo tem 8 `pattern`
  que a cópia da `staging` da web não tem) e não há deploy; com a web em zod
  4 antes, o CI da web fica vermelho.
  1. **Web, só a cópia do documento:** um commit com o `public-openapi.json`
     regenerado (que leva também a rota de cancelamento do L9, que mudou o
     mesmo arquivo), sozinho no topo do push, sem a migração da web para o
     zod 4. O CI da web lê a cópia para montar o portal, mas não a compara
     com a API: passa.
  2. **API em zod 4:** o `Validate` encontra na `staging` da web a cópia
     igual ao documento ao vivo.
  3. **Web e app em zod 4** (o resto dos commits): os testes de paridade
     encontram a `staging` da API em zod 4.

  Com o CI novo no mesmo lote, o CI da web e o do app também ficam
  vermelhos contra a `staging` anterior da API por outros testes (o
  `dokploy-deploy.test.ts` e o `shared-deploy-section.test.ts`), e o da API
  contra a `staging` anterior do app: vale a ordem da
  [seção 26, "O CI dos três"](#o-ci-dos-três-desde-10112026) ("Ordem do
  primeiro push com o CI novo"), em que estes três passos cabem.

- **O que a API passa a recusar** (nenhum cliente nosso manda isso hoje):
  - um id que não é UUID da RFC 9562 (versão 1 a 8, variante 8/9/a/b; nil e
    max seguem aceitos). Os ids do Trajetto são v7 e v4, e o app e a web
    geram v4;
  - um número infinito (`1e999` numa query) — antes virava `Infinity`;
  - listas acima do teto, todas novas e acima do uso real: permissões em
    lote (uma por recurso), reordenação do Kanban (500 colunas, 10.000
    cards), escopos de uma chave de API (6) e tópicos de um webhook (o
    catálogo inteiro, cada um uma vez);
  - um texto curto com emoji: o zod 4 mede um texto em caracteres (code
    points), e o zod 3 em unidades UTF-16, em que um emoji conta 2. O
    `.min()` fica mais estrito e o `.max()` mais folgado, só para emoji e
    outros caracteres fora do BMP; para as colunas `VARCHAR`, que também
    contam caracteres, é neutro. O login e a senha atual da troca de senha
    mantêm o piso em unidades (`storedPasswordField`): uma senha como
    `abc😀😀`, criada antes, continua entrando.
- **O que muda de texto:** um valor fora do enum, num campo que tem frase
  própria, sai com ela (antes, a genérica "tem um valor não aceito"). Um
  número infinito sai como tipo errado (a frase de tipo do campo ou "deve ser
  um número finito"; na API pública, "esperado número finito, recebido
  Infinity."), e não mais pela faixa do campo.
- **O que fica igual de propósito, com código para isso:**
  - no `POST /integration/v1/deliveries`, um tipo errado e um campo faltando
    saem com as frases publicadas ("shipper_id: esperado texto, recebido
    número.", "kind: esperado 'DELIVERY' | 'SERVICE_ORDER', recebido
    número.", "campo obrigatório."). O zod 4 dá a vez à frase própria do
    campo, e o parse refaz a frase a partir do valor enviado. Conferido com
    um probe de 373 corpos rodado no zod 3 e no zod 4: só mudam o UUID
    estrito, o infinito e a lista de 201 itens, que vira uma recusa só;
  - uma lista mandada no lugar de um texto (ou um texto no lugar de uma
    lista) sai só com a frase do tipo: o zod 4 ainda mede o tamanho de
    qualquer valor que tenha `length`, e o `issues` ganhava "deve ter no
    mínimo 2 caracteres" junto; o handler corta o que vem depois de um tipo
    errado no mesmo campo, como o zod 3 parava;
  - a chave recusada de um `z.record` (`form_answers`) sai em pt-BR, no
    caminho da chave, e não como o "Invalid key in record" do zod 4;
  - a edição de permissão (`PATCH /permission/update-permission/:permissionId`)
    sem `canWrite` continua mantendo a escrita gravada: o `default(false)`,
    que o zod 3 nunca aplicava (o `.optional()` de fora respondia antes), saiu,
    porque o zod 4 passaria a aplicá-lo e revogaria a escrita.
- **O que muda de comportamento, de propósito:** a edição do card do Kanban
  (`PATCH /kanban/card/update/:cardId`) sem `completed` deixa o card como
  está (o zod 3 gravava `false`; a web atual manda o campo sempre). A URL do
  webhook é gravada sem espaço nas pontas. Mais de 50 respostas no
  `form_answers` de uma ocorrência, ou mais de 20 cabeçalhos num webhook,
  viram uma recusa só, contada antes de ler cada entrada (já eram recusados,
  mas com uma frase por entrada inválida: um motorista mandava 1 MiB de
  entradas recusadas, 110 mil issues e 175 MB de heap por pedido).
- **A resposta de sucesso continua analisada pelo schema** (default
  preenchido, campo desconhecido fora): o serializer do type provider 7
  codifica em vez de analisar e daria 500 em resposta com default; a API usa
  o seu (`src/shared/http/response-serializer.ts`).
- **Diff do OpenAPI**, gerado antes e depois, campo a campo:
  - `/integration/docs/openapi.json` (o público): **8 diferenças**, todas um
    `pattern` novo que descreve o que a API já validava — o UUID do `{id}`
    em `GET /integration/v1/deliveries/{id}`, `GET /integration/v1/routes/{id}`
    e `POST /integration/v1/deliveries/{id}/cancel`, o `shipper_id` e o
    `recipient_email` do corpo de `POST /integration/v1/deliveries` e o
    `updated_since` (data-hora ISO com `Z`) das três listas. O resto é
    idêntico, inclusive `limit` (padrão 50) e as datas `string (date-time)`.
    A cópia do portal (`trajetto-ui/tests/unitaires/fixtures/public-openapi.json`)
    foi regenerada, e o portal renderiza o documento novo.
  - `/docs/json` (o interno): **1.650 diferenças**, todas de forma, nenhuma de
    significado: `pattern` em UUID, data e e-mail (520); o intervalo do
    inteiro seguro (±9007199254740991) em cada `.int()` (412 máximos e 394
    mínimos, quase todos em respostas); `additionalProperties: false` saiu de
    133 corpos de requisição que nunca recusaram campo desconhecido (a API o
    descarta; os `.strict()` seguem com `false`); 123 listas `required` de
    resposta passam a nomear o campo com default (`message`, `success`), que o
    serializer preenche; os corpos de abastecimento e checklist viraram um
    objeto só, com os mesmos campos e os mesmos obrigatórios (antes `allOf`);
    7 recusas mostram o `default` do `message` da rota no lugar da descrição
    genérica, como outras 16 já mostravam; o mínimo de `amount` (contas) e de
    `maintenance_interval_km_at_service` (OS) agora é o real (`≥ 1` e
    `≥ 0,1`; antes `> 1` e `> 0`); união com `null` vira `nullable: true`;
    duas uniões discriminadas saem como `oneOf`; as contagens por status da
    lista de rotas listam os cinco status como obrigatórios; a tupla `bbox`
    da busca de endereço sai como `items` com `anyOf` (o 3.0 não tem tupla);
    `includeUnscheduled` sai só como booleano (na query string, `true` e
    `false` são o mesmo texto); `canWrite` perde o `default: false` que nunca
    valia, `supplierId` ganha o `default: null` que a API já aplicava, e 6
    listas ganham `maxItems`.
- **Antes de promover**, no staging: abra o portal `/docs` da web de staging
  com a API nova e o `/docs` interno da API; mande um cadastro inválido pelo
  painel e pelo app e confira a frase em pt-BR.

**@fastify/static 10.1.8 e @fastify/swagger-ui 6.1.3 (10/11/2026).** Sem
migration, sem variável nova e sem rota nova. A imagem da API muda
(`@fastify/static` 8.3.0 → 10.1.8 e `@fastify/swagger-ui` 5.2.2 → 6.1.3, com
o `swagger-ui-dist` 5.34). Fecha os quatro alertas do `@fastify/static` que o
`yarn audit` mostrava (o alto GHSA-83w8-p2f5-377r e os moderados
GHSA-8pvw-jcv7-9cmj, GHSA-x428-ghpx-8j92 e GHSA-pr96-94w5-mx2h) e os dois que
só o repositório do pacote publica (o alto GHSA-423g-23ch-w7c6 e o moderado
GHSA-r799-r9gc-m956). Nenhum é alcançável: em produção ele só serve os
arquivos públicos da tela do `/docs`, sem trava nossa na frente e sem
listagem de pasta. A regra está em
[arquitetura.md (Integrações externas)](./arquitetura.md#integrações-externas).

- **A ordem não importa:** só a API muda, e réplicas antigas e novas convivem
  no rollout. O `/tmp/*` só existe fora de produção.
- **Ficam dois moderados**, que vêm pelo `@fastify/static` 10.1.8:
  GHSA-3g3m-2fjr-6pw4 (`glob` 13) e GHSA-g3hv-75wg-m249 (`minimatch` 10).
  Também não são alcançáveis: o static só chama o `glob` com
  `wildcard: false`, que nenhum dos dois registros usa. Saem com o
  `@fastify/static` 10.1.10 (`glob` 14), que cumpre a carência de 7 dias em
  11/11/2026 às 17:11 UTC. A carência vale também para cada pacote novo que
  a troca traz ao `yarn.lock`, e o `yarn install` pega o mais novo de cada
  intervalo: no registro de 10/11, o `glob` 14.0.4 (06/11), o `minimatch`
  11.0.7 (10/11 às 23:03 UTC) e o `@isaacs/nonrecursive-glob-match` 1.1.0
  (05/11). Na troca:
  1. Troque o `10.1.8` do `package.json` por `10.1.10` e apague do
     `yarn.lock` a entrada `"@fastify/static@10.1.8", "@fastify/static@^10.1.0"`
     antes do `yarn install`: sem isso, o `^10.1.0` do swagger-ui fica na
     10.1.8, numa cópia aninhada, e o `dependency-security-floor` falha.
  2. Depois do `yarn install`, confira com `npm view <pacote> time` cada
     versão nova no `git diff yarn.lock`. A que ainda não tem 7 dias é
     reescrita à mão com a mais nova do intervalo que já tem, como a do
     `@fastify/static` de hoje: `version`, `resolved` e `integrity` saem de
     `npm view <pacote>@<versão> dist`, e as dependências dela entram na
     mesma conferência. De 11/11 em diante, servem o `glob` 14.0.3 (28/10),
     o `minimatch` 11.0.4 (02/11, pelo `^11.0.2` do glob 14.0.3) e o
     `@isaacs/nonrecursive-glob-match` 1.0.3 (28/10), já com as correções
     (`glob` 14.0.2 e `minimatch` 11.0.1); o `path-scurry` 3.0.0 (27/10)
     entra como o yarn resolver.
  3. `yarn install --frozen-lockfile` passa, um `yarn install` sem a flag
     não muda o `yarn.lock` e o `yarn audit --groups dependencies` não
     mostra mais o `glob` nem o `minimatch`.
- **Antes de promover**, no staging: abra o `/docs` com o `DOCS_USER` e o
  `DOCS_PASSWORD` e confira que a tela carrega com o CSS, o logo na barra do
  topo e a lista de rotas, sem erro de CSP no console do navegador.

**Regras entre motorista, veículo e rota (10/11/2026).** Sem migration, sem
variável nova e sem rota nova. A regra está em
[arquitetura.md (Motorista, veículo e rota: o que é aviso e o que é recusa)](./arquitetura.md#motorista-veículo-e-rota-o-que-é-aviso-e-o-que-é-recusa).

- **A ordem não importa**; pelo padrão, API e depois a web. A web anterior
  mostra no toast a recusa nova da liberação e a mensagem do desbloqueio. A
  web nova contra a API anterior pede a confirmação pela
  `GET /route/assignment-preview`, que já existe, e o desbloqueio na rua
  continua recusado. O app não muda e não precisa de OTA:
  `409 ROUTE_VEHICLE_BUSY` e `400 ROUTE_VEHICLE_UNAVAILABLE` só mudam de
  texto, e o reenvio da saída responde como antes.
- **O que a operação nota:** liberar uma rota com o veículo bloqueado ou
  inativo passa a ser recusado no escritório (`400 ROUTE_VEHICLE_UNAVAILABLE`,
  com a placa), e não só no pátio. A planilha deixa de criar rota para o
  motorista inativo (as entregas entram, com nota por linha) e cria a rota
  sem veículo quando o veículo está bloqueado ou inativo. Desbloquear um
  veículo com a rota na rua, antes `409 VEHICLE_IN_ACTIVE_ROUTE`, responde 200
  e grava "Em rota". Na web, liberar a rota de hoje com o caminhão ou o
  motorista em outra rota em andamento pede "Liberar mesmo assim".
- **Durante o rollout**, a réplica anterior ainda cria a rota da planilha para
  o motorista inativo e recusa o desbloqueio na rua. O estorno feito por ela
  de uma planilha que esta versão importou mantém a rota e as entregas
  roteadas (ela conta a linha nova "Adicionada à Rota N" como trabalho do
  motorista). Para um estorno que importa, espere o rollout terminar.
- **Fica para a release do índice `route_active_driver_idx`** (uma rota em
  andamento por motorista, no banco). Antes dela, rode no staging e na
  produção, no psql do Database PostgreSQL do Dokploy (só leitura):
  ```sql
  SELECT "driverId", count(*) FROM route WHERE status = 'IN_PROGRESS' GROUP BY 1 HAVING count(*) > 1;
  ```
  Se aparecer alguma linha, encerre com pendências ou cancele as rotas
  sobrando desse motorista; senão a migration falha e não sobe.

**O ponto de outra entrega na mesma porta (14/11/2026).** Sem variável nova
e sem rota nova. A regra está em
[arquitetura.md (Geocerca e coordenadas do endereço)](./arquitetura.md#geocerca-e-coordenadas-do-endereço).
A migration `20261114120000_delivery_address_key` é só de expansão: a coluna
`delivery.address_key` (TEXT, nula, sem default, só no catálogo) e o índice
parcial `delivery_address_key_idx`, sob `lock_timeout=5s`. O índice é criado
sem `CONCURRENTLY` e lê a tabela inteira uma vez sob o lock `SHARE` (as
escritas em `delivery` esperam): numa base com volume, construa-o antes à
mão, pelo roteiro no comentário da migration, e ela não faz nada.

A migration `20261114130000_delivery_geo_copied_from` vem junto e também é
só de expansão: a coluna `delivery.geo_copied_from` (TEXT, nula, sem default,
só no catálogo, sem chave estrangeira) e o índice parcial
`delivery_geo_copied_from_idx`, sob `lock_timeout=5s`. Ele também é criado
sem `CONCURRENTLY` e lê a tabela inteira uma vez sob o lock `SHARE`: são dois
índices desse tipo em `delivery` neste deploy, e numa base com volume os dois
seguem o mesmo roteiro do comentário de cada migration.

- **A ordem é a de sempre: API, depois a web.** A imagem anterior não lê nem
  grava as duas colunas. Durante o rollout, a entrega criada por uma réplica
  anterior fica sem chave e não empresta nem recebe ponto até o backfill, e
  a que ela edita fica com a chave do endereço antigo até o backfill, que
  recalcula a chave de todas. O pino ou a edição feitos por uma réplica
  anterior não apagam `geo_copied_from`; isso não move nada errado, porque o
  acompanhamento só muda a cópia `GEOCODER` que ainda tem exatamente o ponto
  anterior da origem, e o backfill apaga a raiz de toda chave que corrige. A
  web e o app não mudam: o ponto copiado chega como `GEOCODER` ("Pelo
  endereço"), que os dois já mostram e que a geocerca do app já lê como
  exato no número ou na rua. Sem OTA.
- **O que a operação nota:** a entrega criada sem ponto num endereço que a
  empresa já localizou (pino, coordenada na criação ou o geocodificador no
  número ou na rua) já nasce com o ponto, mesmo com o geocodificador
  desligado, e não gasta consulta do LocationIQ. Editar o endereço para uma
  porta já localizada faz o mesmo. Nunca entre empresas, e nunca num
  endereço sem número (`s/n`, `0` ou vazio): sem número o endereço nomeia
  uma rua, não uma porta, e a entrega é consultada e fixada sozinha, como
  antes.
- **O pino vale para a porta toda.** O "Fixar no mapa" de uma entrega dá o
  mesmo ponto às outras entregas abertas da empresa no mesmo endereço ainda
  sem ponto (`propagated` na resposta; a web nova diz no toast quantas, a
  anterior ignora o campo). Sem versão de plano nova para elas: a página da
  rota relê pelo `routeStopsLocated`, e o app relê o dia pelo
  `route-stop.located`, que todo build já trata.
- **Corrigir o pino corrige as cópias.** Se o despachante mudar o pino da
  entrega de origem, as cópias abertas dela que ainda estão no mesmo
  endereço e com o ponto antigo mudam junto, e `propagated` conta também
  essas. Apagar o pino (`{ clear: true }`, só pela API) apaga o ponto delas
  e elas voltam para a localização automática. Uma cópia fixada à mão
  depois, uma com o endereço mudado e uma encerrada ficam como estão. Para
  testar no staging: fixe uma entrega, crie outra no mesmo endereço (ela
  nasce com o ponto), mude o pino da primeira e veja a segunda mudar junto.
- **As entregas de antes** ficam com a chave nula até o backfill único. Depois
  que a API com esta migration estiver no ar, primeiro no staging e depois na
  produção, fora do pico, abra o terminal do contêiner da Application
  `trajetto-api` no Dokploy e rode `node build/backfill-delivery-address-key.js`
  (no desenvolvimento, `yarn deliveries:address-key`). Ele lê todas as
  entregas em lotes de 1.000, cada um com `lock_timeout = '5s'`, grava a
  chave onde ela falta ou está velha e dá uma vez o ponto de cada porta às
  entregas abertas dela ainda sem ponto, cada porta numa transação com o
  mesmo `lock_timeout`. A última linha diz quantas chaves e
  quantas entregas. Se um lote estourar o `lock_timeout`, é só rodar de
  novo: ele é idempotente e termina o resto.
- **Rollback para antes desta imagem: rode o backfill de novo** quando a
  imagem nova voltar a servir. A imagem anterior edita o endereço sem mexer
  na chave: a entrega editada fica com a chave do endereço antigo e o ponto
  do novo, e a próxima criada no endereço antigo copiaria esse ponto (a
  parada e a geocerca na porta errada). O backfill recalcula a chave de toda
  entrega e corrige as que mudaram; a que ele não corrigir porque foi
  editada no meio do lote fica para a próxima rodada.

**Contract pendente (release seguinte): o 2FA sem corpo.** `PATCH
/user/twofactor` sem corpo ainda inverte o estado, sem senha, só para a web
da release anterior que roda durante o rollout. Cada uso deixa a linha `warn`
`event: auth.twofactor_legacy_toggle` ("Deprecated contract: two-factor
toggled without a body"). Quando a web que manda `{ enabled, password }`
estiver em produção e a linha ficar **14 dias** sem aparecer em todas as
réplicas: tire o ramo sem corpo do controller e do use case
(`update-two-factor-authentication`), passe o `body` da rota de
`config.openapi` para `schema.body`, e apague os testes do modo antigo
(`user-self-service-usecases.test.ts` e `driver-account-security-http.test.ts`).

**Depois de cada release de produção**, atualize `LAST_MIGRATION_IN_PRODUCTION`
em `tests/unitaires/lifecycle/migration-safety.test.ts` para a última
migration que a release levou.

### Banco de dev que aplicou as versões antigas

`prisma migrate deploy` (e o `yarn dev`) aceita; `prisma migrate dev` recusa as
duas migrations editadas ("was modified after it was applied"). Saídas:
resetar o banco de dev (`yarn prisma:migrate:reset`, perdendo os dados locais)
ou atualizar o checksum registrado, calculado na mesma máquina:

```sh
sha256sum prisma/migrations/20260815120000_remove_whatsapp_instance_state/migration.sql \
          prisma/migrations/20260815200000_add_ai_analysis_pipeline/migration.sql
```

```sql
UPDATE "_prisma_migrations" SET checksum = '<sha256 do arquivo>'
 WHERE migration_name = '20260815120000_remove_whatsapp_instance_state';
UPDATE "_prisma_migrations" SET checksum = '<sha256 do arquivo>'
 WHERE migration_name = '20260815200000_add_ai_analysis_pipeline';
```

## 16. Promover para produção

### O que conferir no staging antes do PR para `main`

1. `/health/readiness` 200 e as duas réplicas de pé
   (`docker service ls | grep trajetto-api-staging` → `2/2`).
2. `robots.txt` da web de staging com `Disallow: /` (`APP_ENV=staging` na web).
3. **WebSocket atrás do Traefik**: um socket aberto por mais de 3 minutos sem
   reconexão:
   ```sh
   LOAD_SOCKET_URL=https://api-staging.intrajetto.com LOAD_SOCKET_TOKEN=<token de um gestor> \
     HOLD_MINUTES=5 node tests/load/socket-hold.mjs
   ```
4. Um e-mail e um WhatsApp de teste chegam ao destino de teste, e a nenhum
   cliente real.
5. _Sistema → Provedores_ sem `error` inesperado (Resend, Meta, R2,
   trajetto-ai, heartbeat).

### A promoção

1. Abra o PR `staging → main`; espere os checks (_Secret scan_ e _Staging
   evidence_).
2. Merge com **Create a merge commit**.
3. O run do push em `main` (_Production_) começa pelo _Staging evidence_,
   sem aprovação: resolve o commit (o head do PR), exige o marcador
   `staged-<7>` das duas imagens no mesmo digest (o staging rodou este
   build; espera até 20 min se o deploy de staging dele ainda estiver em
   andamento, em vez de falhar pedindo um _re-run_), ou usa o build do commit
   mais próximo que o staging rodou, se o merge só muda documentação desde
   ele (abaixo), confere o `Gate` desse build, compara com o staging e lê os
   digests a promover. Se algo disso falhar, ninguém chega a ser chamado para
   aprovar.
4. _Actions_ → o run → job _Deploy_ → _Review deployments_ → aprovar o
   environment `production`. A ação de deploy roda as migrations se a
   produção ainda não aplicou a imagem de migração do build (Application
   `trajetto-api-migrate`; [seção 15](#15-migrations)), move `stable` e pede
   o deploy de cada Application de produção (IA → API; a IA só se o digest
   dela mudou), e espera a convergência. Verde = o Swarm roda o digest
   promovido em todas as réplicas da API. Os digests ficam no resumo do run.
5. Depois, o job _Release_ cria a versão.

Conferir à mão:

```sh
docker service ps trajetto-api-production --filter desired-state=running --format '{{.Image}} {{.CurrentState}}'
docker service inspect trajetto-api-production --format '{{.UpdateStatus.State}}'   # completed
```

**Ordem entre API e web**: API primeiro, web depois. A promoção da web confere
se a API de produção serve todas as rotas que a web chama
(`trajetto-ui/docs/deploy.md`).

### Commits só de documentação

Um commit que só muda documentação — um arquivo `*.md` em qualquer pasta, ou
qualquer coisa em `docs/` — não muda nenhuma imagem (o `.dockerignore` deixa
os dois de fora, em qualquer profundidade: `**/*.md`; a IA copia só arquivos
nomeados). Por isso, desde 30/10/2026, ele vai para a produção com o
build do commit mais próximo que o staging rodou, e **`[skip ci]` só para
documentação passou a ser seguro**: o check do PR `staging → main` e a
promoção aceitam o build do commit anterior (com os dois cuidados do próprio
GitHub listados no fim desta seção).

Desde 10/11/2026 a marcação quase não economiza mais: um push só de
documentação (o `Changes` decide, pela mesma regra) roda só o _Secret scan_
e o `Docs` — os unitários sem cobertura, porque há testes que leem a
documentação, mais o Prettier; uns 12 min cobrados — e nenhum build nem
deploy. Ela continua permitida só em commit de documentação (decisão D11), e
nunca na ponta de um PR para `main`. Um push de documentação não cancela a
validação do push de código embaixo dele, que segue até o deploy.

Quando a cabeça do PR (ou o commit mergeado, na promoção) só muda
documentação desde o build promovido, o _Staging evidence_ confere também o
`Gate` do run da própria cabeça: o `Docs` dela é a validação daquela
documentação. Sem isso, um guia que quebrasse os testes de documentação
chegaria à `main` sem nada que bloqueasse (o PR antigo, que validava tudo
de novo, barrava).

O que é documentação está num lugar só, `.github/scripts/docs-only.sh`, e é
a mesma regra da web (`docs-only.mjs`) e do app. A regra de promoção, a
mesma no check do PR e na promoção (`.github/scripts/staged-build.sh`,
testada em `staged-build.test.ts`):

1. O commit tem o marcador `staged-<7>` no digest de `sha-<7>`: promove o
   build dele (o caminho normal).
2. Não tem: percorre os ancestrais pelo primeiro pai (até 50), do mais
   próximo para trás. O primeiro que tem o marcador é o build promovido,
   desde que o `git diff` entre ele e o commit só toque documentação. A
   busca para no primeiro ancestral cujo diff já inclui outro arquivo, e o
   check (ou a promoção) falha listando esses arquivos: qualquer outro
   arquivo exige a execução do staging.
3. O resumo do run diz qual build foi promovido e por quê, e o
   `wait-for-version.mjs` espera o commit desse build na liveness.

O doc com `[skip ci]` pode subir a qualquer hora, inclusive enquanto o
pipeline do commit de código anterior ainda roda (uns 25 min). O
`Deploy` daquele run vê na `staging` uma cabeça mais nova, mas, como
ela só acrescenta documentação ao commit dele (`docs-only.sh`), implanta e
grava o `staged-<7>` mesmo assim. Antes, ele saía verde sem implantar, o
commit de documentação não tinha run, e a promoção travava até o próximo
push. Se a cabeça mais nova muda qualquer outro arquivo, o run mais velho
continua saindo sem mexer no staging, e o run da cabeça faz o deploy.

Dois cuidados do próprio GitHub, que nenhuma regra daqui contorna:

- **A ponta do PR `staging → main` com `[skip ci]`**: o GitHub também não
  roda os workflows de `pull_request` quando o commit da ponta do PR tem
  `[skip ci]` na mensagem, e os dois checks exigidos em `main`
  ([seção 13](#13-configurar-o-github), "Proteção das branches") ficam
  pendentes. Para destravar, um commit vazio sem a marcação
  (`git commit --allow-empty`) na `staging`: o `pr.yml` roda de novo no PR,
  e o `staging.yml` o classifica como documentação (só o `Docs`, sem build).
- **O título do PR**: num PR de um commit só, o GitHub preenche o título com
  a mensagem desse commit, e o título vai para o corpo do merge commit. Com
  `[skip ci]` ali, o push em `main` não roda o `production.yml` e nada é
  promovido. Tire o `[skip ci]` do título antes do merge.

Cuidado: a regra vale só para `*.md` e `docs/`. Um commit que mexe num
teste, num workflow, num script ou no `.dockerignore` precisa do pipeline
de staging, mesmo que pareça inofensivo. Os testes que leem a documentação
(`tests/unitaires/docs`, os guias de agente) rodam no `Docs` do próprio push
(com a marcação de pular CI, só no próximo push que roda): se eles falharem,
a correção é no doc.

## 17. Rollback

Um build anterior a 31/10/2026 (`main-<sha>` e os `sha-<7>` de antes da
imagem de migração) volta a migrar no boot se a `trajetto-api` não tiver
`RUN_MIGRATIONS_ON_BOOT=false` no _Environment_: ele lê a variável com
padrão `true` ([seção 15](#15-migrations)). Confira antes de voltar para um
deles.

### Caminho normal: promover o build bom

1. Achar a tag boa: o resumo de uma promoção anterior registra o
   `sha-<7>` promovido e os digests (_Staging evidence_) e
   `trajetto-api:stable → sha256:...` (_Deploy_); ou o job _Build_ do push
   em `staging` que gerou o build.
2. _Actions_ → _Production_ → _Run workflow_ (branch `main`) →
   `image_tag = sha-<7>` (builds antigos: `main-<sha>`). O campo é
   obrigatório.
3. Aprovar o environment `production`.
4. O job move `stable` de volta para aquele build e pede o deploy das
   Applications. O run só fica verde depois do passo _Wait for the rollout to
   converge_ (ou com o aviso, se `ROLLOUT_VERIFY=off`). O rollback não exige
   o marcador `staged-<7>` (builds antigos não o têm, e alguém aprova a tag
   digitada).

### Emergência: voltar agora, sem esperar o pipeline

`docker service rollback` **não serve** mais: a spec anterior tem a mesma
tag, e o host já tem a imagem nova com essa tag. Use o digest bom
diretamente, no host:

```sh
docker service update --with-registry-auth \
  --image ghcr.io/trajetto-organization/trajetto-api@sha256:<digest bom> \
  trajetto-api-production
```

O digest bom está no resumo da promoção anterior. Ou, pelo painel: na
Application `trajetto-api` de produção, troque _Docker Image_ para
`ghcr.io/trajetto-organization/trajetto-api:sha-<7 bom>`, **Save** e
**Deploy**. Os dois são desfeitos ou travados depois: o próximo deploy do
Dokploy reaplica a imagem configurada. Feita a emergência, rode o caminho
normal com a tag boa e, se mexeu no painel, **volte o _Docker Image_ para
`:stable`** — senão as próximas promoções não chegam à produção.

### O banco não volta junto

As migrations de uma versão ficam aplicadas quando a imagem volta. Uma imagem
anterior só é segura sobre o schema novo se a versão nova seguiu
expandir/contrair ([`arquitetura.md`](./arquitetura.md#migrations-expandir-e-contrair)).
O promote de uma imagem anterior roda a etapa de release com a imagem de
migração dela quando o digest difere de `stable-applied`: as migrations dela
já estão no banco (não há o que aplicar), e os seeds dela rodam de novo,
idempotentes. Um build anterior à imagem de migração pula a etapa
([seção 15](#15-migrations)).

### A trilha numa volta para antes da onda 7

Da onda 7 do plano de escala em diante (F2-10), as posições vão para a
trilha enxuta `driver_position_v2`, e a tela da trilha lê as duas tabelas.
Uma imagem de antes dela só conhece a `driver_position`: voltar o código
para ela tira da tela da trilha todo ponto gravado pela imagem nova. O mapa
da torre não sente (a última posição é a mesma tabela nas duas), e os pontos
não se perdem: ficam na v2, que a imagem velha não lê nem apaga.

1. Depois de a volta convergir, traga os pontos de volta com
   `prisma/backfills/driver-position-v2-to-legacy.sql`, no `psql` do
   Database com o usuário dono (o arquivo copiado para o host, ou colado no
   `psql`), repetindo até a resposta ser `INSERT 0 0`. Cada rodada copia até
   100 mil pontos, numa transação própria:

   ```sh
   docker exec -i $(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-production) \
     psql -U trajetto -d trajetto -v ON_ERROR_STOP=1 < ./driver-position-v2-to-legacy.sql
   ```

   Um ponto que já está na legada (o mesmo motorista no mesmo instante,
   gravado pela imagem velha durante o rolling) fica como está, e um dia que
   a legada já não tem partição fica de fora. Nada sai da v2: a imagem da
   onda 7, de volta, lê as duas e conta o ponto uma vez. Um
   `INSERT … SELECT` direto não serve: o `id` da legada é `TEXT NOT NULL`
   sem padrão no banco, os ids são `uuid` de um lado e texto do outro, e um
   dia sem partição na legada derruba o comando inteiro
   (`tests/E2E/driver-position-rollback.test.ts` roda o arquivo).

2. Na volta para a frente (a imagem da onda 7 de novo), os pontos que a
   imagem velha gravou já estão na legada, que a tela lê. Mas a imagem velha
   não conhece a v2 e não cria as partições dela: depois de uma volta mais
   longa que `DRIVER_POSITION_PARTITION_LOOKAHEAD_DAYS` (7 dias), a v2 não
   tem a partição de hoje, e nenhuma migration a cria. O job
   `partition-maintenance` está sem sucesso há mais de 26 h, então a
   varredura de recuperação dos crons o roda 1 minuto depois do boot
   (`partitions.driver_position_v2` no `/health/metrics`). Até lá, todo
   POST de posições responde 5xx (o app guarda os pontos e reenvia; nada se
   perde) e o mapa da torre para, porque a trilha e a última posição são
   gravadas na mesma transação. Para não ter esse minuto, faça essa volta
   para a frente fora do horário das rotas.

3. A retirada da legada (F2-12) conta a retenção a partir da volta para a
   frente: durante a volta, a legada recebeu pontos de novo.

### As linhas de status da entrega (onda 7)

O F2-06 (plano de escala) faz toda mudança de status deixar a sua linha no
histórico da entrega: a criação ("Entrega criada", de nada para Pendente) e
o que a rota move sozinha (a saída, a parada incluída em rota em andamento,
a volta à base de uma rota cancelada ou encerrada com pendências, a saída em
lote antiga do app), uma linha `SYSTEM` por entrega. A imagem desta release
já sabe ler essas linhas; a de antes da onda 7, que ainda atende durante o
rolling e é o destino de uma volta do código, lê errado:

- o desfazer da importação conta a linha da criação como trabalho e não
  remove nenhuma entrega da planilha;
- o `/integration/v1/events` chama a criação de `delivery.pending`, um
  tópico fora do catálogo, e o integrador passa o cursor por cima dela;
- a torre conta a linha `SYSTEM` da saída como mudança feita por alguém e
  não consegue mais aprovar a ocorrência pedida antes dela;
- o feed da torre mostra uma linha por entrega a cada saída, e os fatos da
  rua saem do limite da tela.

Por isso a escrita só começa com `DELIVERY_STATUS_TRAIL_ENABLED=true` no
_Environment_ da `trajetto-api`, desligada por padrão: a release leva os
leitores, e o dono liga a escrita quando não sobra imagem velha, como a
regra do enum novo, que só é gravado na release seguinte. Desligada, a
entrega muda de status e a saída manda o `delivery.in_transit` como
sempre, só sem essas linhas.

1. Na staging, ligue depois de a release da onda 7 convergir; é o que faz
   aparecer a linha do tempo nova ("Entrega criada", "Saiu para entrega
   (Rota N)").
2. Na produção, ligue só depois de a release estar no ar e de nenhuma volta
   para antes dela estar prevista.
3. Antes de voltar o código para antes da onda 7, desligue (**Save** e
   **Deploy**) para parar as linhas novas. As que já foram gravadas ficam, e
   a imagem velha as lê como na lista acima: desfaça à mão a importação feita
   enquanto ela estava ligada, e avise o integrador que um
   `delivery.pending` sem `status_from` é a criação.

### O feed de eventos pela ordem de commit (onda 10)

O F2-05 (plano de escala) faz o `/integration/v1/events` andar pela ordem
de commit (`delivery_event.txid`, até a transação mais antiga ainda aberta)
e devolver o cursor `v2`, com a época do cluster: um evento que confirma
tarde não fica mais para trás do cursor de quem já passou. A imagem de
antes do plano de escala só lê o cursor antigo (o id do evento). Com um
`v2` na mão, ela responde páginas vazias, e o integrador para de receber
eventos sem erro: durante o rolling, ou para sempre depois de uma volta do
código para ela.

Por isso a ordem nova só vale com `INTEGRATION_FEED_ORDER=commit` no
_Environment_ da `trajetto-api`, `id` por padrão (o caminho de sempre, com
o cursor antigo). As respostas já trazem os campos novos nos dois modos:
`resume_cursor` no `/events` e `sync_watermark` no `/deliveries` e no
`/routes`.

1. Na staging, ligue depois de a release da onda 10 convergir (nenhuma
   task da imagem anterior em `docker service ps`), **Save** e **Deploy**.
   Confira uma página do `/integration/v1/events` com uma chave de teste:
   o `next_cursor` e o `resume_cursor` começam com `v2.`.
2. Na produção, ligue do mesmo jeito, só depois de a release estar no ar e
   de nenhuma volta para antes dela estar prevista. Desde a virada, **o
   piso de rollback do código é esta release**: a imagem anterior não lê
   os cursores que os integradores guardaram.
3. Para voltar o modo, `INTEGRATION_FEED_ORDER=id`: o cursor `v2` continua
   aceito e é lido pelo id do evento, como no F2-04. Um cursor antigo que
   chega com o modo `commit` é convertido (o contador
   `feed.legacy_conversions` da `ops_sample`), sem pular nada.

Um cursor `v2` de outra época (um PITR, um promote, um restore lógico) é
convertido pelo piso dele, e os eventos desde então vão de novo: o alerta
[feed-epoch-conversion](./runbooks/feed-epoch-conversion.md) avisa para
falar com os clientes, até 7 dias depois de a época mudar. Um cursor com
uma época que a história do cluster não sustenta (o cursor não é assinado)
é convertido igual, conta em `feed.stray_epoch_conversions` e não alerta. Um INSERT em `delivery_event` mais de 240 s depois
do início da transação é recusado (`TJ001`,
[runbook](./runbooks/delivery-event-writer-bound.md)): é o que mantém o
piso do feed seguro.

**O feed no standby** (onda 17, F4-43) só existe com a ordem de commit e
um standby na `DATABASE_REPLICA_URL`: `INTEGRATION_EVENTS_READ_REPLICA=true`
no _Environment_ da `trajetto-api` manda as páginas ao standby enquanto o
replica-guard o abona, com o horizonte do próprio standby, e ao primário no
resto do tempo. `false` por padrão; até o standby do prod-db-2 (onda 23),
só no ensaio de failover da staging, para medir. Voltar é `false` e
**Deploy**: os cursores são os mesmos nos dois servidores.

### Contrações que esperam a capability (onda 10)

O plano de escala sai num push só, e a imagem que ainda serve durante o
rolling, e que volta num rollback, é a de antes do plano. Por isso as
contrações da onda 10 não vão em migration: cada uma é um passo de
`prisma/post-deploy` que pergunta antes a `trajetto_capability_ready`
([README da pasta](../prisma/post-deploy/README.md)) e fica `pending`
enquanto houver um processo sem a capability, ou uma sessão sem nome no
banco (a imagem de antes do plano). Num banco sem empresa a migration do
mesmo item já fez a mudança.

| Passo                                | Item   | O que tira                                                                                                                                                                                                                                                                                                                                                                              | Capability                           |
| ------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `03-route-stop-status-index.sql`     | F2-21b | o índice global `route_stop (status, deliveryId)`                                                                                                                                                                                                                                                                                                                                       | `route-stop-open-by-route-v1`        |
| `05-queue-contract.sql`              | F5-06  | as chaves estrangeiras e os uniques das quatro filas (`domain_outbox_event`, `notification_delivery`, `notification_provider_receipt`, `webhook_delivery`), depois de copiar para `outbox_event_key` a chave de todo evento que não tem a sua; espera também não haver evento ainda não publicado (PENDING, PROCESSING ou FAILED) com entrega gravada pela imagem anterior com outro id | `queue-partition-agnostic-v1`        |
| `07-notification-contract.sql`       | F5-15  | as chaves estrangeiras do sino (`notification`) para `user` e `business` e o unique de `deliveryId`; espera também não haver entrega IN_APP em voo com notificação gravada pela imagem anterior com outro id                                                                                                                                                                            | `notification-partition-agnostic-v1` |
| `10-queue-partition-swap.sql`        | F5-09  | as quatro filas comuns: cada uma vira particionada por dia pelo id, com a tabela de hoje anexada como `<fila>_legacy` ([ADR 0014](./adr/0014-filas-particionadas.md)); espera também o `05-queue-contract.sql`                                                                                                                                                                          | `queue-partition-agnostic-v1`        |
| `20-notification-partition-swap.sql` | F5-15  | o sino comum: vira particionado por mês pelo id, com a tabela de hoje anexada como `notification_legacy`; espera também o `07-notification-contract.sql`                                                                                                                                                                                                                                | `notification-partition-agnostic-v1` |

1. No primeiro deploy desta release a etapa roda com a imagem anterior no
   ar e os passos ficam `pending` (o `/health/rollout` mostra em
   `release.pending`). Depois de o rolling convergir, o deploy seguinte
   roda a etapa de novo sozinho; para não esperar, _Run workflow_ com
   `force_release`.
2. Confira no log da `trajetto-api-migrate` o `applied:` de cada passo.
3. **Desde o `applied`, o piso de rollback do código é esta release**:
   a imagem anterior não aguenta o que o passo tirou. Para segurar a
   contração mais tempo (manter a volta possível), deixe
   `POST_DEPLOY_STEPS=off` na `trajetto-api-migrate` até decidir; tire
   depois.

A troca das filas (`10-queue-partition-swap.sql`) tem estes cuidados a mais:

- **A trava.** Cada fila fica sob `ACCESS EXCLUSIVE` só por instantes: para
  pôr a guarda `CHECK ("id" < corte) NOT VALID` e, depois, para a troca, que
  só mexe no catálogo. A leitura da tabela inteira (o `VALIDATE` da guarda)
  fica entre as duas, sob `SHARE UPDATE EXCLUSIVE`, com as escritas
  seguindo. O `NOTICE` do passo diz, por fila trocada, a espera, a trava e
  a validação (`tempos: …`). Meça na staging antes da produção, num
  Database descartável com o seed `prod-like`, rodando os passos à mão como
  diz o
  [ADR 0014](./adr/0014-filas-particionadas.md#medir-a-trava-antes-da-produção)
  (o _Run workflow_ rodaria no Database da staging, não no descartável). O
  aceite é espera mais trava abaixo de 3 s em cada fila.
- **A guarda que ficou.** Se o passo terminar `pending` com
  `a restrição <fila>_swap_cutoff ficou em …` (o lock para tirá-la não
  veio), ou se a etapa morrer no meio da troca (o passo fica `failed`), a
  guarda fica na tabela comum, e a fila recusa toda gravação a partir do
  corte dela (a meia-noite UTC de depois de amanhã, para as filas; o
  primeiro dia de um mês, para o sino; a mensagem e o
  `pg_get_constraintdef` mostram o id). Antes dele, rode a etapa de novo
  (_Run workflow_ com `force_release`), que tira a guarda ou termina a
  troca; ou tire à mão, no `psql` do Database:

  ```sql
  ALTER TABLE "<fila>" DROP CONSTRAINT "<fila>_swap_cutoff";
  ```

- **Fila grande demais.** Com mais de 2 M linhas estimadas a fila (ou o
  sino, F5-15, que na escala alvo passa disso) fica comum e o passo diz
  `skipped: … exige uma janela própria`. Numa janela com os workers parados
  (`WORKERS_ENABLED=false` na `trajetto-api`), rode o arquivo à mão no
  Database, depois de `SET trajetto.swap_window = 'on'` na mesma sessão do
  `psql`, com o expurgo em dia; ou deixe a tabela comum: o código serve os
  dois jeitos.
- **Os planos.** Com as filas trocadas, as reivindicações planejam um mês
  de partições. Meça na staging o p95 do planejamento delas (o
  `pg_stat_statements`, `mean_plan_time`, com `pg_stat_statements.track_planning`)
  e, acima de 2 ms, ligue `QUEUE_CLAIM_ID_FLOOR_ENABLED=true` no
  _Environment_ da `trajetto-api` (o plano B do F5-13, que poda os dias sem
  linha em voo); desligar volta às reivindicações de sempre.
- **A volta.** `prisma/post-deploy/rollback/unpartition-queue.sql`, à mão,
  copia toda linha de volta para uma tabela comum e marca a fila para a
  troca não voltar sozinha (o passo a passo no ADR 0014).

### A janela do histórico (onda 11)

`delivery_event` (F2-17) e `activity` (F2-18) viram particionadas por mês
pelo id numa janela de madrugada aprovada por você, não num deploy
qualquer: os passos `30-delivery-event-window.sql` e
`31-activity-window.sql` de `prisma/post-deploy` só rodam dentro do
intervalo `HISTORY_WINDOW_APPROVED` da `trajetto-api-migrate` (decisões D39
e D68). Fora dele terminam `skipped: aguardando janela`, e um hotfix
promovido depois desta release nunca dispara a janela sem aviso. Dentro
dele, esperam (`pending`) todo processo vivo anunciar
`history-partition-agnostic-v1`.

| Passo                          | Item  | O que faz                                                                                                                                                                                                                                                    | Capability                      |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `30-delivery-event-window.sql` | F2-17 | copia `delivery_event` para a casca `delivery_event_part` com o `txid` como está, recupera as chaves de envio que só estavam na coluna e troca os nomes; a tabela de antes vira `delivery_event_legacy`                                                      | `history-partition-agnostic-v1` |
| `31-activity-window.sql`       | F2-18 | copia `activity` para a casca `activity_part`, dando a todo id de antes do uuid v7 um v7 do próprio `created_at` (o mesmo em toda rodada, `trajetto_activity_rekey`); a tabela de antes vira `activity_legacy`, e por 14 dias o id antigo se resolve por ela | `history-partition-agnostic-v1` |

O passo a passo (ensaio na staging com o seed `prod-like`, o aviso de 48 h,
a janela, a conferência e a volta nos 14 dias) está no
[runbook da janela do histórico](./runbooks/history-window.md). O ensaio
roda os dois passos à mão, no `psql`, num Database descartável: ali não há
processo nenhum para anunciar a capability, então o anúncio e a aprovação
são feitos na sessão (sem eles, os passos ficam `pending` para sempre), e
o _Run workflow_ rodaria no Database da staging, não no descartável. Valor
inválido ou intervalo de mais de 24 h não aprova nada (o log da etapa diz
por quê). Apague a variável depois da janela.

### O trem de releases do plano de escala (as datas das contrações)

O plano de escala sai inteiro numa release só (decisão do dono de
16/11/2026: um push, API → web → app, e uma promoção para a produção),
com a imagem anterior servindo durante o rolling. Por isso nada que tira
alguma coisa vai junto com o que a expande: cada contração espera a sua
condição, e a ordem abaixo é a do trem. A release é **N**; as datas de
exemplo supõem N na produção em 30/11/2026 e a janela do histórico em
06/12/2026 (troque pelas suas e anote na tabela quando cada uma rodar).

| Passo                                                                                                                                                                                               | O que sai                                                                                                                              | Quando, no mais cedo                                                                               | Exemplo    | Como                                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contrações com capability (onda 10): `03-route-stop-status-index.sql`, `05-queue-contract.sql`, `07-notification-contract.sql`, `10-queue-partition-swap.sql`, `20-notification-partition-swap.sql` | o índice global das paradas, as FKs e uniques das filas e do sino, a troca das filas e do sino por tabelas particionadas               | no deploy seguinte ao rolling de N convergir (todo processo vivo anuncia a capability)             | 30/11/2026 | sozinhas, pela etapa de release; para não esperar, _Run workflow_ com `force_release` ([acima](#contrações-que-esperam-a-capability-onda-10))                                                     |
| Janela do histórico: `30-delivery-event-window.sql` e `31-activity-window.sql` (F2-17, F2-18)                                                                                                       | `delivery_event` e `activity` comuns viram particionadas; as de antes ficam como `*_legacy`                                            | o primeiro domingo, 03:00 BRT, depois de N na produção e do ensaio na staging, com o aviso de 48 h | 06/12/2026 | `HISTORY_WINDOW_APPROVED` na `trajetto-api-migrate` e a etapa sem trocar de build: **Deploy** nela, ou `force_release` com a `image_tag` que está no ar ([runbook](./runbooks/history-window.md)) |
| U-03                                                                                                                                                                                                | as posições na sala de operações (fica só `positions:<businessId>`)                                                                    | ≥ 1 semana com a web X-32 na produção                                                              | 07/12/2026 | push próprio da onda 20                                                                                                                                                                           |
| F2-20                                                                                                                                                                                               | `delivery_event_legacy`, `activity_legacy`, a consulta do id antigo (`trajetto_activity_rekey`) e as entradas datadas do gate de drift | ≥ 14 dias depois da janela                                                                         | 20/12/2026 | push próprio da onda 20; o `DO` da migration recusa antes disso                                                                                                                                   |
| F2-23                                                                                                                                                                                               | os índices sem uso                                                                                                                     | ≥ 30 dias de `pg_stat_statements` na produção                                                      | 30/12/2026 | push próprio da onda 20, pelo relatório de uso                                                                                                                                                    |
| F2-36                                                                                                                                                                                               | a dupla escrita do orçamento no Redis                                                                                                  | uma release depois do F2-32 na produção                                                            | N+1        | push próprio da onda 20                                                                                                                                                                           |
| U-10                                                                                                                                                                                                | os caminhos de compatibilidade vencidos e o `warn` do orçamento de memória                                                             | 2 releases depois de N, com os valores da seção 3 do plano aplicados nos dois environments         | N+2        | push próprio da onda 20                                                                                                                                                                           |
| F2-12                                                                                                                                                                                               | a `driver_position` legada                                                                                                             | ≥ `DRIVER_POSITION_RETENTION_DAYS` (90) depois do F2-10 na produção                                | 28/02/2027 | push próprio da onda 20                                                                                                                                                                           |
| U-09                                                                                                                                                                                                | o dump do Dokploy, trocado pelo pgBackRest                                                                                             | quando o dono decidir, com o PITR conferido                                                        | —          | o texto, a documentação e o teste já prontos                                                                                                                                                      |

Regras do trem:

- **Uma contração nunca vai na mesma release da expansão de que ela
  depende.** As da onda 20 ficam fora da branch `staging` até a data delas
  chegar, cada uma num push.
- **Depois que uma contração roda, o piso de rollback do código é a
  release dela**: a imagem anterior não aguenta o que ela tirou
  ([Rollback](#17-rollback)).
- A janela do histórico é a única que pede aprovação por intervalo: um
  hotfix promovido depois de N nunca a dispara sem aviso.
- Antes de cada contração datada, confira a data nesta tabela e anote a do
  dia em que rodou.

### Quando o Swarm desiste de um serviço

Nenhuma Application tem limite de tentativas (`MaxAttempts: 0`). Se uma
réplica ainda assim ficar parada, **Deploy** da Application no painel (ou
`docker service update --force <App Name>`) recria as tasks.

## 18. Backup e restauração

Decisão do dono (26/10/2026, final): **o único backup do banco é o Backup do
próprio Database PostgreSQL no Dokploy**, gravado no Cloudflare R2. O antigo
serviço `trajetto-backup` (imagem própria, `pg_dump` cifrado com age, heartbeat
de 1 dia) saiu do código e do pipeline; nada no repositório agenda backup.

|                   |                                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quando**        | uma cópia por dia, às 03:00 UTC (antes do primeiro job que apaga dados, 03:17 UTC)                                                                             |
| **Retenção**      | as 30 cópias diárias mais recentes, ou seja, 30 dias; não há cópias semanais nem mensais                                                                       |
| **RPO**           | até 24 h                                                                                                                                                       |
| **RTO**           | medido no ensaio de 15/09/2026: 10,5 s de restore para 94 MB (cresce com o volume; a parte lenta é recriar índices)                                            |
| **Cifra**         | as cópias **não** são cifradas por nós; o R2 cifra tudo em repouso (do lado do provedor)                                                                       |
| **PITR**          | não vem deste dump: é o pgBackRest da imagem `trajetto-postgres`, na staging desde a onda 3 e na produção desde a onda 6 ([seção 27](#27-pitr-com-pgbackrest)) |
| **Arquivos (R2)** | fora do dump ("O que o dump não cobre", abaixo)                                                                                                                |

### O backup agendado (Dokploy → Database → Backups)

**1. O destino no R2** (uma vez por bucket):

1. Cloudflare → **R2**: um bucket **só de backup** (diferente do bucket de
   fotos), `trajetto-backups`. Em _R2 → Manage API tokens_, um token com
   _Object Read & Write_ **só nesse bucket**; anote o _Access Key ID_, o
   _Secret Access Key_ e o _Account ID_ da conta.
2. Dokploy → **Settings → S3 Destinations** → **Add**:

   | Campo             | Valor                                                             |
   | ----------------- | ----------------------------------------------------------------- |
   | Name              | `r2-trajetto-backups` (o de staging foi criado como `r2-backups`) |
   | Provider          | **Cloudflare**                                                    |
   | Access Key Id     | o _Access Key ID_ do token R2 do bucket de backup                 |
   | Secret Access Key | o _Secret Access Key_ do mesmo token                              |
   | Bucket            | `trajetto-backups`                                                |
   | Region            | `auto`                                                            |
   | Endpoint          | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`                   |

   **Test** (o Dokploy confere o acesso) e **Create**. O token fica só aqui:
   não vai em Environment nenhum.

**2. O backup do Database** (em cada environment): Dokploy → projeto
`trajetto-api` → o Database PostgreSQL (`trajetto-postgres`) → aba
**Backups** → **Create Backup**:

| Campo       | Staging                                                      | Produção                                                      |
| ----------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Destination | o S3 Destination do R2 (`r2-trajetto-backups`)               | o S3 Destination do R2 (de preferência o de produção, abaixo) |
| Database    | `trajetto`                                                   | `trajetto`                                                    |
| Schedule    | `0 3 * * *` (todo dia às 03:00; o relógio do servidor é UTC) | `0 3 * * *`                                                   |
| Prefix      | `trajetto-staging/`                                          | `trajetto-production/`                                        |
| Keep Latest | 30                                                           | 30                                                            |
| Enabled     | ligado                                                       | ligado                                                        |

**Create** e, na linha do backup, rode um **backup manual** (o botão de
executar agora): o arquivo aparece no bucket, sob o prefixo do ambiente.

O que o Dokploy faz a cada execução: roda o `pg_dump` do banco `trajetto`,
comprime e envia o arquivo ao R2 sob o prefixo; depois apaga, naquele prefixo,
as cópias além das 30 mais recentes. Como a agenda é diária, 30 cópias = 30
dias de histórico. O dump leva a base inteira (inclusive a trilha de posição).

**Recomendação** (não obrigatória): produção num bucket próprio,
`trajetto-backups-prod`, com token e S3 Destination próprios
(`r2-trajetto-backups-prod`), para que um token de staging nunca alcance as
cópias de produção; opcionalmente com **R2 Bucket Lock** no prefixo
`trajetto-production/` (os tokens do R2 não têm escopo "só escrita": o lock é
o que impede quem vaza o token de apagar as cópias). Use um prazo de lock de
até 29 dias, para a limpeza do Dokploy não esbarrar no lock ao apagar a cópia
de 30 dias atrás. Staging pode ficar em `trajetto-backups`, com o prefixo
`trajetto-staging/`.

**Alerta**: não há heartbeat de backup. Em Dokploy → **Settings →
Notifications**, cadastre um canal (Telegram, Slack, Discord ou e-mail) com o
evento de **backup de Database** marcado: o Dokploy avisa quando um backup
falha. Um backup que simplesmente deixou de rodar não avisa: confira de tempos
em tempos a data da cópia mais nova no bucket.

### Restaurar a partir do R2

**Caminho principal: o restore do Dokploy.** Database PostgreSQL → aba
**Backups** → **Restore**: escolha o destino (o S3 Destination), a cópia e o
banco `trajetto`. O Dokploy baixa a cópia do R2 e a restaura no Database.

Num incidente real (banco perdido):

1. Se o Database se perdeu, crie outro ([seção 7.4](#74-postgresql-database))
   com o mesmo usuário, senha e nome de banco. Se o Database novo tiver
   outro App Name (o App Name é o host da URL), ajuste a `DATABASE_URL` da
   API **e** a da `trajetto-api-migrate` do ambiente.
   **Não** ligue `ALLOW_EMPTY_DATABASE_BOOTSTRAP` (nem na API nem na
   `trajetto-api-migrate`): com ela a etapa de release prepararia e semearia
   um banco novo, por cima do qual o dump não restaura.
2. Pare a API: _Advanced → Cluster Settings → Replicas_ `0` → **Save** →
   **Deploy** (ou `docker service scale trajetto-api-production=0`, que dura
   até o próximo deploy). Desligue o backup agendado (_Enabled_) enquanto
   restaura.
3. Restaure pela aba _Backups_ (acima) ou pelo caminho manual (abaixo).
   Num Database **novo** (o passo 1, ou outro servidor), confira o txid do
   feed da integração antes de seguir: o dump traz os txids do cluster
   antigo, e o novo conta do zero. A consulta, a época e o `pg_resetwal -e`
   com o Database parado estão no runbook
   [feed-txid-regressed](./runbooks/feed-txid-regressed.md) (plano de
   escala, F2-03); o ensaio do `restore-postgres.sh` faz o mesmo sozinho.
4. **Sempre**, antes de subir o runtime: rode a etapa de release no banco
   restaurado. **Deploy** na Application `trajetto-api-migrate` do ambiente
   (ou GitHub → Actions → staging/production → _Run workflow_ com
   `force_release`, na produção com a `image_tag` que está no ar) e espere
   a tarefa ficar `Running` (aba _Logs_: "etapa de release concluída").
5. Volte as réplicas da API para `2` (**Save** → **Deploy**) e religue o
   backup.

Por que o passo 4 é sempre: um banco restaurado traz `_prisma_migrations`
e passa pela guarda de banco vazio, mas um restore com `--no-owner` perde
os donos e os grants que o `infra/sql` mantém (e, num cluster novo ou
depois de um PITR, a época do cluster tem de subir), e só a etapa os
devolve. Se o dump é mais velho que o build
no ar, a API ainda recusa subir até as migrations que faltam rodarem. Não
conte com o pipeline para isso: a tag `<ambiente>-applied` diz que a imagem
de migração já rodou **no banco de antes**, e a `release_step_state` veio
do dump, então o próximo run pularia a etapa
([seção 15](#15-migrations)).

**Caminho manual** (baixar a cópia e restaurar à mão):

1. Baixe o arquivo do bucket (painel do R2, ou `rclone copy` com um token de
   leitura do bucket).
2. O Dokploy grava a cópia comprimida com gzip (`.sql.gz`): `gunzip` primeiro.
   O formato interno depende da versão do Dokploy; descubra lendo o índice:
   ```bash
   docker run --rm -i postgres:16-alpine pg_restore --list < ./<arquivo>.sql | head
   ```
   - Lê o índice: é um dump **custom** (`pg_dump -Fc`). Ensaie com
     `infra/scripts/restore-postgres.sh` (abaixo) e restaure com
     `pg_restore` dentro do contêiner do banco:
     ```bash
     docker exec -i $(docker ps -q -f name=trajetto-postgres-production | head -n 1) \
       pg_restore -U trajetto -d trajetto \
       --no-owner --no-privileges --exit-on-error < ./<arquivo>.sql
     ```
   - "input file appears to be a text format dump": é **SQL puro**; restaure
     com `psql`:
     ```bash
     docker exec -i $(docker ps -q -f name=trajetto-postgres-production | head -n 1) \
       psql -U trajetto -d trajetto -v ON_ERROR_STOP=1 < ./<arquivo>.sql
     ```

### Backup à mão (antes de uma operação arriscada)

```bash
POSTGRES_USERNAME=trajetto POSTGRES_DATABASE=trajetto \
POSTGRES_SERVICE=trajetto-postgres-production \
  ./infra/scripts/backup-postgres.sh ./backups
```

Independente do backup do Dokploy, para um dump na hora, antes de uma
migration delicada ou de mexer no Database. O `pg_dump` roda dentro do
contêiner do banco (o script acha a task do Database pelo `POSTGRES_SERVICE`,
o App Name; `POSTGRES_CONTAINER` escolhe um contêiner direto), para a versão do
cliente bater com a do servidor. Escreve `.dump.partial` (formato custom) e só
vira `.dump` depois do tamanho mínimo e do `pg_restore --list`; ao lado sai o
`.sha256`. O arquivo só vira backup quando sai da máquina. Um backup manual
pela aba _Backups_ do Dokploy também serve, e já fica no R2.

### Ensaiar a restauração

```bash
POSTGRES_IMAGE=postgres:16-alpine@sha256:<o digest do Database> \
  ./infra/scripts/restore-postgres.sh ./backups/<arquivo>.dump
```

Só para dumps no formato **custom** (`pg_dump -Fc`): os do
`backup-postgres.sh` e uma cópia do Dokploy descomprimida, se ela for custom
(veja acima). Sobe um Postgres descartável na porta 55432 com a **mesma imagem
da produção** (`POSTGRES_IMAGE`; a do campo de imagem do Database), restaura
com `--exit-on-error`, confere o `.sha256` se existir e roda `prisma migrate
status` contra o banco restaurado — a verificação que importa ("Database
schema is up to date!"; um dump mais velho que o código falha com "Dump
anterior ao código: há migrations pendentes"). Depois confere o txid do
feed da integração (plano de escala, F2-03): o cluster do ensaio é novo e
conta do zero, então, quando os txids do dump estão à frente dele, o
script para o Postgres, roda o `pg_resetwal -e` com a época certa e
confere de novo, como o runbook
[feed-txid-regressed](./runbooks/feed-txid-regressed.md) manda fazer num
Database novo. O contêiner e o volume de dados (`<contêiner>-data`) são
removidos ao final (`KEEP_CONTAINER=true` preserva).

Ensaios feitos: 14/09/2026 (72 migrations do zero, 49 tabelas, 2 s, os cinco
índices de SQL cru e o `pg_trgm` sobreviveram) e 15/09/2026 com volume (banco
de carga de 94 MB: dump de 4,3 MB em 1,5 s, restore em 10,5 s, a API subiu, as
telas de torre, entregas e dashboard responderam e o smoke do k6 passou 12/12,
inclusive escrita na tabela particionada). Falta o ensaio mensal com uma cópia
real do Dokploy (restore pela aba _Backups_ num Database descartável).

### O que o dump não cobre

- **Bucket R2** (fotos de checklist e de entrega, assinaturas, anexos,
  avatares): o banco guarda só as chaves. Fotos de entrega e assinaturas são
  prova documental. O R2 não tem versioning pela API S3: o equivalente é o
  **Bucket Lock** em `deliveryProofs/` (90 dias; `infra/r2/bucket-locks.md`)
  e a **cópia semanal dos comprovantes** (`deliveryProofs/` e
  `deliveryPhotos/`) para um bucket noutra conta Cloudflare, com um token
  que a API não tem: `rclone copy`, nunca `sync`, com Expiration de 90 dias
  no destino, para o que a LGPD manda apagar sair também da cópia
  (`infra/r2/offsite-copy.md`).
- **Segredos**: as cópias vivas são o _Environment_ de cada Application no
  Dokploy e o seu gerenciador de senhas. Perder `JWT_SECRET_REFRESH_TOKEN`
  desloga todo mundo. Perder `WEBHOOK_SECRETS_KEY` **não é recuperável**: os
  segredos dos webhooks dos clientes estão cifrados com ela no dump (a saída é
  uma chave nova e cada cliente gerar novo segredo). Guarde-a longe dos
  backups.
- **Redis**: não precisa ser restaurado.

### Trilha de posição e o backup lógico

A trilha de GPS é a maior tabela em escala (~2.400 pontos por motorista num
dia de 10 h), particionada por dia e guardada por
`DRIVER_POSITION_RETENTION_DAYS` (90 dias). Desde a onda 7 (plano de escala,
F2-10) as posições vão para a trilha enxuta `driver_position_v2` (uns 204
bytes por linha, contra uns 565 da legada): sem id, sem `created_at`, com a
chave primária `(driverId, recorded_at)` e os ids como `uuid`. A legada
`driver_position` fica, só lida, até passar a retenção e uma release
seguinte a apagar (F2-12); a tela da trilha lê as duas e conta uma vez o
ponto que estiver nas duas. Numa volta do código para antes da onda 7, os
pontos da v2 voltam para a legada pelo passo de
[A trilha numa volta para antes da onda 7](#a-trilha-numa-volta-para-antes-da-onda-7).
O backup do Dokploy leva sempre
a base inteira, trilha inclusive: quando o dump passar a levar tempo demais
(e a segurar um snapshot que impede o autovacuum das filas), a decisão volta
para cá. O `backup-postgres.sh` (manual) tem dois controles só dele, passados
na linha de comando (não são variáveis de Application):

| Variável                    | Efeito                                                                        |
| --------------------------- | ----------------------------------------------------------------------------- |
| `BACKUP_EXCLUDE_TRAIL=true` | mantém o schema das duas trilhas e deixa as linhas de fora                    |
| `BACKUP_TRAIL_ONLY=true`    | dump **só** das duas trilhas, num arquivo `<banco>-trail-<data>.dump` à parte |

Restaurar um dump só da trilha:
`pg_restore -d <banco> --data-only --no-owner --no-privileges --exit-on-error <banco>-trail-<data>.dump`
(partições de dias antigos precisam ser criadas antes; o job de partições só
cria de −1 a +7 dias).

### Pendências registradas

O PITR da produção (F1b, onda 6; [seção 27](#27-pitr-com-pgbackrest));
ensaio mensal com uma cópia real do Dokploy; as regras de Bucket Lock
(`infra/r2/bucket-locks.md`), aplicadas pelo dono; réplica de leitura/HA;
retenção da trilha por plano (gatilho: mais de 2 mil motoristas ativos/dia
ou `driver_position` acima de 50 GB).

## 19. Papéis da mesma imagem

A imagem `trajetto-api` é uma só e roda em quantas Applications o
environment tiver, cada uma num papel. O HTTP, o Socket.IO, os workers
(pipeline de notificações, pipeline de IA, dispatcher de webhooks), o
agendador de crons e a ingestão de posições vivem juntos num processo (o
papel `all`, a produção de hoje: uma Application `trajetto-api` faz tudo)
ou separados, cada um com o próprio _Environment_, teto, réplicas e tag
(`<tag>-<papel>`). O código de todos os papéis já está na imagem; separar
é decisão de capacidade, e cada Application nasce quando a régua da
[seção 23](#23-recursos-da-vps-e-logs) deixa
([ADR 0012](./adr/0012-papeis-de-processo.md)). Sem a Application de um
papel, nada muda. Em qualquer papel, as filas no Postgres são
reivindicadas com `FOR UPDATE SKIP LOCKED` e lease, e os crons têm uma
execução por horário graças a um lease no banco: N processos não duplicam
nada. O passo a passo de cada Application está em
[Criar a Application de um papel](#criar-a-application-de-um-papel).

**O papel de cada processo (`PROCESS_ROLE`, plano de escala F3-01).**
Cada Application escolhe o seu:

| Papel             | Workers | Cron | Filas (`WORKER_QUEUES`) | Sockets | Varreduras | Rotas que atende                     |
| ----------------- | ------- | ---- | ----------------------- | ------- | ---------- | ------------------------------------ |
| `all` (o padrão)  | sim     | sim  | todas                   | sim     | 30 s e 5 s | todas                                |
| `api`             | não     | não  | nenhuma                 | sim     | —          | todas                                |
| `worker`          | sim     | sim  | todas                   | não     | 2 s e 2 s  | só `/health*`                        |
| `scheduler`       | sim     | sim  | `none`                  | não     | —          | só `/health*`                        |
| `realtime`        | não     | não  | nenhuma                 | sim     | —          | só `/health*` (e o `/socket.io`)     |
| `worker-external` | sim     | não  | `external`              | não     | 2 s        | só `/health*`                        |
| `ingest`          | não     | não  | nenhuma                 | não     | —          | `/health*` e `POST /route/positions` |

O papel é um preset: ele preenche `WORKERS_ENABLED`, `CRON_ENABLED`,
`WORKER_QUEUES`, `SOCKETS_ENABLED`, `PIPELINE_SWEEP_INTERVAL_MS` e
`WEBHOOK_SWEEP_INTERVAL_MS`, e toda variável dada explicitamente ganha dele. O boot loga
`process role resolved`, com o que ficou valendo; em aviso, com
`overrides`, quando uma variável contrariou o preset (um
`WORKERS_ENABLED=true` copiado do _Environment_ antigo deixaria a API com
os workers). Sem `PROCESS_ROLE`, tudo fica como antes (`all`; com
`WORKERS_ENABLED=false`, `api`). As rotas fora do papel respondem o mesmo
404 de rota inexistente: um contêiner de outro environment na
`dokploy-network` não alcança as rotas de um worker. O registro dos crons
existe em todo processo (o `/health/metrics` lista os jobs em qualquer
réplica); só o `CRON_ENABLED` os agenda. Sem sockets
(`SOCKETS_ENABLED=false`), o processo recusa o upgrade com
`SOCKET_UNAVAILABLE`, sem cobrar o endereço, e emite pelo
`@socket.io/redis-emitter` em vez do adapter (plano de escala U-07): o que
o worker emite chega ao socket conectado na API ou no realtime, sem ele
assinar os frames do cluster (`tests/E2E/process-roles-replicas.test.ts`,
`tests/E2E/socket-emitter-replicas.test.ts`). Cada pool se identifica no
`pg_stat_activity` pelo papel: `trajetto-<papel>` no principal,
`-read`, `-batch` e `-probe` nos laterais e na readiness (um
`application_name` na URL ganha).

**Quem está vivo (`process_heartbeat`, F3-03).** Todo processo, de qualquer
papel, mantém uma linha na tabela `process_heartbeat`: `replica` (a mesma
do `ops_sample`), `role`, `app_env`, `build_commit`, `node_hostname` (com
`SWARM_NODE_HOSTNAME`), `queues`, `cron`, `sockets`, `started_at`,
`updated_at` e `config_fingerprint`. A linha é gravada no boot e a cada
30 s ± 5 s com o `now()` do banco, some no SIGTERM e, se a escrita falhar,
o processo só avisa (`process heartbeat could not be written`, uma vez por
queda) e segue atendendo. Uma linha sem batida há 90 s é de um processo
morto sem SIGTERM; o `purge-ops-series` a apaga depois de 7 dias. A
impressão é o sha256 (16 hex) de `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`,
`SOCKET_ADAPTER_KEY`, `WEBHOOK_SECRETS_KEY`, `APP_ENV`, `R2_BUCKET_NAME`,
`MIN_MOBILE_CONTRACT`, da identidade do banco (o `system_identifier` do
`cluster_epoch` com o `current_database()`) e do `run_id` do Redis dos
contadores e do Redis do pub/sub (o mesmo dos contadores sem
`PUBSUB_REDIS_URL`; com ela, o processo lê o `INFO server` dele pela
conexão das dicas de despertar): uma Application com a variável e outra
sem dão impressões diferentes, e o deploy não fica verde com os eventos e
as dicas de cada uma num Redis. Nunca um valor, e nunca o host: o mesmo
banco visto direto ou pelo PgBouncer, por qualquer login, dá a mesma
impressão. Ela é recalculada a cada batida (um Redis que reinicia muda o
`run_id`, e todos convergem em 30 s) e fica nula até o banco e os Redis
responderem uma vez. Para ver:

```sql
SELECT replica, role, app_env, build_commit, config_fingerprint, queues,
       cron, sockets, now() - updated_at AS desde
FROM process_heartbeat ORDER BY role, replica;
```

**Despertar entre processos (F3-04).** Quem grava trabalho numa fila que
não consome (a `api` publica um evento, o `worker` o expande) avisa pelo
pub/sub do Redis, no canal `<SOCKET_ADAPTER_KEY>:wake:<fila>`, fora dos
padrões que o adapter do Socket.IO assina; os processos que consomem a
fila acordam o worker dela na hora (`src/shared/wake/`). Um processo que
consome a fila também avisa quando há mais de um consumidor vivo no
`process_heartbeat`, para os outros ajudarem; no papel `all` (a produção de
hoje) ele já acordou a si mesmo, e não publica nada. Cem milissegundos de
espera juntam uma rajada num aviso só, e o aviso leva só a réplica de quem
publicou (e a versão da mensagem). Um aviso perdido (Redis fora) custa a
varredura: 2 s no `worker`. O despachante de webhooks ganhou o mesmo
despertar: o fan-out que gravou linhas o acorda meio segundo depois do
commit, em vez de esperar os 5 s da varredura. Depois de expandir eventos,
a varredura do outbox encadeia as raias, e as raias que o processo não
consome (o `external` de um `worker` com `worker-external`) são avisadas.
Quem escuta acorda todas as filas uma vez quando a assinatura volta depois
de uma queda do Redis.

**Concorrência das filas (F3-05).** Quantas linhas de cada fila um
processo trabalha ao mesmo tempo vem do _Environment_:
`NOTIFICATION_INTERNAL_CONCURRENCY` e `NOTIFICATION_EXTERNAL_CONCURRENCY`
(5 por raia), `OUTBOX_EXPANSION_CONCURRENCY` (1: um evento depois do
outro), `WEBHOOK_CONCURRENCY` (5) e `AI_CONCURRENCY` (4, limitado ainda
por `AI_LOCAL_MAX_CONCURRENCY`). Sem elas, as constantes de antes, número
por número; cada uma vai de 1 a 32. Um lote precisa terminar dentro do
lease do seu claim, senão outro processo reivindica o que este ainda
envia e o destinatário recebe duas vezes: as raias e os webhooks conferem
isso ao carregar, com o valor dado, e abaixo de 2 o boot para com a
variável no erro (`... não cabe no lease da fila`). O boot loga os valores
em `process role resolved` (`concurrency`) e avisa com
`queue concurrency takes the whole database pool` quando as vagas só de
banco deste processo (a expansão do outbox mais a raia `internal`) somam o
`connection_limit` da `DATABASE_URL` ou mais: não sobraria conexão para o
HTTP, os claims das outras filas e o cron. É aviso, não recusa.

**Pool contínuo (F3-06 e F3-07).** Desde a onda 13, cada fila é um pool
contínuo: a vaga que libera reivindica de novo, em vez de esperar o lote
inteiro terminar. Um valor acima do lote (20 nas raias e nos webhooks, 10
no outbox) agora vale: o pool reivindica de novo até encher as vagas.
`WEBHOOK_PER_ENDPOINT_CONCURRENCY` (2, o de antes) é quantas chamadas de um
mesmo endpoint cada processo faz ao mesmo tempo; um endpoint lento segura
só essas e as próprias linhas, e os claims seguintes o deixam de fora. Na
parada, o que foi reivindicado e não começou volta na hora, sem esperar o
lease.

**Teto global por endpoint (F3-13).** `WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY`
(4) é quantas chamadas a um mesmo endpoint todos os despachantes juntos
fazem ao mesmo tempo: o claim conta as linhas em voo dele, de qualquer
processo, sob um lock que só dura o claim. Precisa estar no ar **antes** de
qualquer `worker` ×2: sem ele, cada despachante a mais multiplica o que o
ERP do cliente recebe. O 4 é o que as duas réplicas da produção já mandam
hoje; o valor final vem da taxa que a Comprovei/Fusion confirmar (pedido
comercial da onda 13). `0` volta ao teto só por processo.
`WEBHOOK_HOST_GLOBAL_CONCURRENCY` (16, F3-14) faz o mesmo por host de
destino, somando todos os endpoints apontados para ele: o caso do ERP de um
agregador, que recebe um endpoint por empresa no mesmo host. Só vale com o
teto por endpoint ligado; `0` o desliga.

**Tetos globais dos provedores (F3-15a).** `WHATSAPP_GLOBAL_CONCURRENCY`,
`EMAIL_GLOBAL_CONCURRENCY` e `PUSH_GLOBAL_CONCURRENCY` (0, sem teto global,
por padrão) são os envios em voo à Meta, ao provedor de e-mail e ao Expo
somando todos os processos que consomem a raia; cada processo fica com o
teto dividido pelos processos vivos dela (o maior número visto em 10 min,
nunca abaixo de `ROLE_EXPECTED_CONSUMERS` nem de 1). Ligue-os com os
números que a Meta e a Resend confirmarem, antes de pôr uma segunda
réplica na raia `external`, e ponha `ROLE_EXPECTED_CONSUMERS` com o número
de processos que consomem as raias.

**Balde de taxa dos provedores (F3-15c).** Concorrência não limita taxa:
`WHATSAPP_SENDS_PER_SECOND`, `EMAIL_REQUESTS_PER_SECOND` e
`PUSH_NOTIFICATIONS_PER_SECOND` (0, desligado, por padrão) são os envios
por segundo à Meta, ao provedor de e-mail e ao Expo somando todos os
processos, num balde GCRA no Redis. Um envio cuja vez está a mais de 1 s
volta para a fila sem gastar tentativa; um 429 do provedor (o 130429 da
Meta) segura o provedor para todos os processos pela pausa pedida, e a
mensagem espera sem gastar tentativa. Sem Redis, cada processo fica com a
sua parte (a taxa dividida pelos processos vivos da raia). Ligue-os quando
o alerta `provider-throttled` aparecer, ou quando o pico projetado passar
de metade do limite do provedor, com o mesmo valor em todas as
Applications que consomem a raia (propostos: 60, 8 e 500;
[runbook](./runbooks/provider-throttled.md)).

**Push em lote (U-06).** `PUSH_BATCH_SIZE` (1, uma chamada ao Expo por
entrega, por padrão) junta várias entregas de push numa chamada. A partir
de 2, a linha de push que começa com a raia `internal` em atraso (o claim
que a trouxe veio cheio) reivindica até esse número menos um de outras
linhas de push vencidas, para a mesma vaga, e o grupo sai em chamadas de
até 100 mensagens. Cada linha faz as suas conferências, lê os seus
aparelhos, recebe só os tickets das próprias posições na chamada e fecha
com o seu cercamento; os recibos seguem pelo `check-push-receipts` como
antes. Um 5xx do Expo devolve o grupo à fila sem gastar tentativa (a
espera é o degrau do cronograma pela idade da linha; passadas ~4 h 40, a
falha volta a gastar tentativa), e um 400 numa chamada de várias entregas
é reenviado uma entrega por chamada, para só a culpada falhar. Numa parada,
nenhum grupo reivindica mais, e o que está no ar termina como qualquer
linha. Ligue com `20` na Application que consome a raia `internal` quando a
fila de push crescer; `1` desliga.

**Orçamento de memória (U-15).** No boot, cada processo soma o heap
principal (o `--max-old-space-size` do `NODE_OPTIONS`), as threads da
planilha (`SPREADSHEET_READS_PER_PROCESS` × `SPREADSHEET_WORKER_MAX_OLD_MB`)
e a reserva nativa (`NATIVE_RESERVE_MB`, 150) e compara com o `memory.max`
do cgroup, o _Memory_ da Application. Sem `SPREADSHEET_WORKER_MAX_OLD_MB`,
a thread recebe o que sobra por leitura, entre 256 e 768 MiB. A thread lê o
.xlsx linha a linha, e a maior planilha que o leitor aceita cabe em 64 MiB:
os 96 da api de staging e os 256 da produção a leem; só uma pasta com
células mescladas ou links volta à leitura inteira do exceljs (~350 bytes
por célula), que precisa de mais. Com
`MEMORY_BUDGET_MODE=warn` (o padrão deste release), a conta que não fecha
vira o aviso `memory budget does not fit` no log, `memory_budget_ok: false`
no `/health/metrics` e o alerta `memory-budget`; com `enforce`, o boot é
recusado. Sem cgroup legível, a conferência é pulada com aviso. O que fazer
quando não fecha: [runbook memory-budget](./runbooks/memory-budget.md).

- **Tempo real com várias réplicas**: o evento emitido numa réplica chega ao
  cliente conectado em outra pelo pub/sub do Redis
  (`@socket.io/redis-adapter`). Todas as réplicas precisam do mesmo
  `REDIS_URL` e do mesmo `SOCKET_ADAPTER_KEY`. Todo cliente de pub/sub sai
  de `src/shared/redis/pubsub-redis.ts` (F5-01): com `PUBSUB_REDIS_URL`, o
  adapter e as dicas entre processos vão juntos para um Redis só deles, e os
  contadores ficam na `REDIS_URL`; sem ela, nada muda. Ligue em todas as
  Applications do environment no mesmo deploy (`redis-role-map.test.ts`
  guarda o mapa dos clientes). Provado em
  `tests/E2E/multi-replica-events.test.ts`. Sem cookie sticky: WebSocket fica
  na réplica por natureza.
- **Escalar a API**: _Advanced → Cluster Settings → Replicas_ da Application
  `trajetto-api` → **Save** → **Deploy** (ou `docker service scale
trajetto-api-production=N`, que o próximo deploy desfaz) e refaça o
  a conta das conexões
  ([seção 10](#roles-do-banco-logins-urls-e-conexões); por papel, em
  [Valores por papel](#valores-por-papel)).
  O Swarm reparte conexões, não requisições: cada conexão keep-alive atende
  até `HTTP_MAX_REQUESTS_PER_SOCKET` requisições (1.000 por padrão) e a
  última resposta sai com `Connection: close`, para a réplica nova receber a
  parte dela em poucos minutos (`0` desliga).
- **Desligamento ordenado**: SIGTERM → readiness 503 → o dreno, em que a
  réplica ainda atende as conexões que o Traefik já tem com ela (o Swarm a
  tira do endereço virtual uns 2 s antes do SIGTERM, e as conexões novas já
  vão para a outra) → fecha tempo real, HTTP, workers e Redis. Todos os
  prazos saem de `STOP_GRACE_PERIOD_MS`, o _Stop Grace Period_ que o Swarm
  dá ao serviço (`src/shared/lifecycle/shutdown-plan.ts`):

  | Prazo                                           | Fórmula (g = grace)      | Sem a variável (10 s) | Com `40000` |
  | ----------------------------------------------- | ------------------------ | --------------------- | ----------- |
  | teto (`SHUTDOWN_TIMEOUT_MS`)                    | g − clamp(g/8, 1 s, 5 s) | 8,75 s                | 35 s        |
  | dreno (`SHUTDOWN_DRAIN_MS`)                     | 0,3 g                    | 3 s                   | 12 s        |
  | pedidos em andamento, depois do dreno           | 0,25 g                   | 2,5 s                 | 10 s        |
  | planilha em andamento (`IMPORT_DRAIN_GRACE_MS`) | 0,375 g                  | 3,75 s                | 15 s        |
  | para ela parar / para gravar                    | g/8 / g/20               | 1,25 s / 0,5 s        | 5 s / 2 s   |
  | workers (`SHUTDOWN_WORKERS_MS`)                 | 0,3 g                    | 3 s                   | 12 s        |

  Durante o dreno, toda resposta sai com `Connection: close` e a réplica
  encerra a conexão logo depois: o Traefik abre a próxima, que o Swarm já
  manda para outra réplica. As conexões ociosas não são fechadas em laço
  (uma fechada enquanto o Traefik escreve um POST nela vira 502, que o Go
  não repete); ficam para o fechamento do HTTP no fim do dreno. Dreno e
  importação correm juntos desde o SIGTERM. O fechamento do HTTP espera os
  pedidos ainda em andamento, e nada mais o limita (o corpo pode levar até
  120 s para chegar): por isso eles têm até 0,25 g depois do dreno, e
  passado disso a conexão deles é fechada (o cliente vê o pedido falhar e o
  manda de novo, como faria depois do teto). Sem esse prazo, um upload
  lento segurava os workers até o teto, que saía com `exit 1` antes de eles
  pararem. Os workers começam depois do HTTP e da importação, em até
  0,55 g, e terminam em até 0,85 g, antes do teto; o que sobra até o teto é
  do `QUIT` do Redis. Cada prazo aceita um valor à mão (as variáveis entre
  parênteses; o dos pedidos em andamento não tem), e um que não cabe no
  grace derruba o boot com a mensagem. A linha `shutting down` do log traz o
  plano, e a `shutdown complete` traz `durationMs`. Desde o SIGTERM, a fila
  de importação recusa planilhas novas (429 `IMPORT_BUSY`), fecha na hora as
  que esperavam ("não iniciada: envie de novo"), dá à que está rodando o
  prazo dela e depois a para entre duas linhas, com o relatório até ali;
  tudo antes dos workers (ADR [0001](./adr/0001-filas-e-mensageria.md)).
  Ligar os 40 s: o _Stop Grace Period_ da Application primeiro (conferido no
  `inspect`, [seção 7.7](#77-trajetto-api-application), passo 8), a
  variável depois.

### Criar a Application de um papel

Vale para `trajetto-worker`, `trajetto-scheduler`,
`trajetto-worker-external`, `trajetto-realtime` e `trajetto-ingest`, em
qualquer environment (plano de escala X-12). O papel `api` não ganha
Application: é a `trajetto-api` de sempre, com o _Environment_ trocado.
Antes de criar, confira a coluna da fase em
[Tetos por Application e por fase](#tetos-por-application-e-por-fase) e a
soma da [seção 23](#23-recursos-da-vps-e-logs): papel que não cabe na
régua espera. O que muda em cada papel está em
[Valores por papel](#valores-por-papel), e a ordem, em
[Ordem do corte e da reversão](#ordem-do-corte-e-da-reversão).

1. Dokploy → projeto `trajetto-api` → environment (`staging` ou
   `production`) → **Create Service → Application**. _Name_
   `trajetto-<papel>`; _App Name_ `trajetto-<papel>-<environment>` (por
   exemplo `trajetto-worker-production`; seção 7.2). **Create**.
2. Aba _General_ → _Provider_ → **Docker**: _Docker Image_
   `ghcr.io/trajetto-organization/trajetto-api:<staging|stable>-<papel>`
   (por exemplo `:staging-worker`); _Registry URL_ `ghcr.io`; _Username_ e
   _Password_ do PAT de leitura do GHCR (seção 7.3). **Save**. Não ligue
   _Autodeploy_: quem decide o deploy é o workflow. A tag do papel existe
   desde o primeiro run verde com a ação de deploy da onda 12, que a deixa
   no digest da API (passo _Move the tags of the roles not deployed_ da
   seção 3).
3. Aba _Environment_. As chaves que não podem divergir entre os processos
   do mesmo environment são `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`,
   `SOCKET_ADAPTER_KEY`, `WEBHOOK_SECRETS_KEY`, `APP_ENV`,
   `R2_BUCKET_NAME`, `MIN_MOBILE_CONTRACT`, o banco e o Redis. Se o painel
   tiver variáveis compartilhadas do environment (a conferir na v0.30.10;
   nas versões que têm, cada Application as lê como
   `${{environment.NOME}}`), defina-as lá e use a referência; senão, cole o
   _Environment_ inteiro da `trajetto-api` do mesmo environment. Nos dois
   casos, quem confere é a impressão da configuração do
   `process_heartbeat` (acima): uma chave divergente deixa o
   `/health/rollout` com duas impressões, e o deploy fica vermelho
   ([seção 14](#os-papéis-da-mesma-imagem-rollout_roles_expected)). Aplique
   as mudanças da subseção do papel e **tire**, se a cópia trouxer,
   `WORKERS_ENABLED`, `CRON_ENABLED`, `WORKER_QUEUES`, `SOCKETS_ENABLED`,
   `PIPELINE_SWEEP_INTERVAL_MS` e `WEBHOOK_SWEEP_INTERVAL_MS`, menos as que
   a subseção pede: o preset do `PROCESS_ROLE` põe os valores certos, e uma
   variável explícita ganharia dele (o boot avisa com `overrides`).
   **Save**.
4. Aba _Domains_: só no `realtime` e no `ingest`, e só com _Replicas_ ≥ 1.
   _Host_ igual ao da API (`api.intrajetto.com`; na staging,
   `api-staging.intrajetto.com`), _Path_ `/socket.io` (realtime) ou
   `/route/positions` (ingest), _Strip Path_ **desligado**, _Container
   Port_ `3333`, HTTPS ligado e _Certificate Provider_ `Let's Encrypt`. O
   Traefik manda o _Path_ mais longo para esta Application: sem task de pé,
   cada pedido desse caminho recebe o erro do Traefik, em vez de ir para a
   `trajetto-api`. Depois, no host, confira a regra em
   `/etc/dokploy/traefik/dynamic/<App Name>.yml`
   ([runbook roteamento-por-path](./runbooks/roteamento-por-path.md): o
   formato que o Dokploy escreve, a ordem pelo tamanho da regra e a prova
   na bancada com `tests/load/roles-routing.sh`).
5. _Advanced → Resources_: _Memory Limit_ e _CPU Limit_ da tabela de tetos,
   em bytes e nano-CPU (1 MiB = `1048576`; 1 CPU = `1000000000`; "livre" é
   o campo vazio). **Save**.
6. _Advanced → Cluster Settings_: _Replicas_ da tabela de tetos. **Save**.
7. _Advanced → Swarm Settings_ (tempos em nanossegundos; os campos não
   citados ficam vazios). Cole cada bloco no campo de mesmo nome.

   _Health Check_: o mesmo da `trajetto-api`
   ([seção 7.7](#77-trajetto-api-application), passo 8), que é o teste da
   imagem com 5 tentativas em vez das 3 dela. Nunca a readiness: no Swarm,
   falhar aqui destrói a task.

   ```json
   {
     "Test": [
       "CMD",
       "wget",
       "-q",
       "-O",
       "/dev/null",
       "http://127.0.0.1:3333/health/liveness"
     ],
     "Interval": 30000000000,
     "Timeout": 10000000000,
     "StartPeriod": 30000000000,
     "Retries": 5
   }
   ```

   _Restart Policy_:

   ```json
   { "Condition": "any", "Delay": 5000000000, "MaxAttempts": 0 }
   ```

   _Update Config_ (a task nova antes de derrubar a velha, com rollback
   automático):

   ```json
   {
     "Parallelism": 1,
     "Delay": 5000000000,
     "FailureAction": "rollback",
     "Monitor": 30000000000,
     "Order": "start-first"
   }
   ```

   _Rollback Config_:

   ```json
   {
     "Parallelism": 1,
     "Delay": 5000000000,
     "Monitor": 30000000000,
     "Order": "start-first"
   }
   ```

   _Stop Grace Period_: `40000000000` (40 s). _Placement_:
   `{ "Constraints": ["node.labels.trajetto.app==true"] }`, depois dos
   labels do nó (onda 17,
   [runbooks/swarm-multi-no.md](./runbooks/swarm-multi-no.md)).

8. **Deploy**. Em _Logs_: `process role resolved` com o papel certo e, nos
   papéis com filas, `workers started`.
9. Anote o **applicationId** (está na URL da Application). GitHub →
   _Settings → Environments_ → `staging` ou `production`: o secret
   `DOKPLOY_<PAPEL>_APPLICATION_ID` (`WORKER`, `SCHEDULER`,
   `WORKER_EXTERNAL`, `REALTIME` ou `INGEST`) e a variável
   `SWARM_<PAPEL>_SERVICE` com o App Name. Atualize
   `ROLLOUT_ROLES_EXPECTED` com o valor da subseção do papel. Do run
   seguinte em diante, a ação de deploy implanta o papel na ordem da
   seção 3: worker, scheduler e worker-external antes da API; ingest e
   realtime depois dela.
10. Reinstale o `infra/scripts/verify-rollout.sh` no host quando a onda
    pedir
    ([seção 14](#pelo-swarm-por-ssh-padrão-na-produção-rollout_verifyssh-no-staging)).

### Valores por papel

| Papel                      | `PROCESS_ROLE`                                  | O que muda no _Environment_ copiado                                                                                                                 | Banco até a onda 16 (direto)                                                                              |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `all` (a produção de hoje) | ausente ou `all`                                | —                                                                                                                                                   | `DATABASE_URL` com `trajetto_http` e `connection_limit=10`; `BATCH_DATABASE_URL` com `trajetto_batch` e 3 |
| `api`                      | `api`                                           | `SPREADSHEET_READS_PER_PROCESS` (1 até a importação durável, depois 0); `SOCKETS_ENABLED=false` depois do realtime                                  | `trajetto_http` com 6; `DATABASE_READ_URL` com `trajetto_read` e 3                                        |
| `worker`                   | `worker`                                        | `SHUTDOWN_DRAIN_MS=0`; `CRON_ENABLED=false` quando houver scheduler; `WORKER_QUEUES=outbox,internal,webhooks,ai,jobs` quando houver worker-external | `trajetto_worker` com 8; `BATCH_DATABASE_URL` com `trajetto_batch` e 3                                    |
| `scheduler`                | `scheduler` (o preset põe `WORKER_QUEUES=none`) | `SHUTDOWN_DRAIN_MS=0`                                                                                                                               | `DATABASE_URL` e `BATCH_DATABASE_URL` com `trajetto_batch` e 3, diretas                                   |
| `worker-external`          | `worker-external`                               | `SHUTDOWN_DRAIN_MS=0`                                                                                                                               | `trajetto_worker` com 4                                                                                   |
| `realtime`                 | `realtime`                                      | —                                                                                                                                                   | `trajetto_http` com 3                                                                                     |
| `ingest`                   | `ingest`                                        | —                                                                                                                                                   | `trajetto_http` com 6                                                                                     |
| `trajetto-api-migrate`     | imagem própria                                  | `POST_DEPLOY_STEPS` (emergência); `HISTORY_WINDOW_APPROVED` (só na janela)                                                                          | o usuário do Database, direto                                                                             |

As URLs têm o formato de sempre: troque só o usuário, a senha, o host e o
`connection_limit` (o porquê de cada parâmetro está na
[seção 7.7](#77-trajetto-api-application)). Por exemplo, as do worker de
produção:

```
DATABASE_URL=postgresql://trajetto_worker:<SENHA>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=8&pool_timeout=5&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=-c%20statement_timeout%3D30000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000
BATCH_DATABASE_URL=postgresql://trajetto_batch:<SENHA>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=3
```

Na staging, `-staging` no lugar de `-production`, com as senhas da
staging. Os logins são os do
[corte dos roles](#roles-do-banco-logins-urls-e-conexões). Com o PgBouncer
(onda 17), as URLs do runtime passam por ele; as do batch, a da
`trajetto-scheduler` e a da migrate continuam diretas.

**Heap dos papéis pequenos.** O plano fixa o heap da api e do worker; o dos
outros sai da regra do orçamento de memória (acima): heap + 150 MiB de
reserva nativa ≤ teto, com `SPREADSHEET_READS_PER_PROCESS=0`, arredondado
para baixo. Para 320 MiB, `NODE_OPTIONS=--max-old-space-size=160`; para
384, `224`; para 512, `352`. O boot confere a conta (`memory budget fits`).

#### `all` (a produção de hoje)

- **Onde**: a `trajetto-api` de produção até o worker de produção existir
  (onda 14, se a régua fechar), e a de staging até a onda 12.
- **_Environment_**: sem `PROCESS_ROLE` (ou `all`) e sem
  `WORKERS_ENABLED=false`. Na produção, desde a onda 12,
  `NODE_OPTIONS=--max-old-space-size=576` e
  `SPREADSHEET_WORKER_MAX_OLD_MB=256` (576 + 256 + 150 = 982 de 1.024; com
  `MEMORY_BUDGET_MODE=warn`, o boot só avisa se a conta não fechar).
- **Teto**: 2 × 1024 MiB (`1073741824`) na produção, CPU livre, com a
  _Domain_ `/` da seção 7.7.
- **GitHub**: `ROLLOUT_ROLES_EXPECTED=all` (o `all` vale por api, worker e
  scheduler).

#### `api`

- **Onde**: a `trajetto-api` de sempre, sem Application nova. Na staging,
  logo depois do worker (onda 12); na produção, depois do worker de
  produção (onda 14).
- **_Environment_**: `PROCESS_ROLE=api`, e tire o que o passo 3 manda
  tirar (um `WORKERS_ENABLED=true` esquecido deixaria os workers na API).
  `DATABASE_URL` com `trajetto_http` e `connection_limit=6`, e
  `DATABASE_READ_URL` com `trajetto_read` e 3.
- **Staging (fase B)**: `NODE_OPTIONS=--max-old-space-size=320` e
  `SPREADSHEET_WORKER_MAX_OLD_MB=96`, no teto de 576 MiB (`603979776`).
- **Produção (fase C)**: só com a importação durável (onda 14), que tira a
  planilha da API: `SPREADSHEET_READS_PER_PROCESS=0`,
  `NODE_OPTIONS=--max-old-space-size=448` e 2 × 768 MiB (`805306368`).
  Antes dela, a api da produção não cabe em 768 MiB.
- **Depois do realtime**: `SOCKETS_ENABLED=false` (ver o corte, abaixo).
- **Confira**: em _Logs_, `process role resolved` com `role: api` e
  `workers disabled on this replica (WORKERS_ENABLED=false)`.

#### `worker`

Na staging (fase B, onda 12), nesta ordem:

1. Crie a Application pelos passos acima: _Name_ `trajetto-worker`, _App
   Name_ `trajetto-worker-staging`, imagem
   `ghcr.io/trajetto-organization/trajetto-api:staging-worker`.
2. _Environment_ (a cópia do da `trajetto-api` de staging), mudando:
   `PROCESS_ROLE=worker`, `SHUTDOWN_DRAIN_MS=0` (sem tráfego, não há o que
   drenar), `NODE_OPTIONS=--max-old-space-size=256`,
   `SPREADSHEET_READS_PER_PROCESS=0`, `DATABASE_URL` com `trajetto_worker`
   e `connection_limit=8`, e `BATCH_DATABASE_URL` com `trajetto_batch` e
   3, direta. A `DATABASE_READ_URL` não vai: o pool de leitura serve rotas
   HTTP. O `HEALTHCHECK_PING_URL` fica: o ping sai do processo que roda o
   cron.
3. Sem _Domain_. _Replicas_ 1. _Memory Limit_ `469762048` (448 MiB) e _CPU
   Limit_ `250000000` (0,25 CPU).
4. _Swarm Settings_: os blocos do passo 7 e o _Stop Grace Period_
   `40000000000`.
5. **Deploy**. Em _Logs_: `process role resolved` com `role: worker` e
   `workers started`.
6. `trajetto-api` de staging → _Environment_: `PROCESS_ROLE=api`,
   `NODE_OPTIONS=--max-old-space-size=320`,
   `SPREADSHEET_WORKER_MAX_OLD_MB=96`, `DATABASE_URL` com `trajetto_http`
   e `connection_limit=6`, e `DATABASE_READ_URL` com `trajetto_read` e 3 →
   **Deploy**.
7. GitHub → environment `staging`: o secret `DOKPLOY_WORKER_APPLICATION_ID`
   e as variáveis `SWARM_WORKER_SERVICE=trajetto-worker-staging` e
   `ROLLOUT_ROLES_EXPECTED=api,worker`.
8. Reinstale o `verify-rollout.sh` no host (passo 10).
9. Confira: uma notificação chega em menos de 2 s (o despertar); o SQL de
   duplicatas da eleição
   ([Staging com 2 réplicas](#staging-com-2-réplicas-plano-de-02112026-k15-decisão-d53),
   passo 4) volta vazio; e o `/health/rollout` tem os dois papéis no
   commit (seção 14).

Na produção (fase C, onda 14), só se a régua fechar: a R1 com o Postgres
de produção em 1.792 MiB (hit ratio > 99% medido) e a web em 2 × 512 MiB;
senão a R2; senão, o worker espera o 2º VPS. Os mesmos passos, com
`:stable-worker`, _App Name_ `trajetto-worker-production`, _Memory Limit_
`1073741824` (1024 MiB), _CPU Limit_ `1500000000` (1,5 CPU),
`NODE_OPTIONS=--max-old-space-size=512` e, com a importação durável,
`SPREADSHEET_READS_PER_PROCESS=1` e `SPREADSHEET_WORKER_MAX_OLD_MB=320`; no
GitHub, o environment `production`, com
`SWARM_WORKER_SERVICE=trajetto-worker-production` e
`ROLLOUT_ROLES_EXPECTED=api,worker`. Depois, a `trajetto-api` de produção
passa ao papel `api` (subseção acima).

**Reversão**: `PROCESS_ROLE=all` na `trajetto-api` PRIMEIRO (**Deploy**, e
`workers started` no log dela), depois _Replicas_ 0 no worker.

#### `scheduler`

- **Quando**: com o worker em 2 réplicas, para o cron e o pool do batch
  ficarem num processo só: na staging do 2º VPS (onda 18) e na produção
  do prod-1 (onda 22).
- **_Environment_**: `PROCESS_ROLE=scheduler` (o preset põe
  `WORKER_QUEUES=none`: só o cron, nenhuma fila), `SHUTDOWN_DRAIN_MS=0`,
  `SPREADSHEET_READS_PER_PROCESS=0`,
  `NODE_OPTIONS=--max-old-space-size=160`, e a `DATABASE_URL` e a
  `BATCH_DATABASE_URL` com `trajetto_batch` e `connection_limit=3`, as duas
  diretas mesmo com o PgBouncer.
- **Teto**: 320 MiB (`335544320`), 0,25 CPU (`250000000`) na staging; 1 ×
  320 MiB no prod-1. Sem _Domain_.
- **GitHub**: `DOKPLOY_SCHEDULER_APPLICATION_ID`,
  `SWARM_SCHEDULER_SERVICE` e `scheduler` no `ROLLOUT_ROLES_EXPECTED`.
- **Corte**: com ele de pé, `CRON_ENABLED=false` na `trajetto-worker`.
  **Reversão**: `CRON_ENABLED=true` no worker PRIMEIRO, depois _Replicas_
  0 no scheduler.

#### `worker-external`

- **Quando**: na staging do 2º VPS (onda 18); na produção, no prod-1,
  quando a raia `external` (e-mail e WhatsApp) pedir um processo só dela.
- **_Environment_**: `PROCESS_ROLE=worker-external` (o preset põe
  `WORKER_QUEUES=external`, sem cron), `SHUTDOWN_DRAIN_MS=0`,
  `SPREADSHEET_READS_PER_PROCESS=0`, o heap do teto (160 na staging, 224
  no prod-1) e a `DATABASE_URL` com `trajetto_worker` e
  `connection_limit=4`.
- **Teto**: 320 MiB (`335544320`) na staging; 1 × 384 MiB (`402653184`) no
  prod-1. Sem _Domain_.
- **GitHub**: `DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID`,
  `SWARM_WORKER_EXTERNAL_SERVICE` e `worker-external` no
  `ROLLOUT_ROLES_EXPECTED`.
- **Corte**: com ele de pé (`workers started`), tire `external` do worker:
  `WORKER_QUEUES=outbox,internal,webhooks,ai,jobs` na `trajetto-worker`.
  **Reversão**: devolva `external` ao worker PRIMEIRO (tire a
  `WORKER_QUEUES` dele), depois _Replicas_ 0.

#### `realtime`

- **Quando**: na staging do 2º VPS (onda 18), validado pela borda com o
  [LOAD-05](#frota-de-sockets-pela-borda-load-05); na produção, no prod-1.
- **_Environment_**: `PROCESS_ROLE=realtime` (sockets sem workers nem
  cron; o Fastify só responde `/health*`), `SPREADSHEET_READS_PER_PROCESS=0`,
  o heap do teto (224 na staging, 352 no prod-1) e a `DATABASE_URL` com
  `trajetto_http` e `connection_limit=3`. O dreno fica: os sockets fecham
  aos poucos ao longo dele.
- **_Domain_**: _Path_ `/socket.io` (passo 4), só com _Replicas_ ≥ 1.
- **Teto**: 384 MiB (`402653184`), 0,25 CPU (`250000000`) na staging; 2 ×
  512 MiB (`536870912`) no prod-1.
- **GitHub**: `DOKPLOY_REALTIME_APPLICATION_ID`, `SWARM_REALTIME_SERVICE`
  e `realtime` no `ROLLOUT_ROLES_EXPECTED`. É o último do deploy.
- **Só quando o código dele muda** (plano de escala F3-31c, decisão D7):
  o deploy do realtime derruba todos os sockets (eles voltam ao longo do
  dreno), então ele só é implantado quando o que ele executa mudou. A
  imagem leva dois labels, calculados no job `Build` por
  `.github/scripts/realtime-closure.mjs`: `trajetto.realtime-source` (o
  hash do fecho de imports a partir de `src/websocket.ts` e do boot,
  listado em `.github/realtime-closure.txt`, mais as dependências, o
  `schema.prisma` e a configuração do build) e `trajetto.contract-epoch`
  (as migrations de contract mais as versões das mensagens entre
  processos, `src/shared/socket/messages.ts`). O deploy compara com a
  imagem que a tag `<tag>-realtime` aponta e implanta quando: o _Run
  workflow_ veio com **force_realtime**; essa imagem não tem os labels
  (a primeira com eles sempre implanta) ou a tag não existe; a fonte ou
  a época diferem; ou ela tem mais de 7 dias. Senão o realtime fica no
  build dele (a tag não anda), o resumo do run diz por quê, e a
  conferência por papel o aceita no commit anterior. Num rollback
  (`production.yml` com `image_tag`), ele só volta junto se o código ou a
  época diferirem; para levá-lo de qualquer jeito, marque
  **force_realtime**.
- **Corte**: com a _Domain_ e o LOAD-05 aprovado, `SOCKETS_ENABLED=false`
  na `trajetto-api`. A partir daí a api emite pelo emissor do Redis, sem
  assinar nada do adapter (U-07). Meça antes e depois, no console do
  Redis do Dokploy, `redis-cli INFO stats | grep total_net_output_bytes`
  duas vezes com 5 minutos entre elas, no mesmo horário de dois dias
  úteis: a diferença por minuto é a saída do Redis, e ela cai com cada
  processo que deixa de assinar. Confira também a pausa de template sem
  esperar a Meta: no mesmo console, publique uma pausa de 1 s de um
  template que não existe (troque `socket.io` pela `SOCKET_ADAPTER_KEY`
  do ambiente, se houver) e procure `whatsapp template lane changed` com
  esse nome no log de cada processo que drena `external`, em até 5 s:

  ```sh
  redis-cli PUBLISH socket.io:lane '{"v":1,"replica":"teste-do-dono","change":{"template":"teste_inexistente","action":"pause","seconds":1}}'
  ```

  **Reversão**: `SOCKETS_ENABLED=true` na `trajetto-api` PRIMEIRO, depois
  apague a _Domain_ e _Replicas_ 0.

#### `ingest`

- **Quando**: na staging do 2º VPS (onda 18), para provar o roteamento;
  na produção, só pelo gatilho (0 réplicas até lá).
- **_Environment_**: `PROCESS_ROLE=ingest` (só `/health*` e
  `POST /route/positions`, sem sockets, workers nem cron),
  `SPREADSHEET_READS_PER_PROCESS=0`, o heap do teto (224 na staging) e a
  `DATABASE_URL` com `trajetto_http` e `connection_limit=6`.
- **_Domain_**: _Path_ `/route/positions` (passo 4), só com _Replicas_ ≥ 1.
- **Teto**: 384 MiB (`402653184`) na staging.
- **GitHub**: `DOKPLOY_INGEST_APPLICATION_ID`, `SWARM_INGEST_SERVICE` e
  `ingest` no `ROLLOUT_ROLES_EXPECTED`. Vai logo depois da API.
- **Corte**: crie com _Replicas_ ≥ 1 e só então a _Domain_. **Reversão**:
  apague a _Domain_ PRIMEIRO, depois _Replicas_ 0.

### Ordem do corte e da reversão

Regra: uma fila nunca fica sem processo, e a reversão é sempre na ordem
inversa, mudando primeiro a Application que fica.

| Corte           | Primeiro                                                                        | Depois                                        | Reversão                                                               |
| --------------- | ------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| worker          | criar o `trajetto-worker` e conferir `workers started`                          | `PROCESS_ROLE=api` na api                     | `PROCESS_ROLE=all` na api, depois _Replicas_ 0 no worker               |
| scheduler       | criar o `trajetto-scheduler`                                                    | `CRON_ENABLED=false` no worker                | `CRON_ENABLED=true` no worker, depois _Replicas_ 0 no scheduler        |
| worker-external | criar o `trajetto-worker-external`                                              | tirar `external` do `WORKER_QUEUES` do worker | devolver `external` ao worker, depois _Replicas_ 0                     |
| realtime        | criar o `trajetto-realtime` com a _Domain_ `/socket.io` e validar com o LOAD-05 | `SOCKETS_ENABLED=false` na api                | `SOCKETS_ENABLED=true` na api, depois apagar a _Domain_ e _Replicas_ 0 |
| ingest          | criar o `trajetto-ingest` com réplica ≥ 1                                       | a _Domain_ `/route/positions`                 | apagar a _Domain_, depois _Replicas_ 0                                 |
| PgBouncer       | criar o `trajetto-pgbouncer` (onda 17)                                          | as URLs, uma Application por vez              | as URLs de volta ao Postgres direto, uma por vez                       |

### Tetos por Application e por fase

Os valores vão em bytes (_Memory Limit_) e nano-CPU (_CPU Limit_), como o
Dokploy pede: 1 MiB = `1048576`; 1 CPU = `1000000000`. "Livre" quer dizer
sem _CPU Limit_, de propósito. "Heap" é o `--max-old-space-size` do
`NODE_OPTIONS`. Cada célula diz réplicas × MiB.

Fases na VPS única: **A** = ondas 0 a 11; **B** = ondas 12 e 13 (a
staging ganha o worker); **C** = ondas 14 e 15 (a produção ganha o
worker); **E** = ondas 16 a 21 (a staging já está no 2º VPS, e a produção
fica sozinha na VPS 1). **prod-1** = onda 22 em diante, nos servidores
próprios. Até a troca de imagem da onda 3, o Postgres de produção fica sem
teto (a imagem oficial usa 128 MB de `shared_buffers`); a soma da fase A
já conta os 2 GiB dele. Se a produção continuar no papel `all` na fase C
(a R1 não fechou), a api fica com 2 × 1024 e heap 480.

**Produção**

| Application                  | Imagem                        | Papel                      | _Domain_ / _Path_                                         | A                                                       | B                     | C                                                         | E (VPS 1 sozinha)                                    | prod-1                                 |
| ---------------------------- | ----------------------------- | -------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | --------------------- | --------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------- |
| Database `trajetto-postgres` | `trajetto-postgres@sha256`    | —                          | —                                                         | 2048 (`2147483648`), CPU livre                          | 2048                  | 1792 (`1879048192`) se o hit ratio > 99%; senão 2048 e R2 | 3072 (`3221225472`)                                  | no prod-db-1 (12 GiB ou mais, a medir) |
| `trajetto-api`               | `trajetto-api:stable`         | `all` até C; `api` desde C | `api.intrajetto.com`, `/`                                 | 2 × 1024 (`1073741824`), heap 768 (576 desde a onda 12) | 2 × 1024              | 2 × 768 (`805306368`), heap 448                           | 3 × 768                                              | 3 × 768, depois pela ELU               |
| `trajetto-worker`            | `:stable-worker`              | `worker`                   | —                                                         | —                                                       | —                     | 1 × 1024, 1,5 CPU (`1500000000`), heap 512                | 1 × 1024                                             | 2 × 1024                               |
| `trajetto-scheduler`         | `:stable-scheduler`           | `scheduler`                | —                                                         | —                                                       | —                     | —                                                         | —                                                    | 1 × 320 (`335544320`)                  |
| `trajetto-worker-external`   | `:stable-worker-external`     | `worker-external`          | —                                                         | —                                                       | —                     | —                                                         | —                                                    | 1 × 384 (`402653184`)                  |
| `trajetto-realtime`          | `:stable-realtime`            | `realtime`                 | `api.intrajetto.com`, `/socket.io`                        | —                                                       | —                     | —                                                         | —                                                    | 2 × 512 (`536870912`)                  |
| `trajetto-ingest`            | `:stable-ingest`              | `ingest`                   | `api.intrajetto.com`, `/route/positions` (só com réplica) | —                                                       | —                     | —                                                         | —                                                    | 0 (pelo gatilho)                       |
| `trajetto-pgbouncer`         | `trajetto-pgbouncer:stable`   | —                          | —                                                         | —                                                       | —                     | —                                                         | 1 × 64 (`67108864`), 0,25 CPU (`250000000`), onda 17 | 1, depois 2 em nós diferentes          |
| `trajetto-ui`                | `trajetto-ui:stable`          | —                          | `www.intrajetto.com`                                      | 2 × 768 (`805306368`); 640 se o RSS de pico < 500       | 2 × 640 (`671088640`) | 2 × 512 (`536870912`) se o RSS de pico < 380              | 2 × 640                                              | 2 × 640                                |
| `trajetto-ai`                | `trajetto-ai`                 | —                          | —                                                         | 1 × 1024, 2 CPU (`2000000000`)                          | igual                 | igual                                                     | igual                                                | 2 × 1024 se a fila de OCR pedir        |
| Database `trajetto-redis`    | `redis:7-alpine`              | —                          | —                                                         | 512 (`536870912`), `maxmemory 256mb`                    | igual                 | igual                                                     | igual                                                | 512; ~1 GiB no 1M                      |
| `trajetto-api-migrate`       | `trajetto-api-migrate:stable` | release                    | —                                                         | 384 (`402653184`), transitório                          | igual                 | igual                                                     | igual                                                | igual                                  |
| `trajetto-offsite`           | `rclone@sha256`               | —                          | —                                                         | 64 (`67108864`)                                         | igual                 | igual                                                     | igual                                                | igual                                  |

**Staging**

| Application                  | Papel                | A                                                          | B                                                   | C                           | 2º VPS (onda 16 em diante)                      |
| ---------------------------- | -------------------- | ---------------------------------------------------------- | --------------------------------------------------- | --------------------------- | ----------------------------------------------- |
| Database `trajetto-postgres` | —                    | 576 (`603979776`), 0,5 CPU (`500000000`)                   | igual                                               | igual                       | 1024 (`1073741824`)                             |
| `trajetto-api`               | `all`; `api` desde B | 576 (`603979776`), 0,5 CPU (`500000000`), heap 400         | 576, heap 320                                       | 512 (`536870912`), heap 288 | 576                                             |
| `trajetto-worker`            | `worker`             | —                                                          | 448 (`469762048`), 0,25 CPU (`250000000`), heap 256 | 512, heap 224               | 512                                             |
| `trajetto-scheduler`         | `scheduler`          | —                                                          | —                                                   | —                           | 320 (`335544320`), 0,25 CPU (`250000000`)       |
| `trajetto-worker-external`   | `worker-external`    | —                                                          | —                                                   | —                           | 320 (`335544320`)                               |
| `trajetto-realtime`          | `realtime`           | —                                                          | —                                                   | —                           | 384 (`402653184`), 0,25 CPU (`250000000`)       |
| `trajetto-ingest`            | `ingest`             | —                                                          | —                                                   | —                           | 384 (`402653184`)                               |
| `trajetto-pgbouncer`         | —                    | —                                                          | —                                                   | —                           | 32 (`33554432`), 0,1 CPU (`100000000`), onda 17 |
| `trajetto-ui`                | —                    | 320 (`335544320`), 0,25 CPU (`250000000`)                  | igual                                               | igual                       | 384                                             |
| `trajetto-ai`, sempre ligada | —                    | 768 (`805306368`), 1 CPU (`1000000000`)                    | igual                                               | igual                       | 1024                                            |
| Database `trajetto-redis`    | —                    | 160 (`167772160`), 0,1 CPU (`100000000`), `maxmemory 64mb` | igual                                               | igual                       | 192 (`201326592`)                               |
| `trajetto-api-migrate`       | release              | 384 (`402653184`), transitório                             | igual                                               | igual                       | 384                                             |

As somas por fase, as réguas R1 e R2, a CPU e o disco estão na
[seção 23](#23-recursos-da-vps-e-logs);
`tests/unitaires/lifecycle/role-guide.test.ts` confere que elas saem
destas tabelas e que cada valor em bytes é o MiB da célula.

### Staging com 2 réplicas (plano de 02/11/2026, K15; decisão D53)

O código está pronto para N réplicas, mas o staging roda com 1: os caminhos
entre réplicas nunca rodam antes da produção. Para a validação (cenário S6):

1. **Antes de subir**: `free -m` na VPS (cada réplica tem até 1 GiB, _Memory
   Limit_ da [seção 7.7](#77-trajetto-api-application)) e o orçamento de
   conexões, `réplicas × 11 + migrations (2) + ferramentas < max_connections`
   (`SHOW max_connections;`, 100 por padrão: com 2 réplicas, 24 + ferramentas).
2. **Local, antes do staging**: o harness da API com duas réplicas atrás do
   Traefik, `bash tests/load/multi-replica.sh` (`tests/load/README.md`):
   balanceamento, rate limit compartilhado, fila sem lease vencido, evento de
   uma réplica no socket da outra, fila sem duplicata e vazão.
3. **No Dokploy**: _Advanced → Cluster Settings → Replicas_ `2` e, se a versão
   tiver, _Stop Grace Period_ `40000000000` (40 s) → **Save** → **Deploy**.
   Não configure health check no Traefik (ver a lacuna da
   [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)):
   o Swarm só põe a réplica no balanceamento depois da liveness.
4. **No staging, com as duas de pé**: socket conectado numa réplica e evento
   gerado na outra (a torre recebe a parada resolvida pelo app); os crons
   novos rodam uma vez por horário:
   ```sql
   SELECT "jobName", "scheduledFor", count(*)
     FROM scheduled_job_execution
    WHERE "jobName" IN ('alert-routes-left-open', 'geocode-deliveries')
    GROUP BY 1, 2 HAVING count(*) > 1;   -- tem de voltar vazio
   ```
   e uma rota esquecida em andamento gera **um** aviso aos administradores
   (`route.left_open:<id>` em `domain_outbox_event`), mesmo com as duas
   réplicas varrendo.

**Estado em memória (auditoria K15, 03/11/2026).** Nada de dado de empresa
mora num processo, a não ser a foto da torre (plano de escala F4-11), de até
10 s e com a permissão conferida antes, e a do dashboard (F4-23), de até
60 s, por empresa e pelo que o perfil pode ver. O resto do que fica em memória é de
plataforma ou é limite por réplica documentado como tal:

| O quê                                                                                                                   | Onde                                                                                                                   | Por que é seguro com N réplicas                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rate limit, ticket do socket, limite de handshakes, cota de e-mail                                                      | Redis (janela fixa, falha aberta; o ticket, de uso único, falha fechado)                                               | compartilhado entre as réplicas                                                                                                                                                                                                                                                                                           |
| orçamento, pausa e vaga do geocodificador; contagens, pausa e cache da busca de endereço                                | Redis (`geocoding:*`, falha fechada)                                                                                   | compartilhado entre as réplicas, sob o mesmo prefixo (`geocoding-keys.ts`); o cache da busca é por empresa, com chave HMAC e valor cifrado                                                                                                                                                                                |
| filas (outbox, IA, webhooks, geocodificação, importação), crons, aviso de rota esquecida                                | Postgres (`SKIP LOCKED`, lease do cron, carimbo `left_open_alerted_at`, chave única do outbox)                         | cada linha é reivindicada por uma réplica só; provado em `cron-scheduler-lock`, `delivery-geocoding-repository-contract` e `route-close-with-pending-http`                                                                                                                                                                |
| snapshots de plataforma (prontidão dos provedores, painel do MASTER)                                                    | memória da réplica + Redis (`snapshot-cache.ts`)                                                                       | sem empresa na chave; alguns segundos de defasagem                                                                                                                                                                                                                                                                        |
| exportações simultâneas, escrita de `last_used_at` da chave de API, contagem de uso da API, pausa de modelo do WhatsApp | memória da réplica (`export-slots.ts`, `last-used-throttle.ts`, `api-usage-recorder.ts`, `meta-cloud-api-provider.ts`) | limites e buffers por réplica, documentados no próprio arquivo: N réplicas = N vezes o teto; o uso da API soma com `increment`                                                                                                                                                                                            |
| a foto da torre, do resumo e da primeira página do `/route/live`                                                        | memória da réplica (`tenant-snapshot.ts`, `TOWER_SNAPSHOT_TTL_MS`; adendo de 19/11/2026 do ADR 0002)                   | por empresa, com a permissão e a empresa conferidas antes de cada leitura; cada réplica lê a sua, no máximo uma vez por intervalo (10 s); `0` desliga                                                                                                                                                                     |
| os números da visão geral e as tendências do dashboard                                                                  | memória da réplica (`tenant-snapshot.ts`, `DASHBOARD_SNAPSHOT_TTL_MS`; adendo de 19/11/2026 do ADR 0002)               | por empresa e pelo que o perfil de quem vê pode ver (as séries e cada bloco), com o papel e a sessão conferidos antes de cada leitura; dois perfis só dividem uma cópia quando veriam os mesmos números; as atividades recentes são lidas a cada visita; cada réplica lê a sua, no máximo uma vez por minuto; `0` desliga |
| formatadores de data, modelos de e-mail compilados, chaves do JWT                                                       | memória da réplica                                                                                                     | derivados do código ou do segredo, iguais em toda réplica                                                                                                                                                                                                                                                                 |

### Ensaio de carga na staging (burn-in)

Curto e limitado, para provar na staging a fiação e o rolling sem 5xx
(plano de escala LOAD-09), nunca capacidade: a staging divide a VPS com a
produção. O roteiro é `tests/load/staging-burn-in.sh` (como ele recusa e
aborta: [`tests/load/README.md`](../tests/load/README.md), "Burn-in na
staging"); o mesmo rolling já foi ensaiado antes num Swarm local
(`tests/load/swarm-rolling.sh`).

**Uma vez, antes do primeiro ensaio (dono):**

1. Na web de staging, como MASTER: crie a empresa com a razão social (ou o
   nome fantasia) exatamente `Carga (staging)`, com o módulo Entregas, e
   ponha o limite de veículos dela em pelo menos 12 (um por motorista da
   fixture; `FIXTURE_DRIVERS`, padrão 12). Nas configurações da empresa, o
   checklist da rota fica "Nenhum". A fixture recusa qualquer empresa com
   outro nome.
2. Crie o administrador dela com um e-mail seu, entre uma vez pela web,
   confirme o e-mail, defina a senha e deixe o segundo fator desligado
   nesta conta (a fixture entra por e-mail e senha e recusa uma conta que
   peça código).

**A cada ensaio:**

1. Só de segunda a sábado, das 03:00 às 05:00 BRT (06:00–08:00 UTC, a
   `load-window` de [`operacao/jobs.md`](./operacao/jobs.md)), nunca no dia 1
   (ensaio de restauração). O roteiro recusa fora disso.
2. No host da VPS (precisa de `docker`, `curl` e `vmstat`), com a pasta
   `tests/load` deste repositório copiada para lá:

   ```bash
   export FIXTURE_ADMIN_EMAIL='<e-mail do administrador de Carga (staging)>'
   read -rs FIXTURE_ADMIN_PASSWORD; export FIXTURE_ADMIN_PASSWORD
   bash tests/load/staging-burn-in.sh            # 20 req/s por 10 min
   ```

   A senha vai ao contêiner da fixture pelo nome da variável, nunca na
   linha de comando. Tetos: `BURN_IN_RATE` até 30, `BURN_IN_DURATION` até
   `10m`, `BURN_IN_MAX_VUS` até 200.

3. Com o k6 rodando, no Dokploy: staging → `trajetto-api` → **Deploy** (o
   _Redeploy_). O veredito é **zero respostas 5xx** com a troca das
   réplicas no meio da carga; confira também a linha `shutdown complete`
   de cada réplica antiga em _Logs_.
4. Saída 0: aprovado. 1: houve 5xx, sem resposta ou fora do esperado (o
   resumo do k6 diz em qual superfície). 2: recusou começar (a mensagem diz
   por quê). 3: uma sonda abortou tudo, a readiness da produção piorou
   (p95 acima de 2× a base ou 3 falhas) ou o host ficou com iowait acima de
   20% ou steal acima de 10%: não repita na mesma noite. A base e a sonda
   são o p95 de 12 amostras, e o limite nunca fica abaixo de 20 ms (o dobro
   de uma base de poucos ms é ruído): de uma base de 10 ms para cima, vale
   exatamente o 2×. O piso muda com `BURN_IN_PROBE_FLOOR_MS`, até 50; o
   roteiro recusa mais que isso, para a sonda nunca ficar desligada.

Os contêineres saem com o roteiro (`--rm`); os dados da empresa de carga
ficam e são reaproveitados na próxima vez (rotas do dia, veículos e
motoristas pelo nome e pela placa).

### Frota de sockets pela borda (LOAD-05)

Os sockets da staging pela Cloudflare e pelo Traefik, à mão, para provar a
conexão, as quedas e a volta depois de um _Redeploy_ (plano de escala
LOAD-05), nunca capacidade. O roteiro é o `tests/load/socket-fleet.mjs`
com `--via-edge` (como ele planeja, recusa e julga:
[`tests/load/README.md`](../tests/load/README.md), "Frota de sockets").
Os sockets passam pelo Traefik e pelo conntrack que a produção usa, por
isso os tetos próprios, que o roteiro recusa antes de conectar: rampa de
até 20 handshakes/s, até 10 minutos, só na `load-window` (06:00–08:00 UTC,
nunca no dia 1 nem no domingo) e, na VPS única, até **1.000 sockets**
(5.000 só depois do G-03, com `FLEET_EDGE_TOPOLOGY=second-vps`). As sondas
são as do burn-in: a readiness da produção (p95 acima de 2× a base ou 3
falhas) e o iowait ou o steal do host, lidos do `/proc/stat`.

**Uma vez (dono):** a empresa `Carga (staging)` e o administrador dela, do
burn-in acima, com o limite de veículos em pelo menos 50 (a fixture cria
um por motorista).

**A cada ensaio**, no host da VPS, com a pasta `tests/load` copiada:

1. Os tokens: a fixture com 50 motoristas, pela borda (51 tokens com o
   administrador; valem 15 minutos, então rode logo antes):

   ```bash
   export FIXTURE_ADMIN_EMAIL='<e-mail do administrador de Carga (staging)>'
   read -rs FIXTURE_ADMIN_PASSWORD; export FIXTURE_ADMIN_PASSWORD
   NODE_IMAGE=node:22.21.1-alpine3.23@sha256:0340fa682d72068edf603c305bfbc10e23219fb0e40df58d9ea4d6f33a9798bf
   export FLEET_CONTEXT_JSON="$(docker run --rm -i --network host \
     --cpus 0.5 --memory 256m -e FIXTURE_ADMIN_EMAIL -e FIXTURE_ADMIN_PASSWORD \
     -e FIXTURE_BASE_URL=https://api-staging.intrajetto.com -e FIXTURE_DRIVERS=50 \
     "$NODE_IMAGE" node --input-type=module - < tests/load/staging-fixture.mjs)"
   ```

2. A frota, num contêiner limitado na rede do host (a origem é o IP da
   VPS, e a sonda da produção vai ao Traefik do próprio host):

   ```bash
   FLEET='cd /tmp && npm install --silent --no-save --ignore-scripts socket.io-client@4.8.4 > /dev/null && SOCKET_IO_CLIENT_ENTRY=/tmp/node_modules/socket.io-client/build/esm/index.js node /load/socket-fleet.mjs --via-edge'
   docker run --rm -i --name trajetto-socket-fleet --network host \
     --cpus 0.5 --memory 512m -v "$PWD/tests/load:/load:ro" \
     -e FLEET_CONTEXT_JSON -e FLEET_URL=https://api-staging.intrajetto.com \
     -e FLEET_SOCKETS=1000 -e FLEET_SOCKETS_PER_TOKEN=20 \
     "$NODE_IMAGE" sh -c "$FLEET" > fleet.json
   ```

   De uma origem só, a rampa sobe a 4 handshakes/s (o compassador deixa a
   origem abaixo de 300 por minuto): 1.000 sockets em uns 250 s.

3. Com restart, troque o tamanho do passo 2 por estas três variáveis (de
   uma origem, só 240 sockets voltam dentro do minuto do orçamento):

   ```bash
   -e FLEET_SOCKETS=240 -e FLEET_RESTART_AFTER_S=60 -e FLEET_RESTART_WINDOW_S=240
   ```

   Na hora que o roteiro imprime (`restart às ...`), no Dokploy: staging →
   `trajetto-api` → **Deploy**. A janela de 240 s cobre o _Redeploy_ até a
   réplica antiga sair.

4. Saída 0: aprovado. 1: reprovado (o `fleet.json` diz qual critério). 2:
   recusou começar (a mensagem diz por quê). 3: uma sonda abortou tudo:
   não repita na mesma noite.

Depois do G-03 (staging no 2º VPS), os 5.000 sockets pedem
`FLEET_EDGE_TOPOLOGY=second-vps`, pelo menos 5 origens
(`FLEET_SOURCE_ADDRESSES`, ou `FLEET_SHARD` em várias máquinas com o mesmo
`FLEET_START_AT`, e o `merge`) e mais motoristas que os 50 da fixture.

### Conexões presas

503 com `Query read timeout` (o `socket_timeout`; `err.reason` =
`query-timeout`) ou `timeout exceeded when trying to connect` (pool cheio;
`err.reason` = `pool-timeout`) no log, com o banco de pé (no Prisma 6:
`P1008`/"Operations timed out after `60s`" ou `P2024`):

```sql
SELECT pid, state, wait_event_type, wait_event, now() - state_change AS há,
       left(query, 80)
  FROM pg_stat_activity
 WHERE datname = current_database() AND backend_type = 'client backend'
 ORDER BY state_change;
```

**Deploy** da Application `trajetto-api` (ou `docker service update --force
trajetto-api-production`) recria as réplicas (start-first) e zera os pools.

## 20. Alertas e monitoramento

O sinal é **empurrado** para fora, não lido por um robô em `/health/metrics`.

Os SLOs propostos, a fonte de cada um e a regra dos alertas (limiares fixos
até haver 30 dias de `ops_sample`, depois burn rate em duas janelas) estão em
[slo.md](./slo.md).

### Dead man's switch (`ops-heartbeat`, a cada minuto)

Uma réplica por minuto lê o estado da operação, aplica as regras de
`src/shared/health/alert-rules.ts` e: tudo certo → `GET HEALTHCHECK_PING_URL`;
alguma regra quebrou → `POST <ping>/fail` com os motivos, um por linha, em
pt-BR (com `HEALTHCHECK_FAIL_URL`, `GET` nela com os motivos no `msg`); banco
fora, processo morto, scheduler parado → **nenhum ping** (o silêncio é o
alerta). Sem `HEALTHCHECK_PING_URL` os motivos só vão para o log
(`operational check failed`).

| Regra                                       | Dispara quando                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Outbox                                      | evento **devido** esperando > 5 min                                                                                                                                                                                                                                                                                                                     |
| Entregas internas (in-app, push, atividade) | entrega devida esperando > 5 min                                                                                                                                                                                                                                                                                                                        |
| Entregas externas (e-mail, WhatsApp)        | entrega devida esperando > 15 min                                                                                                                                                                                                                                                                                                                       |
| Webhooks                                    | linha devida esperando > 30 min                                                                                                                                                                                                                                                                                                                         |
| IA                                          | análise devida esperando > 15 min                                                                                                                                                                                                                                                                                                                       |
| Credencial                                  | primeira entrega FAILED nos últimos 10 min com erro de credencial (WhatsApp 401/403/190, SMTP EAUTH/535/530, push 401/403)                                                                                                                                                                                                                              |
| Rajada                                      | 50 entregas FAILED do mesmo canal em 10 min                                                                                                                                                                                                                                                                                                             |
| IA credencial                               | análise FAILED/PARTIAL com `authentication_error`/401/403                                                                                                                                                                                                                                                                                               |
| Cron                                        | job sem sucesso há 26 h, que rodou e nunca teve sucesso, ou com lease vencido; um expurgo parcial só depois de 26 h só de parciais (a primeira não alerta)                                                                                                                                                                                              |
| Partições                                   | uma tabela do registro de partições (hoje, `driver_position` e `driver_position_v2`) com menos de 3 dias de partições à frente (`partition-runway-low`) ou, antes, com menos de 5 (`partition-lookahead-low`); uma partição que passou da retenção há mais de 3 dias e continua no banco (`partition-stuck`)                                            |
| Worker travado                              | heartbeat sem progresso há 10 min numa réplica viva                                                                                                                                                                                                                                                                                                     |
| Postgres                                    | conexões ≥ 80 % de `max_connections`                                                                                                                                                                                                                                                                                                                    |
| Sockets por réplica                         | os sockets de uma réplica em 80% ou mais do teto dela (`socket_cap`, o menor entre `SOCKET_MAX_CONNECTIONS` e o limite de descritores menos `SOCKET_FD_RESERVE`), pela linha mais nova do `ops_sample` dela nos últimos 3 min (`socket-cap-high`)                                                                                                       |
| Orçamento de memória                        | a soma do heap principal, das threads da planilha e da reserva nativa de um processo passa do teto do contêiner (`memory.max`), pela linha mais nova do `ops_sample` dele nos últimos 3 min (`memory-budget`; o boot avisa com `MEMORY_BUDGET_MODE=warn` e recusa com `enforce`)                                                                        |
| Fila sem consumidor                         | uma fila (outbox, entregas internas ou externas, webhooks, IA) com item devido há mais de 2 min e nenhum processo vivo deste ambiente no `process_heartbeat` que a consuma (`queue-no-consumer`; com a api em `PROCESS_ROLE=api` e o worker fora, chega em até 3 min)                                                                                   |
| Versões misturadas                          | os processos vivos deste ambiente em dois ou mais commits há mais de 30 min, contados de quando o commit mais novo apareceu (`mixed-versions`)                                                                                                                                                                                                          |
| Processo de outro ambiente                  | uma linha viva do `process_heartbeat` com outro `APP_ENV` (um processo da staging no banco da produção, ou o contrário) (`foreign-environment`)                                                                                                                                                                                                         |
| Redis                                       | sem resposta ao PING em 2 s                                                                                                                                                                                                                                                                                                                             |
| Certificado do comprovante                  | vence em 30 dias (aviso) / 7 dias (crítico), vencido ou inválido                                                                                                                                                                                                                                                                                        |
| PITR esperado                               | `PITR_EXPECTED=true` e `archive_mode` diferente de `on` (sem a variável, nunca)                                                                                                                                                                                                                                                                         |
| Arquivamento do WAL                         | com o arquivamento ligado: último segmento arquivado há mais de 300 s, ou a última tentativa falhou (falha mais nova que o último sucesso)                                                                                                                                                                                                              |
| xid                                         | `age(datfrozenxid)` do cluster acima de 1 bilhão                                                                                                                                                                                                                                                                                                        |
| Escrita longa                               | transação de escrita aberta há mais de `LONG_WRITE_XACT_ALERT_SECONDS` (120 s), em qualquer banco do cluster                                                                                                                                                                                                                                            |
| `pg_wal`                                    | acima de `PG_WAL_ALERT_GIB` (12 GiB; 8 na VPS única); só com superusuário ou `pg_monitor`                                                                                                                                                                                                                                                               |
| Despejo do Redis                            | `evicted_keys` cresceu desde a linha `cluster` do `ops_sample` de 15 a 20 min atrás (sem essa linha, não compara)                                                                                                                                                                                                                                       |
| Teto do Redis                               | Redis respondendo sem `maxmemory` ou com `maxmemory-policy noeviction`                                                                                                                                                                                                                                                                                  |
| Métricas do banco                           | a leitura principal (`core`) ou a do `pg_wal` falhou: as regras acima ficam cegas                                                                                                                                                                                                                                                                       |
| Volume de entregas                          | as entregas dos últimos 7 dias, projetadas para o mês (× 30/7), acima de 70% de `APPROVED_GATE_MONTHLY_DELIVERIES` (10 000); ou as das últimas 24 h acima de `PLATFORM_DAILY_DELIVERY_SOFT_CAP` (vazio = sem teto). Só alerta                                                                                                                           |
| PgBouncer                                   | só com `PGBOUNCER_STATS_URL` na Application que roda o cron (onda 17, F4-36): uma tarefa sem resposta ao `SHOW` em 2 s ou nenhum endereço (`pgbouncer-down`); um cliente esperando conexão de servidor há 2 s ou mais (`pgbouncer-clients-waiting`); as conexões de servidor de um banco em 80% do `max_db_connections` (`pgbouncer-server-saturation`) |

Limiares em `DEFAULT_ALERT_THRESHOLDS` (`alert-rules.ts`); os de escrita
longa e de `pg_wal` vêm das variáveis. As regras do banco e do Redis leem os
números da linha `cluster` do minuto, lidos antes do ping (com
`OPS_SAMPLE_ENABLED=false` elas continuam valendo, menos a do despejo, que
precisa das linhas para comparar).

Cada motivo tem um código estável e termina com o caminho do runbook dele,
`(runbook: docs/runbooks/<código>.md)`: o que o alerta significa, a primeira
ação, como confirmar e quando escalar ([índice dos runbooks](./runbooks/README.md)).
Os códigos ficam em `ALERT_KINDS` (`alert-rules.ts`), e um código novo sem
runbook reprova o `runbooks.test.ts`. A tabela "Primeira ação por motivo",
mais abaixo, é o resumo.

### Ligar (uma vez)

1. Um check de heartbeat num serviço **externo** (healthchecks.io, Better
   Stack ou Cronitor): período 1 min, tolerância 5 min. Uptime Kuma também
   serve (monitor "Push").
2. Notificações desse check para um canal que **não** seja o Resend nem a Meta
   (Telegram, Slack, e-mail do próprio serviço).
3. `HEALTHCHECK_PING_URL` no _Environment_ da Application `trajetto-api` (ex.
   `https://hc-ping.com/<uuid>`). A URL é segredo: quem a tem pode silenciar
   o alerta.
4. Uptime Kuma: `HEALTHCHECK_PING_URL=https://<kuma>/api/push/<token>?status=up&msg=OK`
   e `HEALTHCHECK_FAIL_URL=https://<kuma>/api/push/<token>?status=down`.
5. Depois do deploy, confira um ping por minuto no painel. Para testar o
   `/fail`, pare o Redis de staging (_Stop_ no Database) por dois minutos.
6. **Uptime externo**: monitores HTTP de `https://<host da API>/health/readiness`
   e `https://www.intrajetto.com/api/health` (1 min, alerta após 2 falhas) e da
   expiração do TLS dos dois hosts (14 dias).
7. O backup do banco não tem heartbeat: a falha chega pela notificação do
   próprio Dokploy (_Settings → Notifications_, evento de backup de
   Database), como na [seção 18](#18-backup-e-restauração).

### Primeira ação por motivo

| Motivo começa com                                        | Primeiro passo                                                                                                                                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Canal WHATSAPP: falha de credencial`                    | token da Meta vencido/revogado: gerar token de sistema novo no Business Manager e atualizar `META_WHATSAPP_ACCESS_TOKEN`; as falhas estão em `/health/dead-letter?channel=WHATSAPP`                                                 |
| `Canal EMAIL: falha de credencial`                       | chave do Resend revogada ou domínio desverificado                                                                                                                                                                                   |
| `Canal PUSH: falha de credencial`                        | a credencial FCM V1 do projeto no EAS (`eas credentials`), ou o _Enhanced Security for Push Notifications_ ligado no projeto Expo: a API não envia token de acesso da Expo                                                          |
| `Canal X: N entregas falharam de vez`                    | abrir o dead letter do canal e ler o prefixo `[... code=...]` mais comum                                                                                                                                                            |
| `Outbox` / `Entregas` / `Webhooks` / `Análises de IA`    | `workers` em `/health/metrics` e o log da réplica; reiniciar a task travada                                                                                                                                                         |
| `... nenhum processo vivo deste ambiente consome a fila` | o worker caiu ou não existe: `process_heartbeat` vivo e a Application `trajetto-worker` no Dokploy; para voltar a como era, `PROCESS_ROLE=all` na `trajetto-api` ([runbook](./runbooks/queue-no-consumer.md))                       |
| `Processos deste ambiente em N commits`                  | um papel ficou no build anterior: o último deploy da Application dele e o secret `DOKPLOY_<PAPEL>_APPLICATION_ID` ([runbook](./runbooks/mixed-versions.md))                                                                         |
| `N processo(s) de APP_ENV=`                              | uma Application do outro ambiente com a `DATABASE_URL` deste: pare-a primeiro, depois corrija a URL ([runbook](./runbooks/foreign-environment.md))                                                                                  |
| `Cron X`                                                 | `cron_jobs` em `/health/metrics` traz `last_error`; o catch-up refaz jobs diários a cada hora. `Cron X: só execuções parciais` = o expurgo não dá conta do que entra: ver [Expurgos parciais](#expurgos-parciais)                   |
| `driver_position` (ou outra tabela do registro)          | `partitions.<tabela>` em `/health/metrics` (`lookahead_days`, `stuck`, `owner_ok`); rodar o job `partition-maintenance` (idempotente) e ver por que falhou no log                                                                   |
| `Postgres`                                               | `runtime.prisma_pool` em `/health/metrics`; réplicas × `connection_limit`                                                                                                                                                           |
| `Redis`                                                  | a API segue (fail-open), mas o rate limit fica local e o Socket.IO não cruza réplicas                                                                                                                                               |
| `Certificado ICP do comprovante vence em`                | renovar o A1 antes da data e trocar `PROOF_SIGNING_PFX_*`; `proof_signing` em `/health/metrics` mostra `not_after` e `days_left`                                                                                                    |
| `Certificado ICP ... vencido` / `inválido`               | os comprovantes saem sem assinatura (e dizem isso); `PFX_UNREADABLE` = senha errada ou arquivo corrompido, `PFX_FILE_UNREADABLE` = o arquivo não montou                                                                             |
| `PITR esperado`                                          | o Database perdeu o `PITR_ARCHIVE=on` ou ganhou um _Command_/_Args_ que apaga o `CMD` da imagem; `SHOW archive_mode` no banco                                                                                                       |
| `Arquivamento do WAL`                                    | `SELECT * FROM pg_stat_archiver` e o log do Database (o `archive-push` diz por que falhou); R2 fora ou chave errada fazem o `pg_wal` crescer                                                                                        |
| `Postgres: idade do xid`                                 | `SELECT datname, age(datfrozenxid) FROM pg_database ORDER BY 2 DESC` e o autovacuum da tabela mais velha                                                                                                                            |
| `Postgres: transação de escrita aberta`                  | `SELECT pid, now() - xact_start, state, left(query, 80) FROM pg_stat_activity WHERE backend_xid IS NOT NULL ORDER BY 2 DESC`; uma sessão esquecida no `psql` termina com `pg_terminate_backend(pid)`                                |
| `Postgres: pg_wal com`                                   | o arquivamento primeiro (se parado, o WAL não sai), depois um slot de replicação abandonado (`pg_replication_slots`)                                                                                                                |
| `Redis despejou` / `Redis sem teto` / `noeviction`       | o comando personalizado do Database Redis ([seção 10](#10-postgres-e-redis)): `--maxmemory 256mb --maxmemory-policy allkeys-lru`; despejo com o teto certo = memória no limite, ver `used_memory_mb` em `/health/metrics`           |
| `Verificação incompleta: métricas do banco`              | o SQLSTATE diz quem recusou (`57014` = `statement_timeout`, `42501` = permissão)                                                                                                                                                    |
| `Volume de entregas`                                     | segurar a próxima coorte da rampa; subir `APPROVED_GATE_MONTHLY_DELIVERIES` só com um relatório de portão novo em `docs/desempenho` ([runbook](./runbooks/volume-near-gate.md))                                                     |
| `Geocodificação: N consultas hoje`                       | ver o gasto do dia por escopo em `provider_quota_day` e corrigir `LOCATIONIQ_DAILY_QUOTA` ou os orçamentos pela tabela da decisão D40 ([runbook](./runbooks/geocoding-quota-high.md))                                               |
| `Provedores recusaram por taxa`                          | ligar o balde de taxa do provedor (`WHATSAPP_SENDS_PER_SECOND`, `EMAIL_REQUESTS_PER_SECOND`, `PUSH_NOTIFICATIONS_PER_SECOND`) abaixo do contrato, ou baixar o valor se já está ligado ([runbook](./runbooks/provider-throttled.md)) |
| `Feed da integração: o maior txid`                       | um restore lógico num cluster novo sem o `pg_resetwal -e`: API em 0 réplicas, a época certa e o `pg_resetwal` com o Database parado ([runbook](./runbooks/feed-txid-regressed.md))                                                  |
| `Época do cluster`                                       | um PITR, um promote ou um cluster novo que a etapa de release ainda não viu: **Deploy** na `trajetto-api-migrate` (ou _Run workflow_ com `force_release`) ([runbook](./runbooks/cluster-epoch-stale.md))                            |
| `Feed da integração: N cursor(es) de outra época`        | esperado logo depois de um PITR, promote ou restore: avisar os clientes de polling que um trecho de eventos veio de novo e deve ser deduplicado pelo `id` ([runbook](./runbooks/feed-epoch-conversion.md))                          |
| `PgBouncer sem resposta` / `sem endereço`                | `pgbouncer.instances[].error` em `/health/metrics`: a tarefa fora, a senha de estatística diferente nos dois lados ou o nome de `PGBOUNCER_STATS_HOSTS` ([runbook](./runbooks/pgbouncer-down.md))                                   |
| `PgBouncer com cliente esperando`                        | o pool cheio: o Postgres lento ou um `PAUSE` esquecido; aos 5 s a API responde 503 `SERVICE_BUSY` ([runbook](./runbooks/pgbouncer-clients-waiting.md))                                                                              |
| `PgBouncer usando N% das conexões de servidor`           | o banco perto do `max_db_connections`: quais logins ocupam em `pgbouncer.instances[].pools` ([runbook](./runbooks/pgbouncer-server-saturation.md))                                                                                  |

Para trocar uma variável: _Environment_ da Application → **Save** →
**Deploy** (salvar sozinho não reinicia o contêiner).

### Séries de operação (`ops_sample`)

A régua do plano de escala: cada processo da API grava **uma linha por
minuto** na tabela `ops_sample`, de 0 a 15 s depois do fim do minuto (um
timer local com sorteio, nunca um cron, para que toda réplica grave), com os
mesmos números da linha de log `runtime metrics`: laço de eventos, threadpool,
memória, CPU por requisição (`cpu.ms_per_request`: a CPU do processo no
minuto dividida pelas requisições fora de `/health`, `null` sem requisição;
`cpu.includes_workers` diz se o trabalho das filas está junto), pool do Prisma, provedores chamados no minuto, sockets e o portão
do bcrypt (`src/shared/health/ops-sample.ts`), mais a seção `http`: as
respostas do minuto por classe de status e o histograma de latência de cada
grupo de rota, só dos grupos com requisição, e os `contract=` do app nos
`POST /route/positions` dos últimos 10 minutos, só das sessões de motorista
e do 426 do portão de versão, nunca de um 401
(`src/shared/health/http-metrics.ts`), e a seção `deliveries`: as entregas
que o processo criou no minuto (`created`), contadas depois de cada commit
(criação no painel, pela integração, planilha e XML;
`src/shared/health/volume-gauge.ts`), e a seção `shedding`: as requisições
que chegaram com a réplica ocupada (`under_pressure`, e o que estava ocupado
em `reasons`) e, por grupo de rota, o que o descarte de carga recusou
(`shed`) ou recusaria no `SHED_MODE=observe` (`would_shed`;
`src/shared/http/load-shedding.ts`), e a seção `panel_budget`: o que o
orçamento do painel por empresa cobrou, recusou ou recusaria no
`TENANT_PANEL_BUDGET_MODE=observe`, na fatia da pessoa (`user`) e na
empresa (`tenant`; `src/shared/integration/panel-budget.ts`). As colunas dizem de quem é a
linha: `role` (o `PROCESS_ROLE` do processo: `all`, `api`, `worker`…; as
linhas de antes da onda 12 dizem `http` para uma réplica sem workers),
`replica` (o hostname do contêiner, mais `/<slot>` com `SWARM_TASK_SLOT`) e
`commit`. Com as variáveis de identidade do Swarm no _Environment_ da
`trajetto-api`, digitadas como os modelos do próprio Swarm
(`SWARM_NODE_HOSTNAME={{.Node.Hostname}}`, `SWARM_TASK_SLOT={{.Task.Slot}}`,
`SWARM_SERVICE_NAME={{.Service.Name}}`), a linha leva também
`metrics.swarm` (`node`, `task_slot`, `service`) e as linhas de log levam
`swarm_node`, `swarm_task_slot` e `swarm_service`; sem elas, nada muda. Só
números de infraestrutura: nunca empresa, IP nem id de pessoa. São cerca de 1.440
linhas por processo por dia, guardadas por `OPS_SAMPLE_RETENTION_DAYS` (30)
dias: o cron `purge-ops-series` (04:40 UTC) apaga as mais velhas em lotes,
com a execução parcial dos [expurgos](#expurgos-parciais). Uma gravação que falha vira um aviso
(`ops sample write failed`) e o processo segue servindo; `OPS_SAMPLE_ENABLED=false`
desliga a gravação sem tirar a linha de log. Não há rota: a leitura é pelo
`psql`.

Além das linhas de cada processo, há **uma linha `cluster` por minuto**, de
todo o ambiente: a réplica que vence a eleição do `ops-heartbeat` a grava
depois do ping, com o `ts` do minuto eleito (duas réplicas no mesmo minuto
deixam uma linha só). Ela leva a latência das filas (outbox, as duas faixas
de entregas, webhooks, IA), os workers travados e a folga das partições, os
números do próprio banco (uso de conexões, idade do xid, escrita e snapshot
mais antigos, `archive_mode` e o `pg_stat_archiver`, `pg_wal`, os contadores
do cache, `pg_stat_statements`) e o Redis inteiro de `/health/metrics`; a
cada 15 minutos (:00, :15, :30, :45), também os tamanhos e as tabelas
quentes. Ela soma, em `deliveries.created`, as entregas que as linhas dos
processos contaram desde a linha `cluster` anterior (um minuto atrás delas,
para a gravação de cada processo já ter chegado), e nos quartos de hora traz
também as somas das últimas 24 h e dos últimos 7 dias (`last_24h`,
`last_7d`, e `since`, o minuto mais antigo contado): é a régua de rampa do
alerta de volume. É a linha-marcador do ensaio de PITR: uma restauração até T tem a
linha `cluster` do minuto de T. Os números do banco e do Redis são lidos uma
vez, antes do ping, porque as regras de alerta também os julgam; uma leitura
que falha vira `null` (e, nas partes do banco que as regras leem, um motivo
`Verificação incompleta`). Uma gravação que falha vira o aviso
`cluster ops sample write failed`, sem atrasar o ping. `OPS_SAMPLE_ENABLED=false`
desliga a gravação; as leituras continuam, para os alertas.

```sql
-- utilização do laço e espera no pool por réplica, na última hora
SELECT replica, ts,
       (metrics->'event_loop'->>'utilization')::float8 AS elu,
       (metrics->'prisma_pool'->>'waiting')::int AS pool_waiting
FROM ops_sample
WHERE ts > now() - interval '1 hour'
ORDER BY replica, ts;

-- a escrita aberta mais antiga e o pg_wal, minuto a minuto, na última hora
SELECT ts,
       (metrics->'database'->>'oldest_write_xact_seconds')::float8 AS escrita_s,
       (metrics->'database'->'pg_wal'->>'bytes')::float8 / 1048576 AS pg_wal_mb
FROM ops_sample
WHERE role = 'cluster' AND ts > now() - interval '1 hour'
ORDER BY ts;

-- respostas 5xx por minuto, somando as réplicas, nas últimas 24 h
SELECT date_trunc('minute', ts) AS minuto,
       sum((metrics->'http'->'classes'->>'5xx')::int) AS erros_5xx,
       sum((metrics->'http'->>'requests')::int) AS requisicoes
FROM ops_sample
WHERE ts > now() - interval '24 hours' AND role <> 'cluster'
GROUP BY 1
ORDER BY 1;
```

### Custo das consultas (`pgss_snapshot`)

De hora em hora (:13), a réplica que vence a eleição do cron
`snapshot-query-stats` lê o `pg_stat_statements` deste banco e grava em
`pgss_snapshot` o que cada uma das `PGSS_SNAPSHOT_TOP` (200) consultas mais
caras da hora custou, por role (`userid`): chamadas, tempo de execução e de
planejamento, linhas, blocos e WAL. A view é acumulada, então cada linha é a
diferença contra a leitura anterior (guardada em `pgss_baseline`; o que a
última leitura viu da extensão fica em `pgss_state`). A coluna `basis` diz
como a diferença foi tirada: `previous` (contra a hora anterior), `new` (a
consulta entrou na view na hora), `recreated` (voltou depois de um despejo:
um contador abaixo da leitura anterior) ou `reset` (a primeira execução, ou
as estatísticas foram zeradas: o `period_start` é o `stats_reset`). O
`max_exec_time_ms` é o máximo acumulado da entrada, como o PG16 guarda. Um
despejo (`dealloc` subindo) vira o aviso `pg_stat_statements evicted
entries since the last snapshot`: as consultas que voltaram contam menos na
hora, e o caminho é um `pg_stat_statements.max` maior. Enquanto o servidor
não pré-carrega a biblioteca (a produção até a imagem nova do Postgres), o
cron não faz nada e avisa `query stats snapshot skipped`, sem falhar. O
texto das consultas pode ter literais: fica só no banco, e a leitura é pelo
`psql`. As linhas ficam `PGSS_SNAPSHOT_RETENTION_DAYS` (30) dias: o mesmo
`purge-ops-series` das 04:40 UTC as apaga, antes das do `ops_sample`
(e, antes de tudo, as linhas do `process_heartbeat` sem batida há 7
dias).

```sql
-- as 10 consultas que mais custaram nas últimas 24 h, por role
SELECT userid, queryid, sum(calls) AS chamadas,
       round(sum(total_exec_time_ms)::numeric, 1) AS exec_ms,
       max(max_exec_time_ms) AS maximo_ms, min(left(query, 80)) AS consulta
FROM pgss_snapshot
WHERE taken_at > now() - interval '24 hours'
GROUP BY 1, 2
ORDER BY exec_ms DESC
LIMIT 10;
```

**O custo de planejar (plano de escala, F2-22).** O alvo de estatística
1000 deixa as listas do planejador maiores, e o plano pede planejamento
p95 abaixo de 2 ms nas consultas quentes. O `pg_stat_statements` só mede o
planejamento com `track_planning`, que custa um pouco em toda consulta: ligue
por 7 dias depois da release com as estatísticas por empresa e desligue
depois. Fica no catálogo do banco, e não no `postgresql.auto.conf`; rode no
`psql` do Database com o usuário dono (o superusuário do contêiner):

```sql
ALTER DATABASE trajetto SET pg_stat_statements.track_planning = on;
-- sete dias depois
ALTER DATABASE trajetto RESET pg_stat_statements.track_planning;
```

Vale para as conexões novas: o pool troca as dele aos poucos, e um Deploy
da `trajetto-api` acelera. Nesses dias, `total_plan_time_ms / calls` no
`pgss_snapshot` dá o planejamento médio de cada consulta; acima de 2 ms
numa consulta quente, o caminho é baixar o alvo daquela coluna (um arquivo
novo em `prisma/concurrent` e a migration de mesmo nome).

### Expurgos parciais

Os expurgos noturnos (`cleanup-*` e `purge-ops-series`, 03:17–04:50 UTC,
os `refresh_token` vencidos inclusive) apagam em lotes e param no orçamento da execução (`CRON_PURGE_RUN_BUDGET_MS`, 5 min) ou no
teto de linhas de cada tabela. Se ainda houver linha vencida quando param
(uma sonda confere, para um teto batido junto com a última linha não contar),
a execução termina **FAILED com `last_error` começando por `[partial]`**,
com o nome do que sobrou, e não mais SUCCEEDED; o log diz `cron job partial:
stopped with work left` (aviso, não erro). Os passos seguintes do job rodam
mesmo assim, e os expurgos pequenos vão primeiro, para o grande não gastar o
orçamento deles.

O catch-up de hora em hora (:07) repete uma execução parcial **só dentro de
`CRON_PARTIAL_RETRY_WINDOW_UTC`** (06:00–09:00 UTC, depois dos backups das
05:00 e antes da manhã) e no máximo `CRON_PARTIAL_RETRIES_PER_DAY` vezes no
dia (3: às 06:07, 07:07 e 08:07); fora dela, a sobra espera a noite
seguinte. Uma falha que não é parcial segue a regra de antes (sem sucesso em
26 h, roda na próxima varredura, a qualquer hora). Em `/health/metrics`,
`cron_jobs[].last_partial` e `partial_since` mostram o estado; o alerta só
vem com 26 h só de parciais: aí o expurgo perde para o que entra, e o
caminho é olhar o volume da tabela e o tempo de cada lote antes de subir
o orçamento (que já está no máximo) ou o teto. A folga vale só enquanto
tudo o que rodou desde o último sucesso foi parcial: se uma falha de
verdade (um _statement timeout_, um lease vencido) veio no meio,
`partial_since` vem `null` e o job é julgado pelo último sucesso, como
qualquer falha; senão uma parcial depois de duas noites de erro calaria por
mais 26 h um job parado havia três dias. A imagem anterior, durante um
rolling deploy, lê a linha como um FAILED comum.

### Falhas que só o cliente vê

Ficam no log com formato fixo: `event: "client.diagnostics"` (app e navegador:
fila offline, últimos erros por tipo; `kind: "upload"` com 403 e o host do R2
em vários motoristas = credencial ou política do bucket); na web,
`source: "server-action"`; `presigned upload authorization failed` (nível
error, com o stack).

### Rastrear uma falha de ponta a ponta

`x-request-id` em toda resposta (e `requestId` no corpo do 500) →
`domain_outbox_event.correlationId` → a linha `notification delivery ...` do
worker (`deliveryId`, `outboxEventId`, `correlationId`) → o provedor
(`Resend-Idempotency-Key`, `biz_opaque_callback_data`) → o recibo em
`notification_provider_receipt` → `/health/dead-letter` (com `correlationId`).
Webhooks de clientes: `webhook event fanned out` liga o `correlationId` ao
`X-Trajetto-Event-Id`. IA: `ai analysis queued` liga ao `aiRequestId`. Os logs
não levam segredo (`logger.ts` censura toda credencial do env-schema; o teste
`provider-secret-redaction.test.ts` falha se uma variável nova com cara de
segredo ficar de fora). Os logs de cada Application ficam na aba _Logs_ dela
(ou `docker service logs <App Name>`), com a rotação do `daemon.json`.

### Prontidão dos provedores (`GET /health/providers`, só MASTER)

Sem enviar nada a ninguém e sem devolver segredo: Resend (`GET /domains`),
Meta (`GET /{phone_number_id}` e uma listagem só dos modelos, com
`META_WHATSAPP_BUSINESS_ACCOUNT_ID`: os 21 do código, cada um aprovado, em
pt_BR, UTILITY e com as variáveis e os botões que o código envia; MARKETING é
erro), Expo (avisa sem `EXPO_ACCESS_TOKEN`), R2 (`HeadBucket`; `local` em
produção é erro), trajetto-ai (`/health` e um `POST /v1/read` vazio), o
certificado e o heartbeat. `not_configured` traz `missing_env` com os nomes que
faltam. As sondas rodam em paralelo (o número da Meta junto com os
templates, o `/health` da IA junto com a conferência do token). Cada
tentativa tem até 3,5 s, o que cobre o reenvio de DNS do musl (2,5 s) mais
o handshake; depois de uma falha que pode passar sozinha (tempo esgotado,
rede, HTTP 5xx, resposta cortada ou ilegível) há no máximo mais uma, dentro
de 5 s por provedor. O cliente S3 da sonda tem `maxAttempts: 1`: quem decide
a repetição é a sonda. Uma recusa definitiva (chave, bucket, domínio) nunca é
repetida nem atenuada, e duas falhas seguidas continuam `error`. Cada
provedor diz `attempts`, `transient` (o veredito depende de uma condição
passageira: falha de uma tentativa, 429 ou resposta lenta, acima de 2 s) e
`failure_kind`. O relatório vale 30 s, ou 5 s quando algum provedor está
`transient`, e é compartilhado pelas réplicas pelo Redis (`cached` diz se
veio da foto); `refresh=true` sonda de novo no máximo a cada 5 s. Na web, a
aba Sistema mostra "Instável" para um `warning` transitório e, depois de um
resultado transitório, relê sozinha uma única vez.

Desde 14/11/2026, duas entradas do LocationIQ, **sem sonda**: cada chamada ao
provedor gasta um crédito do dia, e uma recusa já pausa todas as réplicas com
o HTTP no Redis, então a pausa faz o papel da sonda (e não há consulta de
saldo, decisão D-28). As duas leem as variáveis e um `MGET` das chaves do
geocodificador (a pausa da conta, a da busca e as contagens do dia), com
prazo de 1 s e falha aberta: sem Redis, a mensagem é "Estado do dia não
lido", `transient`, nunca `error`.

- `geocoding`, "Localização das entregas (LocationIQ)": `not_configured`
  sem `REVERSE_GEOCODER_URL`, ou sem `REVERSE_GEOCODER_KEY` com o host do
  LocationIQ; `disabled` com `DELIVERY_GEOCODING_DAILY_BUDGET=0`; `error`
  enquanto uma recusa segura as consultas, com o que o HTTP quer dizer (401
  a chave, 403 o token sem o Search ou com restrição, 404 a URL que não é a
  raiz da API) e até quando (horário de Brasília); `warning` com a cota do
  dia do provedor ou o orçamento do dia gasto; `ok` com "Hoje: N de M
  consultas". O pico de um minuto não conta.
- `address_search`, "Busca do 'Fixar no mapa'": `not_configured` sem
  `ADDRESS_SEARCH_URL`, ou sem chave nenhuma (`ADDRESS_SEARCH_KEY` e
  `REVERSE_GEOCODER_KEY` vazias) no LocationIQ; `disabled` com
  `ADDRESS_SEARCH_DAILY_BUDGET=0`; `warning` com o host do LocationIQ e
  `ADDRESS_SEARCH_PROTOCOL=nominatim-search` (o padrão, que chama o
  `/search` em vez do `/autocomplete`); `error` enquanto a recusa da própria
  busca a segura (403: o token sem o Autocomplete); `warning` com a cota do
  dia ou as buscas do dia gastas. A recusa da localização das entregas não
  segura a busca.

Os `details` não levam segredo: `protocol`, `key_source` (o nome da
variável da chave, nunca o valor), `today_used`, `daily_budget`,
`business_daily_limit`, `paused_reason`, `paused_until` e `refused_status`.

Cada tentativa que falha vira uma linha `warn` com
`component=provider-readiness` e `msg="provider probe attempt failed"`, com
`provider`, `attempt`, `kind`, `code` (EAI_AGAIN, ECONNRESET,
UND_ERR_SOCKET… ou `timeout`), `http_status`, `phase` (`response`: DNS, TCP,
TLS e cabeçalhos; `body`: corpo da resposta), `elapsed_ms` e `will_retry`;
uma repetição que deu certo vira `info` com
`msg="provider probe recovered on retry"`. Nenhuma URL, host ou chave vai
para essas linhas. Para achar a causa de um "Com erro" que some sozinho:
`docker service logs <App Name> 2>&1 | grep "provider probe"`. `EAI_AGAIN`
ou um `timeout` em `phase=response` perto de 2,5–3,5 s apontam DNS;
`ECONNRESET`/`UND_ERR_SOCKET` apontam a conexão; `http_status` 5xx, o
provedor.

Fase 2 (fora do repositório, quando houver pilha de métricas): 5xx acima de
2 % e p95 acima de 1,5 s por rota e picos de 429 (métricas do Traefik); disco
acima de 80 % (node-exporter); restarts de contêiner (cAdvisor). O Dokploy tem
uma aba _Monitoring_ por serviço que ajuda no dia a dia, mas não alerta
ninguém.

## 21. Cadeia de suprimentos e segredos

| Controle                                                             | Onde                                                                                                                                         | Quando falha                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependabot (npm, actions, imagens base, pip da IA, compose de carga) | `.github/dependabot.yml`, PRs contra `staging`                                                                                               | não falha: abre PRs no dia 1º de cada mês, só de versões publicadas há 7 dias (30 para major), com as majors num PR só, que é lista de tarefas; majors de Node, do Prisma, do `pg` e do `dotenv-expand` e o motor de OCR ficam de fora de propósito |
| Actions fixadas por commit                                           | todo `uses:` dos workflows, com `# vX.Y.Z`                                                                                                   | `supply-chain.test.ts` recusa um `uses:` por tag                                                                                                                                                                                                    |
| Imagens base por digest                                              | `Dockerfile`, `infra/ai-ocr/Dockerfile`; nos workflows, os serviços, o smoke test, o BuildKit, gitleaks e Trivy                              | `supply-chain.test.ts` e `ci-stability.test.ts`                                                                                                                                                                                                     |
| Serviço de IA                                                        | rodas Python com `--require-hashes`, modelos versionados em `infra/ai-ocr/models` e conferidos contra `models.sha256`                        | o build falha num hash diferente; o pytest roda dentro da imagem                                                                                                                                                                                    |
| Gate de audit                                                        | `.github/scripts/audit-gate.sh` (o `audit-ci` fixado) no job `Validate` do `validate.yml` (branches e `staging`), config em `audit-ci.jsonc` | advisory CRITICAL numa dependência de produção sem entrada na allowlist, num run cujo intervalo muda dependência (ou o `audit-ci.jsonc`) desde o último build servido pela staging; nos outros, só relata                                           |
| SBOM e proveniência                                                  | `build-push-action` (`sbom: true`, `provenance: mode=max`)                                                                                   | não falha: anexa as atestações à imagem no GHCR                                                                                                                                                                                                     |
| Scan da imagem (Trivy)                                               | depois do push, por digest, com o banco de vulnerabilidades baixado uma vez e guardado no cache do Actions                                   | só um achado, e só com `IMAGE_SCAN_ENFORCE=true`; falha no download ou erro do Trivy viram aviso                                                                                                                                                    |
| Varredura de segredos (gitleaks)                                     | job `Secret scan` do `ci.yml`, do `staging.yml` e do `pr.yml`                                                                                | um segredo novo em qualquer commit do histórico                                                                                                                                                                                                     |

As imagens do Postgres e do Redis não passam pelo Dependabot (são campos do
Dokploy, não arquivos do repositório): atualize o digest do Postgres à mão,
numa janela, e só dentro da versão 16. As dos workflows (serviços do CI,
smoke test, BuildKit) também não: o procedimento está em
[Versões fixas](#versões-fixas).

**O audit falhou**: leia a advisory; com versão corrigida, atualize (ou aceite
o PR do Dependabot). Sem correção, entra na allowlist do `audit-ci.jsonc` com
comentário dizendo por que não chega à produção e `Revisar até AAAA-MM-DD` (o
teste recusa sem data). Nunca o pacote inteiro. Hoje a allowlist está vazia:
a última exceção (`tar` via bcrypt 5 → node-pre-gyp) saiu em 30/10/2026, com
o bcrypt 6.

O audit só **bloqueia** o push ou PR que muda o que ele lê: `package.json`,
`yarn.lock` ou `package-lock.json` em qualquer pasta, ou o próprio
`audit-ci.jsonc` (tirar uma exceção também precisa passar). A comparação é
com a base do PR ou com o `before` do push; sem base (branch nova,
_Run workflow_, base fora do checkout), bloqueia. Num push que não mexe em
dependência, um aviso novo aparece como `::warning::` e com o relatório no
resumo do job, sem reprovar: o aviso já está na árvore que roda, o alerta do
Dependabot avisa e a correção vai numa branch de trabalho a partir da
`staging` (os _security updates_ ficam desligados: o GitHub só os abre contra
a `main`), e a próxima mudança de dependência passa pelo portão de verdade. Um aviso que aparece assim é
tarefa do dia, não do próximo push.

Um audit que **não rodou** é outra coisa, e o portão diz qual foi. O
`audit-ci` escreve "Failed security audit due to ..." quando acha um aviso;
qualquer outra saída com erro é o npm ou o endpoint de auditoria que não
respondeu (o `audit-ci` 7.1.0 só repete, e sem pausa, um "503 Service
Unavailable"; uma conexão derrubada saía com o mesmo código de um
CRITICAL). O portão repete esse caso 3 vezes, com pausa de 10 s e 20 s e um
`::warning::` a cada uma; se persistir, o resumo diz "não rodou". Bloqueia
só onde o veredito bloquearia (o run muda dependência, que não passa sem
auditoria), e a mensagem nunca manda atualizar dependência por causa da
rede.

**Ligar o scan de imagem de verdade**: quando foi adicionado, a base
`node:22.21.1-alpine` tinha CRITICALs corrigíveis (OpenSSL em
libssl3/libcrypto3 e o `tar` do npm embutido; desde 28/10/2026 o runtime
da API é Alpine com só o binário do `node`, sem npm). Suba a base (PR do
Dependabot), confira no passo "Scan the images" que não sobrou CRITICAL
corrigível e ponha `IMAGE_SCAN_ENFORCE=true`. Ligado, só um **achado**
reprova: o banco de vulnerabilidades vem de um registry com limite de taxa
(`mirror.gcr.io`, depois `ghcr.io`), é baixado uma vez por run (passo
"Download the vulnerability database", 3 tentativas) e guardado no cache do
Actions por dia; se o download falhar, o scan usa a cópia do cache, e sem
cópia não roda — nos dois casos com aviso e uma linha no resumo, nunca como
achado. Um erro do próprio Trivy (uma imagem que ele não conseguiu puxar)
repete 3 vezes e vira aviso.

**O gitleaks falhou**: trate como vazamento. Revogue/rotacione na origem
primeiro; remova do código (reescreva a branch se ainda não foi mergeada; em
`main`/`staging`, não reescreva — já foi rotacionado). Um valor público por
design que a regra genérica confunde com chave (hoje só o
`ACCESS_CODE_ALPHABET` de `src/modules/user/services/driver-enrollment.ts`,
cuja linha serve de modelo) leva o comentário de liberação inline do gitleaks
**na própria linha que dispara**, com o motivo escrito logo acima: o
comentário anda junto com a linha. Cada um fica listado, com a linha inteira,
no `tests/unitaires/lifecycle/secrets-hygiene.test.ts`, que reprova um novo
que ninguém revisou em qualquer arquivo, Markdown inclusive (o gitleaks
respeita o comentário em toda linha que varre, até contra as regras de
provedor). Segredo de verdade nunca leva o comentário. O `.gitleaksignore`
fica só com o que já está preso num commit do histórico — a baseline e os
segredos já rotacionados —, pela impressão digital completa
(`commit:arquivo:regra:linha`). O job varre o histórico de **todas** as
branches do remoto. O `.gitleaks.toml` mantém todas as regras padrão e
silencia só a `generic-api-key` em `tests/` e no `.env.example`. A baseline
guarda o que o histórico tinha quando a varredura foi ligada — entre eles uma
`ANTHROPIC_API_KEY` antiga (commit `2926c01`), revogada e excluída no console
da Anthropic (confirmado em 29/10/2026); a API não usa mais a Anthropic
(ADR 0010).

**Segredos no Dokploy**: ficam no _Environment_ de cada Application e nos
Databases; qualquer usuário do painel com acesso ao projeto os vê. Dê acesso
ao Dokploy só a quem pode ver produção, e renove o token do GHCR
(`read:packages`) antes de vencer — vencido, todo deploy falha no pull.

Configuração fora do repositório: _Dependabot alerts_ ligados e _security
updates_ desligados (abririam PRs contra a `main`, que não os promove; decisão
de 04/11/2026, [`infraestrutura.md` → 7.7](./infraestrutura.md#77-dependabot-e-varredura-de-segredos));
_CodeQL default setup_ ligado; política da organização exigindo actions
fixadas por SHA.

## 22. Bucket R2 e retenção no GHCR

**CORS do bucket de fotos** (produção e staging): o navegador envia fotos
direto ao R2 por URL pré-assinada (`PUT` com `Content-Type`); quem responde o
preflight é o bucket. Sem a regra, o upload falha antes de sair da aba e não
aparece em log nenhum. Em _R2 → bucket → Settings → CORS Policy_:

```json
[
  {
    "AllowedOrigins": ["https://www.intrajetto.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Em staging, a origem é a web de staging. Não use `*`. O app não passa por
CORS. O bucket é **privado**: toda leitura é URL assinada de curta duração.

**Retenção no GHCR**: cada push em `staging` publica `sha-<7>` das três
imagens (a da IA, quando reaproveitada, é só uma tag a mais na mesma versão)
e o marcador `staged-<7>` da API e da IA. Não há limpeza automática: as versões sem tag
incluem os manifestos de atestado e os índices que `stable` e `staging`
usam, e apagá-las às cegas quebra imagens com tag. Limpe à mão, pelo painel
do pacote, as `sha-<7>`/`staged-<7>` e `main-<sha>` antigas que não são
`stable` nem `staging` (guarde as últimas como alvo de rollback). Na
`trajetto-api-migrate`, guarde as mesmas `sha-<7>` que você guardar na
`trajetto-api` (o rollback para um build roda a etapa com a imagem de
migração dele), e não apague as versões que `staging-applied`,
`stable-applied` e a `src-<hash>` mais recente apontam. Na `trajetto-ai`, não apague a versão que a tag `src-<hash>` mais recente
aponta: sem ela, o próximo push reconstrói a IA (e a reimplanta).

Na `trajetto-postgres` (publicada só quando `infra/postgres` muda, com
`src-<hash>` e `sha-<7>`; a promoção move `stable` só como referência), não
apague a versão que o Database de cada ambiente roda (o digest anotado na
troca, [seção 27](#27-pitr-com-pgbackrest)), nem a da `src-<hash>` mais
recente, nem a anterior a ela (o alvo da reversão). O pacote é público, e o
armazenamento de pacotes públicos não conta na cota do GitHub Packages; os
três privados, sim: limpe-os antes de a cota encher, porque um push que
não cabe derruba o `Build`.

## 23. Recursos da VPS e logs

**A VPS única não recebe o primeiro cliente de escala.** Mesmo sozinha
nela, a produção tem ~1,5–2 vCPU para o HTTP: ~130–170 req/s (ESTIMADO a
partir dos 8,14 ms MEDIDOS de CPU por requisição), abaixo dos 200 req/s do
portão do 100k. Esse cliente só entra depois da virada para os servidores
próprios (o prod-1, com 12 núcleos dedicados, e o prod-db-1), com os
portões aprovados nos dois (plano de escala, onda 22), e o volume dele
sobe por coortes até o portão aprovado. Até lá, a VPS de hoje (6 vCPU
compartilhadas, 12 GB de RAM e 100 GB NVMe) divide a produção e a staging
pelas réguas abaixo (plano de escala X-18). Os tetos de cada Application,
fase a fase, estão em
[Tetos por Application e por fase](#tetos-por-application-e-por-fase).

### Memória: a reserva do host, a R1 e a R2

- **Reserva do host:** 1.280 MiB (ESTIMADO): o sistema, o `dockerd`, o
  Dokploy, o Traefik, o `dokploy-postgres`, o `dokploy-redis` e o agente do
  Beszel. A RAM visível é de ~11.980 MiB (ESTIMADO; a medição do F0-09
  confirma com `free -m`).
- **R1 (tetos):** a soma dos tetos estáveis mais o maior transitório fica
  em até 11.500 MiB. Os transitórios são uma `trajetto-api-migrate` (384
  MiB; a de um environment espera a do outro), o k6 do burn-in (256 MiB)
  ou uma janela de ensaio de 1 GiB, feita com a api e a web da staging em
  0 réplicas (devolvem 896 MiB) e sem deploy durante ela.
- **R2 (uso medido):** se a R1 não fechar por até 1.024 MiB, a fase só
  segue com o p95 da RAM usada no pico em até 70% em 7 dias no Beszel, o
  earlyoom ativo (abaixo) e nenhum OOM kill de contêiner da produção no
  `dmesg` em 7 dias. Se nem a R2 fechar, a fase espera o 2º VPS (G-03).
- Os monitores (o Uptime Kuma e o hub do Beszel), se estiverem no host,
  somam ~192 MiB (ESTIMADO) e tiram a folga das fases B e C.
- Os papéis usam a mesma imagem e não gastam disco a mais.

A soma por fase (MiB), da coluna de cada fase nas tabelas de tetos, sem a
migrate, que é o transitório:

| Fase                          | Produção | Staging | Host  | Soma estável | Com o transitório       | Régua                                                      |
| ----------------------------- | -------- | ------- | ----- | ------------ | ----------------------- | ---------------------------------------------------------- |
| A (web de produção em 768)    | 7.232    | 2.400   | 1.280 | 10.912       | 11.296                  | R1 cabe (com os monitores no host, 11.488)                 |
| B (web em 640)                | 6.976    | 2.848   | 1.280 | 11.104       | 11.488                  | R1 cabe só com a web em 640 e os monitores fora; senão, R2 |
| C (Postgres 1.792, web 512)   | 6.976    | 2.848   | 1.280 | 11.104       | 11.488                  | R1 cabe só com os dois ajustes medidos; senão, R2 ou G-03  |
| E (produção sozinha na VPS 1) | 9.344    | —       | 1.280 | 10.624       | 11.008                  | R1 cabe; o limite passa a ser a CPU                        |
| 2º VPS (staging sozinha)      | —        | 5.152   | 1.280 | 6.432        | 7.456 (janela de 1 GiB) | folga para os ensaios e o standby temporário               |

### CPU na VPS única

Na fase A, os tetos da staging somam 2,35 vCPU (2,6 na B). Mesmo com a
staging e a IA de produção no teto, sobram pelo menos 1,65 vCPU para a api
e o Postgres da produção. Na fase E, com o Postgres (~1,5), a IA (2), o
worker (0,5) e o sistema (0,5), sobram ~1,5–2 vCPU para o HTTP: é o número
do topo desta seção, e o motivo de o prod-1 vir antes do cliente de
escala. A api fica sem _CPU Limit_ de propósito (o throttling do CFS
piora o p99); a IA tem limite, porque o OCR satura todo núcleo que
recebe. Os números reais saem do `docker stats` sob o harness de carga
(`tests/load/README.md`), com a pilha presa a 6 núcleos.

### Disco na VPS única

ESTIMADO, no NVMe de 100 GB dividido:

| Item                                                                                               | Hoje → 10k/mês     | 100k/mês                            |
| -------------------------------------------------------------------------------------------------- | ------------------ | ----------------------------------- |
| sistema, Docker, Dokploy e `dokploy-postgres`                                                      | ~10 GB             | ~10 GB                              |
| imagens (com a limpeza diária)                                                                     | ~8 GB              | ~8 GB                               |
| logs dos contêineres (json-file, 50 MB × 5 × ~20)                                                  | ≤ 5 GB             | ≤ 5 GB                              |
| banco de produção (dados e índices)                                                                | ~3–5 GB            | ~15–25 GB (trilha de 30 dias ~5 GB) |
| `pg_wal` da produção (uso normal; com o bucket R2 fora do ar, mais a fila de arquivamento de 4 GB) | 1–2 GB (até 12 GB) | 2–8 GB (até 12 GB)                  |
| staging (banco, WAL e fila)                                                                        | ≤ 3 GB             | ≤ 3 GB                              |
| ensaio de restore ou seed descartável (só na janela)                                               | ≤ 50% do livre     | ≤ 50% do livre                      |
| **Total estável**                                                                                  | ~30–35 GB          | ~45–60 GB                           |

O gatilho de disco é 60%: ele chega perto do 100k, outro motivo para o
prod-db-1 vir antes do cliente de escala. O alerta de 80% vai por e-mail,
e o de 85%, pelo Telegram (Beszel).

### Sem swap: o earlyoom no lugar

Com swap no host, o Docker dá a cada contêiner sem `MemorySwap` explícito
um swap igual ao próprio teto, e o Dokploy não expõe o `--memory-swap`: o
teto deixaria de matar o processo e passaria a trocar página no NVMe que o
Postgres da produção usa. Por isso o host fica **sem arquivo de swap**
(plano de escala F0-11), e a guarda contra o OOM global do kernel é o
`earlyoom`: com a memória livre abaixo de 4%, ele mata o maior processo,
evitando `postgres`, `dockerd`, `containerd`, `traefik` e o Dokploy. Um
processo Node morto volta pelo Swarm em segundos; o Postgres não entra em
recuperação. O earlyoom escolhe pelo nome do processo: o painel do
Dokploy roda como `node`, e o que o protege é ser dos menores (o earlyoom
mata o de maior `oom_score`) e voltar pelo Swarm. Por SSH, fora do
horário (dono):

1. `swapon --show`. Se houver swap: `swapoff -a` e tire a linha dele do
   `/etc/fstab`.
2. `apt install earlyoom`.
3. Em `/etc/default/earlyoom`:

   ```sh
   EARLYOOM_ARGS="-m 4 -r 3600 --avoid '^(postgres|dockerd|containerd|traefik|dokploy)$' --prefer '^(node|python3?)$'"
   ```

4. `systemctl enable --now earlyoom` e `journalctl -u earlyoom -n 20`: o
   log de partida mostra a lista de exclusão.
5. Dokploy → _Settings_ → ligue a limpeza diária de imagens.

Aceite: `swapon --show` vazio e `systemctl is-active earlyoom` = `active`.
Sem swap, um pico real acima da RAM mata uma réplica Node, que volta
sozinha.

### Quando a VPS única deixa de bastar

- **A RAM não fecha nem pela R2**: a fase espera o 2º VPS (G-03, onda
  16), que leva a staging para fora; a produção passa à coluna E.
- **A CPU**: na fase E, o HTTP da produção tem ~1,5–2 vCPU, abaixo do
  portão do 100k. O prod-1 vem antes do cliente de escala (onda 22).
- **O disco** passa de 60%, perto do 100k: o banco vai para o prod-db-1.
- **O steal** medido no F0-09 passa de 5%: a produção precisa de CPU
  dedicada (VDS), não de mais réplicas.

**Logs**: a rotação é a do `/etc/docker/daemon.json`
([seção 6](#6-preparar-o-servidor-uma-vez), passo 3): 50 MB × 5 arquivos por
contêiner. Confira de tempos em tempos `df -h /var/lib/docker` e o tamanho
dos logs (`du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail`).
Um contêiner criado antes da regra não rotaciona: um **Deploy** da Application
o recria.

## 24. Migrar do Portainer para o Dokploy

> **Domínio antigo.** A stack antiga (o `compose.production.yaml` da `main`
> anterior a este desenho) respondia em `trajettoapi.thorsolucoes.com.br`. A
> produção no Dokploy usa o host da [seção 26](#26-os-três-repositórios-juntos)
> (`api.intrajetto.com`, no ar desde 29/10/2026); o domínio antigo só importa enquanto
> a stack antiga estiver no ar.

O dado mora no volume do Postgres da stack antiga (`trajetto_postgres_data`,
da stack `trajetto` do Portainer). O Database do Dokploy usa um volume
**novo**: o caminho é dump e restore, nunca apontar o Database para o volume
antigo. A guarda de bootstrap da API recusa um banco vazio em produção, então
uma API que sobe sobre o banco errado para em vez de semear por cima.

### Mesma VPS

1. **Backup fresco** e conferido ([seção 18](#18-backup-e-restauração)). Com
   a stack antiga ainda no ar:
   ```sh
   docker exec $(docker ps -q -f name=trajetto_trajetto-database | head -n 1) \
     pg_dump -U <usuário> -d <banco> -Fc > trajetto-migracao.dump
   docker run --rm -i postgres:16-alpine pg_restore --list < trajetto-migracao.dump | head   # o índice lê
   ```
   Guarde uma cópia fora da VPS.
2. **Janela de manutenção.** Exporte do Portainer o compose e o env de cada
   stack (API, web, Traefik): voltar atrás é um `docker stack deploy` com eles.
   As portas 80/443 são do Traefik antigo e o Dokploy precisa delas:
   ```sh
   docker stack rm trajetto trajetto-ui      # remove os serviços; os volumes ficam
   ```
   Pare também o Traefik antigo. **Não** apague o volume
   `trajetto_postgres_data` até o fim da migração.
3. **Instalar o Dokploy** e seguir as [seções 6 e 7](#6-preparar-o-servidor-uma-vez)
   no environment `production` **até o Database PostgreSQL (7.4)**, com o
   Redis (7.5) e a IA (7.6) se quiser.
4. **Restaurar** no Database novo, antes de criar a API:
   ```sh
   docker exec -i $(docker ps -q -f name=trajetto-postgres-production | head -n 1) \
     pg_restore -U trajetto -d trajetto --no-owner --no-privileges --exit-on-error < trajetto-migracao.dump
   ```
   Se o dump do passo 1 não foi feito e a stack já saiu, tire o dump do volume
   antigo com um contêiner temporário:
   ```sh
   docker run -d --name pg-antigo -v trajetto_postgres_data:/var/lib/postgresql/data postgres:16-alpine
   docker exec pg-antigo pg_dump -U <usuário> -d <banco> -Fc > trajetto-migracao.dump
   docker rm -f pg-antigo
   ```
5. **`trajetto-api-migrate` e API** (7.12 e 7.7, a API sem Deploy), sem
   `ALLOW_EMPTY_DATABASE_BOOTSTRAP` em nenhuma das duas: o dump é de uma
   versão antiga, e a API recusa o banco até as migrations dela rodarem.
   Configure os secrets do environment `production` do GitHub (os quatro
   `DOKPLOY_*`) e faça o primeiro promote
   ([seção 8](#8-primeiro-deploy-na-ordem-com-conferências), "Produção",
   passo 4): ele roda a etapa de release antes da API. Um **Deploy** manual
   na `trajetto-api-migrate` (esperando `Running`) só serve depois que um
   promote com os quatro `DOKPLOY_*` moveu `trajetto-api-migrate:stable`;
   antes disso a tag não existe, e só o pipeline roda a etapa. Num banco
   vazio, a etapa para na guarda de banco vazio, e nada é semeado: é o sinal
   de que o banco não é o certo. Depois o backup do Database (7.9).
6. **Conferir**: `/health/readiness` 200, login, contagem de algumas tabelas
   contra o dump.
7. **Web** depois da API (`trajetto-ui/docs/deploy.md`).
8. **Limpar**, só depois de uns dias no ar: o volume `trajetto_postgres_data`,
   o `trajetto_redis_data` (órfão) e a rede `minha_rede` (se nada mais a usar).

A imagem antiga de `main` (anterior a este desenho) não sobe com estas
variáveis (o env-schema dela exige `RABBITMQ_URL` e as variáveis do
Evolution): voltar para ela é parar as Applications e redeployar as stacks
antigas com o compose e o env exportados no passo 2 — o volume antigo ainda
está lá.

### VPS nova

Sem volume para reaproveitar: monte tudo (seções 6 e 7) até o Database,
restaure o dump ([seção 18](#18-backup-e-restauração), "Restaurar a partir do
R2"), crie a `trajetto-api-migrate` e a API e aponte o DNS. Se a produção
já tinha rodado a etapa no servidor antigo, `stable-applied` registra o
banco de lá, e o promote do mesmo build a pularia: dê **Deploy** na
`trajetto-api-migrate` nova (a `:stable` dela já existe) e espere `Running`
antes do deploy da API. `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` só serve para
uma instalação **sem** dados a restaurar.

## 25. Checklist do primeiro deploy

Na ordem:

- [ ] Branch `staging` criada no GitHub a partir do estado que vai para
      produção; só merge commit habilitado; proteção de `main` e `staging`
      ([seção 13](#13-configurar-o-github)).
- [ ] Primeiro push em `staging` verde: `sha-<7>` das três imagens e
      `staging` da API e da IA no GHCR (o deploy aparece como "pulado"; a
      `staging` da imagem de migração nasce no primeiro deploy).
- [ ] VPS com Dokploy; `daemon.json` com rotação de log e Docker reiniciado;
      `infra/traefik/` aplicado ([seção 6](#6-preparar-o-servidor-uma-vez)).
- [ ] Firewall da VPS com 80 e 443 só da Cloudflare, e nada respondendo
      direto no IP ([6.1](#61-firewall-da-vps-contabo)); IPv4 preferido no
      host (`gai.conf` e `GODEBUG=netdns=cgo` no Docker), com o `dockerd`
      baixando de `185.199.x.x`
      ([6.2](#62-downloads-do-ghcr-pelo-ipv4-preferência-do-sistema)).
- [ ] DNS na Cloudflare (proxy, Full strict, TLS 1.2, Always HTTPS) para os
      hosts da API de produção e de staging.
- [ ] Token classic `read:packages` do GHCR criado (e a data de renovação
      anotada), informado no provider Docker de cada Application.
- [ ] Buckets R2: fotos de produção e de staging (com CORS); backup
      (`trajetto-backups`, e o recomendado `trajetto-backups-prod` para
      produção); um token por bucket; os _S3 Destinations_ no Dokploy
      ([seção 18](#18-backup-e-restauração)).
- [ ] Heartbeat da operação (1 min) e monitores de uptime; notificação de
      falha de backup no Dokploy (_Settings → Notifications_).
- [ ] Segredos gerados por ambiente: senha do Postgres e do Redis
      (`openssl rand -hex`), `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`, token
      da IA, `WEBHOOK_SECRETS_KEY`, `RATE_LIMIT_FORWARDER_SECRET` (igual ao da
      web), `DOCS_PASSWORD`.
- [ ] **Staging**, no environment `staging` do Dokploy, projeto
      `trajetto-api`: Postgres → Redis (com o comando) → `trajetto-ai` →
      `trajetto-api-migrate` (_Restart Policy_ `none`; no banco vazio, com
      `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` e as `MASTER_USER_*` só no
      primeiro deploy; seção 8, passo 4) → `trajetto-api` (sem Deploy: o
      primeiro é do pipeline, três itens abaixo) → backup do
      Database PostgreSQL (aba _Backups_, prefixo `trajetto-staging/`, com um
      backup manual conferido no bucket), cada um com a conferência da
      [seção 8](#8-primeiro-deploy-na-ordem-com-conferências).
- [ ] Os três applicationIds e o App Name da API anotados (seção 7.10).
- [ ] Environment `staging` no GitHub (`DOKPLOY_URL`, `DOKPLOY_API_KEY`,
      `DOKPLOY_API_APPLICATION_ID`, `DOKPLOY_MIGRATE_APPLICATION_ID`,
      `DOKPLOY_AI_APPLICATION_ID`, `API_PUBLIC_URL`; `SWARM_API_SERVICE`, os
      `DEPLOY_SSH_*` e a chave da conferência só com `ROLLOUT_VERIFY=ssh`),
      sem `ROLLOUT_VERIFY=off`.
- [ ] Um push em `staging` roda a etapa de release (resumo: "Migrations:
      trajetto-api-migrate concluiu a etapa de release", ou o aviso de que o
      banco já aplicou aquela imagem), faz o deploy sozinho (IA → API),
      termina com "API: … responde <commit>" e escreve o marcador
      `staged-<7>`.
- [ ] Tag `stable` criada pelo _Run workflow_ (seção 8, "Produção", passo 1).
- [ ] **Produção**, no environment `production` do Dokploy, os mesmos cinco
      serviços e o backup do Database (prefixo `trajetto-production/`) com os
      valores de produção, a `trajetto-api` sem Deploy (o primeiro é do
      promote, dois itens abaixo); conferidos o Postgres, o Redis e a IA;
      vindo do Portainer, a
      [seção 24](#24-migrar-do-portainer-para-o-dokploy).
- [ ] Environment `production` no GitHub com **revisores obrigatórios**,
      _Deployment branches_ = `main`, os quatro `DOKPLOY_*` (com o
      `DOKPLOY_MIGRATE_APPLICATION_ID` de produção) e, sem
      `ROLLOUT_VERIFY=http`, `SWARM_API_SERVICE`, os `DEPLOY_SSH_*` e a chave
      da conferência.
- [ ] Primeiro promote (PR `staging → main` com merge commit, ou _Run
      workflow_ na `main` com o mesmo `sha-<7>` da tag `stable`), aprovação:
      promoção verde, com "Migrations: trajetto-api-migrate concluiu a etapa
      de release" no passo _Run the database migrations on production
      (Dokploy)_ (ou o aviso de que o banco de produção já aplicou aquela
      imagem); depois as conferências da API de produção (seção 8,
      "Produção", passo 5).
- [ ] `HEALTHCHECK_PING_URL` chegando 1/min; uma cópia diária nova no bucket
      (prefixo do ambiente); um ensaio de restore.
- [ ] Certificado A1 do comprovante (`PROOF_SIGNING_*`) em produção;
      `proof_signing` em `/health/metrics`.
- [ ] Web promovida **depois** da API (`trajetto-ui/docs/deploy.md`).
- [ ] Apagar os secrets e variáveis obsoletos do GitHub
      (`DOKPLOY_COMPOSE_ID`, `DOKPLOY_BACKUP_APPLICATION_ID`, `PORTAINER_*`,
      `STAGING_ENABLED`, `MIGRATIONS_VIA_JOB`, `DEPLOY_SSH_KEY`), se
      existirem. No Environment das duas Applications `trajetto-api`:
      `RUN_MIGRATIONS_ON_BOOT=false` (**não** apagar: os builds de antes de
      31/10/2026 a leem com padrão `true`; seção 15) e, se quiser, sem a
      `MIGRATION_DATABASE_URL`. Se a Application `trajetto-backup` chegou a
      ser criada no Dokploy, apagá-la.

## 26. Os três repositórios juntos

> Esta seção é **a mesma** nos três manuais de deploy:
> [`trajetto-api/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-api/blob/main/docs/deploy.md),
> [`trajetto-ui/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-ui/blob/main/docs/deploy.md)
> e
> [`trajetto-mobile/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-mobile/blob/main/docs/deploy.md).
> Mudou aqui, mude nos outros dois. O detalhe de cada passo fica no manual do
> repositório dono dele. O que foi configurado à mão nos painéis (Contabo,
> Dokploy, Cloudflare, GitHub, Expo, Resend e R2), os tokens e o porquê de cada
> escolha ficam em
> [`trajetto-api/docs/infraestrutura.md`](https://github.com/Trajetto-Organization/trajetto-api/blob/staging/docs/infraestrutura.md).

### Quem é quem

|                             | API (`Trajetto-Organization/trajetto-api`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Web (`Trajetto-Organization/trajetto-ui`)                                                                                                                                                                       | App (`Trajetto-Organization/trajetto-mobile`)                                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Artefato                    | imagens `trajetto-api` (que também roda os papéis de processo, cada um na tag `<tag>-<papel>`), `trajetto-api-migrate` e `trajetto-ai` em `ghcr.io/trajetto-organization/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | imagem `ghcr.io/trajetto-organization/trajetto-ui`                                                                                                                                                              | APK/AAB (EAS Build) e OTA (EAS Update)                                                                          |
| Onde roda                   | Dokploy, projeto `trajetto-api` de cada environment (`staging` e `production`): as Applications `trajetto-api` (com domínio), `trajetto-api-migrate` (as migrations, antes do deploy que as muda), `trajetto-ai` (sem domínio) e, depois de o dono criá-las, as de papel da mesma imagem (`trajetto-worker`, `trajetto-scheduler`, `trajetto-worker-external`, `trajetto-ingest` e `trajetto-realtime`; manual da API, seção 19), puxando as imagens do GHCR, e os Databases PostgreSQL (com o backup diário do próprio Dokploy para o Cloudflare R2) e Redis                                                                                                    | Dokploy, projeto `trajetto-ui` de cada environment: a Application `trajetto-ui`, puxando a imagem do GHCR                                                                                                       | no celular do motorista (APK interno em staging, Play Store em produção)                                        |
| Nome no Dokploy / EAS       | App Names `trajetto-api-staging` e `trajetto-api-production` (e `trajetto-api-migrate-*`, `trajetto-ai-*`, `trajetto-<papel>-*`, `trajetto-postgres-*`, `trajetto-redis-*`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Application `trajetto-ui` no projeto `trajetto-ui` de cada environment (App Names `trajetto-ui-staging` e `trajetto-ui-production`)                                                                             | perfis, ambientes e canais `staging` e `production`                                                             |
| Como o pipeline publica     | API do Dokploy (`.github/scripts/dokploy-deploy.mjs`): quando as migrations mudaram, primeiro a `trajetto-api-migrate`, esperando a etapa terminar (`dokploy-release.mjs`); depois `application.deploy` de cada Application, na ordem de "Ordem de cada release" (abaixo), a IA só quando o digest muda e cada papel só com o secret dele (`.github/scripts/deploy-roles.sh`), acompanhando cada deployment até o fim e disparando de novo, até 6 vezes e com espera crescente, o que termina em erro; depois da API, confere a convergência (a `/health/liveness` pública respondendo o commit novo, ou o Swarm por SSH) e só então implanta os papéis de borda | API do Dokploy com o **mesmo** `.github/scripts/dokploy-deploy.mjs` (cópia comparada por teste): `application.deploy` da Application `trajetto-ui`, acompanhando o deployment, depois espera o `/build-id.json` | `eas update` (OTA) e, quando o canal não tem binário para o runtime do commit (fingerprint), `eas build`        |
| Secrets de deploy no GitHub | environments `staging` e `production`: `DOKPLOY_URL`, `DOKPLOY_API_KEY`, `DOKPLOY_API_APPLICATION_ID`, `DOKPLOY_MIGRATE_APPLICATION_ID` (obrigatórios), `DOKPLOY_AI_APPLICATION_ID` e um `DOKPLOY_<PAPEL>_APPLICATION_ID` por Application de papel (opcionais); variáveis `API_PUBLIC_URL` (a conferência pela liveness), `SWARM_API_SERVICE` e `SWARM_<PAPEL>_SERVICE` (a conferência por SSH) e `ROLLOUT_ROLES_EXPECTED` (os papéis esperados no commit novo)                                                                                                                                                                                                  | environments `staging` e `production`: `DOKPLOY_URL`, `DOKPLOY_API_KEY` e `DOKPLOY_UI_APPLICATION_ID`                                                                                                           | `EXPO_TOKEN` (repositório) e `EXPO_UPDATE_PRIVATE_KEY` (environments `staging` e `production`)                  |
| Sem os secrets              | move as tags e pula o deploy com `::notice::`; sem o secret de um papel, só ele fica de fora, com aviso, e a tag dele segue a da API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | move as tags e pula o deploy com aviso                                                                                                                                                                          | termina verde com aviso, sem publicar                                                                           |
| De staging para produção    | promove por digest a imagem `sha-<7 do commit>` (tag `staging` → `stable`), sem rebuild, e exige o marcador `staged-<7 do commit>` no mesmo digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | igual à API, e exige o marcador `staged-<7 do commit>` no mesmo digest                                                                                                                                          | promove o **commit** verde em staging (a URL da API é embutida no build, então o artefato não pode ser o mesmo) |
| Rollback                    | _Run workflow_ do `production.yml` com `image_tag=sha-<7>`; a API e os papéis voltam juntos, porque rodam o mesmo digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | _Run workflow_ do `production.yml` com `image_tag=sha-<7>`                                                                                                                                                      | `ota-rollback.yml` (republica um grupo de OTA)                                                                  |

Regras comuns aos três: a branch `staging` recebe o trabalho (push direto do
dono ou merge de PR) e todo push nela roda a validação completa e publica o
staging; `main` só recebe PR **de `staging`**, com **merge commit** (squash e
rebase criam um commit que o staging nunca validou, e a promoção recusa); o
environment `production` do GitHub tem **Required reviewers** e
_Deployment branches_ restrito a `main`, então nada chega à produção sem
aprovação. No Dokploy, as imagens privadas do GHCR são puxadas com um token
_classic_ `read:packages`, informado no provider Docker de cada Application.

### Endereços

|                        | Staging                                                                           | Produção                                                           |
| ---------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Web                    | `https://staging.intrajetto.com`                                                  | `https://www.intrajetto.com` (o apex `intrajetto.com` redireciona) |
| API (REST e Socket.IO) | `https://api-staging.intrajetto.com`                                              | `https://api.intrajetto.com` (no ar desde 29/10/2026)              |
| Serviço de IA          | sem endereço público: `http://trajetto-ai-staging:8080` na rede `dokploy-network` | sem endereço público: `http://trajetto-ai-production:8080`         |

### O que precisa casar entre os repositórios

| Valor                             | API (Environment das Applications do projeto `trajetto-api`)                                                                                                                                                                                                                                                                                                    | Web (Environment da Application)                                                                                          | App (ambiente EAS)                                                                                                                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| URL pública da API                | o host na aba _Domains_ da Application `trajetto-api` e `API_HTTP_REQUEST` (a URL; dela sai o logo dos e-mails)                                                                                                                                                                                                                                                 | `HTTP_REQUEST` (chamadas do servidor da web) e `PUBLIC_API_URL` (chamadas do navegador)                                   | `EXPO_PUBLIC_API_URL`                                                                                                                                                                                                     |
| Socket.IO                         | o mesmo host da API, com WebSocket liberado na borda                                                                                                                                                                                                                                                                                                            | `PUBLIC_API_URL` (o socket roda na própria API; não há variável própria)                                                  | o socket usa `EXPO_PUBLIC_API_URL`                                                                                                                                                                                        |
| Origem da web                     | `HTTP_REQUEST` = a origem da web do ambiente (única origem do CORS e do Socket.IO, base dos links)                                                                                                                                                                                                                                                              | `METADATA_BASE`                                                                                                           | `EXPO_PUBLIC_WEB_APPLICATION_URL` (links de Privacidade e Termos; é também a origem sob a qual a página do mapa ao vivo carrega, para os tiles levarem o `Referer` que a restrição de origem da chave do provedor aceita) |
| Limite de tentativas por IP       | `RATE_LIMIT_FORWARDER_SECRET`                                                                                                                                                                                                                                                                                                                                   | `RATE_LIMIT_FORWARDER_SECRET`, **o mesmo valor**                                                                          | —                                                                                                                                                                                                                         |
| Captcha (Turnstile)               | `TURNSTILE_SECRET_KEY` (o mesmo widget da web; definida, exige o token)                                                                                                                                                                                                                                                                                         | `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`                                                                             | —                                                                                                                                                                                                                         |
| Fotos no R2                       | `R2_*` (um bucket por ambiente)                                                                                                                                                                                                                                                                                                                                 | `CSP_STORAGE_ORIGINS` libera a origem do bucket; o CORS do bucket libera a origem da web                                  | envia direto à URL pré-assinada que a API devolve (sem configuração)                                                                                                                                                      |
| Mapa de fundo (tiles)             | `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`, `MAP_TILE_URL_DARK` e `MAP_TILE_ATTRIBUTION_DARK` na `trajetto-api` (opcionais), definidas pelo dono em staging e produção com **os mesmos valores** da web do ambiente: a API as entrega ao app em `GET /config/map`; um modelo que o app recusaria (host que o CSP dele não nomeia como uma origem só) derruba o boot | as mesmas quatro `MAP_TILE_*`; a chave do provedor na URL é restrita às origens da web (MapTiler, _Allowed HTTP Origins_) | nenhuma variável: lê o mapa de fundo de `GET /config/map` e carrega a página do mapa sob `EXPO_PUBLIC_WEB_APPLICATION_URL`; sem as `MAP_TILE_*` na API, o mapa ao vivo mostra "Mapa de fundo não configurado"             |
| IA (leitura de fotos)             | `AI_LOCAL_TOKEN` na `trajetto-api` = `AI_TOKEN` na `trajetto-ai` (o mesmo valor, um por ambiente) e `AI_LOCAL_URL=http://<App Name da IA>:8080`                                                                                                                                                                                                                 | nenhuma variável: a IA chega pela API                                                                                     | nenhuma variável                                                                                                                                                                                                          |
| Push (FCM)                        | nenhuma: a API chama a Expo Push API                                                                                                                                                                                                                                                                                                                            | —                                                                                                                         | `GOOGLE_SERVICES_JSON` (arquivo secreto no EAS) e a chave FCM V1 em `eas credentials`                                                                                                                                     |
| Rastreamento em segundo plano     | —                                                                                                                                                                                                                                                                                                                                                               | `BACKGROUND_TRACKING`                                                                                                     | `EXPO_PUBLIC_BACKGROUND_TRACKING` (mesma regra: ausente é ligado, só `false` desliga)                                                                                                                                     |
| Versão do app                     | `MIN_MOBILE_CONTRACT` e `MOBILE_STORE_URL`                                                                                                                                                                                                                                                                                                                      | —                                                                                                                         | `CLIENT_CONTRACT` em `utils/client-version.ts`                                                                                                                                                                            |
| QR Code de acesso do motorista    | `APP_ENV`, que vai dentro do QR Code: `trajetto-enroll:1:<APP_ENV>:<token>`                                                                                                                                                                                                                                                                                     | nenhuma variável: o diálogo mostra o QR Code que a API gerou                                                              | `extra.appEnvironment` do build, tirado de `EAS_BUILD_PROFILE` ou `APP_ENV` (`preview` e `staging` viram `staging`), **igual ao `APP_ENV` da API**; diferente, o app recusa o QR Code e só o código de acesso funciona    |
| Gate de rotas da web              | `/docs/json` com `DOCS_USER` e `DOCS_PASSWORD`                                                                                                                                                                                                                                                                                                                  | secrets `API_DOCS_URL`, `DOCS_USER`, `DOCS_PASSWORD` no environment `production`                                          | —                                                                                                                                                                                                                         |
| Checkout entre repositórios no CI | `CLIENT_REPOS_READ_TOKEN` (lê a web e o app)                                                                                                                                                                                                                                                                                                                    | `API_REPO_READ_TOKEN` (lê a API)                                                                                          | `API_REPO_READ_TOKEN` (lê a API)                                                                                                                                                                                          |

Segredos nunca são compartilhados entre staging e produção. Cada variável
está detalhada no `docs/variaveis-de-ambiente.md` do repositório que a lê.

### O CI dos três (desde 10/11/2026)

Os três repositórios têm a mesma forma: um workflow por gatilho, a validação
num workflow reutilizável só (`validate.yml`) e o deploy numa ação composta,
com os mesmos nomes de arquivo, de job e de passo quando é a mesma coisa. Os
nomes são curtos, em inglês e nunca uma pergunta: um teste em cada
repositório recusa `?` em nome de job ou de passo. O detalhe de cada job fica
no manual do repositório.

| Arquivo          | Gatilho                                                      | API                                                                                                                      | Web                                                                                                                                     | App                                                                                               |
| ---------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ci.yml`         | push em branch de trabalho; _Run workflow_                   | `Changes`, `Secret scan`, `Validate`                                                                                     | `Changes`, `Secret scan`, `Validate` (no _Run workflow_ com `image_tag`, também `Browser suites`)                                       | `Changes`, `Secret scan`, `Validate`                                                              |
| `validate.yml`   | chamado pelos outros (`workflow_call`)                       | `Validate`, `E2E (1/3)`, `E2E (2/3)`, `E2E (3/3)`, `AI OCR`; num push de documentação, `Docs`; depois de todos, `Result` | `Validate`, `Browser suites (1/2)`, `Browser suites (2/2)`; num push de documentação, `Docs`; depois de todos, `Result`                 | `Validate`; num push de documentação, `Docs`                                                      |
| `staging.yml`    | push em `staging`                                            | `Changes`, `Secret scan`, `Validate` → `Gate` → `Build` → `Image scan` → `Deploy`                                        | `Changes`, `Secret scan` → `Build` (`candidate-<7>`) → `Image scan`, `Browser suites`; `Validate` desde o `Changes` → `Gate` → `Deploy` | `Changes`, `Secret scan`, `Validate` → `Gate` → `Publish` (OTA; o binário pelo fingerprint)       |
| `pr.yml`         | PR para `main` (no app, também para `staging`)               | `Secret scan`, `Staging evidence`                                                                                        | `Secret scan`, `Staging evidence`                                                                                                       | `Secret scan`, `Staging evidence` (para `staging`: `Changes`, `Secret scan`, `Validate`)          |
| `production.yml` | push em `main`; na API e na web, _Run workflow_ é o rollback | `Staging evidence` → `Deploy` (aprovação) → `Release`                                                                    | `Staging evidence` → `Deploy` (aprovação) → `Release`                                                                                   | `Changes`, `Secret scan`, `Staging evidence`, `Dependency audit` → `Gate` → `Publish` (aprovação) |
| ações compostas  | —                                                            | `.github/actions/setup`, `deploy` e `siblings`                                                                           | `.github/actions/setup`, `secret-scan` e `deploy`                                                                                       | `.github/actions/setup`, `secret-scan` e `publish`                                                |

Além desses, a API tem o `cloudflare-ranges.yml` (semanal) e o app, o
`native-build.yml` (build manual) e o `ota-rollback.yml`. Na tela do GitHub,
um job do `validate.yml` aparece com o nome de quem o chamou na frente:
`Validate / Validate`, `Validate / E2E (1/3)`, `Browser suites / Browser
suites (1/2)`, `Validate / Docs`, `Validate / Result`.

Regras comuns:

- **Push só de documentação** (todo arquivo em `*.md` ou `docs/**`): roda o
  `Secret scan` e o `Docs` (os unitários sem cobertura, porque há testes que
  leem a documentação). Nada de build, deploy ou OTA, e um vermelho cai no
  commit que o causou. A marcação de pular CI continua permitida só em
  commit de documentação, e nunca na ponta do PR para `main`.
- **Cancelamento**: um push novo na `staging` cancela só a **validação** do
  run anterior; build, deploy e publicação nunca são cancelados, e só o run
  da cabeça da branch implanta (`Check run is branch head`). Na `main`, nada
  é cancelado.
- **Base do audit**: o último build que a `staging` serviu (`staged-<7>` na
  API e na web; no app, o último run verde da `staging`), não o push
  anterior. O audit só bloqueia quando muda `package.json`, o lockfile ou o
  `audit-ci.jsonc`, e repete 3 vezes uma falha de rede.
- **`Gate`**: junta tudo o que bloqueia o deploy num check só, e é ele que
  o `Staging evidence` confere no commit promovido. Todo job depois do
  `Gate` (ou de um job que chama o `validate.yml`) declara a própria função
  de status: `!cancelled()` e o resultado, ou uma saída, de cada job de que
  precisa. Sem ela, o `success()` implícito do GitHub vê os jobs pulados
  dentro do `validate.yml` e pula o deploy mesmo com o `Gate` verde
  ([actions/runner#2205](https://github.com/actions/runner/issues/2205));
  só com o `!cancelled()`, o job rodaria depois de um `Gate` vermelho. Um
  teste em cada repositório recusa as duas coisas.
- **O veredito do `validate.yml`**: o `Gate` lê a saída do `validate.yml`,
  nunca o `needs.<job que o chama>.result`. Em toda chamada algum job lá
  dentro é pulado (o `Docs` num push de código, as suítes sem imagem), um
  job pulado dentro de um workflow reutilizável vaza para quem o chama
  ([community/discussions/189172](https://github.com/orgs/community/discussions/189172)),
  e o valor que isso deixa no resultado do chamador não é contrato: se
  fosse `skipped`, o `Gate` ficaria vermelho em todo push. Dentro do
  `validate.yml` o resultado de cada job é confiável. Na API e na web, o
  job `Result`, depois de todos, confere cada um contra o que a chamada
  pediu (verde se pedido, pulado se não) e publica `passed`; com o E2E e as
  suítes em matriz, a saída de um job não serviria (fica a do último shard
  que escreve). No app, sem matriz, o último passo de cada job grava a
  saída dele (`validate-passed`, `docs-passed`). A única leitura do
  resultado de quem chama é a da web, para conferir que as suítes que o
  `Changes` deixou de fora nem começaram (pulada pelo próprio `if`, sem
  nada dentro que vaze). Um teste em cada repositório recusa outra.

**Mudança que atravessa repositórios: branches com o mesmo nome.** Uma
mudança que mexe em mais de um repositório (uma rota nova que a web chama, um
evento de socket que o app ouve, uma regra compartilhada) vai numa branch
com **o mesmo nome** em cada um (por exemplo `feat/entregas-x` na API, na web
e no app). O passo `Pick the sibling branches` (id `refs`, o mesmo texto nos
três) procura no irmão a branch de mesmo nome e faz o checkout dela; só a
resposta "essa branch não existe" (código 2 do `git ls-remote`) cai na
`staging` do irmão, com aviso, e um erro de rede ou de credencial repete (3
vezes na API e no app, 4 na web) e depois falha, nunca cai na `staging` por
engano. Na API, o passo está na ação `.github/actions/siblings`, chamada pelo
`Validate` e pelo `Docs` do `validate.yml`, e lê a web e o app; na web, nos
jobs `Validate` e `Browser suites` do `validate.yml`; no app, no `Validate`
do `validate.yml`; os dois leem a API. Por isso o `ci.yml` existe nos três:
o push na branch de trabalho testa cada lado contra a sua contraparte, e na
`staging` a sonda acha a `staging` do irmão. O `compose-ci-siblings.test.ts`
da API executa todas as sondas dos três repositórios, exige que todo
checkout de irmão use a resposta dela e que todo checkout de outro
repositório escreva por extenso a organização e o nome (sem expressão,
em qualquer caixa). Suba primeiro o lado que o outro consome (em geral a
API) e mantenha os nomes iguais até o merge. Na `staging`, quando os dois
lados dependem um do outro, vale a ordem do primeiro push, abaixo.

**Esta seção é uma só.** O `shared-deploy-section.test.ts` da web e o do
app comparam a cópia deles com a da API ao lado (a branch de mesmo nome ou
a `staging` dela), byte a byte, e também os nomes dos cinco workflows e dos
jobs que os dois têm em comum, como o `dokploy-deploy.test.ts` da web
compara o script de deploy. A cópia da API é a referência: mude primeiro a
dela e depois a da web e a do app, e suba nessa ordem, como em todo
release.

**Checks exigidos nos Rulesets.** Na `main` dos três, exija só
**`Secret scan`** e **`Staging evidence`**, os dois do `pr.yml`: o _Staging
evidence_ já prova que o staging rodou o commit e que o `Gate` dele está
verde, então a validação não é exigida de novo. Troque o Ruleset no primeiro
PR `staging → main` de cada repositório depois da virada; antes disso, não
tire os nomes antigos, ou o PR fica sem check nenhum. Os nomes antigos
deixaram de existir:

| Repositório       | Checks antigos a tirar da `main`                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trajetto-api`    | `Lint, type-check, unit (coverage floor) and E2E`, `AI OCR service (image + pytest)`, `Secret scan (gitleaks)` e `The PR head was built on staging`                                                                                                                                                                                                                                                              |
| `trajetto-ui`     | `Validate (audit, lint, types, unit and rule tests)`, `Secret scan (gitleaks)` e `UI, a11y and responsive against a running stack`                                                                                                                                                                                                                                                                               |
| `trajetto-mobile` | nenhum, pelo guia do desenvolvedor (a `main` do app não exigia check: um commit marcado para pular CI na ponta prendia o PR); se algum destes estiver lá, tire: `Lint, type-check, unit tests and Expo doctor`, `Secret scan (gitleaks)`, `Checks / ...`, `What this push ships`, `Was this commit green on staging?`, `Staging (OTA and internal APK)`, `Production (OTA and store build)` e `Manual EAS build` |

Na `staging`, PR não é exigido (o dono faz push direto). Quem quiser exigir
PR ali marca `Validate / Validate`, `Validate / Docs` e `Secret scan` (no
app, no lugar dos antigos `Lint, type-check, unit tests and Expo doctor` e
`Secret scan (gitleaks)`).

**Minutos do Actions, os três somados.** A cota do plano Free da
organização é de 2.000 min por mês, dividida pelos três repositórios, e cada
job é cobrado arredondado para cima, em minutos. Um push de código na
`staging` custa uns 61 min na API, 54 na web e 14 no app: uns 129 min quando
a mesma mudança vai aos três (antes da troca, 75 + 51 + 13 = 139). Um push só
de documentação custa 12 + 15 + 8 = 35 min, e um release (o PR `staging →
main` e o merge) 13 + 8 + 10 = 31 min. O `Result` da API e o da web somam 1
min por chamada do `validate.yml` (2 num push de código da web, que o chama
duas vezes): é o preço de o `Gate` não depender do resultado de quem chama.
No ritmo de novembro de 2026, o mês fica em uns 1.750 min na API, 1.350 na
web e 335 no app: uns 3.400 min, contra uns 4.500 antes da troca, ainda
acima da cota. Por isso o orçamento com teto (abaixo) não é opcional: sem
minutos, nenhum job começa, nem um de aviso, e o run só diz _failed_.

**Ações do dono na virada**, nos três:

1. **Rulesets**: a troca acima, no primeiro PR para `main` de cada
   repositório.
2. **Orçamento do Actions** (organização → _Settings → Billing and
   licensing_): uma forma de pagamento com orçamento limitado (US$ 10–15 por
   mês) e alertas em 75, 90 e 100 %, com bloqueio no limite. Run _failed_
   sem nenhum job vermelho é a cota: veja _Summary → Annotations_.
3. **Limpeza do GHCR**: `candidate-*` e `suites-*` são só da web (o pacote
   `trajetto-ui`); a API não publica `candidate-*`, e o app não publica
   imagem. A retenção está no manual da web, seção 17.
4. **Runs antigos**: antes do push de cada repositório, nenhum run do
   workflow antigo rodando ou esperando aprovação (o `deploy.yml` da API e da
   web, o "Release (EAS)" do app); não faça merge em `main` com um deles em
   andamento. No app, despache antes do merge na `main` qualquer release que
   dependa de commits antigos da `staging`: o `Staging evidence` só
   reconhece runs do `staging.yml`.
5. **Nomes dos runs** (os e-mails do GitHub, os filtros e o vigia): o
   `validate.yml` não vira run próprio, os jobs dele aparecem dentro do run
   de quem o chama.

   | Repositório       | Antes                                                                                                              | Depois                                                                                                                           |
   | ----------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
   | `trajetto-api`    | `CI (branches)`; `Pipeline (staging → produção)` (push em `staging` e em `main`, e o PR para `main`)               | `CI`; `Staging`, `Pull request` e `Production`                                                                                   |
   | `trajetto-ui`     | `CI` (também no PR para `main`); `Browser suites` (o PR para `main`); `Deploy` (push em `staging` e em `main`)     | `CI` (só branch de trabalho); `Pull request`; `Staging` (as suítes de navegador viram jobs dele) e `Production`                  |
   | `trajetto-mobile` | `CI` (também nos PRs para `staging` e `main`); `Release (EAS)` (push em `staging` e em `main`, e o _Run workflow_) | `CI` (só branch de trabalho); `Pull request`; `Staging`, `Production` e `Native build` (o build manual); `OTA rollback` não muda |

6. **Na máquina**: depois de puxar a API, `yarn install --force` antes do
   E2E local (o ambiente do E2E é uma dependência `file:`).

**Ordem do primeiro push com o CI novo: web e app, API, web e app de
novo**, um passo de cada vez, acompanhando o run de cada um antes do
seguinte. Desde a troca, o CI de cada repositório lê o irmão também no push
em `staging` (o `Validate` faz o checkout da `staging` dele; antes, isso era
pulado ali), e neste lote os dois lados mudaram arquivos que o outro lê:

- **A web e o app leem a `staging` da API**: o `dokploy-deploy.test.ts` da
  web exige a cópia do `.github/scripts/dokploy-deploy.mjs` igual à da API;
  os testes de paridade (`cpf-field-api-parity`, `recipient-email-api-parity`
  e os outros) comparam com o código dela; e o
  `shared-deploy-section.test.ts` dos dois compara esta seção com a da API.
- **A API lê a `staging` da web e a do app**: o
  `public-docs-guide-samples.test.ts` exige no guia de erros da web
  (`src/content/docs/erros.mdx`) todo código que o documento público
  publica, como os `DELIVERY_NOT_CANCELLABLE` e `DELIVERY_STATUS_CONFLICT`
  do cancelamento de entrega, e a cópia do documento na web
  (`tests/unitaires/fixtures/public-openapi.json`) igual ao documento ao
  vivo; e o `app-reading-windows.test.ts` exige no app os números da API,
  como o mínimo do motivo da pausa (`PAUSE_NOTE_MIN_LENGTH`, de
  `features/pauses/pause-rules.ts`), que o app da `staging` ainda não tem.

Numa réplica Linux de 11/11/2026, a API deste lote contra a `staging` antiga
da web e do app ficou vermelha nesses dois arquivos; a web e o app
contra a `staging` antiga da API ficam vermelhos nos deles. Nenhuma ordem
fica verde de primeira. A que mantém o deploy da API antes do da web, e o
do app por último:

1. **Web e app**: o push dos dois. O run de cada um fica vermelho só nos
   testes que leem a `staging` da API, e um run vermelho não implanta nada
   no staging nem publica OTA.
2. **API**, logo depois: o `Validate` dela lê a `staging` nova da web e do
   app e passa. Espere o `Deploy` dela.
3. **Web de novo**: reexecute o run mais novo da `staging` da web
   (_Re-run all jobs_). Ele lê a API nova e implanta. Espere o `Deploy`.
4. **App de novo**: reexecute o run mais novo da `staging` do app. Ele
   publica a OTA.

Os passos 3 e 4 não são teste instável rodado de novo: o vermelho do passo 1
é o irmão ainda na versão anterior, e o mesmo run fica verde, e sempre, com
o irmão já na `staging`. Os três passos do zod 4 (manual da API, seção 15,
"zod 4.6.7 e fastify-type-provider-zod 7.0.0") cabem nesta ordem: a cópia
do documento e o zod 4 da web e do app vão no passo 1, e a API em zod 4 no
passo 2. Fora de um lote assim, vale a regra das branches de
mesmo nome (acima): suba primeiro o lado que o outro consome. O
`compose-ci-siblings.test.ts` da API lê as sondas da web e do app no formato
antigo e no novo, e o `compose-rollout-verify.test.ts` lê o deploy da web
nos dois formatos: nenhum dos dois prende a ordem.

O que acompanhar no primeiro run de cada um (o que só um run de verdade
confirma):

- os nomes dos checks como os Rulesets vão vê-los, inclusive os que vêm do
  reutilizável (`Validate / Validate`, `Validate / E2E (1/3)`, `Browser
suites / Browser suites (1/2)`), e o `Gate` com esse nome exato (o
  _Staging evidence_ da API e da web o procura por ele);
- que o job depois do `Gate` **rodou**, e não ficou _Skipped_: o `Build` na
  API e na web, o `Publish` no app;
- que o `Gate` leu o veredito pela saída do `validate.yml`: na API e na
  web, o `Validate / Result` verde (e o `Browser suites / Result`, na web)
  com o `Docs` pulado e o `Gate` verde; no app, o `Gate` verde lendo
  `validate-passed`. Um `Gate` vermelho dizendo `Validate (Validate /
Result)` com o `Result` verde seria a saída que não chegou ao chamador:
  um defeito do workflow, não do código;
- o tempo de cada job, contra a tabela de minutos do manual de cada um;
- as tags e a publicação: na API, `sha-<7>` das três imagens e `staged-<7>` da API e da IA;
  na web, `candidate-<7>`, `sha-<7>`, `suites-<7>` e `staged-<7>` no mesmo
  digest, com os dois shards das suítes; no app, a OTA no canal `staging` e
  o passo `Check native binary` dizendo que o binário do runtime existe
  (nenhum build enfileirado);
- um segundo push de código em menos de 10 min: a validação do run anterior
  fica cancelada (cinza) e nada é implantado por ele; depois, um push só de
  documentação sobre um build já servido, que roda só o `Secret scan` e o
  `Docs`;
- no primeiro PR para `main`: os dois checks novos chegando, e a troca do
  Ruleset.

### Ordem do primeiro deploy

1. **GitHub, nos três repositórios:** branch `staging` criada a partir de
   `main`; environments `staging` e `production` (este com revisores e só a
   branch `main`); só merge commit habilitado; proteção de `main`. Um
   primeiro push em `staging` em cada repositório: a API e a web publicam
   `sha-<7>` no GHCR e pulam o deploy; o app pula o EAS até o `EXPO_TOKEN`
   existir.
2. **Servidor:** VPS com Dokploy, rotação de log no `/etc/docker/daemon.json`,
   Traefik ajustado com `trajetto-api/infra/traefik/`, DNS na Cloudflare (Full
   strict) para os hosts da web e da API, e um token _classic_
   `read:packages` do GHCR (o mesmo serve para as quatro imagens: API,
   migração, IA e web).
3. **Contas externas:** buckets R2 de fotos (um por ambiente, CORS com a
   origem da web) e de backup do banco (`trajetto-backups`, com um prefixo
   por ambiente; recomendado um bucket próprio para produção,
   `trajetto-backups-prod`), widgets do Turnstile por ambiente, Meta e
   Resend (de teste em staging), heartbeats de monitoramento.
4. **API de staging** (manual da API), no projeto `trajetto-api` do
   environment `staging`, nesta ordem e conferindo cada um: Databases
   **PostgreSQL** e **Redis**; Application **`trajetto-ai`** (com o
   `AI_TOKEN`); Application **`trajetto-api-migrate`** (a URL do banco sem
   tetos e _Restart Policy_ `none`; num banco vazio, também
   `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` e as `MASTER_USER_*` só no
   primeiro deploy, apagadas depois; manual da API, seções 8 e 15);
   Application **`trajetto-api`** (com `AI_LOCAL_TOKEN` igual,
   `AI_LOCAL_URL` apontando para a IA e as URLs do banco e do Redis),
   **sem Deploy**: ela recusa o banco até a etapa de release rodar. Depois,
   os secrets `DOKPLOY_*` (os quatro obrigatórios, com o
   `DOKPLOY_MIGRATE_APPLICATION_ID`) e a variável `API_PUBLIC_URL` no
   environment `staging` da API, e um run do pipeline (push ou _Run
   workflow_ na `staging`): ele roda as migrations e só então faz o deploy
   da IA e da API. Confira `/health/readiness` e, como MASTER na web,
   _Sistema → Provedores_. Por fim, o **backup** na aba _Backups_ do
   Database PostgreSQL (destino S3 no R2, diário). As Applications de papel
   (`trajetto-worker` e as outras) não entram no primeiro deploy: o dono
   cria cada uma depois, quando o plano de escala pede (manual da API,
   seção 19).
5. **Web de staging** (Application `trajetto-ui` do projeto `trajetto-ui` no
   environment `staging`, manual da web): imagem
   `:staging`, `HTTP_REQUEST` e `PUBLIC_API_URL` apontando para a API de
   staging, o mesmo `RATE_LIMIT_FORWARDER_SECRET` da API de staging, e o
   `HTTP_REQUEST` da API de staging igual à origem da web de staging. Depois,
   `DOKPLOY_URL`, `DOKPLOY_API_KEY` (a mesma chave da API serve),
   `DOKPLOY_UI_APPLICATION_ID` e `METADATA_BASE_STAGING` no environment
   `staging` da web.
6. **App de staging** (manual do app): ambiente EAS `preview` (o EAS não
   tem ambiente `staging`; o perfil `staging` lê o `preview`) com
   `EXPO_PUBLIC_API_URL` = API de staging e
   `EXPO_PUBLIC_WEB_APPLICATION_URL` = web de staging; `EXPO_TOKEN` no
   GitHub; um push em `staging` gera o APK de staging.
7. **Produção, na mesma ordem:** a tag `stable` da API criada antes (_Run
   workflow_ do `production.yml` da API com `image_tag=sha-<7>`, enquanto o
   environment `production` ainda não tem os secrets do Dokploy); as mesmas
   peças (Databases com o backup, IA, migrations e API, esta sem Deploy) no
   projeto `trajetto-api` do environment `production`, já em `:stable`; os
   secrets de produção (os quatro `DOKPLOY_*`) e o primeiro promote da API
   (o PR `staging → main`, ou _Run workflow_ na `main` com o mesmo
   `sha-<7>`), que cria `trajetto-api-migrate:stable`, roda a etapa de
   release e só então faz o deploy da API; as conferências da API; depois a
   Application `trajetto-ui` do environment `production` e o PR da web; por
   último o PR do app, que gera o AAB de produção apontando para a API de
   produção.

### Ordem de cada release

**API → web → app**, sempre:

1. **API:** merge `staging → main`, aprovação, convergência das réplicas.
   Mudanças de rota seguem expandir e depois contrair: a API nunca tira uma
   rota que a web ou o app em produção ainda chamam. Dentro do deploy da
   API, as Applications vão numa ordem fixa (manual da API, seções 3 e 19):
   `trajetto-pgbouncer` → `trajetto-api-migrate` → `trajetto-ai` →
   `trajetto-worker` → `trajetto-scheduler` → `trajetto-worker-external` →
   `trajetto-api` → `trajetto-ingest` → `trajetto-realtime`. O PgBouncer
   (onda 17 do plano de escala) só é implantado quando o digest dele mudou
   (um push que não muda `infra/pgbouncer` não o reimplanta) e com a
   Application criada e o secret `DOKPLOY_PGBOUNCER_APPLICATION_ID`; sem
   eles, só a tag dele anda. A etapa de release (a
   migrate) só roda quando as migrations mudaram, e a IA só quando o digest
   dela mudou. Os papéis de fila (worker, scheduler e worker-external) vão
   antes da API; os de borda (ingest e realtime), só depois de a
   conferência da API passar. Cada papel puxa a própria tag,
   `<tag>-<papel>`, que anda para o digest da API logo antes do deploy
   dele, e só é implantado com a Application criada e o secret
   `DOKPLOY_<PAPEL>_APPLICATION_ID`: sem nenhum, o deploy é migrate → IA →
   API, como antes do plano de escala. Um papel que falha para tudo o que
   vem depois, a API inclusive.
2. **Web:** só depois. O gate de rotas do promote falha se a API de
   produção ainda não serve alguma rota que o build da web chama.
3. **App:** por último. Se o app passou a enviar algo novo, o
   `CLIENT_CONTRACT` (`utils/client-version.ts`) sobe e a API compatível já
   precisa estar em produção; `MIN_MOBILE_CONTRACT` só sobe depois que a OTA
   (ou o binário) com o contrato novo estiver publicada e os contratos
   antigos sumirem dos logs da API.

**Compatibilidade: duas versões ficam no ar juntas.** O rolling sobe a
réplica nova antes de tirar a anterior, um papel de fila sobe antes da API,
e um rollback devolve a imagem anterior: por alguns minutos (ou até o
rollback seguinte), a versão nova e a anterior servem juntas, contra o
mesmo banco e o mesmo Redis. O worker novo trabalha o que a API anterior
enfileirou, e a API anterior lê o que o worker novo gravou. Por isso:

- **Expandir antes, contrair depois.** Primeiro vai o release que aceita o
  novo (a coluna, a rota, o campo, o evento, a mensagem entre processos) e
  continua aceitando o antigo; a contração, que tira o antigo, só num
  release seguinte, com a expansão já em produção e, quando o manual da API
  marca uma data, depois dela. A expansão e a contração que depende dela
  nunca vão no mesmo release: a imagem anterior, que serve durante o
  rolling e volta num rollback, ainda usa o que a contração tira. Quando um
  lote sai num push só, a contração dele vai como passo de
  `prisma/post-deploy`, que espera todo processo ter a capability (manual
  da API, seção 17, "Contrações que esperam a capability"), ou fica fora da
  `staging` até o release seguinte.
- **A web, do mesmo jeito:** não tira uma Server Action ou rota no mesmo
  release em que deixa de usá-la, e lê como opcional o campo novo que a API
  anterior ainda não manda.
- **O app, por contrato.** Um build antigo fica meses nas ruas (OTA
  atrasada, aparelho sem rede), e a API aceita todo contrato desde o
  `MIN_MOBILE_CONTRACT`. O app que passa a enviar algo novo sobe o
  `CLIENT_CONTRACT`, e a OTA (ou o binário) só sai com a API que aceita o
  novo já em produção. O `MIN_MOBILE_CONTRACT` só sobe com o aval do dono,
  depois de a adoção do contrato novo aparecer na conta que a API faz dos
  envios de posição (`/health/metrics` e o `ops_sample`); no contrato 8,
  seis semanas depois de pelo menos 95% deles virem do 8.

**O lote das ondas 2 a 5 (contrato 6 do app)**, nesta ordem:

1. **API**, com as três migrations só de expansão
   (`20261106120000_user_must_change_password`,
   `20261106120100_driver_trusted_device` e
   `20261106120200_driver_trusted_device_backfill`) e a de dados
   `20261109120000_kanban_service_order_card_without_amount`, que o pipeline
   roda pela `trajetto-api-migrate` antes do deploy. Depois do rollout, rode
   de novo à mão o `UPDATE` dessa última ("Card automático da ordem de
   serviço sem valor", na seção 15). Antes do
   deploy, o dono define as quatro `MAP_TILE_*` no _Environment_ da
   Application `trajetto-api`, em staging e em produção, com os valores da
   web do mesmo ambiente. Já com esta API, o login por CPF passa a valer só
   num aparelho confiável para aquele login, em todos os builds do app
   (manual da API, seção 15, "Conta e acesso do motorista, onda 2").
2. **Web:** logo depois da API. Até ela subir, a web anterior mostra ao
   motorista "R$ 0,00" e "N/A" no histórico de ordens de serviço do veículo
   ("Ordens de serviço sem valores para o motorista", na seção 15).
3. **App:** por OTA, sem binário novo, com o contrato 6, e só com a API do
   passo 1 em produção. Antes da OTA de produção, confira num aparelho com
   o build de staging que os tiles do MapTiler aparecem no mapa ao vivo (a
   página carrega sob a origem da web do build). `MIN_MOBILE_CONTRACT` fica
   como está até o contrato 5 sumir dos logs da API.

**O lote de 09 e 10/11/2026 (contrato 7 do app)**, nesta ordem:

1. **API**, com a migration só de expansão
   `20261110120000_delivery_event_api_key` e a de dados
   `20261110130000_customer_message_suppression_email_entries`, que o
   pipeline roda pela `trajetto-api-migrate` antes do deploy. Antes do
   deploy, o dono define `ADDRESS_SEARCH_URL` e `ADDRESS_SEARCH_PROTOCOL` no
   _Environment_ da Application `trajetto-api`, em staging e em produção
   (sem elas, a busca do "Fixar no mapa" responde 503 e nada quebra), e
   roda em produção as duas contagens só de leitura: motoristas com CPF
   inválido e entregas em aberto com lista ou nome no e-mail. No staging,
   antes de promover, faz o teste de e-mail real pela Resend
   (nodemailer 10) e abre o `/docs` interno com o `DOCS_USER` e o
   `DOCS_PASSWORD` (CSS, logo, lista de rotas, sem erro de CSP no console).
   Depois do rollout, roda de novo à mão o `INSERT` da migration de dados.
   Tudo no manual da API, seção 15 ("CPF conferido no cadastro do
   motorista", "Busca de endereço do 'Fixar no mapa'", "nodemailer 10.3.1 e
   o e-mail do destinatário das importações e do painel" e "@fastify/static
   10.1.8 e @fastify/swagger-ui 6.1.3"). No push para a
   `staging`, este lote segue a "Ordem do primeiro push com o CI novo"
   (acima): a web e o app vão antes e ficam vermelhos só nos testes que
   leem a `staging` da API (o CI da web roda o `cpf-field-api-parity` e o
   `recipient-email-api-parity` contra ela), a API sobe depois, lendo a
   web e o app novos, e os runs mais novos da web e do app são
   reexecutados.
2. **Web:** só com a API do passo 1 em produção. A web nova chama
   `GET /address-search/:businessId` e `POST /user/session/revoke` (na API
   desde 04/11/2026, ainda fora da `v1.3.0`), oferece o escopo
   `deliveries:cancel`, que a API anterior recusa com 400, e manda a lista
   de e-mails do destinatário no cadastro e na edição da entrega, que a API
   anterior recusa com 400. O gate de rotas
   do promote só cobra as rotas com `API_DOCS_URL` (e `DOCS_USER` e
   `DOCS_PASSWORD`) no _environment_ de produção da web; sem ela, confira
   as duas no `/docs/json` da API de produção antes de promover (manual da
   web, seção 13).
3. **App:** por último, por OTA, sem binário novo, com o contrato 7 (o
   motivo na pausa por outro motivo e o "Novo assunto" do chat) e a troca
   de tema mais leve. Nada é recusado por contrato: o app 7 funciona sobre
   a API anterior. `MIN_MOBILE_CONTRACT` não muda.
   O **zod 4 do app** (zod 3.25.76 → 4.6.7) vai nessa mesma OTA, sem
   binário novo (manual do app, "Canais, branches e runtime") e sem mexer
   no `CLIENT_CONTRACT`, e em produção não depende do zod da API (manual
   da API, seção 15, "zod 4.6.7 e fastify-type-provider-zod 7.0.0"): o
   zod 4 mede um texto em caracteres, com o emoji contando 1, e o zod 3 em
   unidades UTF-16, com o emoji contando 2, e os textos livres que o app
   põe na fila ("Quem recebeu", a descrição da ocorrência e as observações
   do checklist e do abastecimento) conferem o teto em unidades, que
   nenhuma das duas recusa pelo tamanho. Um rollback da API para o zod 3
   não pede o da OTA. No push para a `staging` deste lote, o app em zod 4
   vai no passo 1 da "Ordem do primeiro push com o CI novo" (acima), com a
   web em zod 4, e fica vermelho nos testes que leem a `staging` da API,
   entre eles o `occurrence-form-rules.test.ts`, que compara a cópia do
   app, linha a linha, com o arquivo da `staging` da API; a API em zod 4
   sobe no passo 2, e o run do app reexecutado no passo 4 publica a OTA.
   Fora de um lote assim, o app em zod 4 sobe depois da API em zod 4 (o
   passo 3 da ordem do manual da API).

**O lote do plano de escala (contrato 8 do app)**, nesta ordem:

1. **API**, com todas as ondas de código do plano num release só. Sem as
   Applications de papel, o run implanta migrate → IA → API, como hoje, e
   cada réplica da API segue fazendo tudo (`PROCESS_ROLE` ausente vale
   `all`). A imagem que serve durante o rolling, e que volta num rollback,
   é a de antes do plano: por isso as contrações do plano esperam a
   capability (manual da API, seção 17) ou ficam para depois (onda 20 do
   plano). O `trajetto-worker` de staging é criado depois deste deploy
   (manual da API, seção 19); o de produção, só na onda 14 do plano.
2. **Web:** só com a API do passo 1 em produção.
3. **App:** por último, por OTA, sem binário novo, com o contrato 8 (as
   posições recuam quando a API falha ou pede calma; manual do app,
   "Versão do contrato e gate com a API"), e só com a API do passo 1 em
   produção. Nada é recusado por contrato: o app 8 funciona sobre a API
   anterior, e a API continua aceitando o 7. `MIN_MOBILE_CONTRACT` não
   muda.

No push para a `staging`, este lote segue a "Ordem do primeiro push com o
CI novo" (acima): esta seção mudou nos três, e o
`shared-deploy-section.test.ts` da web e do app a compara com a da
`staging` da API. A web e o app vão antes e ficam vermelhos nos testes que
leem a `staging` da API, a API sobe depois, lendo a web e o app novos, e
os runs mais novos da web e do app são reexecutados.

## 27. PITR com pgBackRest

> Plano de escala, itens F1-01 a F1-03, F1-19 e F1-26. O PITR (restaurar o
> banco até o minuto) liga em etapas: na staging, o F1a (onda 3); na
> produção, primeiro a troca da imagem **sem** arquivamento (onda 3) e só no
> fim da onda 6 o F1b, depois que a API deixar de conectar como
> superusuário (decisão D61: uma injeção de SQL com superusuário leria as
> chaves do PITR no ambiente do contêiner). O backup do Dokploy
> ([seção 18](#18-backup-e-restauração)) continua nos dois ambientes, com a
> mesma agenda e as mesmas 30 cópias.

O Database PostgreSQL passa a rodar a imagem `trajetto-postgres`
(`infra/postgres`): a `postgres:16-alpine` pelo mesmo digest da CI (o mesmo
Postgres 16, a mesma musl e a mesma colação, então a troca serve no volume de
hoje), mais o pgBackRest compilado da fonte, os parâmetros de produção
(`infra/postgres/postgres.params`), toda a memória derivada do teto e os
scripts `trajetto-backup` e `trajetto-restore-drill`. O porquê de cada valor
está nos comentários do `infra/postgres/trajetto-entrypoint.sh`; as travas
dos buckets, em `infra/r2/bucket-locks.md`; o ensaio, em
[`runbooks/restore-drill.md`](./runbooks/restore-drill.md).

### Regras do Database

- **Imagem sempre por digest**, copiado do resumo do run que a publicou (o
  `Build` do `staging.yml` escreve o digest e "troca no Database: ação do
  dono"):
  `ghcr.io/trajetto-organization/trajetto-postgres@sha256:<digest>`. O
  pacote é público, então o Database não precisa de credencial do GHCR.
  Nenhum passo da CI implanta o Database.
- **_Command_ e _Args_ do Database ficam VAZIOS.** O _Command_ troca o
  entrypoint da imagem e o wrapper (`trajetto-entrypoint.sh`) deixa de
  rodar; os _Args_ trocam o `CMD`, e um valor como o antigo
  `docker-entrypoint.sh postgres -c …` também pula o wrapper. Sem ele, a
  memória volta aos padrões do Postgres e o arquivamento desliga sem erro
  (o alerta `pitr-archive-off` avisa quando `PITR_EXPECTED=true`). Um
  parâmetro novo vai no `infra/postgres/postgres.params`, versionado, que
  vai e volta com a imagem; nunca por `ALTER SYSTEM`, que fica no volume e
  sobrevive à volta do digest.
- **`CHECKPOINT` antes de cada _Deploy_ do Database**, entre 00h e 05h BRT,
  com aviso. Cada mudança (imagem, _Environment_, _Resources_) recria o
  contêiner: junte tudo num _Deploy_ só.
- **`POSTGRES_MEMORY_LIMIT_MB` igual ao _Memory Limit_**, em MiB. Se o
  teto do contêiner for menor, o wrapper usa o teto e avisa no log.
- Nos comandos abaixo, `trajetto-postgres-staging` e
  `trajetto-postgres-production` são os marcadores dos App Names
  ([seção 7.2](#72-nomes-name-e-app-name)); o usuário e o banco são os do
  Database (`trajetto`).

### Valores por ambiente

As variáveis vão no _Environment_ do Database PostgreSQL (não no da API);
o passo a passo de cada etapa vem a seguir. "—" = não definir. O que cada
variável faz:
[`variaveis-de-ambiente.md`, seção 14](./variaveis-de-ambiente.md#14-backup-do-banco).

| Variável ou campo                                                               | Staging (F1a)                                   | Produção, troca (onda 3)            | Produção, F1b (onda 6)                  |
| ------------------------------------------------------------------------------- | ----------------------------------------------- | ----------------------------------- | --------------------------------------- |
| _Docker Image_                                                                  | `trajetto-postgres@sha256:<digest>`             | `trajetto-postgres@sha256:<digest>` | `trajetto-postgres@sha256:<digest>`     |
| _Memory Limit_                                                                  | `603979776`                                     | `2147483648`                        | `2147483648`                            |
| _CPU Limit_                                                                     | `500000000`                                     | vazio                               | vazio                                   |
| _Command_ e _Args_                                                              | vazios                                          | vazios                              | vazios                                  |
| `POSTGRES_MEMORY_LIMIT_MB`                                                      | `576`                                           | `2048`                              | `2048`                                  |
| `POSTGRES_MAX_WAL_SIZE`                                                         | `1GB`                                           | `8GB`                               | `8GB`                                   |
| `POSTGRES_MAX_SLOT_WAL_KEEP_SIZE`                                               | `2GB`                                           | —                                   | `4GB`                                   |
| `PGBACKREST_ARCHIVE_PUSH_QUEUE_MAX`                                             | `1GB`                                           | —                                   | `4GB`                                   |
| `PGBACKREST_REPO1_S3_ENDPOINT`                                                  | `<ACCOUNT_ID>.r2.cloudflarestorage.com`         | —                                   | `<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| `PGBACKREST_REPO1_S3_BUCKET`                                                    | `trajetto-pitr-staging`                         | —                                   | `trajetto-pitr-prod`                    |
| `PGBACKREST_REPO1_S3_KEY`, `PGBACKREST_REPO1_S3_KEY_SECRET`                     | o token de escrita do bucket                    | —                                   | o token de escrita do bucket            |
| `PGBACKREST_REPO1_CIPHER_PASS`                                                  | `openssl rand -base64 48`, duas cópias no cofre | —                                   | outra, gerada do mesmo jeito            |
| `PITR_DRILL_REPO1_S3_KEY`, `PITR_DRILL_REPO1_S3_KEY_SECRET`                     | o token só de leitura do bucket                 | —                                   | o token só de leitura do bucket         |
| `PITR_BACKUP_FULL_PING_URL`, `PITR_BACKUP_DIFF_PING_URL`, `PITR_DRILL_PING_URL` | os três checks do healthchecks.io               | —                                   | os três checks do healthchecks.io       |
| `PITR_ARCHIVE`                                                                  | `on`, só no passo 7                             | —                                   | `on`, só no passo 3                     |
| `SHOW shared_buffers` esperado                                                  | `108MB`                                         | `448MB`                             | `448MB`                                 |
| `SHOW archive_mode` esperado                                                    | `off`, e `on` depois do passo 7                 | `off`                               | `on`                                    |
| `PITR_EXPECTED` (na `trajetto-api`)                                             | `true`, no passo 10                             | —                                   | `true`, no passo 7                      |

O teto muda por fase (seção 3.2 do plano de escala): a produção vai a 1792
MiB (`1879048192`) na fase C se o hit ratio passar de 99%, e a 3072 MiB
(`3221225472`) quando a staging sair da VPS; a staging vai a 1024 MiB no
2º VPS. Mude o _Memory Limit_ e o `POSTGRES_MEMORY_LIMIT_MB` juntos, no
mesmo _Deploy_.

### F1a: a staging (onda 3), nesta ordem

A ordem importa: ligar o arquivamento antes da stanza faria todo
`archive-push` falhar e sujaria o aceite de 7 dias. Antes: os buckets
`trajetto-pitr-staging` e `trajetto-pitr-prod`, cada um com um token de
escrita e outro só de leitura, e a senha da cifra no cofre.

1. Anote a colação e a imagem de hoje (para conferir no passo 5 e para a
   reversão):

   ```sh
   c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging)
   docker exec "$c" psql -U trajetto -d trajetto -c "SELECT datname, datcollate, datctype, datlocprovider FROM pg_database ORDER BY 1"
   docker service inspect trajetto-postgres-staging --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'
   ```

2. Database → _Environment_: as variáveis da coluna da staging na tabela
   acima, **sem** `PITR_ARCHIVE`. **Save**.
3. _Advanced → Resources_: _Memory Limit_ `603979776` e _CPU Limit_
   `500000000`. Confira que _Command_ e _Args_ estão vazios. **Save**.
4. `CHECKPOINT`, depois _General → Docker Image_ com o digest → **Save** →
   **Deploy**:

   ```sh
   docker exec "$c" psql -U trajetto -d trajetto -c 'CHECKPOINT'
   ```

5. Confira, com o contêiner novo:

   ```sh
   c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging)
   docker exec "$c" psql -U trajetto -d trajetto -Atc 'SHOW shared_buffers'           # 108MB
   docker exec "$c" psql -U trajetto -d trajetto -Atc 'SHOW shared_preload_libraries' # pg_stat_statements
   docker exec "$c" psql -U trajetto -d trajetto -Atc 'SHOW archive_mode'             # off
   docker exec "$c" psql -U trajetto -d trajetto -Atc 'SHOW trajetto.image_revision'  # o commit da imagem
   docker exec "$c" psql -U trajetto -d trajetto -c "SELECT datname, datcollate, datctype, datlocprovider FROM pg_database ORDER BY 1"
   curl -s -o /dev/null -w '%{http_code}\n' https://api-staging.intrajetto.com/health/readiness   # 200
   ```

   A colação tem de ser a do passo 1, linha por linha. O
   `pg_stat_statements` aparece como `ready` no `/health/metrics`.

6. R2 → `trajetto-pitr-staging` → _Settings → Bucket Lock_: a regra de
   `archive/trajetto/1`, 14 dias (`infra/r2/bucket-locks.md`). Depois, a
   stanza, e logo em seguida a cópia crua do `backup.info` e do
   `archive.info` para o cofre (o mesmo documento diz por quê):

   ```sh
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto stanza-create
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto repo-get --raw backup/trajetto/backup.info > backup.info.stanza
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto repo-get --raw archive/trajetto/archive.info > archive.info.stanza
   ```

7. Database → _Environment_: `PITR_ARCHIVE=on` → **Save** → `CHECKPOINT` →
   **Deploy**. No log do Database: "arquivamento ligado".
8. A prova do repositório, um full, um `archive-get` e as estatísticas do
   archiver zeradas (para o aceite contar só daqui em diante):

   ```sh
   c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging)
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto check
   docker exec -u postgres "$c" trajetto-backup full
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto info
   seg=$(docker exec "$c" psql -U trajetto -d trajetto -Atc 'SELECT last_archived_wal FROM pg_stat_archiver')
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto archive-get "$seg" /tmp/archive-get-teste
   docker exec "$c" rm -f /tmp/archive-get-teste
   docker exec "$c" psql -U trajetto -d trajetto -c "SELECT pg_stat_reset_shared('archiver')"
   ```

   O `trajetto-backup full` termina com uma linha
   `{"result":"ok","type":"full",…}`. Anote a hora do fim dele: o aceite
   conta 7 dias a partir dela.

9. O ensaio, à mão, na janela, com a api e a web da staging em 0 réplicas
   ([runbooks/restore-drill.md](./runbooks/restore-drill.md)):

   ```sh
   docker exec "$c" cat /usr/local/bin/trajetto-restore-drill | bash -s -- --from "$c"
   ```

   Anote o `rto_seconds` e o `loss_seconds` do resumo.

10. `trajetto-api` da staging → _Environment_: `PITR_EXPECTED=true` →
    **Save** → **Deploy**.

Depois, os Schedule Jobs (abaixo) e a prova do Bucket Lock
(`infra/r2/bucket-locks.md`, "Primeiro na staging").

### Troca da imagem na produção, sem arquivamento (onda 3)

A produção ganha o `pg_stat_statements` e a memória certa, e continua sem
PITR: nenhuma `PGBACKREST_*` e nenhum `PITR_ARCHIVE`. O dump do Dokploy
segue sendo o backup dela (RPO de 24 h).

1. Os mesmos passos 1 a 5 do F1a, com `trajetto-postgres-production`, a
   coluna "Produção, troca" da tabela (`POSTGRES_MEMORY_LIMIT_MB=2048`,
   `POSTGRES_MAX_WAL_SIZE=8GB`), _Memory Limit_ `2147483648` e _CPU Limit_
   vazio.
2. Esperado: `SHOW shared_buffers` = `448MB`, `SHOW archive_mode` = `off`,
   o `pg_stat_statements` em `ready` no `/health/metrics`, a colação igual
   à anotada e a readiness de `https://api.intrajetto.com` em 200.

### F1b: o PITR na produção (fim da onda 6)

Pré-condições: `DATABASE_REQUIRE_RUNTIME_ROLE=true` na produção há 7 dias
ou mais; o F1a com 7 dias verdes; no `trajetto-pitr-prod`, a regra de
Bucket Lock de `archive/trajetto/1` (e a de `backup/trajetto/2` só se a
prova da staging passou). Até o F1b, o RPO da produção é o do dump do
Dokploy, 24 h; o dump continua depois dele.

O passo 1 põe a chave de escrita e a cifra do repositório no ambiente do
contêiner do banco. Um login que rode um programa ou leia um arquivo do
servidor (um superusuário, ou um membro de `pg_execute_server_program`,
`pg_read_server_files` ou `pg_write_server_files`) as leria ali, com um
`COPY … FROM PROGRAM 'env'`, e apagaria os backups (decisão D61). O corte
dos roles tira esse poder do runtime, e a trava guarda os últimos 14 dias
mesmo de quem tiver a chave. Por isso, na noite do F1b, antes do passo 1,
confira:

- **O runtime no próprio role há 7 dias.** No histórico de deploys da
  `trajetto-api` de produção, o _Deploy_ com
  `DATABASE_REQUIRE_RUNTIME_ROLE=true` tem 7 dias ou mais; desde ele,
  nenhum `permission denied` (42501) no log, e o boot de cada réplica
  escreveu `database role checked` com `superuser: false` e
  `tablesOwner: false`. Toda Application de runtime que já existir (as das
  ondas seguintes) entra na mesma conta. A `trajetto-api-migrate` continua
  com o usuário do Database: ela não atende requisição.

- **Nenhum login, além do usuário do Database, com o poder de ler o
  servidor, e nenhuma conexão do runtime como ele.** No `psql` do Database
  de produção:

  ```sh
  docker exec -it $(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-production) psql -U trajetto -d trajetto
  ```

  ```sql
  SELECT rolname FROM pg_roles
   WHERE rolcanlogin AND rolname <> current_user
     AND (rolsuper
          OR pg_has_role(oid, 'pg_execute_server_program', 'MEMBER')
          OR pg_has_role(oid, 'pg_read_server_files', 'MEMBER')
          OR pg_has_role(oid, 'pg_write_server_files', 'MEMBER'));
  SELECT usename, application_name, count(*) FROM pg_stat_activity
   WHERE backend_type = 'client backend' GROUP BY 1, 2 ORDER BY 1, 2;
  ```

  A primeira volta vazia (a membresia indireta conta). Na segunda, o
  usuário do Database (`trajetto`) aparece só no próprio `psql` (e no
  `pg_dump` do backup do Dokploy, se for a hora dele); o runtime conecta
  como `trajetto_http` e `trajetto_batch`. Qualquer outra linha: pare
  aqui, sem as chaves, e tire o poder ou o login
  (`ALTER ROLE <role> NOLOGIN;`) antes de voltar a este passo. A etapa de
  release nunca dá esses poderes: o `infra-sql-rules.test.ts` recusa um
  `infra/sql` que os conceda.

- **Nenhum código no schema de quem não é o dono.** O `trajetto_batch` é
  membro do `trajetto_partitions`, que tem CREATE no schema para as
  partições; uma função ou um operador criado ali com as credenciais do
  batch rodaria como superusuário na release seguinte (CVE-2018-1058). No
  mesmo `psql`:

  ```sql
  SELECT evtenabled FROM pg_event_trigger
   WHERE evtname = 'trajetto_untrusted_code';
  SELECT 'função' AS tipo, p.oid::regprocedure::text AS nome,
         pg_get_userbyid(p.proowner) AS dono
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
   WHERE p.pronamespace = 'public'::regnamespace AND NOT r.rolsuper
  UNION ALL
  SELECT 'operador', o.oid::regoperator::text, pg_get_userbyid(o.oprowner)
    FROM pg_operator o JOIN pg_roles r ON r.oid = o.oprowner
   WHERE o.oprnamespace = 'public'::regnamespace AND NOT r.rolsuper;
  ```

  A primeira devolve `O` (ligado); a segunda volta vazia. Sem a linha do
  event trigger, rode a etapa de release (`infra/sql/15-untrusted-code.sql`);
  com uma função ou um operador na segunda, pare aqui, sem as chaves:
  descubra quem criou, apague e troque a senha do login dele antes de
  voltar.

- **A trava no bucket.** R2 → `trajetto-pitr-prod` →
  _Settings → Bucket Lock_: a regra de `archive/trajetto/1`, 14 dias, já
  salva, antes do `stanza-create` (`infra/r2/bucket-locks.md`, "Na
  produção"). A prova do **Delete** recusado é a da staging: na produção,
  sem a regra, ela apagaria um WAL de verdade.

- **O F1a verde.** A consulta do aceite (abaixo) na staging, com os 7 dias
  contados do full dela, e o ensaio da staging anotado.

1. Database de produção → _Environment_: acrescente as variáveis da coluna
   "Produção, F1b", **sem** `PITR_ARCHIVE` → **Save** → `CHECKPOINT` →
   **Deploy**.
2. A stanza e a cópia para o cofre, como no passo 6 do F1a, com
   `trajetto-postgres-production`.
3. `PITR_ARCHIVE=on` → **Save** → `CHECKPOINT` → **Deploy**.
4. O passo 8 do F1a (`check`, `trajetto-backup full`, `info`, um
   `archive-get` e o `pg_stat_reset_shared('archiver')`).
5. Os Schedule Jobs da produção (abaixo).
6. O ensaio à mão, na janela e com teto (passo 9 do F1a).
7. `trajetto-api` de produção → `PITR_EXPECTED=true` → **Deploy**.

### Os Schedule Jobs do servidor

Dokploy → _Schedules_ do servidor (tipo _Server_), um por linha, cada um
com o seu check no healthchecks.io (a URL do check vai no _Environment_ do
Database, nas variáveis da tabela acima). O script vem dentro da imagem do
banco, na mesma versão do pgBackRest. Só a staging por enquanto; a produção
ganha os seus no passo 5 do F1b, com `trajetto-postgres-production`.

| Job                   | Agenda (UTC)  | Comando (staging)                                                                                                                                                          | Check                                        |
| --------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| backup diferencial    | `0 5 * * 0-5` | `docker exec -u postgres $(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging) trajetto-backup diff`                                            | `PITR_BACKUP_DIFF_PING_URL`, período de 26 h |
| backup completo       | `0 5 * * 6`   | `docker exec -u postgres $(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging) trajetto-backup full`                                            | `PITR_BACKUP_FULL_PING_URL`, 7 dias e 2 h    |
| ensaio de restauração | `45 5 1 * *`  | `c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging); docker exec "$c" cat /usr/local/bin/trajetto-restore-drill \| bash -s -- --from "$c"` | `PITR_DRILL_PING_URL`, 32 dias               |

Os horários seguem o mapa do plano (decisão D28): o dump do Dokploy às
03:00, os expurgos até 04:50, o pgBackRest às 05:00 com o full no sábado e
o ensaio no dia 1 às 05:45. Estas agendas não são diárias e por isso ficam
fora da [seção 18](#18-backup-e-restauração): o teste `legal-facts` da web
lê toda agenda das seções que falam do Keep do dump como a agenda dele. Um
`/fail` do backup traz o motivo (`archive-gap` pede um full:
[runbooks/wal-archive-stalled.md](./runbooks/wal-archive-stalled.md)); um
`/fail` do ensaio, o motivo do
[runbook do ensaio](./runbooks/restore-drill.md).

### Aceite: 7 dias no `ops_sample`

Contados do fim do primeiro full (o passo 8 do F1a; o passo 4 do F1b), na
linha `cluster` de cada minuto: `failed_count` = 0 e o último segmento
arquivado há menos de 120 s em pelo menos 99% das linhas. O `ts` é UTC,
sem fuso:

```sql
WITH janela AS (
  SELECT ts,
         metrics->'database'->>'archive_mode' AS archive_mode,
         (metrics->'database'->'archiver'->>'failed_count')::bigint AS falhas,
         (metrics->'database'->'archiver'->>'last_archived_age_seconds')::float8 AS lag_s
  FROM ops_sample
  WHERE role = 'cluster'
    AND ts >= '<fim do full, UTC>'::timestamp
    AND ts < '<fim do full, UTC>'::timestamp + interval '7 days'
)
SELECT count(*) AS linhas,                                         -- perto de 10080
       count(*) FILTER (WHERE archive_mode = 'on') AS com_arquivo,  -- todas
       max(falhas) AS falhas,                                       -- 0
       round(100.0 * count(*) FILTER (WHERE lag_s < 120) / nullif(count(*), 0), 2) AS pct_lag_ok -- >= 99
FROM janela;
```

Uma linha sem leitura do archiver (`null`) conta contra. Depois do aceite,
o ensaio anota o RTO e a perda, e esse é o portão da onda: o
`rto_seconds` abaixo de 3600 (1 h) e o `loss_seconds` de até 120 (2 min),
os alvos do [`slo.md`](./slo.md). Anote os dois em
[Ensaiar a restauração](#ensaiar-a-restauração).

### Reversão

- **Do arquivamento**, na ordem inversa: `PITR_EXPECTED` fora da
  `trajetto-api` (**Deploy**), depois `PITR_ARCHIVE` fora do Database →
  `CHECKPOINT` → **Deploy**. O wrapper grava `archive_mode=off` explícito.
- **Da imagem**: o digest anotado no passo 1, com `CHECKPOINT` antes. Os
  parâmetros entram como `-c` (nada no `postgresql.auto.conf`), então
  voltar o digest volta a configuração junto. Se algo foi por
  `ALTER SYSTEM` numa emergência, desfaça antes, ou a imagem antiga, sem o
  pgBackRest, falharia em todo arquivamento e encheria o `pg_wal`:

  ```sql
  ALTER SYSTEM RESET archive_command;
  ALTER SYSTEM SET archive_mode = off;
  ```

- As `PGBACKREST_*` podem ficar no _Environment_ depois da volta: a imagem
  antiga não as lê.

### Grace e placement do Database

- **Grace**: o Dokploy v0.30.10 cria o serviço do Database com um _Stop
  Grace Period_ de 30 s (não os 10 s do Docker puro), com o update
  stop-first. Onde o painel tiver o campo, o F0-01 põe `120000000000` (120
  s). Confira; o valor sai em nanossegundos (`null` = 10 s):

  ```sh
  docker service inspect trajetto-postgres-production --format '{{json .Spec.TaskTemplate.ContainerSpec.StopGracePeriod}}'
  ```

  O `CHECKPOINT` antes de cada parada continua: ele encurta o desligamento,
  qualquer que seja o grace.

- **Placement**: o Dokploy v0.30.10 põe `node.role==manager` em todo
  serviço com volume, e o Database tem o dele. Com um nó só, nada muda.
  Com mais de um manager, o Swarm poderia subir o banco noutro manager, sem
  o volume local. Por isso, desde a onda 17 (F4-52), o Placement do
  Database é
  `{ "Constraints": ["node.labels.trajetto.db==true", "node.hostname==<nó do volume>"] }`,
  aplicado no _Deploy_ da janela do Postgres, depois dos labels do nó e
  antes de qualquer nó novo
  ([runbooks/swarm-multi-no.md](./runbooks/swarm-multi-no.md)). Confira:

  ```sh
  docker service inspect trajetto-postgres-production --format '{{json .Spec.TaskTemplate.Placement}}'
  ```
