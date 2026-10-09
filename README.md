# Trajetto — API

Back-end do Trajetto: a API HTTP, o tempo real (Socket.IO) e os processos de
fundo (filas e crons) que atendem o painel web (`trajetto-ui`), o aplicativo do
motorista (`trajetto-mobile`) e os sistemas dos clientes que se integram pela
API pública. Inclui também o serviço de IA local (`infra/ai-ocr`) e o serviço
de backup (`infra/backup`), publicados como imagens próprias.

> Software proprietário. Leia [Licença](#licença) antes de copiar qualquer coisa
> deste repositório.

## Sumário

- [O Trajetto em 1 minuto](#o-trajetto-em-1-minuto)
- [Documentação deste repositório](#documentação-deste-repositório)
- [O que a API faz](#o-que-a-api-faz)
- [Arquitetura em resumo](#arquitetura-em-resumo)
- [Rodando localmente](#rodando-localmente)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Scripts](#scripts)
- [Testes](#testes)
- [Documentação das rotas](#documentação-das-rotas)
- [Deploy: staging e produção](#deploy-staging-e-produção)
- [Operação e saúde](#operação-e-saúde)
- [Solução de problemas](#solução-de-problemas)
- [Onde está cada decisão](#onde-está-cada-decisão)
- [Licença](#licença)

## O Trajetto em 1 minuto

O Trajetto é uma plataforma B2B (SaaS multiempresa) para transportadoras, com
dois módulos vendidos separadamente por empresa:

- **Frotas** (`FLEET`): veículos, motoristas, abastecimentos com foto do
  odômetro, checklists veiculares, ordens de serviço, peças, fornecedores,
  multas, contas a pagar, filiais e um quadro Kanban.
- **Entregas** (`DELIVERIES`): documentos de entrega (manual, planilha ou XML
  de NF-e), embarcadores, rotas, torre de controle, monitoramento, ocorrências
  com formulário e autorização da torre, pausas do motorista, comprovante em
  PDF assinado, atendimento por ticket (chat), mensagens ao cliente final e a
  API pública com webhooks.

Três projetos formam o produto:

| Repositório no GitHub (pasta local)                 | O que é                                                           | Tecnologia                                          | Onde roda                           |
| --------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------- | ----------------------------------- |
| `trajetto-api` (este)                               | API, tempo real, filas, crons, IA local, backup                   | Node.js 22, Fastify, Prisma, PostgreSQL 16, Redis 7 | Dokploy, app Compose (Docker Stack) |
| `trajetto-fleet-manager-ui` (`trajetto-ui`)         | painel web (`/dashboard`, `/admin`), site público, portal `/docs` | Next.js 14 (App Router)                             | Dokploy, Application                |
| `trajetto-fleet-manager-mobile` (`trajetto-mobile`) | aplicativo de campo do motorista, só Android                      | Expo / React Native                                 | EAS (APK interno e Play Store)      |

## Documentação deste repositório

| Documento                                                          | Para quê                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`docs/arquitetura.md`](./docs/arquitetura.md)                     | como a API é por dentro: estrutura do código, anatomia de um módulo e como criar uma feature, processos, filas, tempo real, IA, comprovante, regras de migration, compatibilidade com o app, unicidade por empresa, ADRs            |
| [`docs/deploy.md`](./docs/deploy.md)                               | o caminho até a produção: branches, workflows, GHCR, Dokploy (staging e produção, passo a passo), IA, Postgres e Redis, borda, migrations, rollback, backup e restore, alertas, cadeia de suprimentos, checklist do primeiro deploy |
| [`docs/variaveis-de-ambiente.md`](./docs/variaveis-de-ambiente.md) | cada variável: para que serve, obrigatoriedade, segredo, formato, valor em dev/staging/produção e onde mora                                                                                                                         |
| [`docs/testes.md`](./docs/testes.md)                               | as suítes, como rodar, o que cada uma prova, cobertura, mutação e as regras para escrever testes                                                                                                                                    |
| [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md)            | o guia de trabalho para agentes de código (e um bom resumo para quem chega)                                                                                                                                                         |
| [`infra/traefik/README.md`](./infra/traefik/README.md)             | a configuração estática do Traefik do Dokploy                                                                                                                                                                                       |
| [`tests/load/README.md`](./tests/load/README.md)                   | o harness de carga e o que ele mediu                                                                                                                                                                                                |

## O que a API faz

Cada pasta de `src/modules/` é um domínio, com casos de uso (`usecases/`,
injetados com `tsyringe`), repositórios Prisma e seus gêmeos em memória
(`repositories/`) e DTOs. As rotas ficam em `src/routes/` e os esquemas zod em
`src/schemas/`. A tabela de módulos e prefixos HTTP, os papéis e as permissões
estão em [`docs/arquitetura.md`](./docs/arquitetura.md#papéis-permissões-e-módulos).

Regras que valem para toda rota:

- **Multiempresa.** Toda leitura e escrita é filtrada pela empresa da sessão
  (ou pela escolhida pelo MASTER no `/admin`). Um id de outra empresa recebe o
  mesmo 404 de um id inexistente. O guard de tenant roda em `preHandler`.
- **Dia de negócio.** `Business.timezone` define o "hoje" de cada empresa
  (`src/shared/time/business-day.ts`); o contêiner roda em UTC, sem `TZ`.
- **Erros com código** e mensagem em pt-BR (`PERMISSION_DENIED`,
  `MODULE_NOT_ENABLED`, `TENANT_INACTIVE`…).
- **Idempotência** com `Idempotency-Key` ou `client_submission_id`.
- **Listagens** do painel em NDJSON com paginação por página e uma linha
  final `meta`; seletores com cursor.

## Arquitetura em resumo

```
 navegador / app / ERP do cliente
            │ HTTPS + WebSocket
            ▼
 Cloudflare ─▶ Traefik (Dokploy) ─▶ api ×2 réplicas (mesma imagem)
                                     │  HTTP (Fastify) + Socket.IO
                                     │  workers + crons (WORKERS_ENABLED)
                     ┌───────────────┼──────────────────┬──────────────┐
                     ▼               ▼                  ▼              ▼
               PostgreSQL 16     Redis 7         trajetto-ai      Cloudflare R2
           dados + filas + crons  rate limit +   (OCR local,       (fotos, PDFs;
                                  pub/sub do     rede interna)     URLs assinadas)
                                  Socket.IO
```

- **Postgres é a fila**: outbox transacional e filas em tabelas com
  `FOR UPDATE SKIP LOCKED`; não há broker.
- **Redis é descartável**: só rate limit e o pub/sub do Socket.IO entre
  réplicas.
- **IA local**: o serviço `trajetto-ai` (RapidOCR em CPU) só transcreve; a API
  decide. Nenhum provedor externo.
- **Comprovante** em PDF assinado com o A1 ICP-Brasil quando configurado.

Detalhes em [`docs/arquitetura.md`](./docs/arquitetura.md).

## Rodando localmente

### Pré-requisitos

- Node.js 22 (a imagem usa `node:22.21.1-alpine`);
- Yarn 1 (o repositório usa `yarn.lock`);
- Docker com Docker Compose (Postgres e Redis de desenvolvimento).

### Passo a passo

```bash
# 1. Dependências
yarn install

# 2. Variáveis: a API lê SÓ o .env da raiz
cp .env.example .env
#    preencha pelo menos JWT_SECRET, JWT_SECRET_REFRESH_TOKEN,
#    MASTER_USER_EMAIL, MASTER_USER_INITIAL_PASSWORD e as POSTGRES_* / DATABASE_URL

# 3. Tudo de uma vez
yarn dev
```

`yarn dev` faz, em ordem:

1. sobe o Postgres e o Redis do `compose.development.yaml`
   (`database:dev:up`, `redis:dev:up`), em `127.0.0.1:5432` e `127.0.0.1:6379`;
2. espera o Postgres responder (`wait-for-postgres`);
3. gera o cliente Prisma e aplica as migrations (`prisma:migrate:deploy`);
4. no `postdev`: cria o usuário master (`seed`), importa a tabela de infrações
   do RENAINF (`seed:infringement`) e sobe o servidor com recarga
   (`dev:server`, porta `3333`).

Para rodar só o servidor depois que o banco já existe: `yarn dev:server`.

### Serviço de IA (opcional)

```bash
# ~1 GiB de RAM. Sem ele, os pedidos de IA ficam PENDING e o resto funciona.
docker compose -f compose.development.yaml --profile ai up -d trajetto-ai
```

O `.env.example` já aponta `AI_LOCAL_URL=http://127.0.0.1:18080` com o token
de desenvolvimento do compose.

### Criando uma migration

```bash
# edite prisma/schema.prisma, depois:
yarn prisma:migrate:dev     # só CRIA o arquivo (--create-only); revise o SQL
yarn prisma:migrate:deploy  # aplica
```

As migrations seguem expandir/contrair: uma versão nova nunca remove o que a
versão anterior ainda lê (regras em
[`docs/arquitetura.md`](./docs/arquitetura.md#migrations-expandir-e-contrair)).

## Variáveis de ambiente

O modelo comentado é o `.env.example`; a referência completa, com o valor de
cada ambiente, é [`docs/variaveis-de-ambiente.md`](./docs/variaveis-de-ambiente.md).
A validação acontece no boot (`src/schemas/env-schema/index.ts`): valor
faltando ou inválido derruba o processo com a lista do que corrigir.

- **desenvolvimento:** `.env` na raiz (o único arquivo lido);
- **staging e produção:** o Environment do app Compose no Dokploy;
- **CI:** os environments `staging` e `production` e as variáveis do
  repositório no GitHub.

Obrigatórias sempre: `DATABASE_URL`, `REDIS_URL`, `HTTP_REQUEST`, `JWT_SECRET`,
`JWT_SECRET_REFRESH_TOKEN`, `MASTER_USER_EMAIL`, `MASTER_USER_INITIAL_PASSWORD`.
Em produção também: `UPLOAD_STORAGE_TYPE=r2` com as quatro `R2_*` e
`RATE_LIMIT_TRUSTED_PROXY`. Segredos nunca vão para o repositório nem para o
log.

## Scripts

| Script                                     | O que faz                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `yarn dev`                                 | sobe Postgres e Redis, migra, roda os seeds e o servidor com recarga                                                |
| `yarn dev:server`                          | só o servidor com recarga (`tsx watch src/server.ts`)                                                               |
| `yarn start:dev`                           | o servidor sem recarga                                                                                              |
| `yarn build`                               | compila com `tsup`                                                                                                  |
| `yarn start`                               | o entrypoint da imagem (`infra/scripts/docker-entrypoint.sh`)                                                       |
| `yarn migrate:release`                     | o passo de release: migrations e seeds, sem subir o servidor                                                        |
| `yarn services:dev:up` / `:down` / `:stop` | todos os serviços do `compose.development.yaml`                                                                     |
| `yarn database:dev:up` / `:down` / `:stop` | só o Postgres de desenvolvimento                                                                                    |
| `yarn redis:dev:up` / `:down` / `:stop`    | só o Redis de desenvolvimento                                                                                       |
| `yarn wait-for-postgres`                   | espera o banco responder                                                                                            |
| `yarn prisma:generate`                     | gera o cliente Prisma                                                                                               |
| `yarn prisma:migrate:dev`                  | cria uma migration sem aplicar (`--create-only`)                                                                    |
| `yarn prisma:migrate:deploy`               | aplica as migrations pendentes                                                                                      |
| `yarn prisma:migrate:reset`                | recria o banco local do zero (apaga os dados)                                                                       |
| `yarn prisma:studio`                       | abre o Prisma Studio                                                                                                |
| `yarn seed`                                | cria o usuário master                                                                                               |
| `yarn seed:infringement`                   | importa os códigos de infração do RENAINF                                                                           |
| `yarn webhooks:seal`                       | cifra os segredos de webhook já gravados com `WEBHOOK_SECRETS_KEY`                                                  |
| `yarn test`                                | testes unitários (`tests/unitaires`)                                                                                |
| `yarn test:watch`                          | unitários em modo watch                                                                                             |
| `yarn test:e2e`                            | testes E2E contra um Postgres real (`tests/E2E`)                                                                    |
| `yarn test:e2e:watch`                      | E2E em modo watch                                                                                                   |
| `yarn test:coverage`                       | cobertura dos unitários (`coverage/unit`), com piso (statements e linhas 70,8 %, branches 82,57 %, funções 57,62 %) |
| `yarn test:coverage:e2e`                   | cobertura do E2E em lotes, juntada em `coverage/all`                                                                |
| `yarn test:mutation`                       | teste de mutação (Stryker) nas regras críticas                                                                      |
| `yarn test:ui`                             | interface do Vitest                                                                                                 |
| `yarn typecheck`                           | `tsc --noEmit`                                                                                                      |
| `yarn validate`                            | gera o Prisma, typecheck e unitários                                                                                |
| `yarn lint:check` / `yarn lint:fix`        | Prettier                                                                                                            |
| `yarn ci`                                  | `yarn install --frozen-lockfile`                                                                                    |

## Testes

| Suíte                                      | Onde                 | Como rodar                                     | Precisa de                                             |
| ------------------------------------------ | -------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Unitários                                  | `tests/unitaires`    | `yarn test`                                    | Node (e um Redis para o teste do adapter do Socket.IO) |
| E2E (HTTP, repositórios, SQL, autorização) | `tests/E2E`          | `yarn test:e2e`                                | Postgres e Redis reais (um banco por arquivo)          |
| Contrato de repositório                    | `tests/contract`     | junto com o E2E                                | Postgres                                               |
| Serviço de IA (Python)                     | `infra/ai-ocr/tests` | `docker build --target test infra/ai-ocr`      | Docker                                                 |
| Contrato com a IA real                     | `tests/ai-local`     | `AI_LOCAL_E2E=1 npx vitest run tests/ai-local` | Docker                                                 |
| Carga                                      | `tests/load`         | `tests/load/README.md`                         | Docker e k6                                            |
| Mutação                                    | `stryker.config.mjs` | `yarn test:mutation`                           | Postgres e Redis de teste                              |

No Windows, rode no máximo 8 arquivos E2E por vez (o engine do Prisma pode cair
com um _napi panic_ com 12 ou mais). Tudo — o que cada suíte prova, cobertura,
mutação e as regras para escrever testes — em [`docs/testes.md`](./docs/testes.md).

## Documentação das rotas

| Endereço              | Para quem                                                                   | Acesso                                                                                             |
| --------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `/docs`               | equipe Trajetto: referência interna de **todas** as rotas, em pt-BR         | aberto fora de produção; em produção, só com `DOCS_USER` e `DOCS_PASSWORD` (HTTP Basic), senão 404 |
| `/integration/docs`   | clientes: console interativo (Scalar) só com o que uma chave de API alcança | aberto                                                                                             |
| portal `/docs` da web | clientes: guias e a referência gerada a partir do mesmo OpenAPI público     | aberto                                                                                             |

O OpenAPI gerado pelo Fastify é a única fonte: cada rota declara os esquemas de
requisição e de resposta, incluindo 400/401/403/404/409/429.

## Deploy: staging e produção

```
branch de trabalho ─push─▶ ci.yml (lint, typecheck, unitários + cobertura, audit, gitleaks, IA)
staging ─push─▶ deploy.yml: validação completa (+ E2E) ─▶ build ÚNICO das 3 imagens (GHCR sha-<sha>)
                            ─▶ tag `staging` por digest ─▶ Dokploy (stack de staging) ─▶ convergência
PR staging → main ─▶ a mesma validação + "o head do PR tem imagem de staging?"
merge em main ─▶ promoção (sem build): migrations ─▶ tag `stable` por digest ─▶ Dokploy (produção)
                 ─▶ convergência ─▶ release        [aprovação do environment production]
Run workflow ─▶ a mesma promoção com uma tag antiga (rollback)
```

- **Uma imagem para os dois ambientes**, construída uma vez em `staging` e
  promovida por digest; staging e produção mudam só o Environment do app no
  Dokploy.
- Imagens: `trajetto-api`, `trajetto-ai` e `trajetto-backup` em
  `ghcr.io/trajetto-organization/`.
- **Dokploy**: um app Compose do tipo Docker Stack por ambiente, com o
  `compose.production.yaml` (`api` ×2, `trajetto-database`, `trajetto-redis`,
  `trajetto-ai`, `trajetto-backup`), atrás do Traefik do Dokploy e da
  Cloudflare.
- Enquanto o Dokploy não estiver configurado, os jobs movem as tags e pulam o
  deploy com um aviso.
- **Merge em `main` sempre com merge commit** (nunca squash/rebase): a
  promoção usa o 2º pai do merge para achar o build de staging.
- Ordem entre web e API: **API primeiro**.

O passo a passo completo (servidor, Dokploy, GitHub, IA, banco, migrations,
rollback, backup, alertas e o checklist do primeiro deploy) está em
[`docs/deploy.md`](./docs/deploy.md). A seção "Os três repositórios juntos"
dele (igual nos três repositórios) traz a ordem do primeiro deploy (banco,
Redis e IA → API → web → app), a ordem de cada release e os valores que
precisam casar entre a API, a web e o app.

## Operação e saúde

| Rota                                                                                       | Para quê                                                                                        |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GET /health/liveness`                                                                     | o processo está vivo (sonda do Swarm)                                                           |
| `GET /health/readiness`                                                                    | pode receber tráfego (sonda do Traefik; vira 503 durante o desligamento)                        |
| `GET /health/metrics`                                                                      | filas, workers, crons, pool, provedores, sockets, Redis, certificado do comprovante (só MASTER) |
| `GET /health/providers`                                                                    | prontidão de cada provedor, sem enviar nada (só MASTER)                                         |
| `GET /health/dead-letter`, `/health/dead-letter/events`, `POST /health/dead-letter/replay` | o que esgotou as tentativas, e o reenvio                                                        |

A aba "Sistema" do `/admin` na web mostra esses números. O heartbeat de
operações avisa o monitor externo a cada minuto; o silêncio dele é o alerta
([`docs/deploy.md`](./docs/deploy.md#20-alertas-e-monitoramento)). Os logs são
JSON (pino), uma linha por requisição, sem segredo e sem URL crua.

## Solução de problemas

| Sintoma                                           | Causa provável                                                        | O que fazer                                                                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid enviroment variables` no boot            | variável obrigatória faltando ou inválida                             | leia a lista impressa e compare com `docs/variaveis-de-ambiente.md`                                                                         |
| `wait-for-postgres` desiste                       | Postgres não subiu ou a porta 5432 está ocupada                       | `yarn database:dev:up` e `docker ps`; pare outro Postgres local                                                                             |
| `P1001` / conexão recusada                        | `DATABASE_URL` aponta para host ou porta errados                      | confira `POSTGRES_HOST`/`POSTGRES_PORT` e a URL expandida                                                                                   |
| Pedidos de IA parados em `PENDING`                | `trajetto-ai` fora do ar ou `AI_PROVIDER=none`                        | suba o serviço com `--profile ai` ou aceite que fique sem leitura                                                                           |
| Toda leitura de IA falha com `401`                | `AI_LOCAL_TOKEN` diferente na API e no serviço                        | use o mesmo valor nos dois                                                                                                                  |
| Login respondendo 429 para todo mundo em produção | `RATE_LIMIT_TRUSTED_PROXY` errado atrás da Cloudflare                 | use `cloudflare` (`docs/deploy.md`, "Domínios, TLS e a borda")                                                                              |
| Tempo real não chega entre réplicas               | Redis fora ou `SOCKET_ADAPTER_KEY` diferente entre réplicas           | confira o Redis; o resto da API segue funcionando                                                                                           |
| `/docs` responde 404 em produção                  | sem `DOCS_USER`/`DOCS_PASSWORD` (ou senha com menos de 20 caracteres) | defina as duas                                                                                                                              |
| PDF do comprovante sem assinatura                 | certificado ausente, vencido ou senha errada                          | veja o estado em `/health/metrics` e o log do boot                                                                                          |
| E2E cai com _napi panic_ no Windows               | muitos arquivos E2E na mesma execução                                 | rode em lotes de até 8 arquivos                                                                                                             |
| Boot de produção recusa banco vazio               | volume novo sem migrations                                            | instalação nova: `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` uma única vez; com dados, restaure o dump (`docs/deploy.md`, "Backup e restauração") |
| Promoção falha com "não existe" no GHCR           | o commit não passou pelo staging, ou o merge foi squash/rebase        | leve o commit a `staging`, espere o verde e faça merge commit                                                                               |
| Deploy "pulado" no resumo do run                  | o environment do GitHub ainda não tem os secrets do Dokploy           | `docs/deploy.md`, "Configurar o GitHub"                                                                                                     |

## Onde está cada decisão

- Arquitetura, ADRs 0001–0010 (resumo), unicidade por empresa, regras de
  migration e compatibilidade com o app: [`docs/arquitetura.md`](./docs/arquitetura.md).
- Fora do repositório, na pasta `docs/` da raiz do workspace (não versionada):
  o texto integral das decisões da fase final, dos ADRs, dos desenhos e as
  pendências do dono.

## Licença

Software proprietário da Trajetto, com todos os direitos reservados. O uso, a
cópia, a modificação e a distribuição dependem de autorização por escrito. Os
termos completos estão em [`LICENSE`](./LICENSE). O `package.json` declara
`"license": "UNLICENSED"` e `"private": true` para impedir publicação acidental
em registro público.
