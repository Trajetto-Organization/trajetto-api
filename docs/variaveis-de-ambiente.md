# Variáveis de ambiente da API

> Toda variável que a API, a stack de produção, os serviços auxiliares, os
> scripts de operação e o CI leem: para que serve, se é obrigatória, se é
> segredo, o formato, o valor em cada ambiente e onde ela mora. O modelo
> versionado, comentado, é o [`.env.example`](../.env.example) (o teste
> `tests/unitaires/security/env-example.test.ts` mantém a lista igual ao
> schema). Como montar cada ambiente no Dokploy: [`deploy.md`](./deploy.md).

## Sumário

- [Onde cada valor mora](#onde-cada-valor-mora)
- [Como a API lê o ambiente](#como-a-api-lê-o-ambiente)
- [Como gerar os segredos](#como-gerar-os-segredos)
- [Legenda](#legenda)
- [1. Identidade e processo](#1-identidade-e-processo)
- [2. Banco de dados](#2-banco-de-dados)
- [3. Redis e tempo real](#3-redis-e-tempo-real)
- [4. URLs, sessão e usuário master](#4-urls-sessão-e-usuário-master)
- [5. Borda, rate limit e anti-bot](#5-borda-rate-limit-e-anti-bot)
- [6. Arquivos (R2)](#6-arquivos-r2)
- [7. WhatsApp (Meta)](#7-whatsapp-meta)
- [8. E-mail (Resend)](#8-e-mail-resend)
- [9. IA local](#9-ia-local)
- [10. Comprovante de entrega](#10-comprovante-de-entrega)
- [11. Documentação, app, webhooks e auditoria](#11-documentação-app-webhooks-e-auditoria)
- [12. Monitoramento](#12-monitoramento)
- [13. Só na stack (`compose.production.yaml`)](#13-só-na-stack-composeproductionyaml)
- [14. Serviço de backup](#14-serviço-de-backup)
- [15. Scripts de operação no host](#15-scripts-de-operação-no-host)
- [16. GitHub Actions](#16-github-actions)
- [17. Testes e ferramentas locais](#17-testes-e-ferramentas-locais)
- [Matriz produção × staging](#matriz-produção--staging)
- [Variáveis que não existem mais](#variáveis-que-não-existem-mais)

## Onde cada valor mora

| Ambiente        | Onde                                                                         | Observação                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desenvolvimento | `.env` na raiz (copiado de `.env.example`)                                   | o **único** arquivo que a API lê; `.env.development`, `.env.staging`, `.env.production` e `.env.test` não são carregados por nada e não são versionados |
| Staging         | _Environment_ do app Compose `trajetto-staging` no Dokploy                   | o mesmo compose da produção; muda o valor                                                                                                               |
| Produção        | _Environment_ do app Compose `trajetto` no Dokploy                           | idem                                                                                                                                                    |
| CI (validação)  | bloco `env:` dos workflows                                                   | valores fixos de teste, sem segredo (banco e Redis dos service containers)                                                                              |
| CI (deploy)     | _environments_ `staging` e `production` do GitHub e variáveis do repositório | seção 16                                                                                                                                                |

O app mobile não lê nada daqui (a URL da API dele vem dos environments do EAS,
`trajetto-mobile/docs/variaveis-de-ambiente.md`); a web lê as dela no
Environment do app da web (`trajetto-ui/docs/variaveis-de-ambiente.md`) e
divide com a API só `RATE_LIMIT_FORWARDER_SECRET` e `TURNSTILE_SECRET_KEY`.
A tabela completa do que precisa casar entre a API, a web e o app (URLs,
origens, segredos compartilhados, R2, IA, push) é a mesma nos três
repositórios: [`deploy.md` → Os três repositórios juntos](./deploy.md#26-os-três-repositórios-juntos).

## Como a API lê o ambiente

- `src/env/index.ts` carrega o `.env` (com `dotenv-expand`: `${VAR}` dentro
  do arquivo funciona) e valida com o schema zod
  `src/schemas/env-schema/index.ts`. Valor faltando ou inválido derruba o
  boot com `Invalid enviroment variables` e a lista do que corrigir.
- **Vazio conta como ausente** (`defined-env.ts`): o compose repassa uma
  variável não definida como `""`, e o padrão dela continua valendo.
- O compose de produção **não usa `env_file`**: cada variável que a API lê
  precisa estar listada no `environment:` do serviço `api`. Definir no Dokploy
  uma variável que o compose não repassa não faz nada (o teste
  `compose-proof-env.test.ts` confere as do comprovante).
- Travas de produção (`NODE_ENV=production`, que a imagem sempre é):
  `UPLOAD_STORAGE_TYPE=r2` com as quatro `R2_*`; `RATE_LIMIT_TRUSTED_PROXY`
  definida; servidores públicos do OpenStreetMap recusados; `https` no mapa e
  no geocoder. Em staging **e** produção (`APP_ENV`): `JWT_SECRET` e
  `JWT_SECRET_REFRESH_TOKEN` com 32+ caracteres, diferentes entre si e sem o
  prefixo `GENERATE_`.
- `DATABASE_URL` não está no schema: quem a lê é o Prisma (e os scripts de
  boot).

## Como gerar os segredos

| Segredo                                                                                     | Comando                                                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`                                                    | `openssl rand -base64 48` (duas vezes: valores diferentes)                                      |
| `REDIS_PASSWORD`, `AI_LOCAL_TOKEN`, `RATE_LIMIT_FORWARDER_SECRET`, `RATE_LIMIT_EDGE_SECRET` | `openssl rand -hex 32`                                                                          |
| `WEBHOOK_SECRETS_KEY`                                                                       | `openssl rand -base64 32` (exatamente 32 bytes)                                                 |
| `POSTGRES_PASSWORD`, `MASTER_USER_INITIAL_PASSWORD`, `DOCS_PASSWORD` (20+)                  | `openssl rand -base64 24` (ou o gerenciador de senhas)                                          |
| `BACKUP_AGE_RECIPIENT`                                                                      | `age-keygen -o trajetto-backup.agekey` → a linha `public key` (a privada fica fora do servidor) |
| chaves SSH do CI                                                                            | `ssh-keygen -t ed25519 -f <nome> -N ''`                                                         |

Nenhum segredo vai para o repositório, para o log nem para um print. Segredos
**diferentes** em staging e produção.

## Legenda

- **Obrig.**: `sempre` (o boot falha sem ela em qualquer ambiente), `prod`
  (o boot falha sem ela com `NODE_ENV=production`), `stack` (o
  `compose.production.yaml` não renderiza sem ela), `não`.
- **Segredo**: 🔒 = trate como senha (Dokploy, gerenciador de senhas; nunca em
  log); vazio = não é segredo.
- **Dev / Staging / Produção**: o valor esperado em cada ambiente; "—" = não
  definir.

## 1. Identidade e processo

| Variável                       | Obrig. | Segredo | Formato / padrão                                                 | Dev               | Staging                                    | Produção                       | Para quê                                                                                                                                                                |
| ------------------------------ | ------ | ------- | ---------------------------------------------------------------- | ----------------- | ------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                     | não    |         | `development`\|`test`\|`production`; padrão `development`        | `development`     | `production` (fixo no compose e na imagem) | `production`                   | liga as travas de produção; o build inlina `production`                                                                                                                 |
| `APP_ENV`                      | stack  |         | `development`\|`staging`\|`production`; vazio segue o `NODE_ENV` | `development`     | `staging`                                  | `production`                   | qual implantação é esta (a imagem é a mesma); `staging`/`production` exigem `NODE_ENV=production`                                                                       |
| `PORT`                         | não    |         | número; padrão `3333`                                            | `3333`            | —                                          | —                              | porta do HTTP (o Traefik fala com 3333)                                                                                                                                 |
| `LOG_LEVEL`                    | não    |         | `fatal`…`trace`\|`silent`; padrão `info`                         | `info` ou `debug` | `info`                                     | `info`                         | nível do logger único; `debug` acrescenta as linhas por socket                                                                                                          |
| `WORKERS_ENABLED`              | não    |         | `true`\|`false`; padrão `true`                                   | `true`            | `true`                                     | `true`                         | se esta réplica roda pipelines, dispatcher de webhooks e crons; `false` só com um serviço `worker` dedicado ([deploy.md](./deploy.md#19-réplicas-workers-e-tempo-real)) |
| `PIPELINE_SWEEP_INTERVAL_MS`   | não    |         | ≥ 500; padrão `30000`                                            | —                 | —                                          | — (`2000` num worker dedicado) | varredura de fundo dos pipelines                                                                                                                                        |
| `WAIT_FOR_POSTGRES_TIMEOUT_MS` | não    |         | ms; padrão `120000`                                              | —                 | —                                          | —                              | quanto o boot espera o Postgres responder                                                                                                                               |
| `UV_THREADPOOL_SIZE`           | não    |         | número; `8` na imagem                                            | —                 | —                                          | —                              | threads do libuv (bcrypt, gzip, fs, dns); só mude com medição                                                                                                           |
| `NODE_OPTIONS`                 | não    |         | montada pelo compose: `--max-old-space-size=${API_HEAP_MB}`      | —                 | —                                          | —                              | teto do heap do V8 (não defina à mão; use `API_HEAP_MB`)                                                                                                                |

## 2. Banco de dados

| Variável                                                                                                        | Obrig. | Segredo | Formato / padrão                                                              | Dev                                                         | Staging                               | Produção                                               | Para quê                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------- | ------ | ------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                  | sempre | 🔒      | `postgresql://USER:SENHA@HOST:5432/BANCO?connection_limit=10&pool_timeout=20` | apontando para `127.0.0.1:5432` (pode usar `${POSTGRES_*}`) | **montada pelo compose** (não defina) | **montada pelo compose**                               | conexão do Prisma em runtime; em produção leva `socket_timeout`, `max_idle_connection_lifetime` e os tetos `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` ([arquitetura.md](./arquitetura.md#conexão-com-o-postgres)) |
| `MIGRATION_DATABASE_URL`                                                                                        | não    | 🔒      | URL sem tetos de runtime                                                      | — (vazio = usa a `DATABASE_URL`)                            | montada pelo compose                  | montada pelo compose                                   | `prisma migrate deploy` e os seeds do entrypoint (pool de 2)                                                                                                                                                                                    |
| `POSTGRES_HOST`                                                                                                 | stack  |         | host                                                                          | `localhost`                                                 | `trajetto-database`                   | `trajetto-database`                                    | o nome do serviço do banco na rede interna                                                                                                                                                                                                      |
| `POSTGRES_PORT`                                                                                                 | stack  |         | porta                                                                         | `5432`                                                      | `5432`                                | `5432`                                                 |                                                                                                                                                                                                                                                 |
| `POSTGRES_USERNAME`                                                                                             | stack  |         | texto                                                                         | `postgres`                                                  | próprio                               | próprio                                                | usuário do Postgres (cria o banco no primeiro boot do volume)                                                                                                                                                                                   |
| `POSTGRES_PASSWORD`                                                                                             | stack  | 🔒      | texto                                                                         | qualquer (local)                                            | **própria**                           | **própria**                                            | senha do Postgres                                                                                                                                                                                                                               |
| `POSTGRES_DATABASE`                                                                                             | stack  |         | texto                                                                         | `trajetto`                                                  | próprio                               | próprio                                                | nome do banco                                                                                                                                                                                                                                   |
| `POSTGRES_VOLUME`                                                                                               | stack  |         | nome de volume                                                                | —                                                           | ex. `trajetto-staging_postgres_data`  | `trajetto_postgres_data`                               | nome fixo do volume do banco; único por stack                                                                                                                                                                                                   |
| `POSTGRES_IMAGE`                                                                                                | não    |         | imagem com digest; padrão `postgres:16-alpine`                                | —                                                           | o digest em uso                       | o digest em uso                                        | fixa a imagem do banco (a tag flutuante atualizaria o banco num deploy); o `restore-postgres.sh` usa a mesma                                                                                                                                    |
| `RUN_MIGRATIONS_ON_BOOT`                                                                                        | não    |         | `true`\|`false`; padrão `true`                                                | —                                                           | `true`                                | `false` **depois** de ligar o job de migrations        | migrar e semear no boot de cada réplica                                                                                                                                                                                                         |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                                                                | não    |         | `true`\|`false`; padrão `false`                                               | —                                                           | `true` só no primeiro boot            | `false` (`true` só numa instalação nova, uma vez)      | o boot de produção recusa banco sem nenhuma migration aplicada                                                                                                                                                                                  |
| `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE`, `PG_WORK_MEM`, `PG_MAINTENANCE_WORK_MEM`, `PG_RANDOM_PAGE_COST` | não    |         | ex. `1GB`, `3GB`, `16MB`, `256MB`, `1.1`                                      | —                                                           | —                                     | só quando o bloco `command:` do banco for descomentado | tuning do Postgres ([deploy.md](./deploy.md#10-postgres-e-redis))                                                                                                                                                                               |

## 3. Redis e tempo real

| Variável               | Obrig. | Segredo        | Formato / padrão                            | Dev                      | Staging                  | Produção                 | Para quê                                                                                                              |
| ---------------------- | ------ | -------------- | ------------------------------------------- | ------------------------ | ------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `REDIS_URL`            | sempre | 🔒 (com senha) | `redis://[:SENHA@]HOST:PORT`                | `redis://localhost:6379` | **montada pelo compose** | **montada pelo compose** | rate limit e adapter do Socket.IO                                                                                     |
| `REDIS_HOST`           | stack  |                | host                                        | `localhost`              | `trajetto-redis`         | `trajetto-redis`         | usado para montar o `REDIS_URL`                                                                                       |
| `REDIS_PORT`           | stack  |                | porta                                       | `6379`                   | `6379`                   | `6379`                   | idem                                                                                                                  |
| `REDIS_PASSWORD`       | stack  | 🔒             | hex de 32 bytes                             | —                        | **própria**              | **própria**              | senha do Redis da stack                                                                                               |
| `REDIS_ENFORCE_AUTH`   | não    |                | `true`\|`false`; padrão `true`              | —                        | —                        | —                        | `false` só no primeiro rollout a partir de uma API sem senha no Redis                                                 |
| `SOCKET_ADAPTER_KEY`   | não    |                | `[A-Za-z0-9._:-]{1,64}`; padrão `socket.io` | —                        | —                        | —                        | prefixo dos canais do adapter; só para duas stacks que dividam um Redis                                               |
| `SOCKET_REVALIDATE_MS` | não    |                | ≥ 1000; padrão `180000`                     | —                        | —                        | —                        | de quanto em quanto cada réplica revalida no banco as sessões dos sockets (não repassada pelo compose: vale o padrão) |

## 4. URLs, sessão e usuário master

| Variável                        | Obrig. | Segredo | Formato / padrão                   | Dev                     | Staging                                                      | Produção                                  | Para quê                                                                                                |
| ------------------------------- | ------ | ------- | ---------------------------------- | ----------------------- | ------------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `HTTP_REQUEST`                  | sempre |         | URL                                | `http://localhost:3000` | origem da web de staging                                     | `https://www.intrajetto.com`              | URL pública da **web**: única origem do CORS e base dos links (PDF, QR, rastreio, e-mails)              |
| `API_HTTP_REQUEST`              | não    |         | URL                                | `http://localhost:3333` | URL da API de staging                                        | `https://trajettoapi.thorsolucoes.com.br` | URL pública da própria API                                                                              |
| `JWT_SECRET`                    | sempre | 🔒      | 32+ caracteres em staging/produção | qualquer                | **próprio**                                                  | **próprio**                               | assina o access token                                                                                   |
| `JWT_SECRET_REFRESH_TOKEN`      | sempre | 🔒      | 32+, diferente do `JWT_SECRET`     | qualquer (diferente)    | **próprio**                                                  | **próprio**                               | assina o refresh token; perdê-lo desloga todo mundo                                                     |
| `MASTER_USER_EMAIL`             | sempre |         | e-mail                             | `admin@example.com`     | o da equipe                                                  | o da equipe                               | usuário MASTER criado pelo seed                                                                         |
| `MASTER_USER_INITIAL_PASSWORD`  | sempre | 🔒      | texto                              | qualquer                | **própria**                                                  | **própria**                               | senha inicial do MASTER criada pelo seed                                                                |
| `TWO_FACTOR_CHALLENGE_REQUIRED` | não    |         | `true`\|`false`; padrão `false`    | `false`                 | `true` quando web e app que mandam o desafio estiverem no ar | idem                                      | exige o desafio do login com senha no 2FA; acompanhe `auth.two_factor_without_challenge` nos logs antes |
| `CLOUDINARY_LOGO_IMAGE`         | não    |         | URL                                | vazio                   | URL do logo                                                  | URL do logo                               | logo usado nos e-mails                                                                                  |

## 5. Borda, rate limit e anti-bot

| Variável                      | Obrig. | Segredo | Formato / padrão                                         | Dev     | Staging                                               | Produção                       | Para quê                                                                                                    |
| ----------------------------- | ------ | ------- | -------------------------------------------------------- | ------- | ----------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_TRUSTED_PROXY`    | prod   |         | `none`\|`xff`\|`cloudflare`; compose padrão `cloudflare` | `none`  | `cloudflare`                                          | `cloudflare`                   | de onde vem o endereço do cliente nos limites anônimos ([deploy.md](./deploy.md#11-domínios-tls-e-a-borda)) |
| `RATE_LIMIT_FORWARDER_SECRET` | não    | 🔒      | 32+ caracteres                                           | vazio   | **o mesmo da web de staging**                         | **o mesmo da web de produção** | o servidor da web repassa o IP do navegador junto com ele; sem ele todo usuário web conta como um endereço  |
| `RATE_LIMIT_EDGE_SECRET`      | não    | 🔒      | 32+ caracteres                                           | vazio   | opcional                                              | recomendado                    | valor da Transform Rule da Cloudflare (`x-trajetto-edge-secret`); só defina **depois** das regras ativas    |
| `TURNSTILE_SECRET_KEY`        | não    | 🔒      | chave secreta do Turnstile                               | vazio   | a de staging                                          | a de produção (a mesma da web) | verifica o token do formulário público de orçamento                                                         |
| `TURNSTILE_REQUIRED`          | não    |         | `true`\|`false`; padrão `false`                          | `false` | `true` quando a web que repassa o token estiver no ar | idem                           | recusa pedido sem token                                                                                     |

## 6. Arquivos (R2)

| Variável                        | Obrig.      | Segredo | Formato / padrão                             | Dev                             | Staging               | Produção                                           | Para quê                                                                |
| ------------------------------- | ----------- | ------- | -------------------------------------------- | ------------------------------- | --------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `UPLOAD_STORAGE_TYPE`           | prod (`r2`) |         | `local`\|`r2`; padrão `local`                | `local`                         | `r2`                  | `r2`                                               | onde ficam fotos, assinaturas e PDFs                                    |
| `UPLOAD_LOCAL_PATH`             | não         |         | caminho; padrão `./tmp`                      | `./tmp`                         | `./tmp`               | `./tmp`                                            | pasta do modo `local`                                                   |
| `UPLOAD_SIGNED_URL_TTL_SECONDS` | não         |         | 60–3600; padrão `900`                        | —                               | —                     | —                                                  | validade das URLs assinadas (não repassada pelo compose: vale o padrão) |
| `UPLOAD_ORPHAN_GC`              | não         |         | `off`\|`dry-run`\|`delete`; padrão `dry-run` | `dry-run`                       | `dry-run`             | `dry-run`, depois `delete` após ler alguns resumos | coletor noturno de objetos sem linha                                    |
| `R2_ACCOUNT_ID`                 | prod        |         | id da conta Cloudflare                       | vazio                           | da conta              | da conta                                           |                                                                         |
| `R2_BUCKET_NAME`                | prod        |         | nome                                         | vazio                           | **bucket de staging** | bucket de produção                                 | bucket **privado** de fotos (com CORS da web)                           |
| `R2_ACCESS_KEY_ID`              | prod        | 🔒      |                                              | vazio                           | token de staging      | token de produção                                  | credencial S3 do R2                                                     |
| `R2_SECRET_ACCESS_KEY`          | prod        | 🔒      |                                              | vazio                           | idem                  | idem                                               |                                                                         |
| `R2_ENDPOINT`                   | não         |         | URL                                          | só nos testes de upload (MinIO) | —                     | —                                                  | endpoint S3 alternativo (path-style)                                    |

## 7. WhatsApp (Meta)

Todas opcionais: sem elas os envios por WhatsApp falham com erro claro e o
resto funciona.

| Variável                               | Segredo | Formato / padrão               | Dev                             | Staging            | Produção         | Para quê                                                                 |
| -------------------------------------- | ------- | ------------------------------ | ------------------------------- | ------------------ | ---------------- | ------------------------------------------------------------------------ |
| `META_WHATSAPP_ACCESS_TOKEN`           | 🔒      | token                          | o temporário do número de teste | **de teste**       | token de sistema | envio pela Cloud API                                                     |
| `META_WHATSAPP_PHONE_NUMBER_ID`        |         | id numérico                    | o do número de teste            | de teste           | o real           |                                                                          |
| `META_WHATSAPP_TEMPLATE_NAME`          |         | padrão `trajetto_notification` | idem                            | idem               | idem             | template aprovado das notificações (uma variável no corpo)               |
| `META_WHATSAPP_CUSTOMER_TEMPLATE_NAME` |         | texto; vazio = usa o anterior  | vazio                           | o de teste         | o aprovado       | template das mensagens ao cliente final                                  |
| `META_WHATSAPP_API_VERSION`            |         | padrão `v23.0`                 | idem                            | idem               | idem             | versão da Graph API                                                      |
| `META_WHATSAPP_BUSINESS_ACCOUNT_ID`    |         | id numérico (5–30 dígitos)     | vazio                           | o da WABA de teste | o da WABA        | só o `/health/providers` lê, para dizer se cada template está `APPROVED` |
| `META_WHATSAPP_APP_SECRET`             | 🔒      |                                | vazio                           | do app de teste    | do app           | assina os callbacks de status (`/webhooks/whatsapp`); vazio = 404        |
| `META_WHATSAPP_WEBHOOK_VERIFY_TOKEN`   | 🔒      | texto qualquer                 | vazio                           | próprio            | próprio          | o handshake da assinatura do webhook                                     |

## 8. E-mail (Resend)

| Variável                | Segredo | Formato                      | Dev                                       | Staging          | Produção     | Para quê                                                           |
| ----------------------- | ------- | ---------------------------- | ----------------------------------------- | ---------------- | ------------ | ------------------------------------------------------------------ |
| `RESEND_SECRET_KEY`     | 🔒      | `re_…`                       | vazio (e-mail desligado fora de produção) | chave de teste   | chave real   | envio                                                              |
| `RESEND_FROM_EMAIL`     |         | e-mail de domínio verificado | vazio                                     | domínio de teste | domínio real | remetente                                                          |
| `RESEND_WEBHOOK_SECRET` | 🔒      | `whsec_…`                    | vazio                                     | próprio          | próprio      | assina `/webhooks/resend` (entregue, devolvido, spam); vazio = 404 |

## 9. IA local

Do lado da **API** (serviço `api`):

| Variável                   | Obrig. | Segredo | Formato / padrão                                            | Dev                                                         | Staging                                        | Produção    | Para quê                                                                           |
| -------------------------- | ------ | ------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------- | ----------- | ---------------------------------------------------------------------------------- |
| `AI_PROVIDER`              | não    |         | `local`\|`none`; padrão `local` (`anthropic` impede o boot) | `local`                                                     | `local` ou `none`                              | `local`     | liga/desliga as leituras de foto                                                   |
| `AI_LOCAL_URL`             | não    |         | URL                                                         | `http://127.0.0.1:18080`                                    | **fixa no compose**: `http://trajetto-ai:8080` | idem        | endereço do serviço `trajetto-ai`                                                  |
| `AI_LOCAL_TOKEN`           | stack  | 🔒      | 32+ caracteres                                              | `dev-only-token-0123456789abcdef0123` (o do compose de dev) | **próprio**                                    | **próprio** | bearer de toda chamada; o compose entrega o mesmo valor ao serviço como `AI_TOKEN` |
| `AI_LOCAL_TIMEOUT_MS`      | não    |         | padrão `15000`                                              | —                                                           | —                                              | —           | orçamento de uma leitura (precisa caber no lease de 300 s, ou o boot para)         |
| `AI_LOCAL_MAX_CONCURRENCY` | não    |         | 1–4; padrão `1`                                             | —                                                           | —                                              | —           | leituras em voo por réplica                                                        |

Do lado do **serviço** `trajetto-ai` (montadas pelo compose; não defina à mão):

| Variável           | Origem                    | Para quê                                                                      |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------- |
| `AI_TOKEN`         | `${AI_LOCAL_TOKEN}`       | token exigido em toda leitura (o serviço não sobe com menos de 32 caracteres) |
| `OCR_THREADS`      | `${AI_CPUS:-2}`           | threads do ONNX = CPUs do contêiner                                           |
| `AI_MAX_QUEUE`     | `${AI_MAX_QUEUE:-2}`      | leituras esperando atrás da que roda; acima disso, 503 `busy`                 |
| `AI_QUEUE_WAIT_MS` | padrão do serviço `10000` | quanto uma leitura espera na fila antes do 503 (não repassada pelo compose)   |
| `PORT`             | padrão `8080`             | porta do serviço                                                              |

Da **stack** (dimensionamento): `AI_IMAGE_TAG`, `AI_REPLICAS`, `AI_CPUS`,
`AI_MEMORY_LIMIT` — seção 13.

## 10. Comprovante de entrega

Todas opcionais e todas repassadas pelo compose. Sem certificado, o PDF sai
"sem assinatura digital" e diz isso; sem mapa/geocoder, imprime o endereço
cadastrado.

| Variável                                        | Segredo             | Formato / padrão                              | Staging               | Produção                                            | Para quê                                             |
| ----------------------------------------------- | ------------------- | --------------------------------------------- | --------------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `PROOF_VERIFICATION_TTL_DAYS`                   |                     | inteiro; padrão `1825`                        | padrão                | padrão                                              | validade do link público do QR                       |
| `PROOF_SIGNING_PFX_BASE64`                      | 🔒                  | base64 do `.pfx`                              | vazio                 | o A1 (e-CNPJ)                                       | certificado ICP-Brasil (ou o `_PATH`, nunca os dois) |
| `PROOF_SIGNING_PFX_PATH`                        |                     | caminho, ex. `/run/secrets/proof_signing.pfx` | vazio                 | alternativa ao base64 (secret montado)              |                                                      |
| `PROOF_SIGNING_PFX_PASSWORD`                    | 🔒                  |                                               | vazio                 | a senha do A1                                       |                                                      |
| `PROOF_SIGNATURE_PROFILE`                       |                     | `pades-ad-rb`\|`cms`; padrão `pades-ad-rb`    | —                     | —                                                   | perfil da assinatura                                 |
| `PROOF_SIGNING_DISABLED`                        |                     | `true`\|`false`; padrão `false`               | —                     | `true` só num incidente                             | desliga a assinatura sem remover o certificado       |
| `PROOF_SIGNER_LOCATION`, `PROOF_SIGNER_CONTACT` |                     | texto                                         | —                     | ex. `Rio de Janeiro, RJ`, e-mail de suporte         | metadados da assinatura                              |
| `PROOF_SIGNER_BRAND`                            |                     | padrão `TRAJETTO`                             | —                     | —                                                   | a marca no texto de garantia                         |
| `PROOF_ISSUER_LEGAL_NAME`                       |                     | padrão `Trajetto Sistemas Ltda`               | —                     | a razão social                                      | quem gerou um documento **sem** assinatura           |
| `PROOF_ISSUER_CNPJ`                             |                     | CNPJ válido                                   | —                     | o CNPJ                                              | idem (vazio = omitido)                               |
| `PROOF_MAP_TILE_URL`                            | 🔒 (pode ter chave) | template XYZ `https://…/{z}/{x}/{y}`          | opcional              | provedor escolhido (nunca `tile.openstreetmap.org`) | mapa estático                                        |
| `PROOF_MAP_TILE_ATTRIBUTION`                    |                     | texto                                         | obrigatório com a URL | idem                                                | crédito impresso no mapa                             |
| `PROOF_MAP_TIMEOUT_MS`                          |                     | ≥ 200; padrão `3000`                          | —                     | —                                                   | orçamento de todos os tiles                          |
| `REVERSE_GEOCODER_URL`                          |                     | URL Nominatim-compatível, https               | opcional              | provedor (nunca `nominatim.openstreetmap.org`)      | endereço do GPS do comprovante                       |
| `REVERSE_GEOCODER_KEY`                          | 🔒                  |                                               |                       |                                                     | chave do provedor                                    |
| `REVERSE_GEOCODER_KEY_PARAM`                    |                     | padrão `key`                                  |                       |                                                     | nome do parâmetro da chave                           |
| `REVERSE_GEOCODER_USER_AGENT`                   |                     | texto                                         |                       |                                                     | User-Agent exigido por alguns provedores             |
| `REVERSE_GEOCODER_TIMEOUT_MS`                   |                     | ≥ 200; padrão `2500`                          |                       |                                                     |                                                      |

## 11. Documentação, app, webhooks e auditoria

| Variável                  | Segredo | Formato / padrão               | Dev                                     | Staging     | Produção                                                                                    | Para quê                                                                                                                                           |
| ------------------------- | ------- | ------------------------------ | --------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOCS_USER`               |         | texto                          | vazio (`/docs` aberto fora de produção) | definir     | definir                                                                                     | usuário do HTTP Basic de `/docs`                                                                                                                   |
| `DOCS_PASSWORD`           | 🔒      | 20+ caracteres                 | vazio                                   | definir     | definir                                                                                     | sem os dois (ou com senha curta), `/docs` responde 404 em produção; a promoção da web lê `/docs/json` com eles                                     |
| `MIN_MOBILE_CONTRACT`     |         | inteiro ≥ 1; vazio = desligado | —                                       | —           | só depois de o OTA/binário novo estar fora e os logs mostrarem os contratos antigos sumindo | 426 `CLIENT_UPGRADE_REQUIRED` abaixo dele                                                                                                          |
| `MOBILE_STORE_URL`        |         | URL `https://`                 | —                                       | —           | opcional                                                                                    | o `storeUrl` do 426                                                                                                                                |
| `WEBHOOK_SECRETS_KEY`     | 🔒      | base64 de 32 bytes             | vazio (chave fixa de dev)               | **própria** | **própria** (recomendada; sem ela o boot avisa e os segredos ficam em claro)                | cifra os segredos e cabeçalhos dos webhooks dos clientes; perder = irrecuperável; guarde fora dos backups; depois de definir, `yarn webhooks:seal` |
| `ACTIVITY_RETENTION_DAYS` |         | inteiro ≥ 365; vazio = nunca   | —                                       | —           | decisão de produto                                                                          | apaga a trilha de auditoria mais velha que N dias                                                                                                  |

## 12. Monitoramento

| Variável               | Segredo | Formato                                         | Staging                        | Produção                           | Para quê                                                                             |
| ---------------------- | ------- | ----------------------------------------------- | ------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------ |
| `HEALTHCHECK_PING_URL` | 🔒      | URL do check (ex. `https://hc-ping.com/<uuid>`) | um check de staging (opcional) | **definir**                        | dead man's switch do `ops-heartbeat` (1/min; `/fail` com os motivos); vazio = só log |
| `HEALTHCHECK_FAIL_URL` | 🔒      | URL                                             | —                              | só no Uptime Kuma (`?status=down`) | URL de falha quando o serviço não segue a convenção `/fail`                          |

## 13. Só na stack (`compose.production.yaml`)

Lidas pelo compose para montar os serviços; a API não as lê diretamente.

| Variável               | Obrig. | Padrão            | Staging                             | Produção                              | Para quê                                |
| ---------------------- | ------ | ----------------- | ----------------------------------- | ------------------------------------- | --------------------------------------- |
| `ROUTER_PREFIX`        | stack  | —                 | `trajetto-staging`                  | `trajetto`                            | prefixo único dos roteadores do Traefik |
| `API_HOST`             | stack  | —                 | host de staging                     | `trajettoapi.thorsolucoes.com.br`     | `Host()` do roteador                    |
| `TRAEFIK_NETWORK`      | não    | `dokploy-network` | —                                   | —                                     | rede do Traefik (externa)               |
| `TRAEFIK_CERTRESOLVER` | não    | `letsencrypt`     | —                                   | —                                     | resolver de certificados                |
| `API_IMAGE_TAG`        | não    | `stable`          | `staging`                           | — (só `sha-<sha>` no primeiro deploy) | tag da imagem da API                    |
| `AI_IMAGE_TAG`         | não    | `stable`          | `staging`                           | idem                                  | tag da imagem da IA                     |
| `BACKUP_IMAGE_TAG`     | não    | `stable`          | `staging`                           | idem                                  | tag da imagem do backup                 |
| `API_HEAP_MB`          | não    | `768`             | menor se dividir a VPS              | `768`                                 | heap do Node (sobe junto com o limite)  |
| `API_MEMORY_LIMIT`     | não    | `1024M`           | idem                                | `1024M`                               | limite de memória de cada réplica       |
| `AI_REPLICAS`          | não    | `1`               | `1` (ou `0` com `AI_PROVIDER=none`) | `1`                                   | réplicas do `trajetto-ai`               |
| `AI_CPUS`              | não    | `2`               | menor se dividir a VPS              | `2`                                   | CPUs do `trajetto-ai` (e `OCR_THREADS`) |
| `AI_MEMORY_LIMIT`      | não    | `1024M`           | idem                                | `1024M`                               | memória do `trajetto-ai`                |
| `AI_MAX_QUEUE`         | não    | `2`               | —                                   | —                                     | fila interna do `trajetto-ai`           |

## 14. Serviço de backup

O serviço `trajetto-backup` recebe `PGHOST`, `PGPORT`, `PGUSER`,
`PGPASSWORD` e `PGDATABASE` montados pelo compose a partir das `POSTGRES_*`.

| Variável                      | Obrig. | Segredo | Formato / padrão                | Staging                     | Produção                | Para quê                                                                                                   |
| ----------------------------- | ------ | ------- | ------------------------------- | --------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `BACKUP_R2_ACCOUNT_ID`        | stack  |         | id da conta                     | da conta                    | da conta                |                                                                                                            |
| `BACKUP_R2_BUCKET`            | stack  |         | nome                            | bucket de backup de staging | bucket **só** de backup | destino dos dumps cifrados                                                                                 |
| `BACKUP_R2_ACCESS_KEY_ID`     | stack  | 🔒      |                                 | token só desse bucket       | idem                    |                                                                                                            |
| `BACKUP_R2_SECRET_ACCESS_KEY` | stack  | 🔒      |                                 |                             |                         |                                                                                                            |
| `BACKUP_AGE_RECIPIENT`        | stack  |         | `age1…` (chave **pública**)     | própria                     | própria                 | cifra o dump antes de sair do contêiner                                                                    |
| `BACKUP_HEARTBEAT_URL`        | stack  | 🔒      | URL do check (período 1 dia)    | própria                     | própria                 | sucesso/`fail` de cada noite                                                                               |
| `BACKUP_AT_UTC`               | não    |         | `HH:MM`; padrão `02:30`         | —                           | —                       | horário do dump (antes das 03:17 UTC)                                                                      |
| `BACKUP_EXCLUDE_TRAIL`        | não    |         | `true`\|`false`; padrão `false` | —                           | decisão de produto      | deixa as linhas de `driver_position` fora do dump                                                          |
| `BACKUP_RUN_NOW`              | não    |         | `true`\|`false`                 | —                           | —                       | roda um backup também na partida (ensaio); não é repassada pelo compose — use `docker exec … backup-to-r2` |

Do script manual `infra/scripts/backup-postgres.sh`: `POSTGRES_USERNAME`,
`POSTGRES_DATABASE`, `POSTGRES_CONTAINER` (qual contêiner), `BACKUP_EXCLUDE_TRAIL`,
`BACKUP_TRAIL_ONLY`. Do `infra/scripts/restore-postgres.sh`: `POSTGRES_IMAGE`,
`KEEP_CONTAINER`.

## 15. Scripts de operação no host

No ambiente do usuário de deploy do host do Dokploy (todas opcionais):

| Variável                  | Script                      | Padrão            | Para quê                                         |
| ------------------------- | --------------------------- | ----------------- | ------------------------------------------------ |
| `STACK_NAME`              | `run-release-migrations.sh` | `trajetto`        | nome da stack (= nome do app no Dokploy)         |
| `API_SERVICE`             | idem                        | `<stack>_api`     | serviço cujo env o job de migrations reaproveita |
| `MIGRATE_NETWORK`         | idem                        | `<stack>_backend` | rede do job                                      |
| `MIGRATE_TIMEOUT_SECONDS` | idem                        | `900`             | espera do job                                    |
| `MIGRATE_POLL_SECONDS`    | idem                        | `5`               | intervalo da espera                              |
| `ROLLOUT_TIMEOUT_SECONDS` | `verify-rollout.sh`         | `600`             | prazo da convergência                            |
| `ROLLOUT_POLL_SECONDS`    | idem                        | `5`               | intervalo da conferência                         |

## 16. GitHub Actions

### Environment `staging`

| Nome                                                           | Tipo     | Para quê                                      |
| -------------------------------------------------------------- | -------- | --------------------------------------------- |
| `DOKPLOY_URL`                                                  | secret   | painel do Dokploy (https)                     |
| `DOKPLOY_API_KEY`                                              | secret   | chave de API do Dokploy                       |
| `DOKPLOY_COMPOSE_ID`                                           | secret   | id do app `trajetto-staging`                  |
| `SWARM_API_SERVICE`                                            | variable | `trajetto-staging_api`                        |
| `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS` | secrets  | acesso SSH ao host (conferência do rollout)   |
| `DEPLOY_VERIFY_SSH_KEY`                                        | secret   | chave privada restrita ao `verify-rollout.sh` |

### Environment `production` (com revisores obrigatórios)

Os mesmos, com `DOKPLOY_COMPOSE_ID` do app `trajetto`, `SWARM_API_SERVICE=trajetto_api`
e mais `DEPLOY_SSH_KEY` (chave privada restrita ao `run-release-migrations.sh`).

### Repositório

| Nome                      | Tipo       | Valores                                                                           | Para quê                                      |
| ------------------------- | ---------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| `MIGRATIONS_VIA_JOB`      | variable   | `true`                                                                            | migrations como job único no promote          |
| `ROLLOUT_VERIFY`          | variable   | `off` (só emergência)                                                             | desliga a conferência do rollout              |
| `IMAGE_SCAN_ENFORCE`      | variable   | `true`                                                                            | Trivy passa a falhar o build                  |
| `CLIENT_REPOS_READ_TOKEN` | secret     | token só leitura de `trajetto-fleet-manager-ui` e `trajetto-fleet-manager-mobile` | contrato de rotas no `ci.yml`                 |
| `GITHUB_TOKEN`            | automático | —                                                                                 | GHCR (push/retag), `gh api`, semantic-release |

Opcionais do `.github/scripts/dokploy-deploy.mjs` (não definidas hoje):
`DOKPLOY_WAIT` (`false` só dispara), `DOKPLOY_TIMEOUT_SECONDS` (900),
`DOKPLOY_POLL_SECONDS` (10).

O bloco `env:` dos workflows define os valores de teste da validação
(`NODE_ENV=test`, `DATABASE_URL` e `REDIS_URL` dos service containers, JWTs e
master de mentira, `UPLOAD_STORAGE_TYPE=local`). Não são segredos.

## 17. Testes e ferramentas locais

| Variável                                                                                 | Onde               | Para quê                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| `TEST_DATABASE_URL`                                                                      | E2E                | servidor onde o ambiente de teste cria um banco por arquivo (senão `DATABASE_URL`) |
| `COVERAGE_DIR`                                                                           | `vite.config.mts`  | pasta do relatório (usada pelos lotes do `coverage-e2e.sh`)                        |
| `MUTATION_BATCH`, `MUTATION_TESTS`                                                       | Stryker            | lote (`guards`, `states`, `outbox`, `lists`) e globs de teste                      |
| `AI_LOCAL_E2E`, `AI_LOCAL_E2E_IMAGE`                                                     | `tests/ai-local`   | liga o contrato com o contêiner real; usa uma imagem pronta                        |
| `MINIO_TEST_ENDPOINT`, `MINIO_TEST_ACCESS_KEY`, `MINIO_TEST_SECRET_KEY`, `REQUIRE_MINIO` | E2E de upload      | o S3 de teste (`tests/support/minio/minio-test.sh env`)                            |
| `RESILIENCE_DOCKER`, `RESILIENCE_REPLICAS`                                               | E2E de resiliência | liga os testes com contêineres; contagens de réplicas                              |
| `IDOR_SWEEP_REPORT`, `COMPANY_MOVE_TRACE`                                                | E2E de isolamento  | grava o relatório da varredura; imprime cada par                                   |
| `UPDATE_PUBLIC_OPENAPI_FIXTURE`                                                          | unitário do portal | regrava a cópia do OpenAPI público da web                                          |
| `LOAD_*`, `HOLD_MINUTES`, `WEB_E2E_PASSWORD`, `WEB_E2E_USERS_OUT`, `MOBILE_E2E_*`        | `tests/load`       | harness de carga e contas das suítes da web e do app (`tests/load/README.md`)      |

## Matriz produção × staging

| Variável                                                                                | Produção                          | Staging                        | Nota                                                                    |
| --------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `APP_ENV`                                                                               | `production`                      | `staging`                      | obrigatória                                                             |
| `ROUTER_PREFIX`                                                                         | `trajetto`                        | `trajetto-staging`             | única por stack                                                         |
| `API_HOST`                                                                              | `trajettoapi.thorsolucoes.com.br` | host próprio                   |                                                                         |
| `POSTGRES_VOLUME`                                                                       | `trajetto_postgres_data`          | outro nome                     | dois apps no mesmo volume = dois Postgres no mesmo disco                |
| `*_IMAGE_TAG`                                                                           | `stable` (padrão)                 | `staging`                      | `sha-<sha>` só para fixar um build                                      |
| `HTTP_REQUEST`, `API_HTTP_REQUEST`                                                      | origens de produção               | as de staging                  |                                                                         |
| `JWT_*`, `REDIS_PASSWORD`, `POSTGRES_PASSWORD`, `AI_LOCAL_TOKEN`, `WEBHOOK_SECRETS_KEY` | próprios                          | **outros**                     | nunca compartilhar                                                      |
| `R2_*`                                                                                  | bucket de produção                | bucket de staging              | CORS de cada bucket                                                     |
| `META_WHATSAPP_*`, `RESEND_*`                                                           | reais                             | de teste                       | staging não fala com cliente real (é configuração, não trava no código) |
| `BACKUP_*`                                                                              | bucket de backup                  | bucket de backup de staging    | o compose exige nos dois                                                |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                                        | `false`                           | `true` só no primeiro boot     |                                                                         |
| `RUN_MIGRATIONS_ON_BOOT`                                                                | `false` com o job ligado          | `true`                         |                                                                         |
| `RATE_LIMIT_TRUSTED_PROXY`                                                              | `cloudflare`                      | `cloudflare`                   |                                                                         |
| `SOCKET_ADAPTER_KEY`                                                                    | vazio                             | vazio                          | cada stack tem o próprio Redis                                          |
| `AI_PROVIDER` / `AI_REPLICAS`                                                           | `local` / `1`                     | `local` / `1`, ou `none` / `0` |                                                                         |
| `PROOF_SIGNING_*`                                                                       | o A1                              | vazio                          |                                                                         |

## Variáveis que não existem mais

Apague se ainda estiverem em algum Environment, `.env` ou secret:

| Variável                                                                                                                                  | Por quê                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`, `AI_ANTHROPIC_MODEL`                                                                                                 | a leitura de fotos é local (ADR 0010); `AI_PROVIDER=anthropic` impede o boot. Revogue a chave antiga |
| `RABBITMQ_URL`                                                                                                                            | o broker saiu em 09/2026; o Postgres é a fila                                                        |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_HTTP_REQUEST`, `TRAJETTO_WHATSAPP_BUSINESS_PHONE`, `TRAJETTO_WHATSAPP_INSTANCE_NAME` | o WhatsApp é a Cloud API oficial da Meta                                                             |
| `R2_PUBLIC_DOMAIN`                                                                                                                        | o bucket é privado; toda leitura é URL assinada                                                      |
| `STAGING_ENABLED` (variável do GitHub)                                                                                                    | o deploy de staging depende só dos secrets do Dokploy                                                |
| `PORTAINER_WEBHOOK_URL`, `PORTAINER_STAGING_WEBHOOK_URL` (secrets do GitHub)                                                              | o deploy é pelo Dokploy                                                                              |
