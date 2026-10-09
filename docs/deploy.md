# Deploy da API — staging e produção

> Documento de referência do caminho de um commit até a produção, e da
> operação do que está no ar: os workflows do GitHub Actions, as imagens no
> GHCR, a stack no Dokploy (Docker Swarm), o serviço de IA, o banco, o Redis,
> o backup, a borda (Cloudflare e Traefik), as migrations, o rollback e os
> alertas. Vive dentro do `trajetto-api` porque descreve arquivos deste
> repositório (`.github/workflows/`, `compose.production.yaml`, `infra/`) e
> precisa mudar junto com eles.
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
5. [Por que um app Compose (Docker Stack) e não Applications avulsas](#5-por-que-um-app-compose-docker-stack-e-não-applications-avulsas)
6. [Preparar o servidor (uma vez)](#6-preparar-o-servidor-uma-vez)
7. [Criar o app de produção no Dokploy](#7-criar-o-app-de-produção-no-dokploy)
8. [Criar o app de staging no Dokploy](#8-criar-o-app-de-staging-no-dokploy)
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
23. [Recursos da VPS](#23-recursos-da-vps)
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
                                     ├─ build ÚNICO das 3 imagens ─▶ GHCR  sha-<sha>  (imutável)
                                     └─ tag `staging` movida por digest ─▶ Dokploy (stack de staging) ─▶ convergência

PR staging → main ──▶ deploy.yml: a mesma validação + "o head do PR tem imagem de staging?"

merge em main ──▶ deploy.yml: PROMOÇÃO (sem build)
                  ├─ resolve o build do commit mergeado (2º pai do merge commit)
                  ├─ migrations (job único, opcional) ─▶ tag `stable` movida por digest
                  ├─ Dokploy (stack de produção) ─▶ convergência   [aprovação do environment production]
                  └─ release (tag semver, CHANGELOG, GitHub Release)

Run workflow (manual) ──▶ a mesma promoção com uma tag antiga: o botão de ROLLBACK
```

Princípios que não mudam:

- **Uma imagem por serviço para os dois ambientes, construída uma vez e
  promovida por digest** (decisão 12.2). A API lê toda a configuração em
  tempo de execução: staging e produção diferem só no Environment do app no
  Dokploy. O que o staging validou é, byte a byte, o que a produção roda.
- **Três imagens**, todas construídas no mesmo job e promovidas juntas:

  | Imagem                                          | De onde                                     | Para quê                                |
  | ----------------------------------------------- | ------------------------------------------- | --------------------------------------- |
  | `ghcr.io/trajetto-organization/trajetto-api`    | `Dockerfile`                                | a API (HTTP, Socket.IO, workers, crons) |
  | `ghcr.io/trajetto-organization/trajetto-ai`     | `infra/ai-ocr/Dockerfile` (stage `runtime`) | o OCR local das leituras de IA          |
  | `ghcr.io/trajetto-organization/trajetto-backup` | `infra/backup/Dockerfile`                   | o backup noturno cifrado para o R2      |

- **Tags**:

  | Tag                           | Quem cria/move                               | Muda?                                   |
  | ----------------------------- | -------------------------------------------- | --------------------------------------- |
  | `sha-<7 primeiros do commit>` | o build de cada push em `staging`            | **nunca** (imutável)                    |
  | `staging`                     | o job `deploy-staging`, por digest           | a cada push em `staging`                |
  | `stable`                      | o job `promote-production`, por digest       | a cada promoção ou rollback             |
  | `main-<sha>`                  | builds antigos, de antes da branch `staging` | nunca; aceitos só como alvo de rollback |

  Não existem `latest`, `main` nem `pr-*`. A stack de produção roda `stable`;
  a de staging, `staging`.

- **O Dokploy dizer `done` não é convergência.** O Dokploy roda
  `docker stack deploy` sem esperar: `done` quer dizer que o Swarm **aceitou**
  as specs. Uma imagem que falha no healthcheck é revertida pelo próprio Swarm
  (`failure_action: rollback`) e a versão antiga continua no ar. Por isso todo
  deploy tem um passo seguinte que espera o estado real
  ([seção 14](#14-conferir-a-convergência)).
- **Antes de o Dokploy existir, nada quebra.** Sem os secrets do Dokploy nos
  environments do GitHub, os jobs movem as tags (`staging`, `stable`) e pulam
  o deploy com um aviso (`::notice::`). Configuração parcial (um secret sim,
  outro não) falha o job, para não parecer "ainda não configurado".

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
   commit do head já tem imagem `sha-<sha>` (espera até 30 min, porque o PR
   costuma abrir enquanto o staging ainda constrói o mesmo commit).
5. **Merge com "Create a merge commit".** Nunca _squash_ nem _rebase_: os dois
   criam um commit que o staging nunca construiu, e a promoção falha de
   propósito ("não passou pelo pipeline de staging"). O merge commit também
   preserva os SHAs que a baseline do gitleaks usa.
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

| Job            | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`     | serviço `redis:7-alpine` (um teste unitário do adapter do Socket.IO precisa dele); checkout com histórico completo; os repositórios irmãos (`trajetto-fleet-manager-ui` e `trajetto-fleet-manager-mobile`, na mesma branch quando ela existe lá) para o contrato de rotas, se o secret `CLIENT_REPOS_READ_TOKEN` existir; `audit-ci` (CRITICAL de produção); Prettier; `prisma generate`; `tsc`; unitários com piso de cobertura; publica `coverage-<sha>` |
| `secrets`      | gitleaks em todo o histórico, imagem fixada por digest                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ai-ocr`       | `docker build --target test infra/ai-ocr` (o pytest roda dentro da imagem)                                                                                                                                                                                                                                                                                                                                                                                 |
| `ai-local-e2e` | só em _Run workflow_: o contrato da API contra o contêiner real de IA (`tests/ai-local`)                                                                                                                                                                                                                                                                                                                                                                   |

Sem E2E, sem imagem, sem deploy: a pergunta é só "esse código pode ir para o
staging?".

### `.github/workflows/deploy.yml` — Pipeline (staging → produção)

| Gatilho                      | Jobs que rodam                                                    |
| ---------------------------- | ----------------------------------------------------------------- |
| push em `staging`            | `test`, `ai-ocr`, `secrets` → `build-and-push` → `deploy-staging` |
| pull request para `main`     | `test`, `ai-ocr`, `secrets`, `staging-image`                      |
| push em `main` (o merge)     | `promote-production` → `release`                                  |
| _Run workflow_ (`image_tag`) | `promote-production`                                              |

| Job                  | Detalhes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`               | serviços `postgres:16-alpine` e `redis:7-alpine`; checkout completo (o teste de rotas aposentadas compara com `origin/main`); `yarn install --frozen-lockfile` com cache; `audit-ci`; `lint:check`; `prisma:generate`; `typecheck`; `test:coverage` (o piso de cobertura); publica `coverage-<sha>`; `test:e2e` (um banco por arquivo).                                                                                                                                                                                                |
| `ai-ocr`             | o pytest do serviço de IA dentro da imagem (`--target test`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `secrets`            | o mesmo gitleaks do `ci.yml` (mesma imagem, flags, `.gitleaksignore`). Nenhuma imagem é construída antes dele passar.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `build-and-push`     | só em push para `staging`, depois dos três acima. Buildx com cache do GitHub (um escopo por imagem); publica `sha-<sha>` das três imagens com SBOM e proveniência (`provenance: mode=max`); varre as três por digest com Trivy (CRITICAL corrigível; só relata até `IMAGE_SCAN_ENFORCE=true`). Exporta os três digests.                                                                                                                                                                                                                |
| `deploy-staging`     | environment `staging`; um por vez (`concurrency: deploy-staging`, nunca cancelado no meio). Confere se o run ainda é o head de `staging` (runs terminam fora de ordem; o mais velho não volta a tag); move `staging` das três imagens para os digests deste run; se o Dokploy estiver configurado, pede o deploy (`.github/scripts/dokploy-deploy.mjs`) e espera a convergência.                                                                                                                                                       |
| `staging-image`      | só no PR: espera (até 30 min) as três imagens `sha-<head do PR>` existirem. Sem elas o merge não teria o que promover.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `promote-production` | environment `production` (revisores obrigatórios = aprovação); um por vez (`concurrency: promote-production`). Resolve o build (2º pai do merge commit; fast-forward = o próprio commit; _Run workflow_ = a tag digitada), valida o formato (`sha-<hex>` ou `main-<hex>`), confere que a imagem existe no GHCR, compara com o que o staging roda (só informa), roda as migrations como job se `MIGRATIONS_VIA_JOB=true`, move `stable` das três imagens por digest, pede o deploy ao Dokploy (se configurado) e espera a convergência. |
| `release`            | depois da promoção, só no push em `main`: `semantic-release` cria a tag, o `CHANGELOG.md` (commit com `[skip ci]`) e o GitHub Release.                                                                                                                                                                                                                                                                                                                                                                                                 |

Permissões: o workflow inteiro tem `contents: read`; só `build-and-push`,
`deploy-staging` e `promote-production` pedem `packages: write`;
`staging-image` pede `packages: read`; `release` pede `contents`, `issues` e
`pull-requests: write`. Todas as actions são fixadas por SHA de commit, com a
versão em comentário (o teste `supply-chain.test.ts` recusa uma tag solta).

O deploy é uma chamada à API do Dokploy (`POST /api/compose.deploy` com
`x-api-key`) feita por `.github/scripts/dokploy-deploy.mjs` (testado contra um
Dokploy falso em `tests/unitaires/lifecycle/dokploy-deploy.test.ts`). O script acompanha
o deployment que ele criou e falha o run quando o Dokploy **não consegue**
fazer o deploy (compose que não renderiza, variável obrigatória faltando,
registry inacessível, chave ou id errados). Por isso a API usa a chave de API
e o id do app, e não o webhook de redeploy (que responde assim que enfileira e
nunca diz se deu certo). A web, que é uma Application de um serviço só, usa o
webhook dela (`trajetto-ui/docs/deploy.md`).

## 4. A topologia no servidor

```
navegador / app / ERP ─TLS─▶ Cloudflare (proxy) ─▶ Traefik do Dokploy (contêiner dokploy-traefik, :443)
                                                     │  rede dokploy-network (overlay, externa)
                         ┌───────────────────────────┼──────────────────────────────┐
                stack da API (app Compose, Swarm)                       Application da web (trajetto-ui)
   api ×2 ──┬── rede interna `backend` (overlay, internal: sem saída) ──┬── trajetto-database (Postgres 16, volume nomeado)
            │                                                          ├── trajetto-redis (Redis 7, senha, sem persistência)
            │                                                          ├── trajetto-ai (OCR, sem porta, sem saída)
            │                                                          └── trajetto-backup (pg_dump → age → R2)
            └── rede `edge` = dokploy-network (Traefik + saída para Meta, Resend, R2)
```

Os serviços do `compose.production.yaml`:

| Serviço             | Imagem                                        | Porta                  | Redes             | Réplicas                              | Health                                                                             | Limites                                                      |
| ------------------- | --------------------------------------------- | ---------------------- | ----------------- | ------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `api`               | `trajetto-api:${API_IMAGE_TAG:-stable}`       | 3333 (só pelo Traefik) | `backend`, `edge` | 2, rolling `start-first` com rollback | liveness no Swarm (`/health/liveness`), readiness no Traefik (`/health/readiness`) | memória `API_MEMORY_LIMIT` (1024M), heap `API_HEAP_MB` (768) |
| `trajetto-database` | `${POSTGRES_IMAGE:-postgres:16-alpine}`       | 5432 (só `backend`)    | `backend`         | 1, `stop-first`, preso no manager     | `pg_isready`                                                                       | sem teto, de propósito                                       |
| `trajetto-redis`    | `redis:7-alpine`                              | 6379 (só `backend`)    | `backend`         | 1, `stop-first`                       | `redis-cli -a … ping`                                                              | 512M (dados 256 MB, `allkeys-lru`)                           |
| `trajetto-ai`       | `trajetto-ai:${AI_IMAGE_TAG:-stable}`         | 8080 (só `backend`)    | `backend`         | `AI_REPLICAS` (1)                     | `GET /health` (200 depois do aquecimento)                                          | `AI_MEMORY_LIMIT` (1024M), `AI_CPUS` (2)                     |
| `trajetto-backup`   | `trajetto-backup:${BACKUP_IMAGE_TAG:-stable}` | —                      | `backend`, `edge` | 1                                     | —                                                                                  | 256M                                                         |

Todos com log `json-file` rotacionado e `restart_policy: any` sem limite de
tentativas (um serviço com estado não tem para onde fazer failover; desistir
só faria a queda durar mais que a causa).

## 5. Por que um app Compose (Docker Stack) e não Applications avulsas

No Dokploy existem dois jeitos de subir um contêiner: uma **Application**
(um serviço, uma imagem) e um **Compose** (um arquivo com vários serviços). A
API sobe como **um app Compose do tipo Docker Stack** apontando para o
`compose.production.yaml`. Cada serviço desse arquivo é o equivalente a uma
Application — a API puxando `trajetto-api` do GHCR, a IA puxando
`trajetto-ai`, o backup puxando `trajetto-backup`, o Postgres e o Redis —, mas
criados juntos, já conectados, com as variáveis certas em cada um. Os motivos:

- **A rede interna.** Postgres, Redis e `trajetto-ai` ficam só na rede
  `backend` da stack (`internal: true`): nada de fora — nem o Traefik, nem a
  web, nem outro app do host — alcança a porta do banco ou o OCR. Applications
  avulsas se falam pela `dokploy-network`, compartilhada por tudo do host.
- **As variáveis ligadas.** O mesmo `AI_LOCAL_TOKEN` vira o `AI_TOKEN` do
  serviço de IA e o token da API; `REDIS_PASSWORD` vira a senha do Redis e o
  `REDIS_URL` da API; as `POSTGRES_*` viram o banco, a `DATABASE_URL` (com os
  tetos de runtime), a `MIGRATION_DATABASE_URL` e as `PG*` do backup. Um valor,
  definido uma vez.
- **O bloco `deploy:`** (duas réplicas, rolling `start-first` com rollback
  automático, limites de memória, banco preso no manager) só vale no modo
  Stack. No modo Docker Compose o `docker compose up` ignora quase tudo isso.
- **A tag resolvida a cada deploy.** `docker stack deploy` resolve a tag para
  o digest atual. No modo Compose, uma `stable` já presente no host **não é
  puxada de novo**: o promote moveria a tag e o deploy terminaria verde com a
  imagem antiga.
- **As ferramentas dependem disso.** O job de migrations e a conferência do
  rollout procuram `<app>_api` e `<app>_backend`; os roteadores do Traefik
  estão nos labels do arquivo, com o prefixo de cada stack.

O mesmo vale para o serviço de IA: no Dokploy ele aparece como o serviço
`<app>_trajetto-ai` **dentro** do app Compose da API, e não como uma
Application separada — é isso que o mantém fora de qualquer rede
compartilhada e com o token entregue pelo próprio compose.

**Não** use a aba _Domains_ do Dokploy nesse app (os roteadores já estão nos
labels) nem a função _Databases_ do Dokploy para o Postgres/Redis da API (ver
[seção 10](#10-postgres-e-redis)).

## 6. Preparar o servidor (uma vez)

1. **VPS** amd64 com Docker (as imagens são `linux/amd64`; numa VPS ARM seria
   preciso build multi-arquitetura). Tamanho: [seção 23](#23-recursos-da-vps).
2. **Instalar o Dokploy** (o instalador inicia o Swarm e sobe o Traefik nas
   portas 80/443). Conferir:
   ```sh
   docker exec dokploy-traefik traefik version        # v3.x
   docker network ls | grep dokploy-network            # a rede do Traefik
   grep -A3 certificatesResolvers /etc/dokploy/traefik/traefik.yml   # o nome do resolver
   ```
   Se a rede ou o resolver tiverem outro nome, use `TRAEFIK_NETWORK` e
   `TRAEFIK_CERTRESOLVER` no Environment dos apps.
3. **Traefik**: aplicar `infra/traefik/` (redirect :80→:443, `readTimeout` de
   120 s no `websecure`, TLS ≥ 1.2) — passo a passo em
   `infra/traefik/README.md`.
4. **DNS na Cloudflare** (proxy laranja): `API_HOST` de produção (hoje
   `trajettoapi.thorsolucoes.com.br`) e o de staging (ex.
   `trajettoapi-staging.thorsolucoes.com.br`) apontando para o IP da VPS;
   _SSL/TLS_ em **Full (strict)**, _Minimum TLS Version_ 1.2, _Always Use
   HTTPS_ ligado. Detalhes da borda na [seção 11](#11-domínios-tls-e-a-borda).
5. **Registry**: as imagens do GHCR são privadas. Crie um token do GitHub
   (_classic_, só `read:packages`, de uma conta com acesso à organização) e,
   no host, `docker login ghcr.io -u <usuário> --password-stdin`; ou cadastre
   em _Dokploy → Settings → Registry_ (`ghcr.io`, usuário, o token). O
   `docker stack deploy` repassa a credencial aos nós.
6. **Acesso do Dokploy ao repositório** (de onde ele lê o compose): em
   _Settings → Git_ (o nome do menu varia entre versões), cadastre o provedor
   **GitHub** criando a GitHub App que o Dokploy propõe e instale-a na
   organização `Trajetto-Organization` com acesso **só** a `trajetto-api`
   (leitura). A web não precisa: é uma Application que puxa a imagem pronta do
   GHCR. Sem isso o primeiro deploy falha no
   clone. Alternativa sem acesso ao GitHub: fonte **Raw**, colando o compose
   no app — e então todo PR que mudar `compose.production.yaml` exige colar a
   versão nova no Dokploy **antes** do deploy que precisa dela (anote no PR).
7. **Usuário de deploy** no host, no grupo `docker`, para o job de migrations e
   a conferência do rollout ([seções 14](#14-conferir-a-convergência) e
   [15](#15-migrations)). O SSH do host precisa aceitar conexões dos runners
   do GitHub.

## 7. Criar o app de produção no Dokploy

1. _Project_ → _Create Service_ → **Compose** → tipo **Docker Stack**.
   Nome do app: **`trajetto`**. O nome do app é o nome da stack no Swarm: os
   serviços se chamam `trajetto_api`, `trajetto_trajetto-database` etc., e o
   job de migrations e a conferência do rollout usam esse nome (com
   `trajetto`, os padrões dos scripts servem sem configurar nada).
2. **Fonte**: Git (o provedor da seção 6), repositório `trajetto-api`, branch
   **`main`**, caminho `compose.production.yaml`. **Auto Deploy desligado**:
   quem decide o deploy é o workflow. O Dokploy lê o compose do `main` no
   momento do deploy; mudanças no compose seguem expandir/contrair como as
   migrations (uma imagem anterior precisa subir com o compose novo).
3. **Não** cadastre nada na aba _Domains_.
4. **Environment**: as variáveis de produção. A lista completa, com o valor de
   cada ambiente, está em [`variaveis-de-ambiente.md`](./variaveis-de-ambiente.md);
   o mínimo para o compose renderizar e a API subir:

   ```
   APP_ENV=production
   ROUTER_PREFIX=trajetto
   API_HOST=trajettoapi.thorsolucoes.com.br
   POSTGRES_VOLUME=trajetto_postgres_data
   POSTGRES_HOST=trajetto-database
   POSTGRES_PORT=5432
   POSTGRES_USERNAME=…            POSTGRES_PASSWORD=…        POSTGRES_DATABASE=…
   REDIS_HOST=trajetto-redis
   REDIS_PORT=6379
   REDIS_PASSWORD=…               (openssl rand -hex 32)
   HTTP_REQUEST=https://www.intrajetto.com
   API_HTTP_REQUEST=https://trajettoapi.thorsolucoes.com.br
   JWT_SECRET=…                   JWT_SECRET_REFRESH_TOKEN=…   (dois valores diferentes, openssl rand -base64 48)
   MASTER_USER_EMAIL=…            MASTER_USER_INITIAL_PASSWORD=…
   UPLOAD_STORAGE_TYPE=r2
   UPLOAD_LOCAL_PATH=./tmp
   R2_ACCOUNT_ID=…  R2_BUCKET_NAME=…  R2_ACCESS_KEY_ID=…  R2_SECRET_ACCESS_KEY=…
   RATE_LIMIT_FORWARDER_SECRET=…  (o mesmo valor da web)
   AI_LOCAL_TOKEN=…               (openssl rand -hex 32)
   BACKUP_R2_ACCOUNT_ID=…  BACKUP_R2_BUCKET=…  BACKUP_R2_ACCESS_KEY_ID=…  BACKUP_R2_SECRET_ACCESS_KEY=…
   BACKUP_AGE_RECIPIENT=age1…     BACKUP_HEARTBEAT_URL=…
   ```

   Mais as de provedores (Meta, Resend, Turnstile), de monitoramento
   (`HEALTHCHECK_PING_URL`), `WEBHOOK_SECRETS_KEY`, `DOCS_*` e o certificado
   do comprovante (`PROOF_SIGNING_*`). Os obrigatórios do compose
   (`${VAR:?...}`) derrubam o deploy com a mensagem certa quando faltam.

5. **Primeiro deploy**: a tag `stable` só existe depois da primeira promoção.
   Enquanto não existir, ponha no Environment `API_IMAGE_TAG=sha-<sha>`,
   `AI_IMAGE_TAG=sha-<sha>` e `BACKUP_IMAGE_TAG=sha-<sha>` (um build verde de
   staging); depois da primeira promoção, apague as três. Num banco novo,
   `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` só nesse primeiro boot (volte para
   `false` em seguida). Vindo do Portainer, siga a [seção 24](#24-migrar-do-portainer-para-o-dokploy).
6. Clique em **Deploy** e confira:
   ```sh
   docker service ls --filter name=trajetto_          # api 2/2, database 1/1, redis 1/1, ai 1/1, backup 1/1
   curl -s https://trajettoapi.thorsolucoes.com.br/health/readiness   # 200
   ```
7. Anote o **id do app** (aparece na URL do app no painel): é o
   `DOKPLOY_COMPOSE_ID` do environment `production` no GitHub.

## 8. Criar o app de staging no Dokploy

Igual ao de produção, com estas diferenças:

|                                                                                                    | Produção                                          | Staging                                                                                                     |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Nome do app (= stack)                                                                              | `trajetto`                                        | `trajetto-staging`                                                                                          |
| Branch da fonte Git                                                                                | `main`                                            | **`staging`** (o compose novo chega primeiro em staging)                                                    |
| `APP_ENV`                                                                                          | `production`                                      | `staging` (a imagem é `NODE_ENV=production`; `APP_ENV` diferencia)                                          |
| `ROUTER_PREFIX`                                                                                    | `trajetto`                                        | `trajetto-staging` (único por stack; igual derrubaria o roteador do outro)                                  |
| `API_HOST`                                                                                         | `trajettoapi.thorsolucoes.com.br`                 | um host próprio, ex. `trajettoapi-staging.thorsolucoes.com.br`                                              |
| `POSTGRES_VOLUME`                                                                                  | `trajetto_postgres_data`                          | outro nome, ex. `trajetto-staging_postgres_data` (o mesmo volume = dois Postgres no mesmo disco)            |
| `API_IMAGE_TAG`, `AI_IMAGE_TAG`, `BACKUP_IMAGE_TAG`                                                | `stable` (padrão; não defina)                     | **`staging`**                                                                                               |
| Segredos (`JWT_*`, `REDIS_PASSWORD`, `POSTGRES_PASSWORD`, `AI_LOCAL_TOKEN`, `WEBHOOK_SECRETS_KEY`) | próprios                                          | **outros**; nunca compartilhe entre ambientes                                                               |
| `R2_*`                                                                                             | bucket de produção                                | **bucket de staging** (com CORS para o host da web de staging)                                              |
| `BACKUP_*`                                                                                         | bucket de backup                                  | um bucket de backup de staging (o compose exige nos dois: staging prova o caminho do backup)                |
| `META_WHATSAPP_*`, `RESEND_*`                                                                      | reais                                             | **de teste** (número de teste da Meta; Resend em domínio de teste): staging não fala com cliente de verdade |
| `HTTP_REQUEST`, `API_HTTP_REQUEST`                                                                 | origens de produção                               | as de staging                                                                                               |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                                                   | `false`                                           | `true` **só** no primeiro boot                                                                              |
| `RUN_MIGRATIONS_ON_BOOT`                                                                           | `false` quando o job de migrations estiver ligado | `true` (staging migra no boot; ver [seção 15](#15-migrations))                                              |
| `SOCKET_ADAPTER_KEY`                                                                               | vazio                                             | vazio (cada stack tem o próprio Redis)                                                                      |
| `AI_PROVIDER` / `AI_REPLICAS`                                                                      | `local` / `1`                                     | `local` / `1`, ou `none` / `0` para economizar a RAM do OCR num host compartilhado                          |
| `PROOF_SIGNING_*`                                                                                  | o A1 (e-CNPJ)                                     | vazio (os comprovantes saem sem assinatura e dizem isso)                                                    |

O id deste app é o `DOKPLOY_COMPOSE_ID` do environment `staging` no GitHub. A
variável `SWARM_API_SERVICE` do environment `staging` é `trajetto-staging_api`.

## 9. O serviço de IA (`trajetto-ai`)

A leitura de fotos (número e data do canhoto, odômetro) roda num serviço
próprio, dentro da mesma stack: RapidOCR sobre ONNX Runtime, só CPU, modelos
embutidos na imagem e conferidos por SHA-256 (o boot não precisa de rede).
Ele só transcreve; quem decide o que a foto diz é a API (ADR 0010; ver
[`arquitetura.md`](./arquitetura.md#ia-local)).

**Como é criado**: não é um app separado no Dokploy — é o serviço
`trajetto-ai` do `compose.production.yaml`, que sobe junto com a API no mesmo
deploy. A imagem `trajetto-ai` é construída no job `build-and-push` (do stage
`runtime`, depois de o pytest passar no stage `test`) e promovida junto com a
API (`staging` e `stable`).

**Como fica conectado**:

| Do lado da API (serviço `api`)                                 | Do lado da IA (serviço `trajetto-ai`)           | De onde vem                                                                  |
| -------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `AI_PROVIDER=local`                                            | —                                               | Environment do app (`local` é o padrão)                                      |
| `AI_LOCAL_URL=http://trajetto-ai:8080`                         | escuta na 8080                                  | fixo no compose (nome do serviço na rede `backend`)                          |
| `AI_LOCAL_TOKEN`                                               | `AI_TOKEN`                                      | **um valor só**, `AI_LOCAL_TOKEN` no Environment; o compose entrega aos dois |
| `AI_LOCAL_TIMEOUT_MS` (15 000), `AI_LOCAL_MAX_CONCURRENCY` (1) | `AI_MAX_QUEUE` (2), `OCR_THREADS` (= `AI_CPUS`) | Environment (opcionais)                                                      |

Passo a passo:

1. Gere o token: `openssl rand -hex 32` (32+ caracteres; o serviço recusa
   subir com menos).
2. Ponha `AI_LOCAL_TOKEN=<valor>` no Environment do app (um valor diferente
   em staging). Sem ele o compose nem renderiza.
3. Opcional: `AI_CPUS`, `AI_MEMORY_LIMIT`, `AI_MAX_QUEUE`, `AI_REPLICAS`
   (padrões 2, 1024M, 2, 1 — medidos: pico de 0,60–0,63 GiB e p95 de 3,1 s
   por foto a 2 CPU / 1 GiB).
4. Deploy. Confira `docker service ls` (`<app>_trajetto-ai 1/1`) e, logado
   como MASTER na web, _Sistema → Provedores_ (`GET /health/providers`): a
   linha "Leitura de fotos (trajetto-ai)" faz `GET /health` e um
   `POST /v1/read` vazio só para provar o token (401 = token diferente).
5. Ligue a IA por empresa no `/admin` (limite mensal
   `Business.ai_analysis_limit`; 0 desliga).

Isolamento: só a rede `backend` (sem Traefik, sem porta publicada, sem saída
para a internet), sistema de arquivos só leitura com `/tmp` em tmpfs,
`cap_drop: ALL`, usuário 10001 na imagem.

Comportamento sob carga e falha: o serviço lê uma foto por vez com uma fila
curta (`AI_MAX_QUEUE`); cheio (ou 10 s esperando), responde 503 `busy` e o
pedido volta para a fila do Postgres em 5–15 s sem gastar tentativa. Com o
serviço fora do ar (ou `AI_REPLICAS=0`) os pedidos esperam na fila; nada se
perde e a cota só é consumida quando a leitura acontece. `AI_PROVIDER=none`
desliga as leituras (registros marcados "não analisado").

Problemas comuns: toda leitura falha com 401 → `AI_LOCAL_TOKEN` diferente nos
dois lados (impossível pelo compose, possível com override manual); pedidos
parados em `PENDING` → serviço fora, `AI_REPLICAS=0` ou `AI_PROVIDER=none`;
`AI_PROVIDER=anthropic` → o boot falha com o motivo (o provedor externo foi
removido).

## 10. Postgres e Redis

Os dois vivem **na stack**, não na função _Databases_ do Dokploy: ficam só na
rede interna `backend`, com o volume do banco nomeado pelo Environment, o
backup lendo pela rede interna e as URLs montadas pelo próprio compose. Um
banco criado pelo Dokploy ficaria fora dessa rede (na `dokploy-network`,
compartilhada) e o compose teria de ser reescrito.

### Postgres (`trajetto-database`)

- **Volume com nome fixo**: `POSTGRES_VOLUME` (obrigatória) dá o nome do volume
  em vez de o Swarm prefixá-lo com o nome da stack. Produção usa o volume que
  já existe (`trajetto_postgres_data`); staging, outro.
- **Preso no manager** (`node.role == manager`): o volume é `local`, pertence a
  um nó. Se o Swarm ganhar um segundo manager, troque por um label do nó que
  tem o volume (`docker node update --label-add trajetto.db=true <nó>` **antes**
  do deploy e `node.labels.trajetto.db == true` no compose); sem o label a task
  fica Pending e, com stop-first, o banco sai do ar.
- **A API recusa banco vazio em produção**: o boot consulta
  `_prisma_migrations` e para com "Banco vazio em produção" se nenhuma
  migration foi aplicada (volume novo, stack renomeada, task reagendada). Numa
  instalação nova de verdade, `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` uma única
  vez. Em recuperação de desastre, restaure o dump **antes** de subir a API.
- **Imagem fixada**: ponha em `POSTGRES_IMAGE` o digest que roda hoje
  (`docker service inspect <stack>_trajetto-database --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'`).
  Com a tag flutuante, um deploy que resolva um `16-alpine` novo reinicia e
  atualiza o banco sem ninguém pedir.
- **Conexões**: cada réplica abre `connection_limit=10` + 1 da readiness.
  Mantenha `réplicas × 11 + migrations (2) + ferramentas` abaixo do
  `max_connections` (100 por padrão). Os parâmetros da URL estão em
  [`arquitetura.md`](./arquitetura.md#conexão-com-o-postgres).
- **Parada planejada**: `docker exec <contêiner do banco> psql -U $POSTGRES_USERNAME -d $POSTGRES_DATABASE -c 'CHECKPOINT'`
  antes (o desligamento cabe nos 60 s do `stop_grace_period`), e junte numa
  janela só toda mudança na spec do banco (imagem, placement, redes,
  `command:`), porque cada uma recria a task. `stop-first` fica como está:
  dois postmasters no mesmo PGDATA corrompem o banco.

#### Tuning (desligado até ser agendado)

O serviço roda com os defaults da imagem (`shared_buffers` 128MB, `work_mem`
4MB, `random_page_cost` 4). O compose traz um bloco `command:` **comentado**,
com os valores vindos do Environment (`PG_SHARED_BUFFERS`,
`PG_EFFECTIVE_CACHE_SIZE`, `PG_WORK_MEM`, `PG_MAINTENANCE_WORK_MEM`,
`PG_RANDOM_PAGE_COST`), e um tmpfs de `/dev/shm` também comentado (o Docker dá
64 MB, e um VACUUM ou CREATE INDEX paralelo falhou com "could not resize shared
memory segment" na medição de 10/2026). Ligá-los reinicia o Postgres: janela
combinada. Valores de partida pela RAM reservada ao banco:

| RAM para o Postgres | `PG_SHARED_BUFFERS` | `PG_EFFECTIVE_CACHE_SIZE` | `PG_WORK_MEM` | `PG_MAINTENANCE_WORK_MEM` |
| ------------------- | ------------------- | ------------------------- | ------------- | ------------------------- |
| 2 GB                | 512MB               | 1536MB                    | 8MB           | 128MB                     |
| 4 GB                | 1GB                 | 3GB                       | 16MB          | 256MB                     |
| 8 GB                | 2GB                 | 6GB                       | 32MB          | 512MB                     |

`PG_RANDOM_PAGE_COST=1.1` só em SSD/NVMe. `work_mem` vale por operação, por
conexão: com 2 réplicas × 10 conexões, 32MB vira centenas de MB num pico. O
bloco também liga `max_wal_size=2GB`, `log_min_duration_statement=1000` e
`log_lock_waits=on`. Sem o tmpfs, use `max_parallel_maintenance_workers=0`.

### Redis (`trajetto-redis`)

- **Senha obrigatória** (`REDIS_PASSWORD`, `openssl rand -hex 32`): qualquer
  contêiner que alcançasse o Redis poderia publicar nos canais do adapter do
  Socket.IO. A API recebe `REDIS_URL=redis://:<senha>@trajetto-redis:6379`
  montada pelo compose.
- **Nada durável**: sem RDB/AOF e sem volume (`--save ''`, `--appendonly no`),
  teto de 256 MB com `allkeys-lru`. Só guarda contadores de rate limit e o
  pub/sub do Socket.IO (ADR 0002); não precisa de backup nem de restore.
- `REDIS_ENFORCE_AUTH=false` só existe para o primeiro rollout a partir de uma
  API que falava com o Redis sem senha; numa stack nova não é necessário.

## 11. Domínios, TLS e a borda

```
navegador / app ──TLS──▶ Cloudflare (proxy laranja) ──▶ Traefik do Dokploy (VPS, :443) ──▶ API (rede dokploy-network)
                                                         │
                          web (Next) ◀────────────────────┘  (o servidor da web chama a API de volta)
```

**Roteamento**: os labels do serviço `api` criam o roteador
`${ROUTER_PREFIX}-api` com `Host(${API_HOST})`, entrypoint `websecure`,
certificado do resolver `${TRAEFIK_CERTRESOLVER:-letsencrypt}`, serviço na
porta 3333 com `passHostHeader` e health check `/health/readiness` a cada 10 s
(timeout 5 s). Sem cookie sticky: o socket é só WebSocket, e o adapter Redis
leva os eventos entre réplicas. Staging e produção no mesmo Traefik precisam
de `ROUTER_PREFIX` e `API_HOST` diferentes: dois roteadores com o mesmo nome
fazem o Traefik descartar o roteador ("defined multiple times").

> **Nenhum `-` dentro de `${VAR:?mensagem}` no compose.** O
> `docker stack deploy` lê o hífen como separador de valor padrão: a senha
> virava a literal `hex 32)`. O teste
> `tests/unitaires/lifecycle/compose-stack-render.test.ts` renderiza o compose
> pelo `docker stack config` e barra isso.

**Endereço do cliente** (o balde do rate limit de login, 2FA, recuperação de
senha, refresh e handshake do socket) — `RATE_LIMIT_TRUSTED_PROXY`:

| Valor        | Chave dos limites anônimos                                                                          | Quando usar                                |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `none`       | socket (o Traefik, na produção)                                                                     | só sem proxy nenhum                        |
| `xff`        | última entrada do `X-Forwarded-For`                                                                 | quando o Traefik/nginx **é** a borda       |
| `cloudflare` | `CF-Connecting-IP` **se** o par (última entrada do XFF) é da Cloudflare; senão o par, igual a `xff` | **produção e staging** (padrão do compose) |

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
  `RATE_LIMIT_EDGE_SECRET` e deploy.
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

| Onde                                                     | Sonda                                                    | Para quê                                                                                                                                                                                    |
| -------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Swarm (`healthcheck` do `api` e `HEALTHCHECK` da imagem) | `wget http://127.0.0.1:3333/health/liveness` a cada 30 s | **liveness**: o processo está vivo. Não toca dependência nenhuma: no Swarm, falhar aqui **destrói** a task; apontar para a readiness já fez um soluço do Postgres derrubar as duas réplicas |
| Traefik (labels)                                         | `GET /health/readiness` a cada 10 s, timeout 5 s         | **readiness**: pode receber tráfego. Banco fora → 503 → a réplica sai do balanceador e volta sozinha. Vira 503 durante o desligamento ordenado (12 s antes de fechar)                       |
| Swarm (`trajetto-ai`)                                    | `GET http://127.0.0.1:8080/health`                       | 200 só depois de carregar os dois perfis e ler a foto de aquecimento                                                                                                                        |
| Swarm (banco e Redis)                                    | `pg_isready`; `redis-cli -a … ping`                      |                                                                                                                                                                                             |
| Monitor externo                                          | `/health/readiness` da API e `/api/health` da web, 1/min | uptime ([seção 20](#20-alertas-e-monitoramento))                                                                                                                                            |

Outras rotas: `/health/metrics` (filas, workers, crons, pool, certificado) e
`/health/providers` (prontidão dos provedores), ambas só MASTER.

## 13. Configurar o GitHub

### Environments

_Settings → Environments_ do repositório `trajetto-api`:

**`staging`** (sem revisores; o deploy de staging é automático):

| Tipo     | Nome                                                                                    | Valor                                                                                                                            |
| -------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| secret   | `DOKPLOY_URL`                                                                           | URL do painel, **https** (o script recusa http: a chave vai no cabeçalho)                                                        |
| secret   | `DOKPLOY_API_KEY`                                                                       | _Dokploy → Settings → Profile → API/CLI → Generate_                                                                              |
| secret   | `DOKPLOY_COMPOSE_ID`                                                                    | o id do app `trajetto-staging` (na URL do app)                                                                                   |
| variable | `SWARM_API_SERVICE`                                                                     | `trajetto-staging_api`                                                                                                           |
| secrets  | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY` | conferência do rollout ([seção 14](#14-conferir-a-convergência)); podem ficar no repositório se os dois ambientes dividem o host |

**`production`** — marque **Required reviewers** (você e quem mais puder
aprovar uma ida para produção) e, se quiser, _Deployment branches and tags →
Selected branches: `main`_ (o _Run workflow_ de rollback também roda a partir
de `main`):

| Tipo     | Nome                                                                                    | Valor                                               |
| -------- | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| secret   | `DOKPLOY_URL`, `DOKPLOY_API_KEY`                                                        | idem                                                |
| secret   | `DOKPLOY_COMPOSE_ID`                                                                    | o id do app `trajetto`                              |
| variable | `SWARM_API_SERVICE`                                                                     | `trajetto_api`                                      |
| secrets  | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY` | conferência do rollout                              |
| secret   | `DEPLOY_SSH_KEY`                                                                        | a chave das migrations ([seção 15](#15-migrations)) |

Enquanto os três `DOKPLOY_*` de um environment não existirem, o job daquele
ambiente move a tag e pula o deploy com um aviso.

### Variáveis e secrets do repositório

| Tipo     | Nome                      | Para quê                                                                                |
| -------- | ------------------------- | --------------------------------------------------------------------------------------- |
| variable | `MIGRATIONS_VIA_JOB`      | `true` liga o job único de migrations no promote                                        |
| variable | `ROLLOUT_VERIFY`          | `off` desliga a conferência do rollout (só em emergência; fica registrado no resumo)    |
| variable | `IMAGE_SCAN_ENFORCE`      | `true` faz um CRITICAL corrigível no Trivy falhar o build                               |
| secret   | `CLIENT_REPOS_READ_TOKEN` | token só leitura dos repositórios da web e do app, para o contrato de rotas do `ci.yml` |

Obsoletos (apague se existirem): a variável `STAGING_ENABLED` (o deploy de
staging agora depende só dos secrets) e os secrets `PORTAINER_WEBHOOK_URL` e
`PORTAINER_STAGING_WEBHOOK_URL`.

### Proteção das branches

- `main`: exigir PR, exigir os checks _Lint, type-check, unit (coverage floor)
  and E2E_, _AI OCR service (image + pytest)_, _Secret scan (gitleaks)_ e
  _The PR head was built on staging_; permitir só **merge commit** (desligar
  squash e rebase em _Settings → General → Pull Requests_). Se a proteção
  impedir o push do `semantic-release` (o commit do CHANGELOG), permita que
  o GitHub Actions faça bypass ou desligue o plugin `@semantic-release/git`.
- `staging`: sem exigência de PR (o dono faz push direto); bloquear force-push.

## 14. Conferir a convergência

O passo que prova que o deploy trocou a versão. Roda depois do Dokploy em
staging e na promoção, e **falha o run** quando o Swarm reverteu o update,
quando ele não termina no prazo ou quando a spec não fixa um digest.

- O quê: `infra/scripts/verify-rollout.sh` no manager, por SSH com chave
  restrita (forced command).
- Lê: a spec do serviço (digest), o `UpdateStatus` e as tasks.
- Passa quando: a spec fixa o digest promovido, o update terminou
  (`completed`) e toda task em execução roda esse digest, na quantidade de
  réplicas.
- Falha quando: `rollback_*`/`paused`, spec sem digest (o registry não
  resolveu a tag), 600 s sem convergir (`ROLLOUT_TIMEOUT_SECONDS`).

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
`DEPLOY_SSH_KNOWN_HOSTS`. A única entrada que o CI manda é
`<serviço> ghcr.io/trajetto-organization/trajetto-api@sha256:<digest>`; o
script recusa qualquer outra coisa. À mão, no manager:
`trajetto-verify-rollout trajetto_api ghcr.io/trajetto-organization/trajetto-api@sha256:<digest>`.

Desligar (só numa emergência, e fica registrado no resumo do run): variável de
repositório `ROLLOUT_VERIFY=off`.

## 15. Migrations

### Onde rodam

| Modo                                                                                | Quando                                                                                                          | O que acontece numa migration que falha                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Boot de cada réplica** (`RUN_MIGRATIONS_ON_BOOT=true`, o padrão)                  | cada task da API que sobe roda `prisma migrate deploy` e os seeds antes do servidor                             | a task morre; a linha fica em `_prisma_migrations` com `finished_at` nulo e **toda** imagem, inclusive a antiga, passa a sair com P3009 no boot. O próximo restart de qualquer réplica vira queda |
| **Job único antes do rollout** (`MIGRATIONS_VIA_JOB=true`, recomendado em produção) | a promoção roda `./docker-entrypoint.sh migrate` uma vez, como job do Swarm, com a imagem exata sendo promovida | o passo falha; `stable` não anda, o Dokploy não é chamado e as réplicas em produção nem percebem                                                                                                  |

Staging migra no boot (o job usa o nome da stack de produção); é lá que uma
migration ruim deve aparecer primeiro.

Nos dois modos, `prisma migrate deploy` e os seeds usam
`MIGRATION_DATABASE_URL` (o compose a define, sem tetos de runtime e com pool
de 2). A `DATABASE_URL` de runtime leva `statement_timeout=30s` e
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
   A stack é o nome do app (`trajetto`). Se for outro, exporte `STACK_NAME`
   (ou `API_SERVICE`) no ambiente do usuário de deploy; um nome errado não
   passa (o script recusa quando `<stack>_backend` ou `<stack>_api` não
   existem).
2. Uma chave SSH restrita ao script no `~/.ssh/authorized_keys` do usuário de
   deploy (grupo `docker`):
   ```
   command="/usr/local/bin/trajetto-release-migrate",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ssh-ed25519 AAAA... deploy-trajetto
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
6. Só então `RUN_MIGRATIONS_ON_BOOT=false` no Environment do app de produção.

O que o job faz: copia o env da API em execução (`docker service inspect`)
para um arquivo `0600`, apagado assim que o job é criado (a senha do banco
nunca mora no CI); `docker service create --mode replicated-job
--restart-condition none --no-healthcheck` na rede `<stack>_backend`; espera
até `MIGRATE_TIMEOUT_SECONDS` (900 s). Estourou ou a espera foi interrompida:
o passo falha, mas o job **não é removido** (matá-lo no meio de uma migration
é o que gera P3009) — acompanhe com `docker service logs -f <job>` e remova
depois (`docker service ls --filter name=trajetto-migrate-`).

Limites: imagens anteriores ao modo `migrate` fazem o job falhar e bloqueiam a
promoção (sem estrago); para voltar a uma delas, desligue `MIGRATIONS_VIA_JOB`
só nesse promote. O job usa o env da versão que está no ar: se a versão nova
exige uma variável que a produção ainda não tem, acrescente-a ao Environment
antes do promote.

À mão, no manager: `trajetto-release-migrate ghcr.io/trajetto-organization/trajetto-api:sha-<sha>`.

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
   docker exec -it $(docker ps -q -f name=trajetto_api | head -n 1) \
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

1. `/health/readiness` 200 e as duas réplicas de pé (`docker service ls`).
2. `robots.txt` da web de staging com `Disallow: /` (`APP_ENV=staging` na web).
3. **WebSocket atrás do Traefik**: um socket aberto por mais de 3 minutos sem
   reconexão:
   ```sh
   LOAD_SOCKET_URL=https://<API_HOST de staging> LOAD_SOCKET_TOKEN=<token de um gestor> \
     HOLD_MINUTES=5 node tests/load/socket-hold.mjs
   ```
4. Um e-mail e um WhatsApp de teste chegam ao destino de teste, e a nenhum
   cliente real.
5. _Sistema → Provedores_ sem `error` inesperado (Resend, Meta, R2,
   trajetto-ai, heartbeat).

### A promoção

1. Abra o PR `staging → main`; espere os checks (inclusive _The PR head was
   built on staging_).
2. Merge com **merge commit**.
3. _Actions_ → o run do push em `main` → job _Promote to production_ → aprovar
   o environment `production`.
4. O job resolve o build (`sha-<head do PR>`), compara com o staging, roda as
   migrations (se `MIGRATIONS_VIA_JOB=true`), move `stable`, pede o deploy e
   espera a convergência. Verde = o Swarm roda o digest promovido em todas as
   réplicas. O digest fica no resumo do run.
5. Depois, o job _Release_ cria a versão.

Conferir à mão:

```sh
docker service inspect trajetto_api --format '{{.Spec.TaskTemplate.ContainerSpec.Image}} {{.UpdateStatus.State}}'
```

Deve terminar no digest do resumo do run, com `completed`.

**Ordem entre API e web**: API primeiro, web depois. A promoção da web confere
se a API de produção serve todas as rotas que a web chama
(`trajetto-ui/docs/deploy.md`).

## 17. Rollback

### Caminho normal: promover o build bom

1. Achar a tag boa: o resumo de uma promoção anterior registra
   `trajetto-api:stable → sha-<sha> (sha256:...)`; ou o job _Build and push
   the images (once)_ do push em `staging` que gerou o build.
2. _Actions_ → _Pipeline (staging → produção)_ → _Run workflow_ (branch
   `main`) → `image_tag = sha-<sha>` (builds antigos: `main-<sha>`).
3. Aprovar o environment `production`.
4. O run só fica verde depois do passo _Wait for the rollout to converge_.

### Emergência: voltar um passo agora

```sh
docker service rollback trajetto_api
```

No host do Dokploy. Volta para a spec anterior, com o digest anterior, em
segundos. Volta **um** passo só, e é desfeito pelo próximo deploy do app (que
reaplica `stable`): depois da emergência, rode o caminho normal com a tag boa.

### O banco não volta junto

As migrations de uma versão ficam aplicadas quando a imagem volta. Uma imagem
anterior só é segura sobre o schema novo se a versão nova seguiu
expandir/contrair ([`arquitetura.md`](./arquitetura.md#migrations-expandir-e-contrair)).
Com o job ligado, o promote de uma imagem anterior roda o `migrate deploy`
dela, que não tem o que aplicar.

### Quando o Swarm desiste de um serviço

Nenhum serviço tem `max_attempts`. Se um slot ainda assim ficar parado (um nó
que voltou, uma versão antiga do compose), `docker service update --force
<serviço>` recria a task sem deploy.

## 18. Backup e restauração

Até 14/09/2026 o Trajetto não tinha backup nenhum. Hoje:

|                   |                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------- |
| **RPO**           | até 24 h: um dump por noite às 02:30 UTC, antes do primeiro job que apaga dados (03:17 UTC) |
| **RTO**           | medido: 10,5 s para 94 MB (cresce com o volume; a parte lenta é recriar os índices)         |
| **PITR**          | **não existe** (exigiria WAL archiving com wal-g)                                           |
| **Arquivos (R2)** | fora do dump ("O que o dump não cobre", abaixo)                                             |

### O backup agendado (`trajetto-backup`)

Um serviço da stack, construído e promovido com a API. Toda noite às
`BACKUP_AT_UTC` (02:30):

1. `pg_dump -Fc` **pela rede** de `trajetto-database` (sem socket do Docker).
2. Recusa dump com menos de 1 KB ou cujo índice (TOC) não lê de volta.
3. Cifra com **age** para a chave pública `BACKUP_AGE_RECIPIENT` antes de
   qualquer coisa sair do contêiner (a privada **não** fica no servidor).
4. Envia `<banco>-<AAAAMMDD>T<HHMMSS>Z.dump.age` e o `.sha256` para um **bucket
   R2 separado**, em `pg/daily/AAAA/MM/DD/`; aos domingos copia para
   `pg/weekly/…` e no dia 1º para `pg/monthly/…`.
5. Avisa o heartbeat (`BACKUP_HEARTBEAT_URL`) no sucesso e `…/fail` em qualquer
   falha; o monitor alerta na falha **e no silêncio** (período 26 h).
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
5. Deploy e um ensaio sem esperar a noite:
   `docker exec <task do trajetto-backup> backup-to-r2` (ou
   `BACKUP_RUN_NOW=true` no primeiro boot).

Para trocar só o backup sem deploy:
`docker service update --image ghcr.io/trajetto-organization/trajetto-backup:stable <app>_trajetto-backup`.

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

Num incidente real (banco perdido): faça o deploy da stack com um
`POSTGRES_VOLUME` novo e **sem** `ALLOW_EMPTY_DATABASE_BOOTSTRAP` — a API vai
recusar o banco vazio, o que é o esperado (com a variável ligada ela migraria
e semearia um banco novo por cima do qual o dump não restaura). Então:

```bash
docker service scale <app>_api=0
docker exec -i $(docker ps -q -f name=<app>_trajetto-database | head -n 1) \
  pg_restore -U "$POSTGRES_USERNAME" -d "$POSTGRES_DATABASE" \
  --no-owner --no-privileges --exit-on-error < ./trajetto-<data>.dump
docker service scale <app>_api=2
```

Um banco restaurado traz `_prisma_migrations` e passa pela guarda; as
migrations mais novas que o dump rodam no boot (ou no job).

### Backup à mão (antes de uma operação arriscada)

```bash
POSTGRES_USERNAME=... POSTGRES_DATABASE=... \
  ./infra/scripts/backup-postgres.sh ./backups
```

O `pg_dump` roda dentro do contêiner (`POSTGRES_CONTAINER` escolhe qual), para
a versão do cliente bater com a do servidor. Escreve `.dump.partial` e só vira
`.dump` depois do tamanho mínimo e do `pg_restore --list`; ao lado sai o
`.sha256`. O arquivo só vira backup quando sai da máquina.

### Ensaiar a restauração

```bash
./infra/scripts/restore-postgres.sh ./backups/<arquivo>.dump
```

Sobe um Postgres descartável na porta 55432 com a **mesma imagem da produção**
(`POSTGRES_IMAGE`), restaura com `--exit-on-error`, confere o `.sha256` se
existir e roda `prisma migrate status` contra o banco restaurado — a
verificação que importa ("Database schema is up to date!"; um dump mais velho
que o código falha com "Dump anterior ao código: há migrations pendentes"). O
contêiner é removido ao final (`KEEP_CONTAINER=true` preserva).

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
- **Segredos**: as cópias vivas são o Environment do Dokploy e o seu
  gerenciador de senhas. Perder `JWT_SECRET_REFRESH_TOKEN` desloga todo mundo.
  Perder `WEBHOOK_SECRETS_KEY` **não é recuperável**: os segredos dos webhooks
  dos clientes estão cifrados com ela no dump (a saída é uma chave nova e cada
  cliente gerar novo segredo). Guarde-a longe dos backups.
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
- **Escalar a API**: suba `replicas` no compose (ou
  `docker service scale trajetto_api=N` até o próximo deploy) e refaça o
  orçamento de conexões (`réplicas × 11 + 2 + ferramentas < max_connections`).
- **Desligamento ordenado**: SIGTERM → readiness 503 → 12 s para o Traefik
  tirar a réplica → fecha tempo real, HTTP, workers e Redis, com teto de 35 s
  (o `stop_grace_period` é 40 s).

### Separar os workers do HTTP (só por gatilho medido)

Gatilhos (ADR 0001/0004): espera no pool visível em `/health/metrics`
(`runtime.prisma_pool`) nos horários de dreno; CPU/IO/WAL do Postgres puxados
por um dreno de backlog enquanto o HTTP sofre; necessidade de publicar o HTTP
sem reiniciar os workers. Separar é isolamento, não correção de falha.

1. **Orçamento de conexões antes de tudo**: `réplicas_api × 11 + worker ×
(limite + 1) + migrations (2) + ferramentas` abaixo do `max_connections`
   (ou PgBouncer antes).
2. Crie o serviço `worker` na stack, com a **mesma** imagem e o mesmo ambiente
   da API, mudando só:
   ```yaml
   worker:
     image: ghcr.io/trajetto-organization/trajetto-api:${API_IMAGE_TAG:-stable}
     stop_grace_period: 40s
     environment:
       # ... o mesmo bloco da api, e:
       WORKERS_ENABLED: "true"
       PIPELINE_SWEEP_INTERVAL_MS: "2000"
       RUN_MIGRATIONS_ON_BOOT: "false"
       # connection_limit menor que o da api:
       DATABASE_URL: postgresql://...?schema=public&connection_limit=4&pool_timeout=10&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=...
     deploy:
       replicas: 1
       # sem labels do Traefik: ninguém de fora fala com ele
     networks:
       - backend # Postgres, Redis e trajetto-ai
       - edge # saída para Meta, Resend e os webhooks dos clientes
   ```
3. Suba o worker primeiro e confirme nos logs `workers started` e, em
   `/health/metrics`, os batimentos dos workers vindos dele.
4. Só então `WORKERS_ENABLED=false` na api. Cada réplica loga
   `workers disabled on this replica (WORKERS_ENABLED=false)`.

Voltar: `WORKERS_ENABLED=true` na api primeiro, depois remover o worker. O
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

`docker service update --force <stack>_api` recria as tasks (start-first) e
zera os pools.

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
3. `HEALTHCHECK_PING_URL` no Environment (ex. `https://hc-ping.com/<uuid>`). A
   URL é segredo: quem a tem pode silenciar o alerta.
4. Uptime Kuma: `HEALTHCHECK_PING_URL=https://<kuma>/api/push/<token>?status=up&msg=OK`
   e `HEALTHCHECK_FAIL_URL=https://<kuma>/api/push/<token>?status=down`.
5. Depois do deploy, confira um ping por minuto no painel. Para testar o
   `/fail`, pare o Redis de staging por dois minutos.
6. **Uptime externo**: monitores HTTP de `https://<API_HOST>/health/readiness`
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
| `Certificado ICP ... vencido` / `inválido`            | os comprovantes saem sem assinatura (e dizem isso); `PFX_UNREADABLE` = senha errada ou arquivo corrompido, `PFX_FILE_UNREADABLE` = o secret não montou                              |

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
segredo ficar de fora).

### Prontidão dos provedores (`GET /health/providers`, só MASTER)

Sem enviar nada a ninguém e sem devolver segredo: Resend (`GET /domains`),
Meta (`GET /{phone_number_id}` e os templates, com
`META_WHATSAPP_BUSINESS_ACCOUNT_ID`), Expo, R2 (`HeadBucket`; `local` em
produção é erro), trajetto-ai (`/health` e um `POST /v1/read` vazio), o
certificado e o heartbeat. `not_configured` traz `missing_env` com os nomes que
faltam.

Fase 2 (fora do repositório, quando houver pilha de métricas): 5xx > 2 % e p95

> 1,5 s por rota e picos de 429 (métricas do Traefik); disco > 80 %
> (node-exporter); restarts de contêiner (cAdvisor).

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

**Retenção no GHCR**: cada push em `staging` publica `sha-<sha>` das três
imagens. Não há limpeza automática: as versões sem tag incluem os manifestos
de atestado e os índices que `stable` e `staging` usam, e apagá-las às cegas
quebra imagens com tag. Limpe à mão, pelo painel do pacote, as `sha-<sha>` e
`main-<sha>` antigas que não são `stable` nem `staging` (guarde as últimas
como alvo de rollback).

## 23. Recursos da VPS

| Serviço     | Limite                                                            |
| ----------- | ----------------------------------------------------------------- |
| API         | 2 × 1024M (`API_MEMORY_LIMIT`, heap `API_HEAP_MB` 768)            |
| Web         | 768 MiB (limite da Application; ver `trajetto-ui/docs/deploy.md`) |
| Redis       | 512M (dados 256 MB)                                               |
| Backup      | 256M                                                              |
| trajetto-ai | 1024M e 2 CPUs (`AI_MEMORY_LIMIT`, `AI_CPUS`)                     |
| Postgres    | sem teto (dimensionado pelo tuning)                               |

Mais o Dokploy e o Traefik. Só a produção passa de 3,5 GB sem contar o
Postgres; **com staging no mesmo host, o dobro** (ou staging com limites
menores e `AI_PROVIDER=none`/`AI_REPLICAS=0`). Os números reais saem de
`docker stats` sob o harness de carga (`tests/load/README.md`). Sem limite de
CPU na API de propósito (o throttling do CFS piora o p99); com limite na IA,
porque o OCR satura todo núcleo que recebe.

## 24. Migrar do Portainer para o Dokploy

O dado mora no volume do Postgres. Antes deste compose o volume não tinha nome
fixo e o Swarm o chamava `<stack>_postgres_data`; com o app do Dokploy (outro
nome de stack) o banco subiria **vazio**. Agora o nome vem de
`POSTGRES_VOLUME`, e o guard de bootstrap recusa banco vazio em produção.

### Mesma VPS

1. **Backup fresco** e conferido ([seção 18](#18-backup-e-restauração)).
2. **O nome do volume de hoje**: `docker volume ls | grep postgres_data` (com
   a stack `trajetto` do Portainer, `trajetto_postgres_data`). É o
   `POSTGRES_VOLUME` do app de produção.
3. **Janela de manutenção.** Antes, exporte do Portainer o compose e o env de
   cada stack (API, web, Traefik): voltar atrás é um `docker stack deploy` com
   eles. As portas 80/443 são do Traefik antigo e o Dokploy precisa delas:
   ```sh
   docker stack rm trajetto trajetto-ui      # remove serviços; volumes ficam
   docker ps -a --filter volume=trajetto_postgres_data   # vazio antes de seguir
   ```
   Pare também o Traefik antigo.
4. **Instalar o Dokploy** e seguir as seções 6, 7 e 13, com
   `POSTGRES_VOLUME=trajetto_postgres_data` e
   `ALLOW_EMPTY_DATABASE_BOOTSTRAP=false`. Se a API subir, o volume é o certo:
   num volume vazio o guard derruba o boot.
5. **Primeiro deploy**: `API_IMAGE_TAG`, `AI_IMAGE_TAG` e `BACKUP_IMAGE_TAG`
   em `sha-<sha>` de um build verde de staging; depois rode a promoção
   (cria `stable`) e apague as três. `REDIS_ENFORCE_AUTH=false` não é
   necessário (stack nova).
6. **Conferir**: `/health/readiness` 200, login, contagem de algumas tabelas
   contra o backup.
7. **Web** depois da API, no mesmo desenho (`trajetto-ui/docs/deploy.md`).
8. **Limpar**: a rede `minha_rede` (se nada mais a usar) e o volume
   `trajetto_redis_data`, órfão.

A imagem antiga de `main` (anterior a este desenho) não sobe com este compose
(o env-schema dela exige `RABBITMQ_URL` e as variáveis do Evolution): voltar
para ela é tirar os apps do Dokploy e redeployar as stacks antigas com o
compose e o env exportados no passo 3.

### VPS nova

Sem volume para reaproveitar: suba o app com um `POSTGRES_VOLUME` novo,
restaure o dump com a API em 0 réplicas ([seção 18](#18-backup-e-restauração),
"Restaurar a partir do R2"), suba a API e aponte o DNS.
`ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` só serve para uma instalação **sem**
dados a restaurar.

## 25. Checklist do primeiro deploy

Na ordem:

- [ ] Branch `staging` criada no GitHub a partir do estado que vai para
      produção; proteção de `main` e `staging` ([seção 13](#13-configurar-o-github)).
- [ ] Primeiro push em `staging` verde: imagens `sha-<sha>` das três imagens
      no GHCR (o deploy de staging aparece como "pulado" até o Dokploy existir).
- [ ] VPS com Dokploy instalado; Traefik conferido e `infra/traefik/` aplicado
      ([seção 6](#6-preparar-o-servidor-uma-vez)).
- [ ] DNS na Cloudflare (proxy, Full strict, TLS 1.2, Always HTTPS) para os
      hosts da API (produção e staging).
- [ ] Registry do GHCR no host/Dokploy (token `read:packages`); GitHub App do
      Dokploy com acesso ao `trajetto-api`.
- [ ] Buckets R2: fotos de produção e de staging (com CORS); backup de
      produção e de staging (lifecycle + Bucket Lock); tokens separados.
- [ ] Chave age gerada (privada no gerenciador de senhas); heartbeats criados
      (operação 1 min, backup 1 dia); monitores de uptime.
- [ ] Segredos gerados por ambiente: `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`,
      `REDIS_PASSWORD`, `POSTGRES_PASSWORD`, `AI_LOCAL_TOKEN`,
      `WEBHOOK_SECRETS_KEY`, `RATE_LIMIT_FORWARDER_SECRET` (igual ao da web),
      `DOCS_PASSWORD`.
- [ ] App `trajetto-staging` (branch `staging`) com o Environment de staging;
      primeiro deploy à mão com `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` (depois
      `false`); `/health/readiness` 200.
- [ ] Environment `staging` no GitHub (`DOKPLOY_*`, `SWARM_API_SERVICE`, SSH
      da conferência); script `verify-rollout.sh` instalado e chave restrita.
- [ ] Um push em `staging` faz o deploy sozinho e termina com "convergiu".
- [ ] App `trajetto` (branch `main`) com o Environment de produção e as tags
      `sha-<sha>` ([seção 7](#7-criar-o-app-de-produção-no-dokploy)); vindo do
      Portainer, [seção 24](#24-migrar-do-portainer-para-o-dokploy).
- [ ] Environment `production` no GitHub com **revisores obrigatórios**,
      `DOKPLOY_*`, `SWARM_API_SERVICE`, SSH.
- [ ] PR `staging → main`, merge commit, aprovação: `stable` criada; apagar
      `API_IMAGE_TAG`/`AI_IMAGE_TAG`/`BACKUP_IMAGE_TAG` do app de produção.
- [ ] Job de migrations ligado ([seção 15](#15-migrations)) e, depois de um
      promote com `[release-migrations] ok`, `RUN_MIGRATIONS_ON_BOOT=false` em
      produção.
- [ ] `HEALTHCHECK_PING_URL` chegando 1/min; ensaio do backup
      (`backup-to-r2`) e um ensaio de restore.
- [ ] Certificado A1 do comprovante (`PROOF_SIGNING_*`) em produção;
      `proof_signing` em `/health/metrics`.
- [ ] Web promovida **depois** da API (`trajetto-ui/docs/deploy.md`).
- [ ] Revogar a `ANTHROPIC_API_KEY` antiga do histórico; apagar os secrets
      obsoletos (`PORTAINER_*`, `STAGING_ENABLED`).

## 26. Os três repositórios juntos

> Esta seção é **a mesma** nos três manuais de deploy:
> [`trajetto-api/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-api/blob/main/docs/deploy.md),
> [`trajetto-ui/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-fleet-manager-ui/blob/main/docs/deploy.md)
> e
> [`trajetto-mobile/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-fleet-manager-mobile/blob/main/docs/deploy.md).
> Mudou aqui, mude nos outros dois. O detalhe de cada passo fica no manual do
> repositório dono dele.

### Quem é quem

|                             | API (`trajetto-api`)                                                                                                                                                                | Web (`trajetto-fleet-manager-ui`, pasta `trajetto-ui`)                                                           | App (`trajetto-fleet-manager-mobile`, pasta `trajetto-mobile`)                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Artefato                    | imagens `trajetto-api`, `trajetto-ai` e `trajetto-backup` em `ghcr.io/trajetto-organization/`                                                                                       | imagem `ghcr.io/trajetto-organization/trajetto-ui`                                                               | APK/AAB (EAS Build) e OTA (EAS Update)                                                                          |
| Onde roda                   | Dokploy: **um app Compose (Docker Stack)** por ambiente com o `compose.production.yaml`: `api`, `trajetto-database` (Postgres), `trajetto-redis`, `trajetto-ai` e `trajetto-backup` | Dokploy: **uma Application** por ambiente, puxando a imagem do GHCR                                              | no celular do motorista (APK interno em staging, Play Store em produção)                                        |
| Nome no Dokploy / EAS       | `trajetto-staging` e `trajetto`                                                                                                                                                     | `trajetto-ui-staging` e `trajetto-ui-production`                                                                 | perfis, ambientes e canais `staging` e `production`                                                             |
| Como o pipeline publica     | API do Dokploy (`.github/scripts/dokploy-deploy.mjs`), que acompanha o deployment até o fim                                                                                         | webhook de deploy da Application (`.github/scripts/dokploy-webhook.mjs`), depois espera o `/build-id.json`       | `eas update` e `eas build`                                                                                      |
| Secrets de deploy no GitHub | environments `staging` e `production`: `DOKPLOY_URL`, `DOKPLOY_API_KEY`, `DOKPLOY_COMPOSE_ID`                                                                                       | environment `staging`: `DOKPLOY_STAGING_WEBHOOK_URL`; environment `production`: `DOKPLOY_PRODUCTION_WEBHOOK_URL` | `EXPO_TOKEN` (repositório) e `EXPO_UPDATE_PRIVATE_KEY` (environments `staging` e `production`)                  |
| Sem os secrets              | move as tags e pula o deploy com `::notice::`                                                                                                                                       | move as tags e pula o deploy com aviso                                                                           | termina verde com aviso, sem publicar                                                                           |
| De staging para produção    | promove por digest a imagem `sha-<7 do commit>` (tag `staging` → `stable`), sem rebuild                                                                                             | igual à API, e exige o marcador `staged-<7 do commit>` no mesmo digest                                           | promove o **commit** verde em staging (a URL da API é embutida no build, então o artefato não pode ser o mesmo) |
| Rollback                    | _Run workflow_ do `deploy.yml` com `image_tag=sha-<7>`                                                                                                                              | _Run workflow_ do `deploy.yml` com `image_tag=sha-<7>`                                                           | `ota-rollback.yml` (republica um grupo de OTA)                                                                  |

Regras comuns aos três: a branch `staging` recebe o trabalho (push direto do
dono ou merge de PR) e todo push nela roda a validação completa e publica o
staging; `main` só recebe PR **de `staging`**, com **merge commit** (squash e
rebase criam um commit que o staging nunca validou, e a promoção recusa); o
environment `production` do GitHub tem **Required reviewers** e
_Deployment branches_ restrito a `main`, então nada chega à produção sem
aprovação.

### Endereços

|                        | Staging                                                                         | Produção                                                           |
| ---------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Web                    | `https://staging.intrajetto.com`                                                | `https://www.intrajetto.com` (o apex `intrajetto.com` redireciona) |
| API (REST e Socket.IO) | `https://trajettoapi-staging.thorsolucoes.com.br`                               | `https://trajettoapi.thorsolucoes.com.br`                          |
| Serviço de IA          | sem endereço público: `http://trajetto-ai:8080` na rede interna da stack da API | idem                                                               |

### O que precisa casar entre os repositórios

| Valor                             | API (Environment do app Compose)                                                                        | Web (Environment da Application)                                                         | App (ambiente EAS)                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| URL pública da API                | `API_HOST` (só o host, para o roteador do Traefik) e `API_HTTP_REQUEST` (a URL)                         | `HTTP_REQUEST` (chamadas do servidor da web) e `PUBLIC_API_URL` (chamadas do navegador)  | `EXPO_PUBLIC_API_URL`                                                                 |
| Socket.IO                         | o mesmo host da API, com WebSocket liberado na borda                                                    | `PUBLIC_SOCKET_URL` (vazia = `PUBLIC_API_URL`)                                           | o socket usa `EXPO_PUBLIC_API_URL`                                                    |
| Origem da web                     | `HTTP_REQUEST` = a origem da web do ambiente (única origem do CORS e do Socket.IO, base dos links)      | `METADATA_BASE`                                                                          | `EXPO_PUBLIC_WEB_APPLICATION_URL` (links de Privacidade e Termos)                     |
| Limite de tentativas por IP       | `RATE_LIMIT_FORWARDER_SECRET`                                                                           | `RATE_LIMIT_FORWARDER_SECRET`, **o mesmo valor**                                         | —                                                                                     |
| Captcha (Turnstile)               | `TURNSTILE_SECRET_KEY` (o mesmo widget da web) e `TURNSTILE_REQUIRED`                                   | `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`                                            | —                                                                                     |
| Fotos no R2                       | `R2_*` (um bucket por ambiente)                                                                         | `CSP_STORAGE_ORIGINS` libera a origem do bucket; o CORS do bucket libera a origem da web | envia direto à URL pré-assinada que a API devolve (sem configuração)                  |
| IA (leitura de fotos)             | `AI_LOCAL_TOKEN`, que o compose entrega também ao `trajetto-ai` como `AI_TOKEN` (um valor por ambiente) | nenhuma variável: a IA chega pela API                                                    | nenhuma variável                                                                      |
| Push (FCM)                        | nenhuma: a API chama a Expo Push API                                                                    | —                                                                                        | `GOOGLE_SERVICES_JSON` (arquivo secreto no EAS) e a chave FCM V1 em `eas credentials` |
| Rastreamento em segundo plano     | —                                                                                                       | `BACKGROUND_TRACKING`                                                                    | `EXPO_PUBLIC_BACKGROUND_TRACKING` (as duas ligam juntas)                              |
| Versão do app                     | `MIN_MOBILE_CONTRACT` e `MOBILE_STORE_URL`                                                              | —                                                                                        | `CLIENT_CONTRACT` em `utils/client-version.ts`                                        |
| Gate de rotas da web              | `/docs/json` com `DOCS_USER` e `DOCS_PASSWORD`                                                          | secrets `API_DOCS_URL`, `DOCS_USER`, `DOCS_PASSWORD` no environment `production`         | —                                                                                     |
| Checkout entre repositórios no CI | `CLIENT_REPOS_READ_TOKEN` (lê a web e o app)                                                            | `API_REPO_READ_TOKEN` (lê a API)                                                         | `API_REPO_READ_TOKEN` (lê a API)                                                      |

Segredos nunca são compartilhados entre staging e produção. Cada variável
está detalhada no `docs/variaveis-de-ambiente.md` do repositório que a lê.

### Ordem do primeiro deploy

1. **GitHub, nos três repositórios:** branch `staging` criada a partir de
   `main`; environments `staging` e `production` (este com revisores e só a
   branch `main`); só merge commit habilitado; proteção de `main`. Um
   primeiro push em `staging` em cada repositório: a API e a web publicam
   `sha-<7>` no GHCR e pulam o deploy; o app pula o EAS até o `EXPO_TOKEN`
   existir.
2. **Servidor:** VPS com Dokploy, Traefik ajustado com
   `trajetto-api/infra/traefik/`, DNS na Cloudflare (Full strict) para os
   hosts da web e da API, registry `ghcr.io` no Dokploy com um token
   `read:packages` (o mesmo registry serve para as quatro imagens).
3. **Contas externas:** buckets R2 (fotos e backup, um de cada por
   ambiente, CORS das fotos com a origem da web), widgets do Turnstile por
   ambiente, Meta e Resend (de teste em staging), heartbeats de monitoramento.
4. **API de staging** (`trajetto-staging`, manual da API): um único deploy
   do app Compose sobe, juntos, o **banco** (`trajetto-database`), o
   **Redis**, o **serviço de IA** (`trajetto-ai`, com o `AI_LOCAL_TOKEN`), o
   backup e a `api`, que só fica pronta quando banco e Redis respondem.
   Confira `/health/readiness` e, como MASTER na web, _Sistema → Provedores_.
   Depois, os secrets `DOKPLOY_*` no environment `staging` da API.
5. **Web de staging** (`trajetto-ui-staging`, manual da web): imagem
   `:staging`, `HTTP_REQUEST` e `PUBLIC_API_URL` apontando para a API de
   staging, o mesmo `RATE_LIMIT_FORWARDER_SECRET` da API de staging, e o
   `HTTP_REQUEST` da API de staging igual à origem da web de staging. Depois,
   `DOKPLOY_STAGING_WEBHOOK_URL` e `METADATA_BASE_STAGING` no environment
   `staging` da web.
6. **App de staging** (manual do app): ambiente EAS `staging` com
   `EXPO_PUBLIC_API_URL` = API de staging e
   `EXPO_PUBLIC_WEB_APPLICATION_URL` = web de staging; `EXPO_TOKEN` no
   GitHub; um push em `staging` gera o APK de staging.
7. **Produção, na mesma ordem:** app Compose `trajetto` (primeiro deploy com
   `API_IMAGE_TAG`/`AI_IMAGE_TAG`/`BACKUP_IMAGE_TAG` = `sha-<7>`) e PR
   `staging → main` da API, que cria `stable`; depois a Application
   `trajetto-ui-production` e o PR da web; por último o PR do app, que gera
   o AAB de produção apontando para a API de produção.

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
