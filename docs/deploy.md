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
                                     │  (API, migração e IA; a migração e a IA são reaproveitadas, sem rebuild, se o que rodam não mudou)
                                     ├─ migrations, só se o banco não aplicou essa imagem: Application trajetto-api-migrate (Dokploy)
                                     ├─ por serviço: tag `staging` movida por digest ─▶ Dokploy staging
                                     │  trajetto-ai (só se o digest mudou) → trajetto-api
                                     ├─ a API pública responde este commit? (/health/liveness)
                                     └─ marcador staged-<7> (o que o PR e a promoção exigem)

PR staging → main ──▶ deploy.yml: a mesma validação + "o staging rodou o head do PR?" (staged-<7>)

merge em main ──▶ deploy.yml: PROMOÇÃO (sem build)       [aprovação do environment production]
                  ├─ resolve o build do commit mergeado (2º pai do merge commit)
                  ├─ migrations, se preciso (trajetto-api-migrate, imagem de migração do build) ─▶ tag `stable` movida por digest
                  ├─ Dokploy produção: trajetto-ai → trajetto-api ─▶ convergência
                  └─ release (tag semver, CHANGELOG, GitHub Release)

Run workflow na main ──▶ a mesma promoção com uma tag antiga: o botão de ROLLBACK
Run workflow na staging ──▶ o caminho de staging de novo (force_ai_build: reconstrói e reimplanta a IA)
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

  | Tag                                                             | Quem cria/move                                                                     | Muda?                                                                                                                  |
  | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
  | `sha-<7 primeiros do commit>`                                   | o build de cada push em `staging`                                                  | **nunca** (imutável)                                                                                                   |
  | `staging`                                                       | o job `deploy-staging`, por digest                                                 | a cada push em `staging`                                                                                               |
  | `staged-<7>`                                                    | o job `deploy-staging`, **por último**: depois do scan, do deploy e da conferência | nunca; sem ele o PR e a promoção recusam o commit (salvo um commit só de documentação, que usa o de um ancestral)      |
  | `src-<hash git de infra/ai-ocr>` (só `trajetto-ai`)             | o build da IA                                                                      | nunca; é por ela que um push acha a imagem da IA de mesmo código e a reaproveita                                       |
  | `src-<hash de migrate-source.sh>` (só `trajetto-api-migrate`)   | o build da imagem de migração                                                      | nunca; é por ela que um push sem mudança nas migrations, nos seeds e no que eles rodam reaproveita a imagem            |
  | `staging-applied`, `stable-applied` (só `trajetto-api-migrate`) | `deploy-staging` e `promote-production`, **depois** de a etapa de release terminar | a cada etapa que roda; dizem qual imagem de migração o banco do ambiente já aplicou, e a etapa é pulada se for a mesma |
  | `stable`                                                        | o job `promote-production`, por digest                                             | a cada promoção ou rollback                                                                                            |
  | `main-<sha>`                                                    | builds antigos, de antes da branch `staging`                                       | nunca; aceitos só como alvo de rollback                                                                                |

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

1. Trabalhe numa branch e faça push: o `ci.yml` roda.
2. Leve para `staging` (PR para `staging` ou merge/push). O `deploy.yml` roda
   a validação completa, constrói as imagens e faz o deploy do staging.
