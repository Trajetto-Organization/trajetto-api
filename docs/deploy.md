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
> variável, para que serve e onde mora) e [`testes.md`](./testes.md) (o que a
> validação do pipeline roda). A web tem o próprio guia em
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
19. [Réplicas, workers e tempo real](#19-réplicas-workers-e-tempo-real)
20. [Alertas e monitoramento](#20-alertas-e-monitoramento)
21. [Cadeia de suprimentos e segredos](#21-cadeia-de-suprimentos-e-segredos)
22. [Bucket R2 e retenção no GHCR](#22-bucket-r2-e-retenção-no-ghcr)
23. [Recursos da VPS e logs](#23-recursos-da-vps-e-logs)
24. [Migrar do Portainer para o Dokploy](#24-migrar-do-portainer-para-o-dokploy)
25. [Checklist do primeiro deploy](#25-checklist-do-primeiro-deploy)
26. [Os três repositórios juntos](#26-os-três-repositórios-juntos)

---

## 1. Visão geral

```
branch de trabalho ──push──▶ ci.yml (lint, typecheck, unitários + cobertura, audit, gitleaks, IA)
        │
        └─ merge/push ─▶ staging ──▶ deploy.yml
                                     ├─ validação completa (+ E2E com Postgres e Redis)
                                     ├─ build ÚNICO das 3 imagens ─▶ GHCR  sha-<7>  (imutável)
                                     └─ tag `staging` movida por digest
                                        ─▶ Dokploy staging: trajetto-ai → trajetto-api → trajetto-backup
                                        ─▶ convergência da API

PR staging → main ──▶ deploy.yml: a mesma validação + "o head do PR tem imagem de staging?"

merge em main ──▶ deploy.yml: PROMOÇÃO (sem build)       [aprovação do environment production]
                  ├─ resolve o build do commit mergeado (2º pai do merge commit)
                  ├─ migrations (job único, opcional) ─▶ tag `stable` movida por digest
                  ├─ Dokploy produção: trajetto-ai → trajetto-api → trajetto-backup ─▶ convergência
                  └─ release (tag semver, CHANGELOG, GitHub Release)

Run workflow (manual) ──▶ a mesma promoção com uma tag antiga: o botão de ROLLBACK
```

Princípios que não mudam:

- **Uma imagem por serviço para os dois ambientes, construída uma vez e
  promovida por digest** (decisão 12.2). A API lê toda a configuração em
  tempo de execução: staging e produção diferem só no _Environment_ de cada
  Application no Dokploy. O que o staging validou é, byte a byte, o que a
  produção roda.
- **Três imagens**, todas construídas no mesmo job e promovidas juntas:

  | Imagem                                          | De onde                                     | Para quê                                | Application no Dokploy |
  | ----------------------------------------------- | ------------------------------------------- | --------------------------------------- | ---------------------- |
  | `ghcr.io/trajetto-organization/trajetto-api`    | `Dockerfile`                                | a API (HTTP, Socket.IO, workers, crons) | `trajetto-api`         |
  | `ghcr.io/trajetto-organization/trajetto-ai`     | `infra/ai-ocr/Dockerfile` (stage `runtime`) | o OCR local das leituras de IA          | `trajetto-ai`          |
  | `ghcr.io/trajetto-organization/trajetto-backup` | `infra/backup/Dockerfile`                   | o backup noturno cifrado para o R2      | `trajetto-backup`      |

- **Tags**:

  | Tag                           | Quem cria/move                               | Muda?                                   |
  | ----------------------------- | -------------------------------------------- | --------------------------------------- |
  | `sha-<7 primeiros do commit>` | o build de cada push em `staging`            | **nunca** (imutável)                    |
  | `staging`                     | o job `deploy-staging`, por digest           | a cada push em `staging`                |
  | `stable`                      | o job `promote-production`, por digest       | a cada promoção ou rollback             |
  | `main-<sha>`                  | builds antigos, de antes da branch `staging` | nunca; aceitos só como alvo de rollback |

  Não existem `latest`, `main` nem `pr-*`. As Applications de produção rodam
  `stable`; as de staging, `staging`. O pipeline **nunca** muda a imagem
  configurada numa Application: ele move a tag no GHCR e pede ao Dokploy um
  novo deploy, que puxa a tag de novo.

- **O Dokploy dizer `done` não é convergência.** `done` quer dizer que o
  Dokploy puxou a imagem e o Swarm **aceitou** a nova especificação do
  serviço. A troca das réplicas acontece depois, e uma imagem que falha no
  healthcheck é revertida pelo próprio Swarm. Por isso o deploy da API tem um
  passo seguinte que espera o estado real
  ([seção 14](#14-conferir-a-convergência)).
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

1. Trabalhe numa branch e faça push: o `ci.yml` roda.
2. Leve para `staging` (PR para `staging` ou merge/push). O `deploy.yml` roda
   a validação completa, constrói as imagens e faz o deploy do staging.
3. Confira o staging ([seção 16](#16-promover-para-produção), "O que conferir
   no staging").
4. Abra o PR `staging → main`. O PR roda a mesma validação e confirma que o
   commit do head já tem imagem `sha-<7>` (espera até 30 min, porque o PR
   costuma abrir enquanto o staging ainda constrói o mesmo commit).
5. **Merge com "Create a merge commit".** Nunca _Squash and merge_ nem
   _Rebase and merge_: os dois criam um commit que o staging nunca construiu,
   e a promoção falha de propósito ("não passou pelo pipeline de staging"). O
   merge commit também preserva os SHAs que a baseline do gitleaks usa. Para
   não errar, deixe só essa opção ligada ([seção 13](#13-configurar-o-github),
   "Proteção das branches").
6. O push em `main` dispara a promoção; com revisores obrigatórios no
   environment `production`, o job espera a aprovação.

**Hotfix**: a mesma estrada, mais curta — branch `fix/...` → `staging`
(espera o verde) → PR `staging → main`. Não existe caminho que pule o
staging, porque a produção só roda imagens construídas lá.

**Depois de cada release**: o `semantic-release` faz um commit
`chore(release): x.y.z [skip ci]` com o `CHANGELOG.md` em `main`. Traga `main`
de volta para `staging` de vez em quando (`git merge origin/main` em
`staging`) para as duas não divergirem; esse merge vira um build de staging
como qualquer outro.

O Dependabot abre os PRs dele contra `staging` (`target-branch: staging` em
`.github/dependabot.yml`), pelo mesmo motivo.

## 3. Os workflows em detalhe

### `.github/workflows/ci.yml` — portão das branches de trabalho

Roda em todo push de branch que **não** seja `main`, `master` nem `staging`
(e por _Run workflow_). Um push novo na mesma branch cancela o run anterior.

| Job            | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`     | serviço `redis:7-alpine` (um teste unitário do adapter do Socket.IO precisa dele); checkout com histórico completo; os repositórios irmãos (`Trajetto-Organization/trajetto-ui` e `Trajetto-Organization/trajetto-mobile`, na mesma branch quando ela existe lá) para o contrato de rotas, se o secret `CLIENT_REPOS_READ_TOKEN` existir; `audit-ci` (CRITICAL de produção); Prettier; `prisma generate`; `tsc`; unitários com piso de cobertura; publica `coverage-<sha>` |
| `secrets`      | gitleaks em todo o histórico, imagem fixada por digest                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ai-ocr`       | `docker build --target test infra/ai-ocr` (o pytest roda dentro da imagem)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ai-local-e2e` | só em _Run workflow_: o contrato da API contra o contêiner real de IA (`tests/ai-local`)                                                                                                                                                                                                                                                                                                                                                                                   |

Sem E2E, sem imagem, sem deploy: a pergunta é só "esse código pode ir para o
staging?".

### `.github/workflows/deploy.yml` — Pipeline (staging → produção)

| Gatilho                      | Jobs que rodam                                                    |
| ---------------------------- | ----------------------------------------------------------------- |
| push em `staging`            | `test`, `ai-ocr`, `secrets` → `build-and-push` → `deploy-staging` |
| pull request para `main`     | `test`, `ai-ocr`, `secrets`, `staging-image`                      |
| push em `main` (o merge)     | `promote-production` → `release`                                  |
| _Run workflow_ (`image_tag`) | `promote-production`                                              |

| Job                  | Detalhes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test`               | serviços `postgres:16-alpine` e `redis:7-alpine`; checkout completo (o teste de rotas aposentadas compara com `origin/main`); `yarn install --frozen-lockfile` com cache; `audit-ci`; `lint:check`; `prisma:generate`; `typecheck`; `test:coverage` (o piso de cobertura); publica `coverage-<sha>`; `test:e2e` (um banco por arquivo).                                                                                                                                                                                                                                                                                        |
| `ai-ocr`             | o pytest do serviço de IA dentro da imagem (`--target test`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `secrets`            | o mesmo gitleaks do `ci.yml` (mesma imagem, flags, `.gitleaksignore`). Nenhuma imagem é construída antes dele passar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `build-and-push`     | só em push para `staging`, depois dos três acima. Buildx com cache do GitHub (um escopo por imagem); publica `sha-<7>` das três imagens com SBOM e proveniência (`provenance: mode=max`); varre as três por digest com Trivy (CRITICAL corrigível; só relata até `IMAGE_SCAN_ENFORCE=true`). Exporta os três digests.                                                                                                                                                                                                                                                                                                          |
| `deploy-staging`     | environment `staging`; um por vez (`concurrency: deploy-staging`, nunca cancelado no meio). Confere se o run ainda é o head de `staging` (runs terminam fora de ordem; o mais velho não volta a tag); move `staging` das três imagens para os digests deste run; se os três secrets obrigatórios do Dokploy existirem, pede o deploy das Applications **na ordem `trajetto-ai` → `trajetto-api` → `trajetto-backup`** (`.github/scripts/dokploy-deploy.mjs`, uma chamada por Application) e espera a convergência da API.                                                                                                      |
| `staging-image`      | só no PR: espera (até 30 min) as três imagens `sha-<head do PR>` existirem. Sem elas o merge não teria o que promover.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `promote-production` | environment `production` (revisores obrigatórios = aprovação); um por vez (`concurrency: promote-production`). Resolve o build (2º pai do merge commit; fast-forward = o próprio commit; _Run workflow_ = a tag digitada), valida o formato (`sha-<hex>` ou `main-<hex>`), confere que a imagem existe no GHCR, compara com o que o staging roda (só informa), roda as migrations como job se `MIGRATIONS_VIA_JOB=true`, move `stable` das três imagens por digest (IA e backup só se o build tiver essas imagens), pede o deploy das Applications de produção na mesma ordem (se configurado) e espera a convergência da API. |
| `release`            | depois da promoção, só no push em `main`: `semantic-release` cria a tag, o `CHANGELOG.md` (commit com `[skip ci]`) e o GitHub Release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Permissões: o workflow inteiro tem `contents: read`; só `build-and-push`,
`deploy-staging` e `promote-production` pedem `packages: write`;
`staging-image` pede `packages: read`; `release` pede `contents`, `issues` e
`pull-requests: write`. Todas as actions são fixadas por SHA de commit, com a
versão em comentário (o teste `supply-chain.test.ts` recusa uma tag solta).

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
   o que este run criou: `done` = ok; `error` ou `cancelled` = o run falha com
   a indicação de abrir _Deployments_ da Application no painel.

| Variável do script                                                | De onde vem no workflow                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOKPLOY_URL`                                                     | secret `DOKPLOY_URL` do environment (precisa ser `https://`; a chave vai no cabeçalho)                                                                |
| `DOKPLOY_API_KEY`                                                 | secret `DOKPLOY_API_KEY` do environment (nunca é impressa)                                                                                            |
| `DOKPLOY_APPLICATION_ID`                                          | `DOKPLOY_AI_APPLICATION_ID`, `DOKPLOY_API_APPLICATION_ID` ou `DOKPLOY_BACKUP_APPLICATION_ID`, conforme o passo                                        |
| `DOKPLOY_APP_LABEL`                                               | `trajetto-ai`, `trajetto-api` ou `trajetto-backup` (só para as mensagens)                                                                             |
| `DOKPLOY_OPTIONAL`                                                | `true` nos passos da IA e do backup: sem o id, o passo termina verde com aviso ("a Application ainda não existe"); no passo da API o id é obrigatório |
| `DOKPLOY_WAIT`, `DOKPLOY_TIMEOUT_SECONDS`, `DOKPLOY_POLL_SECONDS` | não definidas: valem `true`, 900 e 10                                                                                                                 |

A ordem importa: a IA vai primeiro porque a API a chama; o backup por último.
Os passos são sequenciais, então **um deploy da IA que falha para o job antes
de tocar na API** (a API antiga continua no ar). O que o script pega e um
webhook não pegaria: imagem que o Dokploy não consegue puxar (credencial do
GHCR errada, tag inexistente), chave ou id errados. Por isso a API usa a
chave de API e o id de cada Application, e não o webhook de redeploy (que
responde assim que enfileira e nunca diz se deu certo). A web, que é uma
Application só, usa o webhook dela (`trajetto-ui/docs/deploy.md`).

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
   │  trajetto-backup ────────────┼─▶ trajetto-postgres ─▶ (saída) R2 de backup              │
   └──────────────────────────────┴────────────────────────────┴──────────────────────────────┘
```

Cada environment do Dokploy (`staging` e `production`) tem o mesmo desenho,
com nomes internos (o _App Name_ de cada serviço) diferentes. Dentro da rede
`dokploy-network`, um serviço encontra o outro pelo **App Name**: a API fala
com `trajetto-postgres-production:5432`, `trajetto-redis-production:6379` e
`http://trajetto-ai-production:8080`. Só a API (e a web) têm domínio; nenhum
serviço publica porta no host.

| Serviço (App Name em produção) | Tipo no Dokploy       | Imagem                                   | Porta interna  | Réplicas                              | Health                                    | Limites                        |
| ------------------------------ | --------------------- | ---------------------------------------- | -------------- | ------------------------------------- | ----------------------------------------- | ------------------------------ |
| `trajetto-api-production`      | Application (Docker)  | `trajetto-api:stable`                    | 3333 (domínio) | 2, rolling `start-first` com rollback | liveness no Swarm (`/health/liveness`)    | memória 1 GiB, heap 768 MB     |
| `trajetto-ai-production`       | Application (Docker)  | `trajetto-ai:stable`                     | 8080           | 1                                     | `GET /health` (200 depois do aquecimento) | memória 1 GiB, 2 CPUs          |
| `trajetto-backup-production`   | Application (Docker)  | `trajetto-backup:stable`                 | —              | 1                                     | —                                         | memória 256 MiB                |
| `trajetto-postgres-production` | Database → PostgreSQL | `postgres:16-alpine` (fixado por digest) | 5432           | 1                                     | do Dokploy                                | sem teto, de propósito         |
| `trajetto-redis-production`    | Database → Redis      | `redis:7-alpine`                         | 6379           | 1                                     | do Dokploy                                | memória 512 MiB (dados 256 MB) |

Em staging, troque `-production` por `-staging` e `:stable` por `:staging`.

## 5. Applications em vez de Compose: o que mudou e o que ficou de fora

Até 21/10/2026 a API subia como **um app Compose do tipo Docker Stack** com o
arquivo `compose.production.yaml` (apagado). Desde 22/10/2026 a decisão do
dono é: **cada serviço é um recurso próprio do Dokploy** — três Applications
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

  | Valor                           | Onde precisa estar, igual                                                                                    |
  | ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | token da IA                     | `AI_TOKEN` na Application `trajetto-ai` **e** `AI_LOCAL_TOKEN` na Application `trajetto-api`                 |
  | usuário/senha/banco do Postgres | o Database PostgreSQL, a `DATABASE_URL` e a `MIGRATION_DATABASE_URL` da API, e as `PG*` do `trajetto-backup` |
  | senha do Redis                  | o Database Redis (e o comando dele, se personalizado) **e** o `REDIS_URL` da API                             |
  | App Name da IA                  | `AI_LOCAL_URL` da API                                                                                        |
  | App Name da API                 | variável `SWARM_API_SERVICE` do environment do GitHub e o comando restrito das migrations                    |

- **Variáveis que o compose montava ou fixava agora são explícitas** na API:
  `AI_LOCAL_URL`, `NODE_OPTIONS`, `RATE_LIMIT_TRUSTED_PROXY`, `APP_ENV`. E
  toda variável que a API lê pode ser definida direto na Application (antes,
  uma variável que o compose não repassava não chegava ao contêiner).

### O que cada proteção do compose virou

| O compose fazia                                                                                      | Agora                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| variáveis obrigatórias (`${VAR:?mensagem}`) derrubavam o deploy                                      | **API**: o schema de ambiente derruba o boot sem `DATABASE_URL`, `REDIS_URL`, `JWT_*`, `MASTER_USER_*`, `HTTP_REQUEST` e, em produção, sem `RATE_LIMIT_TRUSTED_PROXY` e as `R2_*`. **IA**: o serviço recusa subir com `AI_TOKEN` ausente ou curto. **Backup**: o script falha na hora do dump (e avisa o `/fail` do heartbeat) — por isso o primeiro deploy usa `BACKUP_RUN_NOW=true`. **`APP_ENV`: nada obriga.** Vazia, a API segue o `NODE_ENV=production` da imagem e se comporta como produção; confira no staging                     |
| `AI_LOCAL_URL=http://trajetto-ai:8080` fixo                                                          | `AI_LOCAL_URL=http://<App Name da IA>:8080` no Environment da API. **Faltando, a IA fica desligada em silêncio** (a API trata como `none`); confira em _Sistema → Provedores_                                                                                                                                                                                                                                                                                                                                                               |
| `NODE_OPTIONS` montada de `API_HEAP_MB`; `RATE_LIMIT_TRUSTED_PROXY` com padrão `cloudflare`          | as duas digitadas no Environment da API (`NODE_OPTIONS=--max-old-space-size=768`, `RATE_LIMIT_TRUSTED_PROXY=cloudflare`)                                                                                                                                                                                                                                                                                                                                                                                                                    |
| labels do Traefik (`Host()`, `websecure`, certificado, porta 3333, `passHostHeader`)                 | aba _Domains_ da Application: o Dokploy gera o arquivo `/etc/dokploy/traefik/dynamic/<App Name>.yml` com tudo isso (e o redirecionamento HTTP→HTTPS). `ROUTER_PREFIX` não existe mais: os roteadores levam o App Name, único por servidor                                                                                                                                                                                                                                                                                                   |
| health check do balanceador do Traefik em `/health/readiness` (tirava uma réplica sem banco do ar)   | **lacuna**. O Traefik do Dokploy fala com o endereço virtual do serviço do Swarm (um só destino para as duas réplicas), então um health check ali tiraria o serviço inteiro do ar quando uma réplica falhasse. Não configure. O Swarm só põe uma réplica nova no balanceamento depois de ela passar no healthcheck (liveness), e tira a réplica que está desligando                                                                                                                                                                         |
| `priority=1` no roteador                                                                             | desnecessário: cada ambiente tem o próprio host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| bloco `deploy:` (réplicas, `update_config`, `rollback_config`, `restart_policy`, `resources`)        | _Advanced_ da Application: _Replicas_, _Swarm Settings_ (JSON pronto na [seção 7](#7-montar-o-dokploy-do-zero-staging-e-produção)) e _Resources_                                                                                                                                                                                                                                                                                                                                                                                            |
| `stop_grace_period` (40 s na API, 60 s no Postgres)                                                  | API: campo _Stop Grace Period_ do _Swarm Settings_, se a sua versão do Dokploy tiver. Sem ele, o Swarm mata o processo 10 s depois do SIGTERM e o desligamento ordenado (até 35 s) é cortado: **lacuna**, com o contorno `docker service update --stop-grace-period 40s <App Name da API>` no host, que vale até o próximo deploy (o Dokploy reaplica a spec dele). Postgres: os Databases não têm o campo — rode `CHECKPOINT` antes de qualquer parada planejada ([seção 10](#10-postgres-e-redis))                                        |
| `logging: json-file` com rotação por serviço                                                         | rotação **global** no `/etc/docker/daemon.json` do host ([seção 6](#6-preparar-o-servidor-uma-vez)), que vale para todo contêiner                                                                                                                                                                                                                                                                                                                                                                                                           |
| `docker stack deploy` resolvia a tag para o digest e o fixava na spec                                | o Dokploy faz `pull` da tag e força a atualização do serviço, mas a spec guarda **a tag**, não o digest. Consequências: (1) o rollback automático do Swarm protege só o momento do deploy (as réplicas antigas continuam de pé), mas uma réplica antiga que reinicie depois sobe a imagem nova, que já está no host; (2) `docker service rollback` não volta a imagem ([seção 17](#17-rollback)); (3) a conferência da convergência passou a ler o digest do contêiner de cada task, e não a spec ([seção 14](#14-conferir-a-convergência)) |
| rede interna `backend` (`internal: true`): Postgres, Redis e IA inalcançáveis por outros contêineres | **lacuna**. Tudo fica na `dokploy-network`, junto com a web, o staging e o que mais rodar no Dokploy. A proteção passa a ser: nenhuma porta externa, senha forte no Postgres e no Redis, token na IA, segredos diferentes entre staging e produção                                                                                                                                                                                                                                                                                          |
| volume do Postgres com nome fixo (`POSTGRES_VOLUME`)                                                 | o Dokploy cria e nomeia o volume do Database (aparece em _Advanced → Volumes_). A guarda da API contra banco vazio em produção continua valendo                                                                                                                                                                                                                                                                                                                                                                                             |
| Postgres preso no manager (`node.role == manager`)                                                   | desnecessário com um nó só. Com mais nós no Swarm, **lacuna**: os Databases não têm campo de placement                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| imagem do Postgres fixada (`POSTGRES_IMAGE`)                                                         | campo _Docker Image_ do Database com o digest (`postgres:16-alpine@sha256:…`)                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| tuning do Postgres e `/dev/shm` em tmpfs (comentados no compose)                                     | tuning: comando personalizado do Database, se a versão tiver ([seção 10](#10-postgres-e-redis)). `/dev/shm`: **lacuna** (use `max_parallel_maintenance_workers=0` se um VACUUM/CREATE INDEX paralelo falhar)                                                                                                                                                                                                                                                                                                                                |
| Redis sem persistência, `--maxmemory 256mb --maxmemory-policy allkeys-lru`, senha obrigatória        | senha: o Database Redis sempre tem. O resto: comando personalizado do Database ([seção 10](#10-postgres-e-redis)); se a sua versão não tiver o campo, **lacuna** (Redis com snapshot em disco e sem teto de memória)                                                                                                                                                                                                                                                                                                                        |
| IA com `read_only`, `/tmp` em tmpfs e `cap_drop: ALL`                                                | **lacuna**: a Application não tem esses campos. Continua valendo o usuário 10001 (não root) da imagem, sem domínio e sem porta publicada                                                                                                                                                                                                                                                                                                                                                                                                    |
| `REDIS_ENFORCE_AUTH` (transição de um Redis sem senha)                                               | não existe mais: o Redis do Dokploy nasce com senha                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| job de migrations na rede `<stack>_backend`, lendo o env de `<stack>_api`                            | o mesmo script, com `API_SERVICE=<App Name da API>` (obrigatória) no comando restrito e a rede `dokploy-network` por padrão ([seção 15](#15-migrations))                                                                                                                                                                                                                                                                                                                                                                                    |

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
5. **DNS na Cloudflare** (proxy laranja): o host da API de produção
   (`trajettoapi.thorsolucoes.com.br`) e o de staging
   (`trajettoapi-staging.thorsolucoes.com.br`) apontando para o IP da VPS;
   _SSL/TLS_ em **Full (strict)**, _Minimum TLS Version_ 1.2, _Always Use
   HTTPS_ ligado. Detalhes da borda na [seção 11](#11-domínios-tls-e-a-borda).
6. **Credencial do GHCR** ([seção 7.3](#73-credencial-do-ghcr)): um token do
   GitHub que o Dokploy usa para puxar as imagens privadas.
7. **Usuário de deploy** no host, no grupo `docker`, para o job de migrations e
   a conferência do rollout ([seções 14](#14-conferir-a-convergência) e
   [15](#15-migrations)). O SSH do host precisa aceitar conexões dos runners
   do GitHub. Logado como esse usuário, rode `docker login ghcr.io` (usuário
   do GitHub e, como senha, o mesmo token da credencial): o job de migrations
   puxa a imagem.

## 7. Montar o Dokploy do zero (staging e produção)

Staging e produção são **os mesmos passos**, feitos duas vezes: uma no
environment `staging` e outra no `production`, cada uma no projeto
`trajetto-api`. Faça staging primeiro, inteiro, e só depois produção.

### 7.1 O que muda entre staging e produção

| Item                                                                                                   | Staging                                                                                     | Produção                                                                        |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| environment do Dokploy                                                                                 | `staging`                                                                                   | `production`                                                                    |
| sufixo dos App Names                                                                                   | `-staging`                                                                                  | `-production`                                                                   |
| tag das imagens (`trajetto-api`, `trajetto-ai`, `trajetto-backup`)                                     | `:staging`                                                                                  | `:stable` (crie antes: [seção 8](#8-primeiro-deploy-na-ordem-com-conferências)) |
| domínio da API                                                                                         | `trajettoapi-staging.thorsolucoes.com.br`                                                   | `trajettoapi.thorsolucoes.com.br`                                               |
| `APP_ENV`                                                                                              | `staging`                                                                                   | `production`                                                                    |
| `HTTP_REQUEST` / `API_HTTP_REQUEST`                                                                    | `https://staging.intrajetto.com` / `https://trajettoapi-staging.thorsolucoes.com.br`        | `https://www.intrajetto.com` / `https://trajettoapi.thorsolucoes.com.br`        |
| `AI_LOCAL_URL`                                                                                         | `http://trajetto-ai-staging:8080`                                                           | `http://trajetto-ai-production:8080`                                            |
| segredos (senhas do Postgres e do Redis, `JWT_*`, token da IA, `WEBHOOK_SECRETS_KEY`, `DOCS_PASSWORD`) | **próprios**                                                                                | **outros**; nunca compartilhe entre ambientes                                   |
| `R2_*`                                                                                                 | bucket de staging (CORS para a web de staging)                                              | bucket de produção                                                              |
| `BACKUP_*`                                                                                             | bucket de backup de staging (staging prova o caminho do backup)                             | bucket de backup de produção                                                    |
| `META_WHATSAPP_*`, `RESEND_*`                                                                          | **de teste** (número de teste da Meta; domínio de teste)                                    | reais                                                                           |
| `RUN_MIGRATIONS_ON_BOOT`                                                                               | `true` (staging migra no boot)                                                              | `true` até ligar o job; depois `false` ([seção 15](#15-migrations))             |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                                                       | `true` **só** no primeiro boot                                                              | `false` (`true` só numa instalação nova sem dados a restaurar, uma vez)         |
| IA                                                                                                     | opcional: sem a Application `trajetto-ai`, use `AI_PROVIDER=none` na API (economiza ~1 GiB) | `trajetto-ai` com `AI_PROVIDER=local`                                           |
| `PROOF_SIGNING_*`                                                                                      | vazio (comprovantes saem sem assinatura e dizem isso)                                       | o certificado A1 (e-CNPJ)                                                       |
| réplicas da API                                                                                        | 2 (ou 1 para economizar RAM)                                                                | 2                                                                               |
| environment do GitHub                                                                                  | `staging` (sem revisores)                                                                   | `production` (revisores obrigatórios)                                           |
| `SWARM_API_SERVICE` (GitHub)                                                                           | `trajetto-api-staging`                                                                      | `trajetto-api-production`                                                       |

### 7.2 Nomes: Name e App Name

Toda vez que o Dokploy pede para criar um serviço, o diálogo tem dois nomes:
**Name** (o rótulo no painel) e **App Name** (o nome do serviço no Swarm e o
**nome de rede** pelo qual os outros serviços o encontram). O App Name precisa
ser único no servidor inteiro, então o Dokploy sugere o Name com um sufixo
aleatório. **Troque a sugestão pelos nomes abaixo** — o resto deste documento
os usa. Se a sua versão não deixar editar o App Name, anote o que o Dokploy
gerou e use-o onde este documento disser `<App Name …>`.

| Serviço                     | Onde criar                               | Name                | App Name (staging)          | App Name (produção)            |
| --------------------------- | ---------------------------------------- | ------------------- | --------------------------- | ------------------------------ |
| banco                       | _Create Service → Database → PostgreSQL_ | `trajetto-postgres` | `trajetto-postgres-staging` | `trajetto-postgres-production` |
| Redis                       | _Create Service → Database → Redis_      | `trajetto-redis`    | `trajetto-redis-staging`    | `trajetto-redis-production`    |
| IA                          | _Create Service → Application_           | `trajetto-ai`       | `trajetto-ai-staging`       | `trajetto-ai-production`       |
| API                         | _Create Service → Application_           | `trajetto-api`      | `trajetto-api-staging`      | `trajetto-api-production`      |
| backup                      | _Create Service → Application_           | `trajetto-backup`   | `trajetto-backup-staging`   | `trajetto-backup-production`   |
| web (projeto `trajetto-ui`) | `trajetto-ui/docs/deploy.md`             | `trajetto-ui`       | `trajetto-ui-staging`       | `trajetto-ui-production`       |

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
2. Ele vai em **cada** Application (seções 7.6, 7.7 e 7.9), na aba
   _General_ → _Provider_ → _Docker_: _Registry URL_ `ghcr.io`, _Username_ =
   o usuário do GitHub dono do token, _Password_ = o token.
3. O mesmo token serve para o `docker login ghcr.io` do usuário de deploy no
   host ([seção 6](#6-preparar-o-servidor-uma-vez), passo 7) e para a web.

Se os pacotes forem públicos, os três campos ficam vazios. Sinal de que falta
a credencial: o deployment da Application termina em `error` com
`unauthorized` ou `denied` no log do pull.

### 7.4 PostgreSQL (Database)

1. No projeto `trajetto-api` do environment: **Create Service → Database →
   PostgreSQL**.
2. Preencha:

   | Campo             | Valor                                                                                                        |
   | ----------------- | ------------------------------------------------------------------------------------------------------------ |
   | Name              | `trajetto-postgres`                                                                                          |
   | App Name          | `trajetto-postgres-staging` (ou `-production`)                                                               |
   | Database Name     | `trajetto`                                                                                                   |
   | Database User     | `trajetto`                                                                                                   |
   | Database Password | `openssl rand -hex 24` (hex: entra na URL da API sem precisar de escape); guarde no gerenciador de senhas    |
   | Docker Image      | `postgres:16-alpine` (a mesma versão maior do banco atual e do CI; nunca outra maior sem migração planejada) |

3. **Create**, abra o serviço e clique em **Deploy** (o Database só sobe
   depois disso).
4. Na aba _General_, confira em _Internal Credentials_: _Internal Host_ = o
   App Name, _Internal Port_ = 5432. Em _External Credentials_, **deixe
   _External Port_ vazio**: o banco não pode ter porta no host.
5. Fixe a imagem por digest (uma tag flutuante atualizada no Docker Hub
   reiniciaria e atualizaria o banco num redeploy). No host:
   ```sh
   docker image inspect postgres:16-alpine --format '{{index .RepoDigests 0}}'
   ```
   e ponha o resultado (`postgres@sha256:…`, escrito como
   `postgres:16-alpine@sha256:…`) no campo da imagem em _Advanced_; salve e
   faça **Deploy** de novo.
6. Não precisa de backup do Dokploy (aba _Backups_): o backup cifrado é o
   `trajetto-backup` (seção 7.9). Se quiser uma segunda cópia, a aba _Backups_
   manda um dump para um _S3 Destination_ — sem a cifra do age.

### 7.5 Redis (Database)

1. **Create Service → Database → Redis**.
2. Preencha: Name `trajetto-redis`; App Name `trajetto-redis-staging` (ou
   `-production`); Database Password `openssl rand -hex 32` (guarde); Docker
   Image `redis:7-alpine`.
3. **Create** e **Deploy**. _External Port_ vazio.
4. **Sem persistência e com teto de memória** (era o comando do compose): o
   Redis só guarda contadores do rate limit e o pub/sub do Socket.IO (ADR
   0002); um snapshot só traria de volta chaves que deviam ter expirado, e o
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
   `trajetto-ai-staging` (ou `-production`). **Create**.
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
   `trajetto-api-staging` (ou `-production`). **Create**.
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

   DATABASE_URL=postgresql://trajetto:<SENHA_DO_POSTGRES>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=10&pool_timeout=20&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=-c%20statement_timeout%3D30000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000
   MIGRATION_DATABASE_URL=postgresql://trajetto:<SENHA_DO_POSTGRES>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=2&connect_timeout=10
   RUN_MIGRATIONS_ON_BOOT=true
   ALLOW_EMPTY_DATABASE_BOOTSTRAP=false

   REDIS_URL=redis://:<SENHA_DO_REDIS>@trajetto-redis-production:6379

   HTTP_REQUEST=https://www.intrajetto.com
   API_HTTP_REQUEST=https://trajettoapi.thorsolucoes.com.br
   JWT_SECRET=<openssl rand -base64 48>
   JWT_SECRET_REFRESH_TOKEN=<openssl rand -base64 48, outro valor>
   MASTER_USER_EMAIL=<e-mail da equipe>
   MASTER_USER_INITIAL_PASSWORD=<senha forte>
   CLOUDINARY_LOGO_IMAGE=<URL do logo dos e-mails>

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
   META_WHATSAPP_TEMPLATE_NAME=trajetto_notification
   META_WHATSAPP_API_VERSION=v23.0
   RESEND_SECRET_KEY=<re_…>
   RESEND_FROM_EMAIL=<remetente do domínio verificado>
   ```

   Mais, quando forem usadas: `META_WHATSAPP_CUSTOMER_TEMPLATE_NAME`,
   `META_WHATSAPP_BUSINESS_ACCOUNT_ID`, `META_WHATSAPP_APP_SECRET`,
   `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `RESEND_WEBHOOK_SECRET`,
   `TURNSTILE_SECRET_KEY`/`TURNSTILE_REQUIRED`, `RATE_LIMIT_EDGE_SECRET`, o
   certificado do comprovante (`PROOF_SIGNING_*`), mapa e geocoder
   (`PROOF_MAP_*`, `REVERSE_GEOCODER_*`), `MIN_MOBILE_CONTRACT`,
   `MOBILE_STORE_URL`, `TWO_FACTOR_CHALLENGE_REQUIRED`,
   `ACTIVITY_RETENTION_DAYS`.

   Cuidados:

   - Os parâmetros depois do `?` das duas URLs do banco são os mesmos do
     compose antigo, um a um: o pool e os tetos de runtime na `DATABASE_URL`
     ([`arquitetura.md`](./arquitetura.md#conexão-com-o-postgres)) e nenhum teto
     na `MIGRATION_DATABASE_URL` (um `CREATE INDEX` cancelado no meio é uma
     migration falhada). Copie inteiras; troque só a senha, o host e, se
     mudou, usuário e banco.
   - Senha com `@`, `/`, `:`, `#` ou `%` quebra a URL. As senhas geradas com
     `openssl rand -hex` não têm nenhum deles.
   - Não ponha aspas nem espaços em volta do `=`.
   - `PORT` e `NODE_ENV` não se definem: a imagem já traz `3333` e
     `production`.

4. Aba _Domains_ → **Add Domain**:

   | Campo                | Valor                                                                                  |
   | -------------------- | -------------------------------------------------------------------------------------- |
   | Host                 | `trajettoapi.thorsolucoes.com.br` (staging: `trajettoapi-staging.thorsolucoes.com.br`) |
   | Path                 | `/`                                                                                    |
   | Container Port       | `3333`                                                                                 |
   | HTTPS                | ligado                                                                                 |
   | Certificate Provider | `Let's Encrypt`                                                                        |

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

   _Stop Grace Period_ (se existir na sua versão): `40000000000` (40 s; o
   desligamento ordenado da API termina em até 35 s). Sem o campo, o contorno
   é `docker service update --stop-grace-period 40s trajetto-api-production`
   no host depois de cada deploy (o deploy seguinte o desfaz); ver a lacuna
   na [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora).

9. **Deploy**. Acompanhe _Deployments_ e _Logs_ (o boot espera o Postgres,
   migra, semeia e só então escuta a 3333).
10. Anote o **applicationId** e confirme o App Name (seção 7.10).

### 7.8 O Traefik da API (o que os labels faziam)

Não há nada a editar à mão. Para conferir, no host:

```sh
cat /etc/dokploy/traefik/dynamic/trajetto-api-production.yml
```

Deve ter dois roteadores com a regra ``Host(`trajettoapi.thorsolucoes.com.br`)``
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

Se o certificado não sai (o domínio responde com o certificado padrão do
Traefik e a Cloudflare dá erro 526): com _Always Use HTTPS_ na Cloudflare e
_Full (strict)_, o desafio HTTP do Let's Encrypt pode não chegar ao Traefik.
Saída simples: deixe a zona em _Full_ (sem strict) até o certificado aparecer
no log do Traefik (`docker logs dokploy-traefik 2>&1 | grep -i acme`) e volte
para _Full (strict)_; ou use um _Origin Certificate_ da Cloudflare como
certificado próprio do domínio.

### 7.9 `trajetto-backup` (Application)

1. **Create Service → Application**. Name `trajetto-backup`; App Name
   `trajetto-backup-staging` (ou `-production`). **Create**.
2. _General_ → _Provider_ → **Docker**: _Docker Image_
   `ghcr.io/trajetto-organization/trajetto-backup:staging` (produção:
   `:stable`), _Registry URL_ `ghcr.io`, _Username_/_Password_ da seção 7.3.
   **Save**.
3. _Environment_ → **Save** (preparação do bucket, da chave age e do heartbeat
   na [seção 18](#18-backup-e-restauração)):
   ```
   PGHOST=trajetto-postgres-production
   PGPORT=5432
   PGUSER=trajetto
   PGPASSWORD=<SENHA_DO_POSTGRES>
   PGDATABASE=trajetto
   BACKUP_AT_UTC=02:30
   BACKUP_R2_ACCOUNT_ID=<id da conta>
   BACKUP_R2_BUCKET=<bucket SÓ de backup>
   BACKUP_R2_ACCESS_KEY_ID=<token só desse bucket>
   BACKUP_R2_SECRET_ACCESS_KEY=<token só desse bucket>
   BACKUP_AGE_RECIPIENT=age1…
   BACKUP_HEARTBEAT_URL=<URL do check de 1 dia>
   BACKUP_EXCLUDE_TRAIL=false
   BACKUP_RUN_NOW=true
   ```
   `BACKUP_RUN_NOW=true` roda um backup já na partida (prova o caminho
   inteiro no primeiro deploy). Depois de ver o primeiro arquivo no bucket,
   apague a linha (ou ponha `false`) e salve: senão cada deploy faz um dump
   extra.
4. _Domains_ e _Ports_: **nada**.
5. _Advanced → Resources_: _Memory Limit_ `268435456` (256 MiB; `pg_dump`,
   `age` e `rclone` trabalham em fluxo).
6. _Advanced → Swarm Settings_ → _Restart Policy_:
   ```json
   { "Condition": "any", "Delay": 30000000000, "MaxAttempts": 0 }
   ```
7. **Deploy**; em _Logs_, espere `[backup] ...` terminar e confira o arquivo
   no bucket e o ping verde no heartbeat.
8. Anote o **applicationId**.

### 7.10 Anotar o applicationId e o App Name

O pipeline precisa, por ambiente, do **applicationId** de cada uma das três
Applications e do **App Name** da API.

- **applicationId**: abra a Application no painel e olhe a barra de
  endereços. A URL termina em `.../services/application/<applicationId>`: é
  esse último pedaço (letras, números, `-` e `_`). O script recusa outro
  formato.
- **App Name**: o nome que você definiu (seção 7.2); confira no topo da página
  da Application ou com `docker service ls` no host.

| Anotação                           | Vira no GitHub (environment do ambiente) |
| ---------------------------------- | ---------------------------------------- |
| applicationId da `trajetto-api`    | secret `DOKPLOY_API_APPLICATION_ID`      |
| applicationId da `trajetto-ai`     | secret `DOKPLOY_AI_APPLICATION_ID`       |
| applicationId da `trajetto-backup` | secret `DOKPLOY_BACKUP_APPLICATION_ID`   |
| App Name da `trajetto-api`         | variable `SWARM_API_SERVICE`             |

A chave de API do Dokploy (`DOKPLOY_API_KEY`) é uma só para o painel inteiro:
_Settings → Profile → API/CLI → Generate_ (o nome do menu varia entre
versões). Copie na hora: o Dokploy não mostra de novo.

## 8. Primeiro deploy, na ordem, com conferências

A ordem é **bancos → IA → API → backup → web → app**. Cada passo só começa
quando o anterior passou na conferência. Faça tudo em staging; depois repita
em produção.

1. **Imagens existem.** O primeiro push em `staging` (com o environment
   `staging` do GitHub ainda sem os secrets do Dokploy) termina verde e
   publica `sha-<7>` e `staging` das três imagens; o deploy aparece como
   "pulado". Confira em _GitHub → Trajetto-Organization → Packages_.
2. **Postgres e Redis** (seções 7.4 e 7.5), com **Deploy** em cada um.
   Conferir:
   ```sh
   docker service ls | grep -E 'trajetto-(postgres|redis)-staging'   # 1/1 cada
   docker exec $(docker ps -q -f name=trajetto-postgres-staging | head -n 1) \
     pg_isready -U trajetto -d trajetto                               # accepting connections
   ```
3. **`trajetto-ai`** (seção 7.6). Conferir: `docker service ls` mostra
   `trajetto-ai-staging 1/1` (o healthcheck leva até ~1 min no aquecimento).
4. **`trajetto-api`** (seção 7.7). No **primeiro boot de um banco vazio**,
   ponha `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` no Environment antes do Deploy
   e volte para `false` (Save) assim que a API subir. Em produção com dados
   vindos do Portainer, **não**: siga a [seção 24](#24-migrar-do-portainer-para-o-dokploy)
   e restaure antes. Conferir:
   ```sh
   docker service ls | grep trajetto-api-staging                    # 2/2
   curl -s -o /dev/null -w '%{http_code}\n' https://trajettoapi-staging.thorsolucoes.com.br/health/readiness   # 200
   # a IA é alcançável DE DENTRO da API (nome de rede + porta):
   docker exec $(docker ps -q -f name=trajetto-api-staging | head -n 1) \
     wget -q -O - http://trajetto-ai-staging:8080/health               # resposta 200 do serviço
   ```
   E, logado como MASTER na web, _Sistema → Provedores_: a linha "Leitura de
   fotos (trajetto-ai)" sem erro (401 = os tokens dos dois lados diferem).
5. **`trajetto-backup`** (seção 7.9), com `BACKUP_RUN_NOW=true`. Conferir o
   arquivo `pg/daily/AAAA/MM/DD/…dump.age` no bucket e o ping no heartbeat;
   depois tire o `BACKUP_RUN_NOW`.
6. **GitHub** ([seção 13](#13-configurar-o-github)): os secrets e variáveis do
   environment `staging`. Um push em `staging` agora faz o deploy sozinho
   (IA → API → backup) e termina com "convergiu".
7. **Web e app de staging**: `trajetto-ui/docs/deploy.md` e
   `trajetto-mobile/docs/deploy.md` (resumo na
   [seção 26](#26-os-três-repositórios-juntos)).

**Produção**, depois de o staging estar verde:

1. **Crie a tag `stable` antes de montar as Applications de produção**: no
   GitHub, _Actions → Pipeline (staging → produção) → Run workflow_ (branch
   `main`), `image_tag = sha-<7>` de um build verde de staging, e aprove o
   environment `production`. Como o environment `production` ainda não tem os
   secrets do Dokploy, o job move `stable` das três imagens e pula o deploy
   com um aviso. Assim as Applications de produção já nascem em `:stable`.
2. Seções 7.4 a 7.9 no environment `production`, com os valores de produção
   (tabela 7.1). Vindo do Portainer, a [seção 24](#24-migrar-do-portainer-para-o-dokploy)
   diz em que ponto restaurar o banco.
3. As mesmas conferências, com `-production` e o host de produção.
4. Os secrets do environment `production` no GitHub (com revisores
   obrigatórios). A partir daí, todo merge em `main` promove e faz o deploy.
5. Web de produção **depois** da API; app por último.

## 9. O serviço de IA (`trajetto-ai`)

A leitura de fotos (número e data do canhoto, odômetro) roda num serviço
próprio: RapidOCR sobre ONNX Runtime, só CPU, modelos embutidos na imagem e
conferidos por SHA-256 (o boot não precisa de rede). Ele só transcreve; quem
decide o que a foto diz é a API (ADR 0010; ver
[`arquitetura.md`](./arquitetura.md#ia-local)).

**Como é criado**: uma Application própria do Dokploy, sem domínio
([seção 7.6](#76-trajetto-ai-application)). A imagem `trajetto-ai` é
construída no job `build-and-push` (do stage `runtime`, depois de o pytest
passar no stage `test`) e promovida junto com a API (`staging` e `stable`).
O pipeline faz o deploy dela **antes** da API.

**Como fica conectado**:

| Do lado da API (Application `trajetto-api`)                    | Do lado da IA (Application `trajetto-ai`) | Observação                                                      |
| -------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `AI_PROVIDER=local`                                            | —                                         | `local` é o padrão; `none` desliga as leituras                  |
| `AI_LOCAL_URL=http://<App Name da IA>:8080`                    | escuta na 8080                            | o App Name é o nome de rede na `dokploy-network`                |
| `AI_LOCAL_TOKEN`                                               | `AI_TOKEN`                                | **o mesmo valor**, digitado nas duas Applications               |
| `AI_LOCAL_TIMEOUT_MS` (15 000), `AI_LOCAL_MAX_CONCURRENCY` (1) | `AI_MAX_QUEUE` (2), `OCR_THREADS` (2)     | opcionais; `OCR_THREADS` = o limite de CPU da Application da IA |

Trocar o token: gere outro (`openssl rand -hex 32`), salve em `AI_TOKEN` da
IA e em `AI_LOCAL_TOKEN` da API e faça **Deploy** das duas, IA primeiro.
Entre os dois deploys as leituras falham com 401 e voltam para a fila; nada
se perde.

Dimensionamento: pico medido de 0,60–0,63 GiB e p95 de 3,1 s por foto a
2 CPU / 1 GiB. Mais CPU = suba _CPU Limit_ e `OCR_THREADS` juntos.

Ligue a IA por empresa no `/admin` (limite mensal
`Business.ai_analysis_limit`; 0 desliga).

Isolamento: sem domínio, sem porta publicada, usuário 10001 na imagem. A
rede `dokploy-network` é compartilhada (lacuna da
[seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)):
o token é o que impede outro contêiner de usar o OCR.

Comportamento sob carga e falha: o serviço lê uma foto por vez com uma fila
curta (`AI_MAX_QUEUE`); cheio (ou 10 s esperando), responde 503 `busy` e o
pedido volta para a fila do Postgres em 5–15 s sem gastar tentativa. Com o
serviço fora do ar os pedidos esperam na fila; nada se perde e a cota só é
consumida quando a leitura acontece. `AI_PROVIDER=none` desliga as leituras
(registros marcados "não analisado").

Problemas comuns: toda leitura falha com 401 → `AI_LOCAL_TOKEN` (API) e
`AI_TOKEN` (IA) diferentes; pedidos parados em `PENDING` → serviço fora,
`AI_LOCAL_URL` errado ou ausente (a API trata como `none`) ou
`AI_PROVIDER=none`; `AI_PROVIDER=anthropic` → o boot falha com o motivo (o
provedor externo foi removido).

## 10. Postgres e Redis

Os dois são **Databases do Dokploy** ([seções 7.4](#74-postgresql-database)
e [7.5](#75-redis-database)), sem porta externa, alcançados pela API e pelo
backup pelo App Name na `dokploy-network`.

### Postgres

- **Volume**: o Dokploy cria um volume para o Database (veja o nome em
  _Advanced → Volumes_ ou com `docker volume ls`). Apagar o Database pelo
  painel pode apagar o volume: nunca apague o Database de produção sem um
  backup conferido.
- **A API recusa banco vazio em produção**: o boot consulta
  `_prisma_migrations` e para com "Banco vazio em produção" se nenhuma
  migration foi aplicada (volume novo, Database recriado). Numa instalação
  nova de verdade, `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` uma única vez. Em
  recuperação de desastre, restaure o dump **antes** de subir a API.
- **Imagem fixada** por digest no campo da imagem
  ([seção 7.4](#74-postgresql-database), passo 5). Trocar a versão maior
  (16 → 17) não é trocar a imagem: exige dump e restore.
- **Conexões**: cada réplica abre `connection_limit=10` + 1 da readiness.
  Mantenha `réplicas × 11 + migrations (2) + ferramentas` abaixo do
  `max_connections` (100 por padrão). Os parâmetros da URL estão em
  [`arquitetura.md`](./arquitetura.md#conexão-com-o-postgres).
- **Parada planejada**: o Database não tem _Stop Grace Period_ e o Swarm dá
  10 s antes do SIGKILL; um Postgres morto volta por _crash recovery_. Antes de
  qualquer _Stop_, _Redeploy_ ou mudança no Database, force o checkpoint:
  ```sh
  docker exec $(docker ps -q -f name=trajetto-postgres-production | head -n 1) \
    psql -U trajetto -d trajetto -c 'CHECKPOINT'
  ```
  e junte numa janela só toda mudança (imagem, comando, recursos), porque
  cada uma recria o contêiner.
- **Mais de um nó no Swarm**: o volume é local e o Database não tem campo de
  placement. Antes de adicionar nós, planeje (restaurar num nó fixo ou
  restringir por label via CLI).

#### Tuning do Postgres

O banco roda com os defaults da imagem (`shared_buffers` 128MB, `work_mem`
4MB, `random_page_cost` 4). Mudar isso reinicia o Postgres: janela combinada.
Se a sua versão do Dokploy tiver o campo de comando personalizado nos
Databases (_Advanced_), use, numa linha só, passando pelo entrypoint da imagem
(é ele que troca para o usuário `postgres`):

```
docker-entrypoint.sh postgres -c shared_buffers=1GB -c effective_cache_size=3GB -c work_mem=16MB -c maintenance_work_mem=256MB -c random_page_cost=1.1 -c max_wal_size=2GB -c log_min_duration_statement=1000 -c log_lock_waits=on
```

Valores de partida pela RAM reservada ao banco:

| RAM para o Postgres | `shared_buffers` | `effective_cache_size` | `work_mem` | `maintenance_work_mem` |
| ------------------- | ---------------- | ---------------------- | ---------- | ---------------------- |
| 2 GB                | 512MB            | 1536MB                 | 8MB        | 128MB                  |
| 4 GB                | 1GB              | 3GB                    | 16MB       | 256MB                  |
| 8 GB                | 2GB              | 6GB                    | 32MB       | 512MB                  |

`random_page_cost=1.1` só em SSD/NVMe. `work_mem` vale por operação, por
conexão: com 2 réplicas × 10 conexões, 32MB vira centenas de MB num pico. O
Docker dá 64 MB de `/dev/shm` e o Database não tem como aumentar: se um VACUUM
ou CREATE INDEX paralelo falhar com "could not resize shared memory segment"
(aconteceu na medição de 10/2026), acrescente
`-c max_parallel_maintenance_workers=0`. Sem campo de comando, o tuning é uma
lacuna (os defaults funcionam; só não estão dimensionados). Confira depois:
`psql -c 'SHOW shared_buffers'`.

### Redis

- **Senha obrigatória**: o Database Redis sempre nasce com senha. Qualquer
  contêiner que alcançasse um Redis aberto poderia publicar nos canais do
  adapter do Socket.IO. A API recebe `REDIS_URL=redis://:<senha>@<App Name do
Redis>:6379`.
- **Nada durável**: o comando personalizado da [seção 7.5](#75-redis-database)
  desliga RDB/AOF e põe o teto de 256 MB com `allkeys-lru`. Só guarda
  contadores de rate limit e o pub/sub do Socket.IO (ADR 0002); não precisa de
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
do host (`trajettoapi.thorsolucoes.com.br`; em staging, o host de staging),
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
  `x-trajetto-edge-secret`. Para ligar: `openssl rand -hex 32`; nas duas zonas
  (`thorsolucoes.com.br` e `intrajetto.com`), _Rules → Transform Rules →
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
   faixas da Cloudflare, ou Authenticated Origin Pulls. **Não** use Cloudflare
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
curl -sI https://trajettoapi.thorsolucoes.com.br/health/liveness | grep -iE '^(server|cf-ray)'

# 2. Cabeçalho forjado direto na origem NÃO dá balde novo: depois de 8 tentativas, 429
for n in $(seq 1 10); do
  curl -s -o /dev/null -w '%{http_code}\n' \
    --resolve trajettoapi.thorsolucoes.com.br:443:<IP_DO_VPS> \
    -H "Cf-Connecting-Ip: 1.2.3.$n" -H 'Content-Type: application/json' \
    -d '{"email":"x@x.com","password":"x"}' \
    https://trajettoapi.thorsolucoes.com.br/user/session
done

# 3. Duas redes diferentes (4G e fibra) veem x-ratelimit-remaining independentes
curl -si -X POST https://trajettoapi.thorsolucoes.com.br/user/session \
  -H 'Content-Type: application/json' -d '{"email":"x@x.com","password":"x"}' \
  | grep -i x-ratelimit-remaining
```

Integradores (`/integration/v1`): o teto `rate_limit_per_minute` de uma chave
é um balde para todas as rotas v1 juntas; cada endereço tem 30 falhas de
autenticação por minuto antes de 429 `RATE_LIMITED`.

## 12. Health checks

| Onde                                                                           | Sonda                                                    | Para quê                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swarm (_Health Check_ da Application `trajetto-api` e `HEALTHCHECK` da imagem) | `wget http://127.0.0.1:3333/health/liveness` a cada 30 s | **liveness**: o processo está vivo. Não toca dependência nenhuma: no Swarm, falhar aqui **destrói** a réplica; apontar para a readiness já fez um soluço do Postgres derrubar as duas réplicas. Uma réplica nova só entra no balanceamento depois de passar aqui |
| `/health/readiness`                                                            | consultada pelo monitor externo e pelo desligamento      | **readiness**: pode receber tráfego. Banco fora → 503. Vira 503 durante o desligamento ordenado (12 s antes de fechar). O Traefik não a consulta mais (lacuna da [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora))                 |
| Swarm (`trajetto-ai`)                                                          | `GET http://127.0.0.1:8080/health`                       | 200 só depois de carregar os dois perfis e ler a foto de aquecimento                                                                                                                                                                                             |
| Databases (Postgres e Redis)                                                   | o que o Dokploy configura                                | conferência manual: `pg_isready`; `redis-cli -a … ping`                                                                                                                                                                                                          |
| Monitor externo                                                                | `/health/readiness` da API e `/api/health` da web, 1/min | uptime ([seção 20](#20-alertas-e-monitoramento))                                                                                                                                                                                                                 |

Outras rotas: `/health/metrics` (filas, workers, crons, pool, certificado) e
`/health/providers` (prontidão dos provedores), ambas só MASTER.

## 13. Configurar o GitHub

### Environments

No repositório `Trajetto-Organization/trajetto-api`: _Settings →
Environments_. Para cada nome abaixo: _New environment_ (se não existir) →
_Add environment secret_ / _Add environment variable_.

**`staging`** (sem revisores; o deploy de staging é automático):

| Tipo     | Nome                                                                                    | Valor                                                                                                                                 | Obrigatório?                                                        |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| secret   | `DOKPLOY_URL`                                                                           | URL do painel, **https** (ex. `https://dokploy.seudominio.com.br`; o script recusa http)                                              | sim (com os dois abaixo; nenhum dos três = deploy pulado com aviso) |
| secret   | `DOKPLOY_API_KEY`                                                                       | a chave da seção 7.10                                                                                                                 | sim                                                                 |
| secret   | `DOKPLOY_API_APPLICATION_ID`                                                            | applicationId da `trajetto-api` de staging                                                                                            | sim                                                                 |
| secret   | `DOKPLOY_AI_APPLICATION_ID`                                                             | applicationId da `trajetto-ai` de staging                                                                                             | não (sem ele: aviso e a IA não é atualizada)                        |
| secret   | `DOKPLOY_BACKUP_APPLICATION_ID`                                                         | applicationId da `trajetto-backup` de staging                                                                                         | não (idem, para o backup)                                           |
| variable | `SWARM_API_SERVICE`                                                                     | `trajetto-api-staging` (o App Name da API)                                                                                            | sim, enquanto `ROLLOUT_VERIFY` não for `off`                        |
| secrets  | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY` | conferência do rollout ([seção 14](#14-conferir-a-convergência)); podem ficar no repositório, já que os dois ambientes dividem o host | idem                                                                |

**`production`** — marque **Required reviewers** (você e quem mais puder
aprovar uma ida para produção) e, em _Deployment branches and tags_,
_Selected branches and tags_ → `main` (o _Run workflow_ de rollback também
roda a partir de `main`):

| Tipo     | Nome                                                                                    | Valor                                               |
| -------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| secret   | `DOKPLOY_URL`, `DOKPLOY_API_KEY`                                                        | os mesmos do staging (um painel só)                 |
| secret   | `DOKPLOY_API_APPLICATION_ID`                                                            | applicationId da `trajetto-api` de produção         |
| secret   | `DOKPLOY_AI_APPLICATION_ID`                                                             | applicationId da `trajetto-ai` de produção          |
| secret   | `DOKPLOY_BACKUP_APPLICATION_ID`                                                         | applicationId da `trajetto-backup` de produção      |
| variable | `SWARM_API_SERVICE`                                                                     | `trajetto-api-production`                           |
| secrets  | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY` | conferência do rollout                              |
| secret   | `DEPLOY_SSH_KEY`                                                                        | a chave das migrations ([seção 15](#15-migrations)) |

Os três `DOKPLOY_*` obrigatórios de um environment: todos = deploy; nenhum =
o job move a tag e pula o deploy com aviso; só alguns = o job falha
("configuração parcial").

### Variáveis e secrets do repositório

_Settings → Secrets and variables → Actions_, abas _Secrets_ e _Variables_
(nível do repositório):

| Tipo     | Nome                      | Para quê                                                                                                                                                                      |
| -------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| variable | `MIGRATIONS_VIA_JOB`      | `true` liga o job único de migrations no promote                                                                                                                              |
| variable | `ROLLOUT_VERIFY`          | `off` desliga a conferência do rollout (só em emergência; fica registrado no resumo). Pode ser definida só num environment para valer só nele                                 |
| variable | `IMAGE_SCAN_ENFORCE`      | `true` faz um CRITICAL corrigível no Trivy falhar o build                                                                                                                     |
| secret   | `CLIENT_REPOS_READ_TOKEN` | token só leitura de `Trajetto-Organization/trajetto-ui` e `Trajetto-Organization/trajetto-mobile` (fine-grained, _Contents: Read-only_), para o contrato de rotas do `ci.yml` |

**Apague se existirem** (não são mais lidos por nada):
`DOKPLOY_COMPOSE_ID` (dos dois environments: era o id do app Compose), a
variável `STAGING_ENABLED` e os secrets `PORTAINER_WEBHOOK_URL` e
`PORTAINER_STAGING_WEBHOOK_URL`.

### Proteção das branches

- `main`: exigir PR, exigir os checks _Lint, type-check, unit (coverage floor)
  and E2E_, _AI OCR service (image + pytest)_, _Secret scan (gitleaks)_ e
  _The PR head was built on staging_; permitir só **merge commit**: em
  _Settings → General → Pull Requests_, deixe marcado só _Allow merge
  commits_ e desmarque _Allow squash merging_ e _Allow rebase merging_. Se a
  proteção impedir o push do `semantic-release` (o commit do CHANGELOG),
  permita que o GitHub Actions faça bypass ou desligue o plugin
  `@semantic-release/git`.
- `staging`: sem exigência de PR (o dono faz push direto); bloquear force-push.

## 14. Conferir a convergência

O passo que prova que o deploy trocou a versão. Roda depois do Dokploy em
staging e na promoção, e **falha o run** quando o Swarm reverteu o update,
quando ele não termina no prazo ou quando as réplicas não rodam o digest
promovido.

- O quê: `infra/scripts/verify-rollout.sh` no host do Dokploy, por SSH com
  chave restrita (forced command).
- Entrada: `<SWARM_API_SERVICE> ghcr.io/trajetto-organization/trajetto-api@sha256:<digest>`
  — o App Name da API e o digest que este run publicou.
- Lê: o `UpdateStatus` do serviço, as tasks e o digest da imagem do
  contêiner de cada task.
- Passa quando: o update terminou (`completed`) e toda task em execução roda
  o digest esperado, na quantidade de réplicas.
- Falha quando: `rollback_*`/`paused`, uma task com outra imagem, 600 s sem
  convergir (`ROLLOUT_TIMEOUT_SECONDS`).

Como o Dokploy atualiza o serviço com a **tag** (`…:staging`/`…:stable`) e
não grava o digest na spec, o script não compara a spec: ele lê o digest da
imagem do contêiner de cada task em execução. Limite: só enxerga contêineres
do próprio nó (o manager). Com a VPS única, são todas as tasks; com mais nós
no Swarm, o script precisa ser revisto.

Instalação, uma vez, no host do Dokploy:

```sh
sudo install -m 755 infra/scripts/verify-rollout.sh /usr/local/bin/trajetto-verify-rollout
```

E uma chave **só para isso** no `~/.ssh/authorized_keys` do usuário de deploy,
separada da chave das migrations — esta só lê:

```
command="/usr/local/bin/trajetto-verify-rollout",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... verify-trajetto
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
```

Desligar (só numa emergência, e fica registrado no resumo do run): variável
`ROLLOUT_VERIFY=off`.

## 15. Migrations

### Onde rodam

| Modo                                                                                | Quando                                                                                                          | O que acontece numa migration que falha                                                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boot de cada réplica** (`RUN_MIGRATIONS_ON_BOOT=true`, o padrão)                  | cada réplica da API que sobe roda `prisma migrate deploy` e os seeds antes do servidor                          | a réplica morre; a linha fica em `_prisma_migrations` com `finished_at` nulo e **toda** imagem, inclusive a antiga, passa a sair com P3009 no boot. O próximo restart de qualquer réplica vira queda |
| **Job único antes do rollout** (`MIGRATIONS_VIA_JOB=true`, recomendado em produção) | a promoção roda `./docker-entrypoint.sh migrate` uma vez, como job do Swarm, com a imagem exata sendo promovida | o passo falha; `stable` não anda, o Dokploy não é chamado e as réplicas em produção nem percebem                                                                                                     |

Staging migra no boot (o job só existe no promote); é lá que uma migration
ruim deve aparecer primeiro.

Nos dois modos, `prisma migrate deploy` e os seeds usam
`MIGRATION_DATABASE_URL` (definida na Application da API, sem tetos de runtime
e com pool de 2). A `DATABASE_URL` de runtime leva `statement_timeout=30s` e
`lock_timeout=5s`: um `CREATE INDEX` cancelado no meio é uma migration
falhada. No modo `migrate`, o entrypoint roda `prisma migrate deploy`,
`build/seed.js` e `build/import-violation-codes.js` de forma **estrita** e sai
sem subir o servidor; no boot, uma falha de seed não derruba a réplica, mas
aparece como `[entrypoint] ERRO: ...` no stderr.

As regras para escrever uma migration (expandir/contrair, `lock_timeout`,
índices) estão em [`arquitetura.md`](./arquitetura.md#migrations-expandir-e-contrair).

### Ligar o job único (uma vez)

1. No host do Dokploy, instalar o script:
   ```sh
   sudo install -m 755 infra/scripts/run-release-migrations.sh /usr/local/bin/trajetto-release-migrate
   ```
2. Uma chave SSH restrita ao script no `~/.ssh/authorized_keys` do usuário de
   deploy (grupo `docker`). O comando diz qual serviço copiar — `API_SERVICE`
   é obrigatória (o App Name da API de produção; sem ela o script recusa). A
   rede padrão do job já é a `dokploy-network`:
   ```
   command="API_SERVICE=trajetto-api-production /usr/local/bin/trajetto-release-migrate",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... deploy-trajetto
   ```
   O script só aceita `ghcr.io/trajetto-organization/trajetto-api:sha-<sha>`
   (ou `main-<sha>` de builds antigos), numa linha só. Não reaproveite a chave
   da conferência do rollout.
3. `docker login ghcr.io` com esse usuário (token `read:packages`): o job usa
   `--with-registry-auth`.
4. GitHub (environment `production`): secrets `DEPLOY_SSH_HOST`,
   `DEPLOY_SSH_USER`, `DEPLOY_SSH_KEY` e `DEPLOY_SSH_KNOWN_HOSTS`; e a
   variável de repositório `MIGRATIONS_VIA_JOB=true`.
5. Rodar uma promoção e conferir no passo _Run database migrations_ a linha
   `[release-migrations] ok`.
6. Só então `RUN_MIGRATIONS_ON_BOOT=false` no _Environment_ da Application
   `trajetto-api` de produção (Save; vale a partir do próximo deploy).

O que o job faz: copia o env da API em execução (`docker service inspect
trajetto-api-production`) para um arquivo `0600`, apagado assim que o job é
criado (a senha do banco nunca mora no CI); `docker service create --mode
replicated-job --restart-condition none --no-healthcheck` na rede
`dokploy-network` (onde o Postgres está); espera até
`MIGRATE_TIMEOUT_SECONDS` (900 s). Estourou ou a espera foi interrompida: o
passo falha, mas o job **não é removido** (matá-lo no meio de uma migration é
o que gera P3009) — acompanhe com `docker service logs -f <job>` e remova
depois (`docker service ls --filter name=trajetto-migrate-`).

Limites: imagens anteriores ao modo `migrate` fazem o job falhar e bloqueiam a
promoção (sem estrago); para voltar a uma delas, desligue `MIGRATIONS_VIA_JOB`
só nesse promote. O job usa o env da versão que está no ar: se a versão nova
exige uma variável que a produção ainda não tem, acrescente-a ao Environment
da Application **antes** do promote (salvar não reinicia nada; o próximo
deploy usa).

À mão, no host:
`API_SERVICE=trajetto-api-production trajetto-release-migrate ghcr.io/trajetto-organization/trajetto-api:sha-<sha>`.

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
5. Onde rodar o `resolve`: dentro de uma réplica em execução:
   ```sh
   docker exec -it $(docker ps -q -f name=trajetto-api-production | head -n 1) \
     ./node_modules/.bin/prisma migrate resolve --applied <nome>
   ```
6. Rodar o job (ou a promoção) de novo.

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
   LOAD_SOCKET_URL=https://trajettoapi-staging.thorsolucoes.com.br LOAD_SOCKET_TOKEN=<token de um gestor> \
     HOLD_MINUTES=5 node tests/load/socket-hold.mjs
   ```
4. Um e-mail e um WhatsApp de teste chegam ao destino de teste, e a nenhum
   cliente real.
5. _Sistema → Provedores_ sem `error` inesperado (Resend, Meta, R2,
   trajetto-ai, heartbeat).

### A promoção

1. Abra o PR `staging → main`; espere os checks (inclusive _The PR head was
   built on staging_).
2. Merge com **Create a merge commit**.
3. _Actions_ → o run do push em `main` → job _Promote to production_ →
   _Review deployments_ → aprovar o environment `production`.
4. O job resolve o build (`sha-<head do PR>`), compara com o staging, roda as
   migrations (se `MIGRATIONS_VIA_JOB=true`), move `stable` das três imagens,
   pede o deploy das Applications de produção (IA → API → backup) e espera a
   convergência. Verde = o Swarm roda o digest promovido em todas as réplicas
   da API. O digest fica no resumo do run.
5. Depois, o job _Release_ cria a versão.

Conferir à mão:

```sh
docker service ps trajetto-api-production --filter desired-state=running --format '{{.Image}} {{.CurrentState}}'
docker service inspect trajetto-api-production --format '{{.UpdateStatus.State}}'   # completed
```

**Ordem entre API e web**: API primeiro, web depois. A promoção da web confere
se a API de produção serve todas as rotas que a web chama
(`trajetto-ui/docs/deploy.md`).

## 17. Rollback

### Caminho normal: promover o build bom

1. Achar a tag boa: o resumo de uma promoção anterior registra
   `trajetto-api:stable → sha-<7> (sha256:...)`; ou o job _Build and push
   the images (once)_ do push em `staging` que gerou o build.
2. _Actions_ → _Pipeline (staging → produção)_ → _Run workflow_ (branch
   `main`) → `image_tag = sha-<7>` (builds antigos: `main-<sha>`).
3. Aprovar o environment `production`.
4. O job move `stable` de volta para aquele build e pede o deploy das
   Applications. O run só fica verde depois do passo _Wait for the rollout to
   converge_ (ou com o aviso, se `ROLLOUT_VERIFY=off`).

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
Com o job ligado, o promote de uma imagem anterior roda o `migrate deploy`
dela, que não tem o que aplicar.

### Quando o Swarm desiste de um serviço

Nenhuma Application tem limite de tentativas (`MaxAttempts: 0`). Se uma
réplica ainda assim ficar parada, **Deploy** da Application no painel (ou
`docker service update --force <App Name>`) recria as tasks.

## 18. Backup e restauração

Até 14/09/2026 o Trajetto não tinha backup nenhum. Hoje:

|                   |                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **RPO**           | até 24 h: um dump por noite às 02:30 UTC, antes do primeiro job que apaga dados (03:17 UTC) |
| **RTO**           | medido: 10,5 s para 94 MB (cresce com o volume; a parte lenta é recriar os índices)         |
| **PITR**          | **não existe** (exigiria WAL archiving com wal-g)                                           |
| **Arquivos (R2)** | fora do dump ("O que o dump não cobre", abaixo)                                             |

### O backup agendado (`trajetto-backup`)

Uma Application própria ([seção 7.9](#79-trajetto-backup-application)),
construída e promovida com a API. Toda noite às `BACKUP_AT_UTC` (02:30):

1. `pg_dump -Fc` **pela rede** do Database PostgreSQL (`PGHOST` = App Name do
   Postgres; sem socket do Docker).
2. Recusa dump com menos de 1 KB ou cujo índice (TOC) não lê de volta.
3. Cifra com **age** para a chave pública `BACKUP_AGE_RECIPIENT` antes de
   qualquer coisa sair do contêiner (a privada **não** fica no servidor).
4. Envia `<banco>-<AAAAMMDD>T<HHMMSS>Z.dump.age` e o `.sha256` para um **bucket
   R2 separado**, em `pg/daily/AAAA/MM/DD/`; aos domingos copia para
   `pg/weekly/…` e no dia 1º para `pg/monthly/…`.
5. Avisa o heartbeat (`BACKUP_HEARTBEAT_URL`) no sucesso e `…/fail` em qualquer
   falha (inclusive variável faltando); o monitor alerta na falha **e no
   silêncio** (período 26 h).
6. Não deixa nada em disco.

Preparar (uma vez, no console da Cloudflare e na sua máquina):

1. **Bucket R2 só de backup** (diferente do bucket de fotos) e um **token R2**
   com acesso só a ele (`BACKUP_R2_ACCESS_KEY_ID`/`BACKUP_R2_SECRET_ACCESS_KEY`;
   `BACKUP_R2_ACCOUNT_ID` é o id da conta).
2. **Lifecycle** no bucket: `pg/daily/` 8 dias, `pg/weekly/` 35, `pg/monthly/` 400. **Bucket Lock** por prefixo com o mesmo prazo (o lock prevalece sobre
   o lifecycle; um lock de 35 dias em `pg/` inteiro manteria cada diário 35
   dias). Os tokens do R2 não têm escopo "só escrita": o Bucket Lock é o que
   impede quem vaza um token de apagar.
3. **Chave age**: `age-keygen -o trajetto-backup.agekey` na sua máquina. A
   linha `# public key: age1…` vai em `BACKUP_AGE_RECIPIENT`; o arquivo
   (privado) vai para o gerenciador de senhas, **nunca** para o servidor.
4. **Heartbeat**: um check de período 1 dia (healthchecks.io ou Better Stack);
   a URL vai em `BACKUP_HEARTBEAT_URL`.
5. Deploy com `BACKUP_RUN_NOW=true` (ou, com o serviço já de pé,
   `docker exec $(docker ps -q -f name=trajetto-backup-production | head -n 1) backup-to-r2`).

Trocar só o backup, sem esperar o pipeline: **Deploy** da Application
`trajetto-backup` no painel (puxa a tag de novo).

### Restaurar a partir do R2

```bash
# 1. Baixar o par (rclone configurado com um token de leitura do bucket)
rclone copy r2:<bucket>/pg/daily/2026/09/24/ ./restore/
cd restore
# 2. Conferir a integridade da cópia
sha256sum -c trajetto-20260924T023000Z.dump.age.sha256
# 3. Decifrar com a identidade PRIVADA (guardada fora do servidor)
age -d -i ~/trajetto-backup.agekey -o trajetto-20260924T023000Z.dump \
  trajetto-20260924T023000Z.dump.age
# 4. Ensaiar (ou, num incidente, restaurar no banco novo ANTES de subir a API)
../infra/scripts/restore-postgres.sh ./trajetto-20260924T023000Z.dump
```

Num incidente real (banco perdido), restaurando no Database PostgreSQL do
Dokploy:

1. Se o Database se perdeu, crie outro ([seção 7.4](#74-postgresql-database))
   com o mesmo usuário, senha e nome de banco (ou ajuste as URLs da API e as
   `PG*` do backup). **Não** ligue `ALLOW_EMPTY_DATABASE_BOOTSTRAP`: com ela a
   API migraria e semearia um banco novo, por cima do qual o dump não
   restaura.
2. Pare a API: _Advanced → Cluster Settings → Replicas_ `0` → **Save** →
   **Deploy** (ou `docker service scale trajetto-api-production=0`, que dura
   até o próximo deploy). Pare também o `trajetto-backup` (_Stop_).
3. Copie o dump para o host e restaure dentro do contêiner do banco:
   ```bash
   docker exec -i $(docker ps -q -f name=trajetto-postgres-production | head -n 1) \
     pg_restore -U trajetto -d trajetto \
     --no-owner --no-privileges --exit-on-error < ./trajetto-<data>.dump
   ```
4. Volte as réplicas da API para `2` (**Save** → **Deploy**) e o backup
   (_Start_/**Deploy**).

Um banco restaurado traz `_prisma_migrations` e passa pela guarda; as
migrations mais novas que o dump rodam no boot (ou no job).

### Backup à mão (antes de uma operação arriscada)

```bash
POSTGRES_USERNAME=trajetto POSTGRES_DATABASE=trajetto \
POSTGRES_SERVICE=trajetto-postgres-production \
  ./infra/scripts/backup-postgres.sh ./backups
```

O `pg_dump` roda dentro do contêiner do banco (o script acha a task do
Database pelo `POSTGRES_SERVICE`, o App Name; `POSTGRES_CONTAINER` escolhe um
contêiner direto), para a
versão do cliente bater com a do servidor. Escreve `.dump.partial` e só vira
`.dump` depois do tamanho mínimo e do `pg_restore --list`; ao lado sai o
`.sha256`. O arquivo só vira backup quando sai da máquina.

### Ensaiar a restauração

```bash
POSTGRES_IMAGE=postgres:16-alpine@sha256:<o digest do Database> \
  ./infra/scripts/restore-postgres.sh ./backups/<arquivo>.dump
```

Sobe um Postgres descartável na porta 55432 com a **mesma imagem da produção**
(`POSTGRES_IMAGE`; a do campo de imagem do Database), restaura com
`--exit-on-error`, confere o `.sha256` se existir e roda `prisma migrate
status` contra o banco restaurado — a verificação que importa ("Database
schema is up to date!"; um dump mais velho que o código falha com "Dump
anterior ao código: há migrations pendentes"). O contêiner é removido ao
final (`KEEP_CONTAINER=true` preserva).

Ensaios feitos: 14/09/2026 (72 migrations do zero, 49 tabelas, 2 s, os cinco
índices de SQL cru e o `pg_trgm` sobreviveram) e 15/09/2026 com volume (banco
de carga de 94 MB: dump de 4,3 MB em 1,5 s, restore em 10,5 s, a API subiu, as
telas de torre, entregas e dashboard responderam e o smoke do k6 passou 12/12,
inclusive escrita na tabela particionada). Falta o ensaio mensal contra um
dump real de produção.

### O que o dump não cobre

- **Bucket R2** (fotos de checklist e de entrega, assinaturas, anexos,
  avatares): o banco guarda só as chaves. Fotos de entrega e assinaturas são
  prova documental. O R2 não tem versioning pela API S3: o equivalente é um
  **Bucket Lock** nos prefixos `deliveryProofs/` e `deliveryPhotos/` com o
  prazo legal de guarda, e uma cópia periódica (`rclone sync`) para outro
  bucket com um token que a API não tem.
- **Segredos**: as cópias vivas são o _Environment_ de cada Application no
  Dokploy e o seu gerenciador de senhas. Perder `JWT_SECRET_REFRESH_TOKEN`
  desloga todo mundo. Perder `WEBHOOK_SECRETS_KEY` **não é recuperável**: os
  segredos dos webhooks dos clientes estão cifrados com ela no dump (a saída é
  uma chave nova e cada cliente gerar novo segredo). Guarde-a longe dos
  backups.
- **Redis**: não precisa ser restaurado.

### Trilha de posição e o backup lógico

`driver_position` (particionada por dia, 90 dias) é a maior tabela em escala
(~2.400 pontos por motorista num dia de 10 h). Um dump que sempre leva a
trilha passa a levar horas e segura um snapshot que impede o autovacuum das
filas. Por isso:

| Variável                    | Efeito                                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `BACKUP_EXCLUDE_TRAIL=true` | mantém o schema da trilha e deixa as linhas de fora (no `trajetto-backup` e no `backup-postgres.sh`) |
| `BACKUP_TRAIL_ONLY=true`    | só no `backup-postgres.sh`: dump **só** da trilha, para uma cópia separada                           |

O padrão é o dump completo. Com `BACKUP_EXCLUDE_TRAIL=true` a trilha fica fora
do RPO (decisão de produto). Restaurar um dump só da trilha:
`pg_restore -d <banco> --data-only --no-owner --no-privileges --exit-on-error <banco>-trail-<data>.dump`
(partições de dias antigos precisam ser criadas antes; o job de partições só
cria de −1 a +7 dias).

### Pendências registradas

WAL archiving/PITR (imagem derivada com wal-g e um restart planejado);
ensaio mensal com dump real; Bucket Lock nos prefixos de prova; réplica de
leitura/HA; retenção da trilha por plano (gatilho: mais de 2 mil motoristas
ativos/dia ou `driver_position` acima de 50 GB).

## 19. Réplicas, workers e tempo real

Cada réplica da API roda, no mesmo processo e no mesmo pool: o HTTP, o
Socket.IO com o adapter Redis e — com `WORKERS_ENABLED=true`, o padrão — os
workers (pipeline de notificações, pipeline de IA, dispatcher de webhooks) e o
agendador de crons. As filas no Postgres são reivindicadas com
`FOR UPDATE SKIP LOCKED` e lease, e os crons têm uma execução por horário
graças a um lease no banco: N réplicas não duplicam nada.

- **Tempo real com várias réplicas**: o evento emitido numa réplica chega ao
  cliente conectado em outra pelo pub/sub do Redis
  (`@socket.io/redis-adapter`). Todas as réplicas precisam do mesmo
  `REDIS_URL` e do mesmo `SOCKET_ADAPTER_KEY`. Provado em
  `tests/E2E/multi-replica-events.test.ts`. Sem cookie sticky: WebSocket fica
  na réplica por natureza.
- **Escalar a API**: _Advanced → Cluster Settings → Replicas_ da Application
  `trajetto-api` → **Save** → **Deploy** (ou `docker service scale
trajetto-api-production=N`, que o próximo deploy desfaz) e refaça o
  orçamento de conexões (`réplicas × 11 + 2 + ferramentas < max_connections`).
- **Desligamento ordenado**: SIGTERM → readiness 503 → 12 s para o
  balanceamento soltar a réplica → fecha tempo real, HTTP, workers e Redis,
  com teto de 35 s (o _Stop Grace Period_ é 40 s; sem ele, ver a lacuna da
  [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora)).

### Separar os workers do HTTP (só por gatilho medido)

Gatilhos (ADR 0001/0004): espera no pool visível em `/health/metrics`
(`runtime.prisma_pool`) nos horários de dreno; CPU/IO/WAL do Postgres puxados
por um dreno de backlog enquanto o HTTP sofre; necessidade de publicar o HTTP
sem reiniciar os workers. Separar é isolamento, não correção de falha.

1. **Orçamento de conexões antes de tudo**: `réplicas_api × 11 + worker ×
(limite + 1) + migrations (2) + ferramentas` abaixo do `max_connections`
   (ou PgBouncer antes).
2. Crie uma Application `trajetto-worker` (App Name `trajetto-worker-production`)
   com a **mesma** imagem e o mesmo _Environment_ da API, mudando só:
   ```
   WORKERS_ENABLED=true
   PIPELINE_SWEEP_INTERVAL_MS=2000
   RUN_MIGRATIONS_ON_BOOT=false
   DATABASE_URL=postgresql://...?schema=public&connection_limit=4&pool_timeout=10&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=...
   ```
   Sem domínio, 1 réplica, o mesmo _Swarm Settings_ e _Resources_ da API.
   **Atenção**: o `deploy.yml` só faz o deploy de `trajetto-ai`,
   `trajetto-api` e `trajetto-backup`. Um worker exige um passo a mais no
   workflow (outro `DOKPLOY_*_APPLICATION_ID`), senão ele fica na versão
   antiga a cada promoção.
3. Suba o worker primeiro e confirme nos logs `workers started` e, em
   `/health/metrics`, os batimentos dos workers vindos dele.
4. Só então `WORKERS_ENABLED=false` na API. Cada réplica loga
   `workers disabled on this replica (WORKERS_ENABLED=false)`.

Voltar: `WORKERS_ENABLED=true` na API primeiro, depois remover o worker. O
worker roda o mesmo `server.ts`, então também tem Socket.IO com o adapter: os
emits dos pipelines atravessam o Redis até as réplicas HTTP. Numa réplica
HTTP-only um publish não drena nada; o evento espera a varredura do worker
(até 2 s com `PIPELINE_SWEEP_INTERVAL_MS=2000`). Testes:
`tests/unitaires/lifecycle/workers-role-flag.test.ts` e
`workers-disabled-boot.test.ts`.

### Conexões presas

`P1008`/"Operations timed out after `60s`" ou `P2024` com o banco de pé:

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

### Dead man's switch (`ops-heartbeat`, a cada minuto)

Uma réplica por minuto lê o estado da operação, aplica as regras de
`src/shared/health/alert-rules.ts` e: tudo certo → `GET HEALTHCHECK_PING_URL`;
alguma regra quebrou → `POST <ping>/fail` com os motivos, um por linha, em
pt-BR (com `HEALTHCHECK_FAIL_URL`, `GET` nela com os motivos no `msg`); banco
fora, processo morto, scheduler parado → **nenhum ping** (o silêncio é o
alerta). Sem `HEALTHCHECK_PING_URL` os motivos só vão para o log
(`operational check failed`).

| Regra                                       | Dispara quando                                                                                                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Outbox                                      | evento **devido** esperando > 5 min                                                                                        |
| Entregas internas (in-app, push, atividade) | entrega devida esperando > 5 min                                                                                           |
| Entregas externas (e-mail, WhatsApp)        | entrega devida esperando > 15 min                                                                                          |
| Webhooks                                    | linha devida esperando > 30 min                                                                                            |
| IA                                          | análise devida esperando > 15 min                                                                                          |
| Credencial                                  | primeira entrega FAILED nos últimos 10 min com erro de credencial (WhatsApp 401/403/190, SMTP EAUTH/535/530, push 401/403) |
| Rajada                                      | 50 entregas FAILED do mesmo canal em 10 min                                                                                |
| IA credencial                               | análise FAILED/PARTIAL com `authentication_error`/401/403                                                                  |
| Cron                                        | job sem sucesso há 26 h, que rodou e nunca teve sucesso, ou com lease vencido                                              |
| Partições                                   | `driver_position` com menos de 3 dias de partições à frente                                                                |
| Worker travado                              | heartbeat sem progresso há 10 min numa réplica viva                                                                        |
| Postgres                                    | conexões ≥ 80 % de `max_connections`                                                                                       |
| Redis                                       | sem resposta ao PING em 2 s                                                                                                |
| Certificado do comprovante                  | vence em 30 dias (aviso) / 7 dias (crítico), vencido ou inválido                                                           |

Limiares em `DEFAULT_ALERT_THRESHOLDS` (`alert-rules.ts`).

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
7. O backup tem o check próprio (`BACKUP_HEARTBEAT_URL`, período 1 dia).

### Primeira ação por motivo

| Motivo começa com                                     | Primeiro passo                                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Canal WHATSAPP: falha de credencial`                 | token da Meta vencido/revogado: gerar token de sistema novo no Business Manager e atualizar `META_WHATSAPP_ACCESS_TOKEN`; as falhas estão em `/health/dead-letter?channel=WHATSAPP` |
| `Canal EMAIL: falha de credencial`                    | chave do Resend revogada ou domínio desverificado                                                                                                                                   |
| `Canal PUSH: falha de credencial`                     | token de acesso da Expo (push security)                                                                                                                                             |
| `Canal X: N entregas falharam de vez`                 | abrir o dead letter do canal e ler o prefixo `[... code=...]` mais comum                                                                                                            |
| `Outbox` / `Entregas` / `Webhooks` / `Análises de IA` | `workers` em `/health/metrics` e o log da réplica; reiniciar a task travada                                                                                                         |
| `Cron X`                                              | `cron_jobs` em `/health/metrics` traz `last_error`; o catch-up refaz jobs diários a cada hora                                                                                       |
| `driver_position`                                     | rodar o job de partições (idempotente) e ver por que falhou                                                                                                                         |
| `Postgres`                                            | `runtime.prisma_pool` em `/health/metrics`; réplicas × `connection_limit`                                                                                                           |
| `Redis`                                               | a API segue (fail-open), mas o rate limit fica local e o Socket.IO não cruza réplicas                                                                                               |
| `Certificado ICP do comprovante vence em`             | renovar o A1 antes da data e trocar `PROOF_SIGNING_PFX_*`; `proof_signing` em `/health/metrics` mostra `not_after` e `days_left`                                                    |
| `Certificado ICP ... vencido` / `inválido`            | os comprovantes saem sem assinatura (e dizem isso); `PFX_UNREADABLE` = senha errada ou arquivo corrompido, `PFX_FILE_UNREADABLE` = o arquivo não montou                             |

Para trocar uma variável: _Environment_ da Application → **Save** →
**Deploy** (salvar sozinho não reinicia o contêiner).

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
Meta (`GET /{phone_number_id}` e os templates, com
`META_WHATSAPP_BUSINESS_ACCOUNT_ID`), Expo, R2 (`HeadBucket`; `local` em
produção é erro), trajetto-ai (`/health` e um `POST /v1/read` vazio), o
certificado e o heartbeat. `not_configured` traz `missing_env` com os nomes que
faltam.

Fase 2 (fora do repositório, quando houver pilha de métricas): 5xx acima de
2 % e p95 acima de 1,5 s por rota e picos de 429 (métricas do Traefik); disco
acima de 80 % (node-exporter); restarts de contêiner (cAdvisor). O Dokploy tem
uma aba _Monitoring_ por serviço que ajuda no dia a dia, mas não alerta
ninguém.

## 21. Cadeia de suprimentos e segredos

| Controle                                                             | Onde                                                                           | Quando falha                                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Dependabot (npm, actions, imagens base, pip da IA, compose de carga) | `.github/dependabot.yml`, PRs contra `staging`                                 | não falha: abre PRs toda segunda; majors de Node/Postgres e o motor de OCR ficam de fora de propósito |
| Actions fixadas por commit                                           | todo `uses:` dos workflows, com `# vX.Y.Z`                                     | `supply-chain.test.ts` recusa um `uses:` por tag                                                      |
| Imagens base por digest                                              | `Dockerfile`, `infra/backup/Dockerfile`, `infra/ai-ocr/Dockerfile`             | mesmo teste                                                                                           |
| Serviço de IA                                                        | rodas Python com `--require-hashes`, modelos conferidos contra `models.sha256` | o build falha num hash diferente; o pytest roda dentro da imagem                                      |
| Gate de audit                                                        | `npx audit-ci` no `ci.yml` e no `deploy.yml`, config em `audit-ci.jsonc`       | advisory CRITICAL numa dependência de produção sem entrada na allowlist                               |
| SBOM e proveniência                                                  | `build-push-action` (`sbom: true`, `provenance: mode=max`)                     | não falha: anexa as atestações à imagem no GHCR                                                       |
| Scan da imagem (Trivy)                                               | depois do push, por digest                                                     | só com `IMAGE_SCAN_ENFORCE=true`                                                                      |
| Varredura de segredos (gitleaks)                                     | job `secrets` do `ci.yml` e do `deploy.yml`                                    | um segredo novo em qualquer commit do histórico                                                       |

As imagens do Postgres e do Redis não passam pelo Dependabot (são campos do
Dokploy, não arquivos do repositório): atualize o digest do Postgres à mão,
numa janela, e só dentro da versão 16.

**O audit falhou**: leia a advisory; com versão corrigida, atualize (ou aceite
o PR do Dependabot). Sem correção, entra na allowlist do `audit-ci.jsonc` com
comentário dizendo por que não chega à produção e `Revisar até AAAA-MM-DD` (o
teste recusa sem data). Nunca o pacote inteiro. Hoje: `tar` via
bcrypt/node-pre-gyp (só na instalação; sai com bcrypt 6).

**Ligar o scan de imagem de verdade**: quando foi adicionado, a base
`node:22.21.1-alpine` tinha CRITICALs corrigíveis (OpenSSL em
libssl3/libcrypto3 e o `tar` do npm embutido). Suba a base (PR do
Dependabot), confira no passo "Scan the images" que não sobrou CRITICAL
corrigível e ponha `IMAGE_SCAN_ENFORCE=true`.

**O gitleaks falhou**: trate como vazamento. Revogue/rotacione na origem
primeiro; remova do código (reescreva a branch se ainda não foi mergeada; em
`main`/`staging`, não reescreva — já foi rotacionado). Só entra no
`.gitleaksignore`, pela fingerprint (`commit:arquivo:regra:linha`), um falso
positivo ou um segredo já rotacionado. O job varre o histórico de **todas** as
branches do remoto. O `.gitleaks.toml` mantém todas as regras padrão e
silencia só a `generic-api-key` em `tests/` e no `.env.example`. A baseline
guarda o que o histórico tinha quando a varredura foi ligada — entre eles uma
`ANTHROPIC_API_KEY` antiga (commit `2926c01`): revogue-a; a API não usa mais a
Anthropic (ADR 0010).

**Segredos no Dokploy**: ficam no _Environment_ de cada Application e nos
Databases; qualquer usuário do painel com acesso ao projeto os vê. Dê acesso
ao Dokploy só a quem pode ver produção, e renove o token do GHCR
(`read:packages`) antes de vencer — vencido, todo deploy falha no pull.

Configuração fora do repositório: _Dependabot alerts_ e _security updates_
ligados; _CodeQL default setup_ ligado; política da organização exigindo
actions fixadas por SHA.

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
imagens. Não há limpeza automática: as versões sem tag incluem os manifestos
de atestado e os índices que `stable` e `staging` usam, e apagá-las às cegas
quebra imagens com tag. Limpe à mão, pelo painel do pacote, as `sha-<7>` e
`main-<sha>` antigas que não são `stable` nem `staging` (guarde as últimas
como alvo de rollback).

## 23. Recursos da VPS e logs

| Serviço     | Limite (onde)                                                         |
| ----------- | --------------------------------------------------------------------- |
| API         | 2 × 1 GiB (_Resources_ da Application; heap 768 MB no `NODE_OPTIONS`) |
| Web         | 768 MiB (limite da Application; ver `trajetto-ui/docs/deploy.md`)     |
| Redis       | 512 MiB (_Resources_ do Database; dados 256 MB pelo comando)          |
| Backup      | 256 MiB                                                               |
| trajetto-ai | 1 GiB e 2 CPUs                                                        |
| Postgres    | sem teto (dimensionado pelo tuning)                                   |

Mais o Dokploy e o Traefik. Só a produção passa de 3,5 GB sem contar o
Postgres; **com staging no mesmo host, o dobro** (ou staging com 1 réplica,
limites menores e sem a IA, `AI_PROVIDER=none`). Os números reais saem de
`docker stats` sob o harness de carga (`tests/load/README.md`). Sem limite de
CPU na API de propósito (o throttling do CFS piora o p99); com limite na IA,
porque o OCR satura todo núcleo que recebe.

**Logs**: a rotação é a do `/etc/docker/daemon.json`
([seção 6](#6-preparar-o-servidor-uma-vez), passo 3): 50 MB × 5 arquivos por
contêiner. Confira de tempos em tempos `df -h /var/lib/docker` e o tamanho
dos logs (`du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail`).
Um contêiner criado antes da regra não rotaciona: um **Deploy** da Application
o recria.

## 24. Migrar do Portainer para o Dokploy

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
5. **API** (7.7) com `ALLOW_EMPTY_DATABASE_BOOTSTRAP=false`. Se ela subir, o
   banco é o certo (num banco vazio a guarda derruba o boot). Depois o backup
   (7.9) e os secrets do GitHub.
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
R2"), crie a API e aponte o DNS. `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` só
serve para uma instalação **sem** dados a restaurar.

## 25. Checklist do primeiro deploy

Na ordem:

- [ ] Branch `staging` criada no GitHub a partir do estado que vai para
      produção; só merge commit habilitado; proteção de `main` e `staging`
      ([seção 13](#13-configurar-o-github)).
- [ ] Primeiro push em `staging` verde: `sha-<7>` e `staging` das três
      imagens no GHCR (o deploy aparece como "pulado").
- [ ] VPS com Dokploy; `daemon.json` com rotação de log e Docker reiniciado;
      `infra/traefik/` aplicado ([seção 6](#6-preparar-o-servidor-uma-vez)).
- [ ] DNS na Cloudflare (proxy, Full strict, TLS 1.2, Always HTTPS) para os
      hosts da API de produção e de staging.
- [ ] Token classic `read:packages` do GHCR criado (e a data de renovação
      anotada); `docker login ghcr.io` do usuário de deploy.
- [ ] Buckets R2: fotos de produção e de staging (com CORS); backup de
      produção e de staging (lifecycle + Bucket Lock); tokens separados.
- [ ] Chave age gerada (privada no gerenciador de senhas); heartbeats criados
      (operação 1 min, backup 1 dia); monitores de uptime.
- [ ] Segredos gerados por ambiente: senha do Postgres e do Redis
      (`openssl rand -hex`), `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`, token
      da IA, `WEBHOOK_SECRETS_KEY`, `RATE_LIMIT_FORWARDER_SECRET` (igual ao da
      web), `DOCS_PASSWORD`.
- [ ] **Staging**, no environment `staging` do Dokploy, projeto
      `trajetto-api`: Postgres → Redis (com o comando) → `trajetto-ai` →
      `trajetto-api` (com `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` só no primeiro
      boot) → `trajetto-backup` (com `BACKUP_RUN_NOW=true`), cada um com a
      conferência da [seção 8](#8-primeiro-deploy-na-ordem-com-conferências).
- [ ] Os três applicationIds e o App Name da API anotados (seção 7.10).
- [ ] Environment `staging` no GitHub (`DOKPLOY_URL`, `DOKPLOY_API_KEY`,
      `DOKPLOY_API_APPLICATION_ID`, `DOKPLOY_AI_APPLICATION_ID`,
      `DOKPLOY_BACKUP_APPLICATION_ID`, `SWARM_API_SERVICE`, SSH da
      conferência); `verify-rollout.sh` instalado e chave restrita.
- [ ] Um push em `staging` faz o deploy sozinho (IA → API → backup) e termina
      com "convergiu".
- [ ] Tag `stable` criada pelo _Run workflow_ (seção 8, "Produção", passo 1).
- [ ] **Produção**, no environment `production` do Dokploy, os mesmos cinco
      serviços com os valores de produção; vindo do Portainer, a
      [seção 24](#24-migrar-do-portainer-para-o-dokploy).
- [ ] Environment `production` no GitHub com **revisores obrigatórios**,
      _Deployment branches_ = `main`, os `DOKPLOY_*`, `SWARM_API_SERVICE` e SSH.
- [ ] PR `staging → main`, merge commit, aprovação: promoção verde.
- [ ] Job de migrations ligado ([seção 15](#15-migrations)) e, depois de um
      promote com `[release-migrations] ok`, `RUN_MIGRATIONS_ON_BOOT=false` em
      produção.
- [ ] `HEALTHCHECK_PING_URL` chegando 1/min; backup noturno chegando; um
      ensaio de restore.
- [ ] Certificado A1 do comprovante (`PROOF_SIGNING_*`) em produção;
      `proof_signing` em `/health/metrics`.
- [ ] Web promovida **depois** da API (`trajetto-ui/docs/deploy.md`).
- [ ] Revogar a `ANTHROPIC_API_KEY` antiga do histórico; apagar os secrets
      obsoletos (`DOKPLOY_COMPOSE_ID`, `PORTAINER_*`, `STAGING_ENABLED`).

## 26. Os três repositórios juntos

> Esta seção é **a mesma** nos três manuais de deploy:
> [`trajetto-api/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-api/blob/main/docs/deploy.md),
> [`trajetto-ui/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-ui/blob/main/docs/deploy.md)
> e
> [`trajetto-mobile/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-mobile/blob/main/docs/deploy.md).
> Mudou aqui, mude nos outros dois. O detalhe de cada passo fica no manual do
> repositório dono dele.

### Quem é quem

|                             | API (`Trajetto-Organization/trajetto-api`)                                                                                                                                                                                                               | Web (`Trajetto-Organization/trajetto-ui`)                                                                                           | App (`Trajetto-Organization/trajetto-mobile`)                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Artefato                    | imagens `trajetto-api`, `trajetto-ai` e `trajetto-backup` em `ghcr.io/trajetto-organization/`                                                                                                                                                            | imagem `ghcr.io/trajetto-organization/trajetto-ui`                                                                                  | APK/AAB (EAS Build) e OTA (EAS Update)                                                                          |
| Onde roda                   | Dokploy, projeto `trajetto-api` de cada environment (`staging` e `production`): as Applications `trajetto-api` (2 réplicas, com domínio), `trajetto-ai` e `trajetto-backup` (sem domínio), puxando as imagens do GHCR, e os Databases PostgreSQL e Redis | Dokploy, projeto `trajetto-ui` de cada environment: a Application `trajetto-ui`, puxando a imagem do GHCR                           | no celular do motorista (APK interno em staging, Play Store em produção)                                        |
| Nome no Dokploy / EAS       | App Names `trajetto-api-staging` e `trajetto-api-production` (e `trajetto-ai-*`, `trajetto-backup-*`, `trajetto-postgres-*`, `trajetto-redis-*`)                                                                                                         | Application `trajetto-ui` no projeto `trajetto-ui` de cada environment (App Names `trajetto-ui-staging` e `trajetto-ui-production`) | perfis, ambientes e canais `staging` e `production`                                                             |
| Como o pipeline publica     | API do Dokploy (`.github/scripts/dokploy-deploy.mjs`): `application.deploy` de cada Application, na ordem IA → API → backup, acompanhando cada deployment até o fim                                                                                      | webhook de deploy da Application (`.github/scripts/dokploy-webhook.mjs`), depois espera o `/build-id.json`                          | `eas update` e `eas build`                                                                                      |
| Secrets de deploy no GitHub | environments `staging` e `production`: `DOKPLOY_URL`, `DOKPLOY_API_KEY`, `DOKPLOY_API_APPLICATION_ID` (obrigatórios) e `DOKPLOY_AI_APPLICATION_ID`, `DOKPLOY_BACKUP_APPLICATION_ID` (opcionais); variável `SWARM_API_SERVICE`                            | environment `staging`: `DOKPLOY_STAGING_WEBHOOK_URL`; environment `production`: `DOKPLOY_PRODUCTION_WEBHOOK_URL`                    | `EXPO_TOKEN` (repositório) e `EXPO_UPDATE_PRIVATE_KEY` (environments `staging` e `production`)                  |
| Sem os secrets              | move as tags e pula o deploy com `::notice::`                                                                                                                                                                                                            | move as tags e pula o deploy com aviso                                                                                              | termina verde com aviso, sem publicar                                                                           |
| De staging para produção    | promove por digest a imagem `sha-<7 do commit>` (tag `staging` → `stable`), sem rebuild                                                                                                                                                                  | igual à API, e exige o marcador `staged-<7 do commit>` no mesmo digest                                                              | promove o **commit** verde em staging (a URL da API é embutida no build, então o artefato não pode ser o mesmo) |
| Rollback                    | _Run workflow_ do `deploy.yml` com `image_tag=sha-<7>`                                                                                                                                                                                                   | _Run workflow_ do `deploy.yml` com `image_tag=sha-<7>`                                                                              | `ota-rollback.yml` (republica um grupo de OTA)                                                                  |

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
| API (REST e Socket.IO) | `https://trajettoapi-staging.thorsolucoes.com.br`                                 | `https://trajettoapi.thorsolucoes.com.br`                          |
| Serviço de IA          | sem endereço público: `http://trajetto-ai-staging:8080` na rede `dokploy-network` | sem endereço público: `http://trajetto-ai-production:8080`         |

### O que precisa casar entre os repositórios

| Valor                             | API (Environment das Applications do projeto `trajetto-api`)                                                                                    | Web (Environment da Application)                                                         | App (ambiente EAS)                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| URL pública da API                | o host na aba _Domains_ da Application `trajetto-api` e `API_HTTP_REQUEST` (a URL)                                                              | `HTTP_REQUEST` (chamadas do servidor da web) e `PUBLIC_API_URL` (chamadas do navegador)  | `EXPO_PUBLIC_API_URL`                                                                 |
| Socket.IO                         | o mesmo host da API, com WebSocket liberado na borda                                                                                            | `PUBLIC_SOCKET_URL` (vazia = `PUBLIC_API_URL`)                                           | o socket usa `EXPO_PUBLIC_API_URL`                                                    |
| Origem da web                     | `HTTP_REQUEST` = a origem da web do ambiente (única origem do CORS e do Socket.IO, base dos links)                                              | `METADATA_BASE`                                                                          | `EXPO_PUBLIC_WEB_APPLICATION_URL` (links de Privacidade e Termos)                     |
| Limite de tentativas por IP       | `RATE_LIMIT_FORWARDER_SECRET`                                                                                                                   | `RATE_LIMIT_FORWARDER_SECRET`, **o mesmo valor**                                         | —                                                                                     |
| Captcha (Turnstile)               | `TURNSTILE_SECRET_KEY` (o mesmo widget da web) e `TURNSTILE_REQUIRED`                                                                           | `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`                                            | —                                                                                     |
| Fotos no R2                       | `R2_*` (um bucket por ambiente)                                                                                                                 | `CSP_STORAGE_ORIGINS` libera a origem do bucket; o CORS do bucket libera a origem da web | envia direto à URL pré-assinada que a API devolve (sem configuração)                  |
| IA (leitura de fotos)             | `AI_LOCAL_TOKEN` na `trajetto-api` = `AI_TOKEN` na `trajetto-ai` (o mesmo valor, um por ambiente) e `AI_LOCAL_URL=http://<App Name da IA>:8080` | nenhuma variável: a IA chega pela API                                                    | nenhuma variável                                                                      |
| Push (FCM)                        | nenhuma: a API chama a Expo Push API                                                                                                            | —                                                                                        | `GOOGLE_SERVICES_JSON` (arquivo secreto no EAS) e a chave FCM V1 em `eas credentials` |
| Rastreamento em segundo plano     | —                                                                                                                                               | `BACKGROUND_TRACKING`                                                                    | `EXPO_PUBLIC_BACKGROUND_TRACKING` (as duas ligam juntas)                              |
| Versão do app                     | `MIN_MOBILE_CONTRACT` e `MOBILE_STORE_URL`                                                                                                      | —                                                                                        | `CLIENT_CONTRACT` em `utils/client-version.ts`                                        |
| Gate de rotas da web              | `/docs/json` com `DOCS_USER` e `DOCS_PASSWORD`                                                                                                  | secrets `API_DOCS_URL`, `DOCS_USER`, `DOCS_PASSWORD` no environment `production`         | —                                                                                     |
| Checkout entre repositórios no CI | `CLIENT_REPOS_READ_TOKEN` (lê a web e o app)                                                                                                    | `API_REPO_READ_TOKEN` (lê a API)                                                         | `API_REPO_READ_TOKEN` (lê a API)                                                      |

Segredos nunca são compartilhados entre staging e produção. Cada variável
está detalhada no `docs/variaveis-de-ambiente.md` do repositório que a lê.

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
   `read:packages` do GHCR (o mesmo serve para as quatro imagens).
3. **Contas externas:** buckets R2 (fotos e backup, um de cada por
   ambiente, CORS das fotos com a origem da web), widgets do Turnstile por
   ambiente, Meta e Resend (de teste em staging), heartbeats de monitoramento.
4. **API de staging** (manual da API), no projeto `trajetto-api` do
   environment `staging`, nesta ordem e conferindo cada um: Databases
   **PostgreSQL** e **Redis**; Application **`trajetto-ai`** (com o
   `AI_TOKEN`); Application **`trajetto-api`** (com `AI_LOCAL_TOKEN` igual,
   `AI_LOCAL_URL` apontando para a IA e as URLs do banco e do Redis);
   Application **`trajetto-backup`**. Confira `/health/readiness` e, como
   MASTER na web, _Sistema → Provedores_. Depois, os secrets `DOKPLOY_*` e a
   variável `SWARM_API_SERVICE` no environment `staging` da API.
5. **Web de staging** (Application `trajetto-ui` do projeto `trajetto-ui` no
   environment `staging`, manual da web): imagem
   `:staging`, `HTTP_REQUEST` e `PUBLIC_API_URL` apontando para a API de
   staging, o mesmo `RATE_LIMIT_FORWARDER_SECRET` da API de staging, e o
   `HTTP_REQUEST` da API de staging igual à origem da web de staging. Depois,
   `DOKPLOY_STAGING_WEBHOOK_URL` e `METADATA_BASE_STAGING` no environment
   `staging` da web.
6. **App de staging** (manual do app): ambiente EAS `staging` com
   `EXPO_PUBLIC_API_URL` = API de staging e
   `EXPO_PUBLIC_WEB_APPLICATION_URL` = web de staging; `EXPO_TOKEN` no
   GitHub; um push em `staging` gera o APK de staging.
7. **Produção, na mesma ordem:** a tag `stable` da API criada antes (_Run
   workflow_ do `deploy.yml` da API com `image_tag=sha-<7>`, enquanto o
   environment `production` ainda não tem os secrets do Dokploy); as mesmas
   cinco peças no projeto `trajetto-api` do environment `production`, já em
   `:stable`; os secrets de produção e o PR `staging → main` da API; depois a
   Application `trajetto-ui` do environment `production` e o PR da web; por último o PR do
   app, que gera o AAB de produção apontando para a API de produção.

### Ordem de cada release

**API → web → app**, sempre:

1. **API:** merge `staging → main`, aprovação, convergência das réplicas.
   Mudanças de rota seguem expandir e depois contrair: a API nunca tira uma
   rota que a web ou o app em produção ainda chamam.
2. **Web:** só depois. O gate de rotas do promote falha se a API de
   produção ainda não serve alguma rota que o build da web chama.
3. **App:** por último. Se o app passou a enviar algo novo, o
   `CLIENT_CONTRACT` (`utils/client-version.ts`) sobe e a API compatível já
   precisa estar em produção; `MIN_MOBILE_CONTRACT` só sobe depois que a OTA
   (ou o binário) com o contrato novo estiver publicada e os contratos
   antigos sumirem dos logs da API.