3. Confira o staging ([seção 16](#16-promover-para-produção), "O que conferir
   no staging").
4. Abra o PR `staging → main`. O PR roda a mesma validação e confirma que o
   staging **rodou** o commit do head: o marcador `staged-<7>` das duas
   imagens, no mesmo digest de `sha-<7>` (espera até 45 min, porque o PR
   costuma abrir enquanto o staging ainda constrói e implanta o mesmo
   commit). Um commit cujo scan, deploy de staging ou conferência falhou tem
   a imagem, mas não o marcador, e o check falha. Um head que só muda
   documentação desde um commit que o staging rodou passa com o marcador
   desse commit ([seção 16](#16-promover-para-produção), "Commits só de
   documentação").
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
como qualquer outro. Como ele só traz o `CHANGELOG.md` (o único arquivo que
o `@semantic-release/git` commita), pode ir com `[skip ci]` na mensagem
([seção 16](#16-promover-para-produção), "Commits só de documentação").

O Dependabot abre os PRs dele contra `staging` (`target-branch: staging` em
`.github/dependabot.yml`), pelo mesmo motivo.

## 3. Os workflows em detalhe

### `.github/workflows/ci.yml` — portão das branches de trabalho

Roda em todo push de branch que **não** seja `main`, `master` nem `staging`
(e por _Run workflow_). Um push novo na mesma branch cancela o run anterior.

| Job            | O que faz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate`     | serviço `redis:7-alpine` por digest (um teste unitário do adapter do Socket.IO precisa dele); checkout com histórico completo; os repositórios irmãos (`Trajetto-Organization/trajetto-ui` e `Trajetto-Organization/trajetto-mobile`, na mesma branch quando ela existe lá) para o contrato de rotas, se o secret `CLIENT_REPOS_READ_TOKEN` existir — só "a branch não existe" (código 2 do `git ls-remote`) cai na branch padrão, com aviso; erro de rede repete 3 vezes e falha; Node `22.21.1`; cache dos engines do Prisma; auditoria de dependências (`audit-gate.sh`: bloqueia só um push que muda dependência); Prettier; `prisma generate`; `tsc`; unitários com piso de cobertura; publica `coverage-<sha>` |
| `secrets`      | gitleaks em todo o histórico, imagem fixada por digest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ai-ocr`       | o stage `test` de `infra/ai-ocr` pelo Buildx, com cache do GitHub (escopo `ai-test`): o pytest roda dentro da imagem, e um código que já passou leva segundos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ai-local-e2e` | só em _Run workflow_: o contrato da API contra o contêiner real de IA (`tests/ai-local`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Sem E2E, sem imagem, sem deploy: a pergunta é só "esse código pode ir para o
staging?".

### `.github/workflows/deploy.yml` — Pipeline (staging → produção)

| Gatilho                                                 | Jobs que rodam                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| push em `staging`                                       | `test`, `ai-ocr`, `secrets` → `build-and-push` → `deploy-staging` |
| pull request para `main`                                | `test`, `ai-ocr`, `secrets`, `staging-image`                      |
| push em `main` (o merge)                                | `promote-production` → `release`                                  |
| _Run workflow_ na `main` (`image_tag`)                  | `promote-production` (o rollback)                                 |
| _Run workflow_ na `staging` (`force_ai_build` opcional) | os mesmos do push em `staging`                                    |

| Job                  | Detalhes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test`               | serviços `postgres:16-alpine` e `redis:7-alpine` fixados por digest; checkout completo (o teste de rotas aposentadas compara com `origin/main`, e a auditoria com a base do push ou do PR); Node `22.21.1`; cache dos engines do Prisma pela versão deles e `yarn install --frozen-lockfile` com cache; confere que o schema engine do Prisma ficou instalado (baixa de novo, até 3 vezes, se o `postinstall` falhou calado); auditoria de dependências (`audit-gate.sh`); `lint:check`; `prisma:generate`; `typecheck`; `test:coverage` (o piso de cobertura); publica `coverage-<sha>`; `test:e2e` (um banco por arquivo; em duas fases, os arquivos que sobem réplicas por último, um por vez).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ai-ocr`             | o pytest do serviço de IA dentro da imagem (stage `test`, Buildx com cache do GitHub no escopo `ai-test`; o build só fala com o Docker Hub e o PyPI, porque os pesos do OCR estão versionados em `infra/ai-ocr/models`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `secrets`            | o mesmo gitleaks do `ci.yml` (mesma imagem, flags, `.gitleaksignore`). Nenhuma imagem é construída antes dele passar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `build-and-push`     | só no `staging` (push ou _Run workflow_), depois dos três acima. Buildx com cache do GitHub (um escopo por imagem); publica `sha-<7>` das três imagens (API, migração e IA) com SBOM e proveniência (`provenance: mode=max`; o único build arg é o commit, `GIT_SHA`, que vai para a imagem e sai na liveness). A IA só é reconstruída se o código dela mudou: toda imagem da IA leva também a tag `src-<hash git de infra/ai-ocr>`, e um push que encontra essa tag reaproveita a imagem (mesmo digest) e só acrescenta o `sha-<7>` dele, sem rebuild; `force_ai_build` reconstrói mesmo assim. A imagem de migração segue a mesma regra, com a tag `src-<hash>` de `.github/scripts/migrate-source.sh` (as migrations, o schema, os seeds e o que eles importam, o entrypoint, o `Dockerfile` e as dependências). Varre as três por digest com Trivy (CRITICAL corrigível; só relata até `IMAGE_SCAN_ENFORCE=true`, e só um achado reprova: o banco de vulnerabilidades é baixado uma vez por run, com cache diário, e falha no download ou erro do Trivy viram aviso). Exporta os três digests.                                                                                                                                                                                                                                                                                                                                              |
| `deploy-staging`     | environment `staging`; um por vez (`concurrency: deploy-staging`, nunca cancelado no meio). Confere se o run ainda é o head de `staging` (runs terminam fora de ordem; o mais velho não volta a tag, a menos que o head só acrescente documentação, como um `[skip ci]` de doc: `docs-only.sh`); anota para onde as tags `staging` apontam; as migrations, antes de qualquer tag da API ou da IA andar e só se o banco de staging ainda não aplicou a imagem de migração deste commit (o digest comparado com `trajetto-api-migrate:staging-applied`): move `trajetto-api-migrate:staging`, pede o deploy da Application `trajetto-api-migrate` e espera o Swarm dizer que a etapa terminou ou falhou (`.github/scripts/dokploy-release.mjs`; [seção 15](#15-migrations)), e só então move `staging-applied`; por serviço, na ordem **`trajetto-ai` → `trajetto-api`**, move a tag `staging` para o digest deste run e logo depois pede o deploy da Application (`.github/scripts/dokploy-deploy.mjs`, se os quatro secrets obrigatórios do Dokploy existirem). A IA só é movida e reimplantada se o digest dela mudou (ou com `force_ai_build`). Depois espera a API pública responder este commit em `/health/liveness` (`wait-for-version.mjs`; `ROLLOUT_VERIFY=ssh` troca pela conferência no Swarm), escreve o marcador `staged-<7>` das duas imagens e, se um deploy do Dokploy falhou, devolve a tag daquele serviço ao digest anterior. |
| `staging-image`      | só no PR (nome do check: _The PR head was built on staging_): espera (até 45 min) o marcador `staged-<head do PR>` das duas imagens, no mesmo digest de `sha-<head do PR>`, ou que o head só mude documentação desde um commit que o staging rodou (`.github/scripts/staged-build.sh`). Sem isso o merge promoveria um build que o staging não rodou.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `promote-production` | environment `production` (revisores obrigatórios = aprovação); um por vez (`concurrency: promote-production`); só a partir de `main`. Resolve o build (2º pai do merge commit; fast-forward = o próprio commit; _Run workflow_ = a tag digitada), valida o formato (`sha-<hex>` ou `main-<hex>`), confere num merge que o staging rodou o build — o marcador `staged-<7>` no mesmo digest, esperando até 20 min um deploy de staging ainda em andamento, ou o build do commit mais próximo que o staging rodou, quando o merge só muda documentação desde ele (o rollback por _Run workflow_ é isento) —, confere que a imagem existe no GHCR, compara com o que o staging roda (só informa), roda as migrations com a imagem de migração do build pela Application `trajetto-api-migrate` de produção, como no staging, só se o digest dela não é o de `stable-applied` (se o deploy de produção está configurado; um build anterior à imagem de migração pula a etapa com aviso, e um posterior sem ela reprova antes de mover `stable`), move `stable` das duas imagens por digest (a IA só se o build tiver essa imagem), pede o deploy das Applications de produção na mesma ordem (se configurado) e espera a convergência da API (SSH por padrão; `ROLLOUT_VERIFY=http` usa a liveness pública).                                                                                                                                         |
| `release`            | depois da promoção, só no push em `main`: `semantic-release` cria a tag, o `CHANGELOG.md` (commit com `[skip ci]`) e o GitHub Release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Antes do push, o `build-and-push` carrega as imagens da API e de migração no
runner e roda um smoke test contra um Postgres e um Redis descartáveis, numa
rede interna sem saída para a internet (a CLI do Prisma não pode baixar
engine): confere que a imagem da API não traz o CLI, migrations nem seeds e
traz `build/schema-version.json`; sobe a API no banco vazio e exige que ela
**recuse** (a trava de schema); roda a imagem de migração como a Application
dela a roda (comando `release`, só com o Environment daquela Application:
`DATABASE_URL`, `ALLOW_EMPTY_DATABASE_BOOTSTRAP` e as duas `MASTER_USER_*`),
que aplica todas as migrations e os seeds e precisa ficar saudável (o
próprio `HEALTHCHECK`); e sobe a API de novo, que precisa passar no
próprio HEALTHCHECK, responder este commit em `/health/liveness` e 200 em
`/health/readiness`. Se falhar, nada vai para o GHCR. Os pushes seguintes
publicam os mesmos builds, do cache do builder. Uma imagem de migração
reaproveitada é baixada do GHCR por digest e é ela que roda no smoke test: é
a que o deploy vai rodar.

Permissões: o workflow inteiro tem `contents: read`; só `build-and-push`,
`deploy-staging` e `promote-production` pedem `packages: write`;
`staging-image` pede `packages: read`; `release` pede `contents`, `issues` e
`pull-requests: write`. Todas as actions são fixadas por SHA de commit, com a
versão em comentário (o teste `supply-chain.test.ts` recusa uma tag solta).

### Um vermelho é sempre do código

Regra dos três repositórios desde 30/10/2026: um pipeline vermelho quer
dizer que o código (ou uma dependência que o próprio commit mudou) está
errado — nunca a rede, um registry, uma tag que andou ou um passo que travou.
"Rodar de novo" não é correção. O que garante isso aqui (e os testes que
guardam cada item, em `tests/unitaires/lifecycle`):

| Causa de vermelho (ou verde) falso                                                                                      | O que o pipeline faz agora                                                                                                                                                                                                                                                                                                                                                     | Teste                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Um aviso CRITICAL publicado hoje reprovava o push de qualquer commit, até de documentação                               | `.github/scripts/audit-gate.sh`: o `audit-ci` bloqueia só o push ou PR que muda `package.json`, `yarn.lock` ou `package-lock.json` (em qualquer pasta) ou o `audit-ci.jsonc`, ou que não tem base para comparar (branch nova, _Run workflow_, base fora do checkout). Nos outros, roda e relata: `::warning::` e o relatório no resumo do job. O vigia contínuo é o Dependabot | `audit-gate.test.ts`                                     |
| Uma consulta ao GHCR com erro passageiro virava "a tag não existe" (`2>/dev/null \|\| true`)                            | `.github/scripts/ghcr.sh`: só o "not found" do GHCR é resposta vazia; qualquer outro erro repete (5 tentativas, pausa de 5 s dobrando, `::warning::` com a contagem) e depois falha dizendo que o GHCR está fora. Mover uma tag também repete (é idempotente)                                                                                                                  | `ghcr-script.test.ts`, `staging-deploy-workflow.test.ts` |
| O download do banco do Trivy (com limite de taxa) duas vezes por run, escondido junto com os achados                    | um download por run, com retentativa, num diretório que o cache do Actions guarda por dia; o scan usa `--skip-db-update`. Falha no download usa a cópia do cache; sem cópia, o scan não roda e o resumo diz isso. Só um achado reprova, e só com `IMAGE_SCAN_ENFORCE=true`                                                                                                     | `ci-stability.test.ts`                                   |
| Os pesos PP-OCRv5 da IA baixados de `www.modelscope.cn` em todo build sem cache (um pedido, sem retentativa)            | versionados em `infra/ai-ocr/models` (4,8 e 7,9 MB) e conferidos pelo `models.sha256` num `RUN --network=none`; o job `ai-ocr` usa o Buildx com o cache do GitHub                                                                                                                                                                                                              | `image-layers.test.ts`, `ci-stability.test.ts`           |
| O `postinstall` do `@prisma/engines` baixa o schema engine de `binaries.prisma.sh` e falha calado                       | cache de `~/.cache/prisma` pela versão dos engines; o job `test` confere o engine antes do E2E e baixa de novo (até 3 vezes); o `Dockerfile` faz o mesmo no `yarn install` da imagem de migração (a única que leva o CLI) e para o build com a causa                                                                                                                           | `ci-stability.test.ts`, `image-layers.test.ts`           |
| Um erro de rede no `git ls-remote` dos irmãos caía calado na branch padrão                                              | só o código 2 ("a branch não existe") cai na padrão, com `::notice::`; outro código repete 3 vezes (10 s, 20 s) e falha                                                                                                                                                                                                                                                        | `compose-ci-siblings.test.ts`                            |
| `git ls-remote \| cut` sem `pipefail`: uma falha virava "este run não é o head" e o deploy de staging era pulado, verde | `defaults.run.shell: bash` (`-eo pipefail`) nos três workflows; a leitura do head repete 3 vezes e só um sha válido decide; a leitura dos pais do merge (`gh api`) também repete                                                                                                                                                                                               | `ci-stability.test.ts`, `promote-workflow.test.ts`       |
| Um erro passageiro da borda zerava a janela de 90 s da conferência pela liveness                                        | só uma resposta de outro commit zera; sondagem sem resposta não zera, e cada sequência delas vira `::warning::` com a contagem ([seção 14](#14-conferir-a-convergência))                                                                                                                                                                                                       | `wait-for-version.test.ts`                               |
| As retentativas do deploy no Dokploy só apareciam no log                                                                | cada retentativa (pedido, consulta, deploy) é `::warning::` com a contagem, e o resumo do job lista cada tentativa que falhou com o motivo do Dokploy                                                                                                                                                                                                                          | `dokploy-deploy.test.ts`                                 |
| Uma exportação de cache que falhava (429 ou 5xx do serviço de cache) derrubava o build já publicado                     | todo `cache-to: type=gha` com `ignore-error=true`                                                                                                                                                                                                                                                                                                                              | `ci-stability.test.ts`                                   |
| Um passo travado segurava o runner até 6 h                                                                              | `timeout-minutes` em todo job, com folga sobre o pior medido: `test` 90, `ai-ocr` 30, `secrets` 10, `build-and-push` 45, `deploy-staging` 120, `staging-image` 60, `release` 20, `promote-production` 120; no `ci.yml`, `validate` 30, `ai-ocr` 30, `secrets` 10, `ai-local-e2e` 45                                                                                            | `ci-stability.test.ts`                                   |
| Um commit `[skip ci]` só de documentação na ponta da `staging` travava a promoção                                       | a regra de documentação abaixo ([seção 16](#16-promover-para-produção)); e o run do commit de código logo abaixo de uma ponta só de documentação implanta mesmo assim (`docs-only.sh`, testado no `ci-stability.test.ts`)                                                                                                                                                      | `staged-build.test.ts`, `promote-workflow.test.ts`       |

Uma borda do `audit-gate.sh`: a base do push é o `before`. Uma mudança de
dependência que chegue à `staging` sem run próprio (num `[skip ci]`, o que a
regra de documentação proíbe, ou num run pendente que o GitHub trocou pelo do
push seguinte) não entra no diff do push seguinte, e ali o achado só avisa. A
produção continua protegida: o PR `staging → main` compara com a `main`, vê a
mudança e bloqueia.

O que continua dependendo de fora, de propósito: o npm (instalação e o
endpoint de auditoria; o `audit-gate.sh` repete 3 vezes um audit que não
rodou e nunca o confunde com aviso de segurança), o PyPI, o
Docker Hub, o GHCR e o GitHub. Os testes não falam com mais ninguém (a trava
de rede do `setupTests.ts`, [`testes.md`](./testes.md#nenhuma-rede-de-fora)).

### Versões fixas

O mesmo commit testa e publica sempre nas mesmas versões:

- **Node**: `node-version: "22.21.1"` em todo `actions/setup-node` dos três
  workflows, a mesma versão da base do `Dockerfile` (`node:22.21.1-alpine`).
  Antes era `"22"`, que andava com o _toolcache_ do runner. Quando o
  Dependabot sobe a base do `Dockerfile`, suba o `node-version` dos
  workflows no mesmo PR: o `ci-stability.test.ts` falha enquanto os dois
  não batem.
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
`staging` daquele serviço ao digest anterior (último passo do job). O que o
script pega e um webhook não pegaria: imagem que o Dokploy não consegue
puxar (credencial do GHCR errada, tag inexistente), chave ou id errados. Por
isso a API usa a chave de API e o id de cada Application, e não o webhook de
redeploy (que responde assim que enfileira e nunca diz se deu certo). A web
usa o mesmo script, numa cópia que um teste dela compara com esta
(`trajetto-ui/docs/deploy.md`).

**A IA só é reimplantada quando muda.** A imagem `trajetto-ai` era
reconstruída a cada push e ganhava um digest novo toda vez (labels), e o
passo de deploy dela não tinha condição: todo push da API reiniciava a IA e
mandava ~200 MB pela rota instável da VPS. Agora o `build-and-push` acha a
imagem pelo hash git de `infra/ai-ocr` (tag `src-<hash>`) e a reaproveita
quando o código da IA não mudou, e o `deploy-staging` pula o deploy da IA
quando o digest é o mesmo que a tag `staging` já aponta; a promoção faz o
mesmo com a tag `stable`. Um deploy da IA que falha devolve a tag do
ambiente ao digest anterior, para a comparação seguinte não pular um deploy
que não aconteceu. Para forçar (correção que chegou à imagem base sem mudar
o digest, IA fora do lugar): _Actions_ → _Pipeline (staging → produção)_ →
_Run workflow_ com **force_ai_build** marcado — na branch `staging`
reconstrói e reimplanta a IA de staging; na `main`, junto com o
`image_tag`, reimplanta a IA de produção.

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
([seção 18](#18-backup-e-restauração)).

| Serviço (App Name em produção)    | Tipo no Dokploy       | Imagem                                   | Porta interna  | Réplicas                              | Health                                                                       | Limites                        |
| --------------------------------- | --------------------- | ---------------------------------------- | -------------- | ------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------ |
| `trajetto-api-production`         | Application (Docker)  | `trajetto-api:stable`                    | 3333 (domínio) | 2, rolling `start-first` com rollback | liveness no Swarm (`/health/liveness`)                                       | memória 1 GiB, heap 768 MB     |
| `trajetto-ai-production`          | Application (Docker)  | `trajetto-ai:stable`                     | 8080           | 1                                     | `GET /health` (200 depois do aquecimento)                                    | memória 1 GiB, 2 CPUs          |
| `trajetto-api-migrate-production` | Application (Docker)  | `trajetto-api-migrate:stable`            | nenhuma        | 1, _Restart Policy_ `none`            | o da imagem: saudável quando a etapa de release terminou; depois fica parado | nenhum (alguns MB parado)      |
| `trajetto-postgres-production`    | Database → PostgreSQL | `postgres:16-alpine` (fixado por digest) | 5432           | 1                                     | do Dokploy                                                                   | sem teto, de propósito         |
| `trajetto-redis-production`       | Database → Redis      | `redis:7-alpine`                         | 6379           | 1                                     | do Dokploy                                                                   | memória 512 MiB (dados 256 MB) |

Em staging, troque `-production` por `-staging` e `:stable` por `:staging`.

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

| O compose fazia                                                                                      | Agora                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| variáveis obrigatórias (`${VAR:?mensagem}`) derrubavam o deploy                                      | **API**: o schema de ambiente derruba o boot sem `DATABASE_URL`, `REDIS_URL`, `JWT_*`, `MASTER_USER_*`, `HTTP_REQUEST` e, em produção, sem `RATE_LIMIT_TRUSTED_PROXY` e as `R2_*`. **IA**: o serviço recusa subir com `AI_TOKEN` ausente ou curto. **`APP_ENV`: nada obriga.** Vazia, a API segue o `NODE_ENV=production` da imagem e se comporta como produção; confira no staging                                                                                                                                                         |
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
| job de migrations na rede `<stack>_backend`, lendo o env de `<stack>_api`                            | a Application `trajetto-api-migrate` de cada ambiente, na `dokploy-network`, com o próprio _Environment_ (só a URL do banco) e o deploy pedido pelo pipeline antes da API ([seção 15](#15-migrations))                                                                                                                                                                                                                                                                                                                                      |

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

   | Campo             | Valor                                                                                                        |
   | ----------------- | ------------------------------------------------------------------------------------------------------------ |
   | Name              | `trajetto-postgres`                                                                                          |
   | App Name          | `<o App Name sugerido>` (marcador neste documento: `trajetto-postgres-staging` ou `-production`; seção 7.2)  |
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
6. O backup do banco é a aba _Backups_ deste Database (seção 7.9): diário,
   para o Cloudflare R2, configurado na
   [seção 18](#18-backup-e-restauração).

### 7.5 Redis (Database)

1. **Create Service → Database → Redis**.
2. Preencha: Name `trajetto-redis`; App Name `<o App Name sugerido>`
   (marcador: `trajetto-redis-staging` ou `-production`; seção 7.2); Database
   Password `openssl rand -hex 32` (guarde); Docker Image `redis:7-alpine`.
3. **Create** e **Deploy**. _External Port_ vazio.
4. **Sem persistência e com teto de memória** (era o comando do compose): o
   Redis só guarda chaves curtas que expiram sozinhas (contadores do rate
   limit, tickets de socket, o intervalo do "esqueci minha senha" e fotos de
   5–60 s das leituras do MASTER) e o pub/sub do Socket.IO
   ([ADR 0002](./adr/0002-redis-descartavel.md)); um snapshot só traria de volta chaves que deviam ter expirado, e o
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

   DATABASE_URL=postgresql://trajetto:<SENHA_DO_POSTGRES>@trajetto-postgres-production:5432/trajetto?schema=public&connection_limit=10&pool_timeout=20&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=-c%20statement_timeout%3D30000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000
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
   META_WHATSAPP_TEMPLATE_NAME=trajetto_notification
   META_WHATSAPP_API_VERSION=v23.0
   RESEND_SECRET_KEY=<re_…>
   RESEND_FROM_EMAIL=<remetente do domínio verificado>
   ```

   Mais, quando forem usadas: `META_WHATSAPP_CUSTOMER_TEMPLATE_NAME`,
   `META_WHATSAPP_BUSINESS_ACCOUNT_ID`, `META_WHATSAPP_APP_SECRET`,
   `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `RESEND_WEBHOOK_SECRET`,
   `TURNSTILE_SECRET_KEY` (definida, o formulário de orçamento exige o token
   do Turnstile), `RATE_LIMIT_EDGE_SECRET`, o
   certificado do comprovante (`PROOF_SIGNING_*`), mapa e geocoder
   (`PROOF_MAP_*`, `REVERSE_GEOCODER_*`), `MIN_MOBILE_CONTRACT`,
   `MOBILE_STORE_URL`, `ACTIVITY_RETENTION_DAYS`.

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

   _Stop Grace Period_ (se existir na sua versão): `40000000000` (40 s; o
   desligamento ordenado da API termina em até 35 s). Sem o campo, o contorno
   é `docker service update --stop-grace-period 40s trajetto-api-production`
   no host depois de cada deploy (o deploy seguinte o desfaz); ver a lacuna
   na [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora).

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
   GitHub, _Actions → Pipeline (staging → produção) → Run workflow_ (branch
   `main`), `image_tag = sha-<7>` de um build verde de staging, e aprove o
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
construída no job `build-and-push` (do stage `runtime`, depois de o pytest
passar no stage `test`) e promovida junto com a API (`staging` e `stable`).
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

| Do lado da API (Application `trajetto-api`)                    | Do lado da IA (Application `trajetto-ai`) | Observação                                                      |
| -------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `AI_PROVIDER=local`                                            | —                                         | `local` é o padrão; `none` desliga as leituras                  |
| `AI_LOCAL_URL=http://<App Name da IA>:8080`                    | escuta na 8080                            | o App Name é o nome de rede na `dokploy-network`                |
| `AI_LOCAL_TOKEN`                                               | `AI_TOKEN`                                | **o mesmo valor**, digitado nas duas Applications               |
| `AI_LOCAL_TIMEOUT_MS` (15 000), `AI_LOCAL_MAX_CONCURRENCY` (1) | `AI_MAX_QUEUE` (2), `OCR_THREADS` (2)     | opcionais; `OCR_THREADS` = o limite de CPU da Application da IA |

Trocar o token: gere outro (`openssl rand -hex 32`), salve em `AI_TOKEN` da
IA e em `AI_LOCAL_TOKEN` da API e faça **Deploy** das duas, IA primeiro.
Entre os dois deploys a leitura que estiver em andamento falha com 401, sem
nova tentativa, e a API pausa os envios por 5 minutos (dobrando até 1 hora)
para não falhar o resto da fila, que espera em `PENDING` e anda quando o
token volta a bater. Faça os dois deploys em seguida.

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
  chaves curtas que expiram sozinhas e o pub/sub do Socket.IO
  ([ADR 0002](./adr/0002-redis-descartavel.md)); não precisa de backup nem de
  restore.
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
| Pipeline (`deploy-staging`; na promoção com `ROLLOUT_VERIFY=http`)             | `GET <API_PUBLIC_URL>/health/liveness` a cada 5 s, até 600 s | a mesma liveness responde `version` e `commit` (o commit do build); o deploy só fica verde depois de a API pública responder o commit novo por 90 s seguidos ([seção 14](#14-conferir-a-convergência))                                                           |
| `/health/readiness`                                                            | consultada pelo monitor externo e pelo desligamento          | **readiness**: pode receber tráfego. Banco fora → 503. Vira 503 durante o desligamento ordenado (12 s antes de fechar). O Traefik não a consulta mais (lacuna da [seção 5](#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora))                 |
| Swarm (`trajetto-ai`)                                                          | `GET http://127.0.0.1:8080/health`                           | 200 só depois de carregar os dois perfis e ler a foto de aquecimento; responde também `version` e `commit`                                                                                                                                                       |
| Databases (Postgres e Redis)                                                   | o que o Dokploy configura                                    | conferência manual: `pg_isready`; `redis-cli -a … ping`                                                                                                                                                                                                          |
| Monitor externo                                                                | `/health/readiness` da API e `/api/health` da web, 1/min     | uptime ([seção 20](#20-alertas-e-monitoramento))                                                                                                                                                                                                                 |

Outras rotas: `/health/metrics` (filas, workers, crons, pool, certificado) e
`/health/providers` (prontidão dos provedores), ambas só MASTER.

## 13. Configurar o GitHub

### Environments

No repositório `Trajetto-Organization/trajetto-api`: _Settings →
Environments_. Para cada nome abaixo: _New environment_ (se não existir) →
_Add environment secret_ / _Add environment variable_.

**`staging`** (sem revisores; o deploy de staging é automático):

| Tipo     | Nome                                                                                    | Valor                                                                                                                                                                                                      | Obrigatório?                                                                               |
| -------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| secret   | `DOKPLOY_URL`                                                                           | URL do painel, **https**: `https://dokploy.intrajetto.com`, pela Cloudflare (nunca o IP, que o firewall fecha; o script recusa http)                                                                       | sim (com os três abaixo; nenhum dos quatro = deploy pulado com aviso)                      |
| secret   | `DOKPLOY_API_KEY`                                                                       | a chave da seção 7.10                                                                                                                                                                                      | sim                                                                                        |
| secret   | `DOKPLOY_API_APPLICATION_ID`                                                            | applicationId da `trajetto-api` de staging                                                                                                                                                                 | sim                                                                                        |
| secret   | `DOKPLOY_MIGRATE_APPLICATION_ID`                                                        | applicationId da `trajetto-api-migrate` de staging ([seção 15](#15-migrations))                                                                                                                            | sim                                                                                        |
| secret   | `DOKPLOY_AI_APPLICATION_ID`                                                             | applicationId da `trajetto-ai` de staging                                                                                                                                                                  | não (sem ele: aviso e a IA não é atualizada)                                               |
| variable | `API_PUBLIC_URL`                                                                        | a origem pública da API de staging, `https://api-staging.intrajetto.com` (sem barra no fim): o pipeline espera a `/health/liveness` dela responder o commit novo ([seção 14](#14-conferir-a-convergência)) | sim, enquanto `ROLLOUT_VERIFY` não for `off` nem `ssh` (é a conferência padrão do staging) |
| variable | `SWARM_API_SERVICE`                                                                     | `trajetto-api-staging` (o App Name da API)                                                                                                                                                                 | só com `ROLLOUT_VERIFY=ssh`                                                                |
| secrets  | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY` | conferência do rollout ([seção 14](#14-conferir-a-convergência)); podem ficar no repositório, já que os dois ambientes dividem o host                                                                      | só com `ROLLOUT_VERIFY=ssh`                                                                |

Sem o `DOKPLOY_MIGRATE_APPLICATION_ID`, com os outros três definidos, o job
falha logo no começo ("configuração parcial"), antes de qualquer tag andar: a
imagem da API não migra e não sobe num banco sem as migrations dela.

**`production`** — marque **Required reviewers** (você e quem mais puder
aprovar uma ida para produção) e, em _Deployment branches and tags_,
_Selected branches and tags_ → `main` (o _Run workflow_ de rollback também
roda a partir de `main`):

| Tipo     | Nome                                                                                    | Valor                                                                                      |
| -------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| secret   | `DOKPLOY_URL`, `DOKPLOY_API_KEY`                                                        | os mesmos do staging (um painel só)                                                        |
| secret   | `DOKPLOY_API_APPLICATION_ID`                                                            | applicationId da `trajetto-api` de produção                                                |
| secret   | `DOKPLOY_MIGRATE_APPLICATION_ID`                                                        | applicationId da `trajetto-api-migrate` de produção ([seção 15](#15-migrations))           |
| secret   | `DOKPLOY_AI_APPLICATION_ID`                                                             | applicationId da `trajetto-ai` de produção                                                 |
| variable | `API_PUBLIC_URL`                                                                        | a origem pública da API de produção; só é lida com `ROLLOUT_VERIFY=http` neste environment |
| variable | `SWARM_API_SERVICE`                                                                     | `trajetto-api-production`                                                                  |
| secrets  | `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS`, `DEPLOY_VERIFY_SSH_KEY` | conferência do rollout (só sem `ROLLOUT_VERIFY=http`)                                      |

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
| secret   | `CLIENT_REPOS_READ_TOKEN` | token só leitura de `Trajetto-Organization/trajetto-ui` e `Trajetto-Organization/trajetto-mobile` (fine-grained, _Contents: Read-only_), para o contrato de rotas do `ci.yml`                                                                                                                                                                                                                                               |

**Apague se existirem** (não são mais lidos por nada):
`DOKPLOY_COMPOSE_ID` (dos dois environments: era o id do app Compose), as
variáveis `STAGING_ENABLED` e `MIGRATIONS_VIA_JOB` (as migrations rodam pela
Application `trajetto-api-migrate` desde 31/10/2026), o secret
`DEPLOY_SSH_KEY` (a chave do antigo caminho por SSH das migrations, se chegou
a ser criada) e os secrets `PORTAINER_WEBHOOK_URL` e
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

E uma chave **só para isso** no `~/.ssh/authorized_keys` do usuário de deploy
— ela só lê:

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

| Quando                                     | Quem chama                                                                                                                         | O que acontece numa migration que falha                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| deploy de staging                          | `deploy-staging`, passo _Run the database migrations on staging (Dokploy)_, com a imagem de migração **deste commit**              | o passo falha; nenhuma tag da API ou da IA anda, elas não são reimplantadas e o staging segue no build que roda |
| promoção (merge em `main`, _Run workflow_) | `promote-production`, passo _Run the database migrations on production (Dokploy)_, com a imagem de migração **do build promovido** | o passo falha; `stable` não anda, nada é reimplantado e as réplicas de produção nem percebem                    |

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
   30 min (`RELEASE_TIMEOUT_SECONDS`). Só as novas contam: com o _Update
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

1. Abra o PR `staging → main`; espere os checks (inclusive _The PR head was
   built on staging_).
2. Merge com **Create a merge commit**.
3. _Actions_ → o run do push em `main` → job _Promote to production_ →
   _Review deployments_ → aprovar o environment `production`.
4. O job resolve o commit (o head do PR), exige o marcador
   `staged-<7>` das duas imagens no mesmo digest (o staging rodou este
   build; espera até 20 min se o deploy de staging dele ainda estiver em
   andamento, em vez de falhar pedindo um _re-run_), ou usa o build do commit
   mais próximo que o staging rodou, se o merge só muda documentação desde
   ele (abaixo), compara com o staging, roda as migrations se a produção
   ainda não aplicou a imagem de migração do build (Application
   `trajetto-api-migrate`; [seção 15](#15-migrations)), move `stable`
   das duas imagens, pede o deploy
   das Applications de produção (IA → API; a IA só se o digest dela mudou) e
   espera a convergência. Verde = o Swarm roda o digest promovido em todas as
   réplicas da API. O digest fica no resumo do run.
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
documentação passou a ser seguro**: suba o doc sozinho com `[skip ci]` na
mensagem (nenhum workflow roda, nenhum minuto de runner), e o check do PR
`staging → main` e a promoção aceitam o build do commit anterior (com os
dois cuidados do próprio GitHub listados no fim desta seção).

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
pipeline do commit de código anterior ainda roda (cerca de 1 hora). O
`deploy-staging` daquele run vê na `staging` uma cabeça mais nova, mas, como
ela só acrescenta documentação ao commit dele (`docs-only.sh`), implanta e
grava o `staged-<7>` mesmo assim. Antes, ele saía verde sem implantar, o
commit de documentação não tinha run, e a promoção travava até o próximo
push. Se a cabeça mais nova muda qualquer outro arquivo, o run mais velho
continua saindo sem mexer no staging, e o run da cabeça faz o deploy.

Dois cuidados do próprio GitHub, que nenhuma regra daqui contorna:

- **A ponta do PR `staging → main` com `[skip ci]`**: o GitHub também não
  roda os workflows de `pull_request` quando o commit da ponta do PR tem
  `[skip ci]` na mensagem, e os quatro checks exigidos em `main`
  ([seção 13](#13-configurar-o-github), "Proteção das branches") ficam
  pendentes. Para destravar, rode _Run workflow_ do _Pipeline (staging →
  produção)_ na branch `staging`: a validação, o build e o deploy de staging
  daquele commit rodam, e os checks saem no mesmo commit e aparecem no PR
  (o _The PR head was built on staging_ aparece como pulado, o que o GitHub
  conta como aprovado). Um commit vazio sem `[skip ci]`
  (`git commit --allow-empty`) também destrava. Os dois custam um pipeline
  inteiro: o `[skip ci]` economiza de verdade quando o commit de
  documentação não vai ser a ponta de um PR para `main` aberto ou
  atualizado logo depois.
- **O título do PR**: num PR de um commit só, o GitHub preenche o título com
  a mensagem desse commit, e o título vai para o corpo do merge commit. Com
  `[skip ci]` ali, o push em `main` não roda o `deploy.yml` e nada é
  promovido. Tire o `[skip ci]` do título antes do merge.

Cuidado: a regra vale só para `*.md` e `docs/`. Um commit que mexe num
teste, num workflow, num script ou no `.dockerignore` precisa do pipeline
de staging, mesmo que pareça inofensivo. E os testes que leem a
documentação (`tests/unitaires/docs`, os guias de agente) só rodam no
próximo push que roda o pipeline: se eles falharem ali, a correção é no
doc.

## 17. Rollback

Um build anterior a 31/10/2026 (`main-<sha>` e os `sha-<7>` de antes da
imagem de migração) volta a migrar no boot se a `trajetto-api` não tiver
`RUN_MIGRATIONS_ON_BOOT=false` no _Environment_: ele lê a variável com
padrão `true` ([seção 15](#15-migrations)). Confira antes de voltar para um
deles.

### Caminho normal: promover o build bom

1. Achar a tag boa: o resumo de uma promoção anterior registra
   `trajetto-api:stable → sha-<7> (sha256:...)`; ou o job _Build and push
   the images (once)_ do push em `staging` que gerou o build.
2. _Actions_ → _Pipeline (staging → produção)_ → _Run workflow_ (branch
   `main`) → `image_tag = sha-<7>` (builds antigos: `main-<sha>`).
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

### Quando o Swarm desiste de um serviço

Nenhuma Application tem limite de tentativas (`MaxAttempts: 0`). Se uma
réplica ainda assim ficar parada, **Deploy** da Application no painel (ou
`docker service update --force <App Name>`) recria as tasks.

## 18. Backup e restauração

Decisão do dono (26/10/2026, final): **o único backup do banco é o Backup do
próprio Database PostgreSQL no Dokploy**, gravado no Cloudflare R2. O antigo
serviço `trajetto-backup` (imagem própria, `pg_dump` cifrado com age, heartbeat
de 1 dia) saiu do código e do pipeline; nada no repositório agenda backup.

|                   |                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Quando**        | uma cópia por dia, às 03:00 UTC (antes do primeiro job que apaga dados, 03:17 UTC)                                  |
| **Retenção**      | as 30 cópias diárias mais recentes, ou seja, 30 dias; não há cópias semanais nem mensais                            |
| **RPO**           | até 24 h                                                                                                            |
| **RTO**           | medido no ensaio de 15/09/2026: 10,5 s de restore para 94 MB (cresce com o volume; a parte lenta é recriar índices) |
| **Cifra**         | as cópias **não** são cifradas por nós; o R2 cifra tudo em repouso (do lado do provedor)                            |
| **PITR**          | **não existe** (exigiria WAL archiving com wal-g)                                                                   |
| **Arquivos (R2)** | fora do dump ("O que o dump não cobre", abaixo)                                                                     |

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
4. Volte as réplicas da API para `2` (**Save** → **Deploy**) e religue o
   backup.

Um banco restaurado traz `_prisma_migrations` e passa pela guarda de banco
vazio. Se o dump é mais velho que o build no ar, a API recusa subir até as
migrations que faltam rodarem: antes de voltar as réplicas (passo 4), dê
**Deploy** na Application `trajetto-api-migrate` do ambiente e espere a
tarefa ficar `Running` (aba _Logs_: "etapa de release concluída"). Não conte
com o pipeline para isso: a tag `<ambiente>-applied` diz que a imagem de
migração já rodou **no banco de antes**, e o próximo run pularia a etapa. O
Deploy manual aplica as migrations que o dump não tem
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
anterior ao código: há migrations pendentes"). O contêiner é removido ao
final (`KEEP_CONTAINER=true` preserva).

Ensaios feitos: 14/09/2026 (72 migrations do zero, 49 tabelas, 2 s, os cinco
índices de SQL cru e o `pg_trgm` sobreviveram) e 15/09/2026 com volume (banco
de carga de 94 MB: dump de 4,3 MB em 1,5 s, restore em 10,5 s, a API subiu, as
telas de torre, entregas e dashboard responderam e o smoke do k6 passou 12/12,
inclusive escrita na tabela particionada). Falta o ensaio mensal com uma cópia
real do Dokploy (restore pela aba _Backups_ num Database descartável).

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
(~2.400 pontos por motorista num dia de 10 h). O backup do Dokploy leva sempre
a base inteira, trilha inclusive: quando o dump passar a levar tempo demais
(e a segurar um snapshot que impede o autovacuum das filas), a decisão volta
para cá. O `backup-postgres.sh` (manual) tem dois controles só dele, passados
na linha de comando (não são variáveis de Application):

| Variável                    | Efeito                                                                 |
| --------------------------- | ---------------------------------------------------------------------- |
| `BACKUP_EXCLUDE_TRAIL=true` | mantém o schema da trilha e deixa as linhas de fora                    |
| `BACKUP_TRAIL_ONLY=true`    | dump **só** da trilha, num arquivo `<banco>-trail-<data>.dump` à parte |

Restaurar um dump só da trilha:
`pg_restore -d <banco> --data-only --no-owner --no-privileges --exit-on-error <banco>-trail-<data>.dump`
(partições de dias antigos precisam ser criadas antes; o job de partições só
cria de −1 a +7 dias).

### Pendências registradas

WAL archiving/PITR (imagem derivada com wal-g e um restart planejado);
ensaio mensal com uma cópia real do Dokploy; Bucket Lock nos prefixos de
prova; réplica de leitura/HA; retenção da trilha por plano (gatilho: mais de
2 mil motoristas ativos/dia ou `driver_position` acima de 50 GB).

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
  Desde o SIGTERM, a fila de importação recusa planilhas novas (429
  `IMPORT_BUSY`), fecha na hora as que esperavam ("não iniciada: envie de
  novo"), dá até 15 s à que está rodando e depois a para entre duas linhas,
  com o relatório até ali (mais 5 s para ela parar e 2 s para gravar o que a
  fila fechou: até 22 s); tudo antes dos workers (ADR
  [0001](./adr/0001-filas-e-mensageria.md)).

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
   DATABASE_URL=postgresql://...?schema=public&connection_limit=4&pool_timeout=10&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=...
   ```
   Sem domínio, 1 réplica, o mesmo _Swarm Settings_ e _Resources_ da API.
   **Atenção**: o `deploy.yml` só faz o deploy de `trajetto-ai` e
   `trajetto-api`. Um worker exige um passo a mais no
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
7. O backup do banco não tem heartbeat: a falha chega pela notificação do
   próprio Dokploy (_Settings → Notifications_, evento de backup de
   Database), como na [seção 18](#18-backup-e-restauração).

### Primeira ação por motivo

| Motivo começa com                                     | Primeiro passo                                                                                                                                                                      |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Canal WHATSAPP: falha de credencial`                 | token da Meta vencido/revogado: gerar token de sistema novo no Business Manager e atualizar `META_WHATSAPP_ACCESS_TOKEN`; as falhas estão em `/health/dead-letter?channel=WHATSAPP` |
| `Canal EMAIL: falha de credencial`                    | chave do Resend revogada ou domínio desverificado                                                                                                                                   |
| `Canal PUSH: falha de credencial`                     | a credencial FCM V1 do projeto no EAS (`eas credentials`), ou o _Enhanced Security for Push Notifications_ ligado no projeto Expo: a API não envia token de acesso da Expo          |
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

| Controle                                                             | Onde                                                                                                                  | Quando falha                                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependabot (npm, actions, imagens base, pip da IA, compose de carga) | `.github/dependabot.yml`, PRs contra `staging`                                                                        | não falha: abre PRs toda segunda; majors de Node e o motor de OCR ficam de fora de propósito                                                                |
| Actions fixadas por commit                                           | todo `uses:` dos workflows, com `# vX.Y.Z`                                                                            | `supply-chain.test.ts` recusa um `uses:` por tag                                                                                                            |
| Imagens base por digest                                              | `Dockerfile`, `infra/ai-ocr/Dockerfile`; nos workflows, os serviços, o smoke test, o BuildKit, gitleaks e Trivy       | `supply-chain.test.ts` e `ci-stability.test.ts`                                                                                                             |
| Serviço de IA                                                        | rodas Python com `--require-hashes`, modelos versionados em `infra/ai-ocr/models` e conferidos contra `models.sha256` | o build falha num hash diferente; o pytest roda dentro da imagem                                                                                            |
| Gate de audit                                                        | `.github/scripts/audit-gate.sh` (o `audit-ci` fixado) no `ci.yml` e no `deploy.yml`, config em `audit-ci.jsonc`       | advisory CRITICAL numa dependência de produção sem entrada na allowlist, num push ou PR que muda dependência (ou o `audit-ci.jsonc`); nos outros, só relata |
| SBOM e proveniência                                                  | `build-push-action` (`sbom: true`, `provenance: mode=max`)                                                            | não falha: anexa as atestações à imagem no GHCR                                                                                                             |
| Scan da imagem (Trivy)                                               | depois do push, por digest, com o banco de vulnerabilidades baixado uma vez e guardado no cache do Actions            | só um achado, e só com `IMAGE_SCAN_ENFORCE=true`; falha no download ou erro do Trivy viram aviso                                                            |
| Varredura de segredos (gitleaks)                                     | job `secrets` do `ci.yml` e do `deploy.yml`                                                                           | um segredo novo em qualquer commit do histórico                                                                                                             |

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
resumo do job, sem reprovar: o aviso já está na árvore que roda, quem abre a
correção é o Dependabot (_alerts_ e _security updates_), e a próxima mudança
de dependência passa pelo portão de verdade. Um aviso que aparece assim é
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
`main`/`staging`, não reescreva — já foi rotacionado). Só entra no
`.gitleaksignore`, pela fingerprint (`commit:arquivo:regra:linha`), um falso
positivo ou um segredo já rotacionado. O job varre o histórico de **todas** as
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

## 23. Recursos da VPS e logs

| Serviço     | Limite (onde)                                                         |
| ----------- | --------------------------------------------------------------------- |
| API         | 2 × 1 GiB (_Resources_ da Application; heap 768 MB no `NODE_OPTIONS`) |
| Web         | 768 MiB (limite da Application; ver `trajetto-ui/docs/deploy.md`)     |
| Redis       | 512 MiB (_Resources_ do Database; dados 256 MB pelo comando)          |
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

|                             | API (`Trajetto-Organization/trajetto-api`)                                                                                                                                                                                                                                                                                                                                                                                                                               | Web (`Trajetto-Organization/trajetto-ui`)                                                                                                                                                                       | App (`Trajetto-Organization/trajetto-mobile`)                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Artefato                    | imagens `trajetto-api`, `trajetto-api-migrate` e `trajetto-ai` em `ghcr.io/trajetto-organization/`                                                                                                                                                                                                                                                                                                                                                                       | imagem `ghcr.io/trajetto-organization/trajetto-ui`                                                                                                                                                              | APK/AAB (EAS Build) e OTA (EAS Update)                                                                          |
| Onde roda                   | Dokploy, projeto `trajetto-api` de cada environment (`staging` e `production`): as Applications `trajetto-api` (2 réplicas, com domínio), `trajetto-api-migrate` (as migrations, antes do deploy que as muda) e `trajetto-ai` (sem domínio), puxando as imagens do GHCR, e os Databases PostgreSQL (com o backup diário do próprio Dokploy para o Cloudflare R2) e Redis                                                                                                 | Dokploy, projeto `trajetto-ui` de cada environment: a Application `trajetto-ui`, puxando a imagem do GHCR                                                                                                       | no celular do motorista (APK interno em staging, Play Store em produção)                                        |
| Nome no Dokploy / EAS       | App Names `trajetto-api-staging` e `trajetto-api-production` (e `trajetto-api-migrate-*`, `trajetto-ai-*`, `trajetto-postgres-*`, `trajetto-redis-*`)                                                                                                                                                                                                                                                                                                                    | Application `trajetto-ui` no projeto `trajetto-ui` de cada environment (App Names `trajetto-ui-staging` e `trajetto-ui-production`)                                                                             | perfis, ambientes e canais `staging` e `production`                                                             |
| Como o pipeline publica     | API do Dokploy (`.github/scripts/dokploy-deploy.mjs`): quando as migrations mudaram, primeiro a `trajetto-api-migrate`, esperando a etapa terminar (`dokploy-release.mjs`); depois `application.deploy` de cada Application, na ordem IA → API, a IA só quando o digest muda, acompanhando cada deployment até o fim e disparando de novo, até 6 vezes e com espera crescente, o que termina em erro; depois espera a `/health/liveness` pública responder o commit novo | API do Dokploy com o **mesmo** `.github/scripts/dokploy-deploy.mjs` (cópia comparada por teste): `application.deploy` da Application `trajetto-ui`, acompanhando o deployment, depois espera o `/build-id.json` | `eas update` e `eas build`                                                                                      |
| Secrets de deploy no GitHub | environments `staging` e `production`: `DOKPLOY_URL`, `DOKPLOY_API_KEY`, `DOKPLOY_API_APPLICATION_ID`, `DOKPLOY_MIGRATE_APPLICATION_ID` (obrigatórios) e `DOKPLOY_AI_APPLICATION_ID` (opcional); variáveis `API_PUBLIC_URL` (a conferência pela liveness) e `SWARM_API_SERVICE` (a conferência por SSH)                                                                                                                                                                  | environments `staging` e `production`: `DOKPLOY_URL`, `DOKPLOY_API_KEY` e `DOKPLOY_UI_APPLICATION_ID`                                                                                                           | `EXPO_TOKEN` (repositório) e `EXPO_UPDATE_PRIVATE_KEY` (environments `staging` e `production`)                  |
| Sem os secrets              | move as tags e pula o deploy com `::notice::`                                                                                                                                                                                                                                                                                                                                                                                                                            | move as tags e pula o deploy com aviso                                                                                                                                                                          | termina verde com aviso, sem publicar                                                                           |
| De staging para produção    | promove por digest a imagem `sha-<7 do commit>` (tag `staging` → `stable`), sem rebuild, e exige o marcador `staged-<7 do commit>` no mesmo digest                                                                                                                                                                                                                                                                                                                       | igual à API, e exige o marcador `staged-<7 do commit>` no mesmo digest                                                                                                                                          | promove o **commit** verde em staging (a URL da API é embutida no build, então o artefato não pode ser o mesmo) |
| Rollback                    | _Run workflow_ do `deploy.yml` com `image_tag=sha-<7>`                                                                                                                                                                                                                                                                                                                                                                                                                   | _Run workflow_ do `deploy.yml` com `image_tag=sha-<7>`                                                                                                                                                          | `ota-rollback.yml` (republica um grupo de OTA)                                                                  |

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

| Valor                             | API (Environment das Applications do projeto `trajetto-api`)                                                                                    | Web (Environment da Application)                                                         | App (ambiente EAS)                                                                    |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| URL pública da API                | o host na aba _Domains_ da Application `trajetto-api` e `API_HTTP_REQUEST` (a URL; dela sai o logo dos e-mails)                                 | `HTTP_REQUEST` (chamadas do servidor da web) e `PUBLIC_API_URL` (chamadas do navegador)  | `EXPO_PUBLIC_API_URL`                                                                 |
| Socket.IO                         | o mesmo host da API, com WebSocket liberado na borda                                                                                            | `PUBLIC_API_URL` (o socket roda na própria API; não há variável própria)                 | o socket usa `EXPO_PUBLIC_API_URL`                                                    |
| Origem da web                     | `HTTP_REQUEST` = a origem da web do ambiente (única origem do CORS e do Socket.IO, base dos links)                                              | `METADATA_BASE`                                                                          | `EXPO_PUBLIC_WEB_APPLICATION_URL` (links de Privacidade e Termos)                     |
| Limite de tentativas por IP       | `RATE_LIMIT_FORWARDER_SECRET`                                                                                                                   | `RATE_LIMIT_FORWARDER_SECRET`, **o mesmo valor**                                         | —                                                                                     |
| Captcha (Turnstile)               | `TURNSTILE_SECRET_KEY` (o mesmo widget da web; definida, exige o token)                                                                         | `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`                                            | —                                                                                     |
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
   Database PostgreSQL (destino S3 no R2, diário).
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
   workflow_ do `deploy.yml` da API com `image_tag=sha-<7>`, enquanto o
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
   rota que a web ou o app em produção ainda chamam.
2. **Web:** só depois. O gate de rotas do promote falha se a API de
   produção ainda não serve alguma rota que o build da web chama.
3. **App:** por último. Se o app passou a enviar algo novo, o
   `CLIENT_CONTRACT` (`utils/client-version.ts`) sobe e a API compatível já
   precisa estar em produção; `MIN_MOBILE_CONTRACT` só sobe depois que a OTA
   (ou o binário) com o contrato novo estiver publicada e os contratos
   antigos sumirem dos logs da API.
