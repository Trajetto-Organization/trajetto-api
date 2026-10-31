# Variáveis de ambiente da API

> Toda variável que a API, o serviço auxiliar `trajetto-ai`, os scripts de
> operação e o CI leem: para que serve, se é
> obrigatória, se é segredo, o formato, o valor em cada ambiente e **onde ela
> é definida**. O modelo versionado, comentado, é o
> [`.env.example`](../.env.example) (o teste
> `tests/unitaires/security/env-example.test.ts` mantém a lista igual ao
> schema). Como montar cada ambiente no Dokploy, clique a clique:
> [`deploy.md`](./deploy.md#7-montar-o-dokploy-do-zero-staging-e-produção).

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
- [13. Configurações do Dokploy que não são variáveis](#13-configurações-do-dokploy-que-não-são-variáveis)
- [14. Backup do banco](#14-backup-do-banco)
- [15. Scripts de operação no host](#15-scripts-de-operação-no-host)
- [16. GitHub Actions](#16-github-actions)
- [17. Testes e ferramentas locais](#17-testes-e-ferramentas-locais)
- [Matriz produção × staging](#matriz-produção--staging)
- [Variáveis que não existem mais](#variáveis-que-não-existem-mais)

## Onde cada valor mora

| Ambiente                          | Onde                                                                                                                               | Observação                                                                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desenvolvimento                   | `.env` na raiz (copiado de `.env.example`)                                                                                         | o **único** arquivo que a API lê; `.env.development`, `.env.staging`, `.env.production` e `.env.test` não são carregados por nada e não são versionados |
| Staging e produção: API           | aba _Environment_ da Application **`trajetto-api`**, no projeto `trajetto-api` do environment `staging` ou `production` do Dokploy | seções 1 a 12 deste documento; uma variável por linha, `NOME=valor`, sem aspas                                                                          |
| Staging e produção: IA            | aba _Environment_ da Application **`trajetto-ai`**                                                                                 | seção 9 (`AI_TOKEN`, `OCR_THREADS`, `AI_MAX_QUEUE`)                                                                                                     |
| Staging e produção: backup        | nenhuma variável: aba _Backups_ do Database PostgreSQL no Dokploy                                                                  | seção 14                                                                                                                                                |
| Staging e produção: banco e Redis | campos dos Databases **PostgreSQL** e **Redis** do Dokploy (usuário, senha, banco, imagem, comando)                                | não são variáveis de ambiente que você digita; a seção 13 diz quais campos e onde cada valor reaparece                                                  |
| CI (validação)                    | bloco `env:` dos workflows                                                                                                         | valores fixos de teste, sem segredo (banco e Redis dos service containers)                                                                              |
| CI (deploy)                       | _environments_ `staging` e `production` do GitHub e variáveis do repositório                                                       | seção 16                                                                                                                                                |

Salvar o _Environment_ de uma Application não reinicia nada: a mudança vale
no próximo **Deploy** (do painel ou do pipeline).

O app mobile não lê nada daqui (a URL da API dele vem dos environments do EAS,
`trajetto-mobile/docs/variaveis-de-ambiente.md`); a web lê as dela no
Environment da Application da web (`trajetto-ui/docs/variaveis-de-ambiente.md`)
e divide com a API só `RATE_LIMIT_FORWARDER_SECRET` e `TURNSTILE_SECRET_KEY`.
A tabela completa do que precisa casar entre a API, a web e o app (URLs,
origens, segredos compartilhados, R2, IA, push) é a mesma nos três
repositórios: [`deploy.md` → Os três repositórios juntos](./deploy.md#26-os-três-repositórios-juntos).

## Como a API lê o ambiente

- `src/env/index.ts` carrega o `.env` (com `dotenv-expand`: `${VAR}` dentro
  do arquivo funciona) e valida com o schema zod
  `src/schemas/env-schema/index.ts`. Valor faltando ou inválido derruba o
  boot com `Invalid enviroment variables` e a lista do que corrigir.
- Em staging e produção não há `.env`: o contêiner recebe exatamente as
  variáveis do _Environment_ da Application `trajetto-api`. Toda variável que
  a API lê pode ser definida lá; a que não estiver lá não existe (vale o
  padrão). `${VAR}` **não** é expandido no Environment do Dokploy: escreva os
  valores por extenso (por exemplo, a `DATABASE_URL` inteira).
- **Vazio conta como ausente** (`defined-env.ts`): `NOME=` vale o mesmo que
  não ter a linha, e o padrão dela continua valendo.
- Travas de produção (`NODE_ENV=production`, que a imagem sempre é):
  `UPLOAD_STORAGE_TYPE=r2` com as quatro `R2_*`; `RATE_LIMIT_TRUSTED_PROXY`
  definida; servidores públicos do OpenStreetMap recusados; `https` no mapa e
  no geocoder. Em staging **e** produção (`APP_ENV`): `JWT_SECRET` e
  `JWT_SECRET_REFRESH_TOKEN` com 32+ caracteres, diferentes entre si e sem o
  prefixo `GENERATE_`.
- `DATABASE_URL` não está no schema: quem a lê é o Prisma (e os scripts de
  boot). Sem ela o boot para ao esperar o Postgres.

## Como gerar os segredos

| Segredo                                                                                                              | Comando                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`                                                                             | `openssl rand -base64 48` (duas vezes: valores diferentes)       |
| senha do Redis, token da IA (`AI_LOCAL_TOKEN` = `AI_TOKEN`), `RATE_LIMIT_FORWARDER_SECRET`, `RATE_LIMIT_EDGE_SECRET` | `openssl rand -hex 32`                                           |
| senha do Postgres                                                                                                    | `openssl rand -hex 24` (hex: entra na `DATABASE_URL` sem escape) |
| `WEBHOOK_SECRETS_KEY`                                                                                                | `openssl rand -base64 32` (exatamente 32 bytes)                  |
| `MASTER_USER_INITIAL_PASSWORD`, `DOCS_PASSWORD` (20+)                                                                | `openssl rand -base64 24` (ou o gerenciador de senhas)           |
| chaves SSH do CI                                                                                                     | `ssh-keygen -t ed25519 -f <nome> -N ''`                          |

Nenhum segredo vai para o repositório, para o log nem para um print. Segredos
**diferentes** em staging e produção.

## Legenda

- **Obrig.**: `sempre` (o boot falha sem ela em qualquer ambiente), `prod`
  (o boot falha sem ela com `NODE_ENV=production`), `deploy` (o boot não
  exige, mas sem ela o ambiente fica errado — defina em staging e produção),
  `não`.
- **Segredo**: 🔒 = trate como senha (Dokploy, gerenciador de senhas; nunca em
  log); vazio = não é segredo.
- **Dev / Staging / Produção**: o valor esperado em cada ambiente; "—" = não
  definir. Salvo indicação, staging e produção ficam no _Environment_ da
  Application `trajetto-api`.

## 1. Identidade e processo

| Variável                       | Obrig. | Segredo | Formato / padrão                                                 | Dev               | Staging                     | Produção                       | Para quê                                                                                                                                                                                         |
| ------------------------------ | ------ | ------- | ---------------------------------------------------------------- | ----------------- | --------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                     | não    |         | `development`\|`test`\|`production`; padrão `development`        | `development`     | — (a imagem é `production`) | — (idem)                       | liga as travas de produção; o build inlina `production`                                                                                                                                          |
| `APP_ENV`                      | deploy |         | `development`\|`staging`\|`production`; vazio segue o `NODE_ENV` | `development`     | `staging`                   | `production`                   | qual implantação é esta (a imagem é a mesma). **Nada obriga**: vazia, a API se comporta como produção. `staging`/`production` exigem `NODE_ENV=production`                                       |
| `PORT`                         | não    |         | número; padrão `3333`                                            | `3333`            | —                           | —                              | porta do HTTP (o domínio da Application aponta para a 3333)                                                                                                                                      |
| `LOG_LEVEL`                    | não    |         | `fatal`…`trace`\|`silent`; padrão `info`                         | `info` ou `debug` | `info`                      | `info`                         | nível do logger único; `debug` acrescenta as linhas por socket                                                                                                                                   |
| `NODE_OPTIONS`                 | deploy |         | `--max-old-space-size=<MB>`                                      | —                 | `--max-old-space-size=768`  | `--max-old-space-size=768`     | teto do heap do V8, ~75 % do _Memory Limit_ da Application (1 GiB): um heap descontrolado termina num "heap out of memory" limpo, não num SIGKILL no meio de uma requisição. Suba os dois juntos |
| `WORKERS_ENABLED`              | não    |         | `true`\|`false`; padrão `true`                                   | `true`            | `true`                      | `true`                         | se esta réplica roda pipelines, dispatcher de webhooks e crons; `false` só com uma Application `worker` dedicada ([deploy.md](./deploy.md#19-réplicas-workers-e-tempo-real))                     |
| `PIPELINE_SWEEP_INTERVAL_MS`   | não    |         | ≥ 500; padrão `30000`                                            | —                 | —                           | — (`2000` num worker dedicado) | varredura de fundo dos pipelines                                                                                                                                                                 |
| `WAIT_FOR_POSTGRES_TIMEOUT_MS` | não    |         | ms; padrão `120000`                                              | —                 | —                           | —                              | quanto o boot espera o Postgres responder                                                                                                                                                        |
| `UV_THREADPOOL_SIZE`           | não    |         | número; `8` na imagem                                            | —                 | —                           | —                              | threads do libuv (bcrypt, gzip, fs, dns); só mude com medição                                                                                                                                    |
| `APP_COMMIT_SHA`               | não    |         | commit (7–40 hex); vazio = `dev`                                 | —                 | — (a imagem traz)           | — (idem)                       | commit do build, gravado na imagem pelo pipeline (build arg `GIT_SHA`); `GET /health/liveness` devolve em `version`/`commit`. Nunca defina à mão                                                 |

`NODE_ENV=test` é o das suítes (o E2E e as suítes de navegador da web, que
sobem esta API): o e-mail fica numa caixa em memória do processo e nenhum
servidor de e-mail é chamado; em `development`, o Ethereal; em `production`,
o Resend (`src/shared/providers/mail-provider/mail-provider-for.ts`).

## 2. Banco de dados

O banco de staging e o de produção são Databases **PostgreSQL** do Dokploy
(seção 13). A API recebe a conexão em duas URLs que **você monta** com os
dados do Database (usuário, senha, banco e o _Internal Host_, que é o App
Name). Os parâmetros depois do `?` são fixos — copie inteiros:

```
DATABASE_URL=postgresql://<USUÁRIO>:<SENHA>@<APP NAME DO POSTGRES>:5432/<BANCO>?schema=public&connection_limit=10&pool_timeout=20&connect_timeout=5&socket_timeout=60&max_idle_connection_lifetime=300&options=-c%20statement_timeout%3D30000%20-c%20lock_timeout%3D5000%20-c%20idle_in_transaction_session_timeout%3D60000
MIGRATION_DATABASE_URL=postgresql://<USUÁRIO>:<SENHA>@<APP NAME DO POSTGRES>:5432/<BANCO>?schema=public&connection_limit=2&connect_timeout=10
```

Exemplo de host: `trajetto-postgres-production` (staging:
`trajetto-postgres-staging`). O porquê de cada parâmetro, e no que cada um vira
no pool do `pg` (Prisma 7 com `@prisma/adapter-pg`), está em
[`arquitetura.md`](./arquitetura.md#conexão-com-o-postgres).

| Variável                                                                                        | Obrig. | Segredo      | Formato / padrão                | Dev                                                         | Staging                                | Produção                                          | Para quê                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------- | ------ | ------------ | ------------------------------- | ----------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                  | sempre | 🔒           | URL acima                       | apontando para `127.0.0.1:5432` (pode usar `${POSTGRES_*}`) | a URL acima, com o Postgres de staging | a URL acima, com o Postgres de produção           | conexão do Prisma em runtime: pool de 10, `socket_timeout`, `max_idle_connection_lifetime` e os tetos `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout`                                                                                    |
| `MIGRATION_DATABASE_URL`                                                                        | deploy | 🔒           | URL sem tetos de runtime        | — (vazio = usa a `DATABASE_URL`)                            | a URL acima                            | a URL acima                                       | `prisma migrate deploy` e os seeds do job de migrations (pool de 2), que copia o Environment da Application da API; a API em si não a usa. Sem ela as migrations rodam com os tetos de runtime e um `CREATE INDEX` longo é cancelado                              |
| `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USERNAME`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` | não    | 🔒 (a senha) | —                               | `localhost`, `5432`, `postgres`, qualquer, `trajetto`       | —                                      | —                                                 | **só desenvolvimento**: o `compose.development.yaml` cria o banco com elas e o `.env` monta a `DATABASE_URL`. Em staging e produção esses valores são campos do Database (seção 13). O `backup-postgres.sh` lê `POSTGRES_USERNAME`/`POSTGRES_DATABASE` (seção 14) |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                                                | não    |              | `true`\|`false`; padrão `false` | —                                                           | `true` só no primeiro boot             | `false` (`true` só numa instalação nova, uma vez) | o boot de produção recusa banco sem nenhuma migration aplicada                                                                                                                                                                                                    |

Tuning do Postgres (`shared_buffers` e afins) não é variável: é o comando
personalizado do Database ([deploy.md](./deploy.md#10-postgres-e-redis)).

## 3. Redis e tempo real

O Redis de cada ambiente é um Database **Redis** do Dokploy (seção 13), com
senha. A API recebe:

```
REDIS_URL=redis://:<SENHA DO REDIS>@<APP NAME DO REDIS>:6379
```

(ex. `trajetto-redis-production`).

| Variável                                     | Obrig. | Segredo        | Formato / padrão                            | Dev                        | Staging     | Produção    | Para quê                                                                                           |
| -------------------------------------------- | ------ | -------------- | ------------------------------------------- | -------------------------- | ----------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `REDIS_URL`                                  | sempre | 🔒 (com senha) | `redis://[:SENHA@]HOST:PORT`                | `redis://localhost:6379`   | a URL acima | a URL acima | rate limit e adapter do Socket.IO                                                                  |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | não    |                | —                                           | `localhost`, `6379`, vazio | —           | —           | **só desenvolvimento** (o `.env` de dev); em staging e produção a senha é o campo do Database      |
| `SOCKET_ADAPTER_KEY`                         | não    |                | `[A-Za-z0-9._:-]{1,64}`; padrão `socket.io` | —                          | —           | —           | prefixo dos canais do adapter; só para dois ambientes que dividam um Redis (cada um tem o próprio) |
| `SOCKET_REVALIDATE_MS`                       | não    |                | ≥ 1000; padrão `180000`                     | —                          | —           | —           | de quanto em quanto cada réplica revalida no banco as sessões dos sockets                          |

## 4. URLs, sessão e usuário master

| Variável                       | Obrig. | Segredo | Formato / padrão                   | Dev                     | Staging                              | Produção                                | Para quê                                                                                                                                                                                                      |
| ------------------------------ | ------ | ------- | ---------------------------------- | ----------------------- | ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP_REQUEST`                 | sempre |         | URL                                | `http://localhost:3000` | `https://staging.intrajetto.com`     | `https://www.intrajetto.com`            | URL pública da **web**: única origem do CORS e base dos links (PDF, QR, rastreio, e-mails)                                                                                                                    |
| `API_HTTP_REQUEST`             | não    |         | URL                                | `http://localhost:3333` | `https://api-staging.intrajetto.com` | `https://api.intrajetto.com` (previsto) | URL pública da própria API (o host é o da aba _Domains_ da Application); dela sai o logo dos e-mails (`/assets/trajetto-logo.png`), então precisa ser alcançável da internet. Vazia, os e-mails saem sem logo |
| `JWT_SECRET`                   | sempre | 🔒      | 32+ caracteres em staging/produção | qualquer                | **próprio**                          | **próprio**                             | assina o access token                                                                                                                                                                                         |
| `JWT_SECRET_REFRESH_TOKEN`     | sempre | 🔒      | 32+, diferente do `JWT_SECRET`     | qualquer (diferente)    | **próprio**                          | **próprio**                             | assina o refresh token; perdê-lo desloga todo mundo                                                                                                                                                           |
| `MASTER_USER_EMAIL`            | sempre |         | e-mail                             | `admin@example.com`     | o da equipe                          | o da equipe                             | usuário MASTER criado pelo seed                                                                                                                                                                               |
| `MASTER_USER_INITIAL_PASSWORD` | sempre | 🔒      | texto                              | qualquer                | **própria**                          | **própria**                             | senha inicial do MASTER criada pelo seed                                                                                                                                                                      |

## 5. Borda, rate limit e anti-bot

| Variável                      | Obrig. | Segredo | Formato / padrão                                    | Dev    | Staging                       | Produção                       | Para quê                                                                                                                                                                    |
| ----------------------------- | ------ | ------- | --------------------------------------------------- | ------ | ----------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RATE_LIMIT_TRUSTED_PROXY`    | prod   |         | `none`\|`xff`\|`cloudflare`; sem padrão em produção | `none` | `cloudflare`                  | `cloudflare`                   | de onde vem o endereço do cliente nos limites anônimos ([deploy.md](./deploy.md#11-domínios-tls-e-a-borda))                                                                 |
| `RATE_LIMIT_FORWARDER_SECRET` | não    | 🔒      | 32+ caracteres                                      | vazio  | **o mesmo da web de staging** | **o mesmo da web de produção** | o servidor da web repassa o IP do navegador junto com ele; sem ele todo usuário web conta como um endereço                                                                  |
| `RATE_LIMIT_EDGE_SECRET`      | não    | 🔒      | 32+ caracteres                                      | vazio  | opcional                      | recomendado                    | valor da Transform Rule da Cloudflare (`x-trajetto-edge-secret`); só defina **depois** das regras ativas                                                                    |
| `TURNSTILE_SECRET_KEY`        | não    | 🔒      | chave secreta do Turnstile                          | vazio  | a de staging                  | a de produção (a mesma da web) | liga o Turnstile no formulário público de orçamento: pedido sem token é recusado (400 `TURNSTILE_REQUIRED`) e o token é conferido na Cloudflare. Vazia, Turnstile desligado |

## 6. Arquivos (R2)

| Variável                        | Obrig.      | Segredo | Formato / padrão                             | Dev                             | Staging               | Produção                                           | Para quê                                      |
| ------------------------------- | ----------- | ------- | -------------------------------------------- | ------------------------------- | --------------------- | -------------------------------------------------- | --------------------------------------------- |
| `UPLOAD_STORAGE_TYPE`           | prod (`r2`) |         | `local`\|`r2`; padrão `local`                | `local`                         | `r2`                  | `r2`                                               | onde ficam fotos, assinaturas e PDFs          |
| `UPLOAD_LOCAL_PATH`             | não         |         | caminho; padrão `./tmp`                      | `./tmp`                         | `./tmp`               | `./tmp`                                            | pasta do modo `local`                         |
| `UPLOAD_SIGNED_URL_TTL_SECONDS` | não         |         | 60–3600; padrão `900`                        | —                               | —                     | —                                                  | validade das URLs assinadas                   |
| `UPLOAD_ORPHAN_GC`              | não         |         | `off`\|`dry-run`\|`delete`; padrão `dry-run` | `dry-run`                       | `dry-run`             | `dry-run`, depois `delete` após ler alguns resumos | coletor noturno de objetos sem linha          |
| `R2_ACCOUNT_ID`                 | prod        |         | id da conta Cloudflare                       | vazio                           | da conta              | da conta                                           |                                               |
| `R2_BUCKET_NAME`                | prod        |         | nome                                         | vazio                           | **bucket de staging** | bucket de produção                                 | bucket **privado** de fotos (com CORS da web) |
| `R2_ACCESS_KEY_ID`              | prod        | 🔒      |                                              | vazio                           | token de staging      | token de produção                                  | credencial S3 do R2                           |
| `R2_SECRET_ACCESS_KEY`          | prod        | 🔒      |                                              | vazio                           | idem                  | idem                                               |                                               |
| `R2_ENDPOINT`                   | não         |         | URL                                          | só nos testes de upload (MinIO) | —                     | —                                                  | endpoint S3 alternativo (path-style)          |

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

Do lado da **API** (_Environment_ da Application `trajetto-api`):

| Variável                   | Obrig. | Segredo | Formato / padrão                                            | Dev                                                         | Staging                                    | Produção                             | Para quê                                                                                                                                   |
| -------------------------- | ------ | ------- | ----------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `AI_PROVIDER`              | não    |         | `local`\|`none`; padrão `local` (`anthropic` impede o boot) | `local`                                                     | `local`, ou `none` sem a Application da IA | `local`                              | liga/desliga as leituras de foto                                                                                                           |
| `AI_LOCAL_URL`             | deploy |         | URL                                                         | `http://127.0.0.1:18080`                                    | `http://trajetto-ai-staging:8080`          | `http://trajetto-ai-production:8080` | `http://<App Name da Application trajetto-ai>:8080`. **Sem ela (ou sem o token) a IA fica desligada em silêncio**: a API trata como `none` |
| `AI_LOCAL_TOKEN`           | deploy | 🔒      | 32+ caracteres                                              | `dev-only-token-0123456789abcdef0123` (o do compose de dev) | **próprio**                                | **próprio**                          | bearer de toda chamada; **o mesmo valor** do `AI_TOKEN` da Application `trajetto-ai`                                                       |
| `AI_LOCAL_TIMEOUT_MS`      | não    |         | padrão `15000`                                              | —                                                           | —                                          | —                                    | orçamento de uma leitura (precisa caber no lease de 300 s, ou o boot para)                                                                 |
| `AI_LOCAL_MAX_CONCURRENCY` | não    |         | 1–4; padrão `1`                                             | —                                                           | —                                          | —                                    | leituras em voo por réplica                                                                                                                |

Do lado do **serviço** (_Environment_ da Application `trajetto-ai`):

| Variável           | Obrig.                              | Segredo | Padrão  | Staging / Produção                                            | Para quê                                                               |
| ------------------ | ----------------------------------- | ------- | ------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `AI_TOKEN`         | sempre (o serviço não sobe sem ela) | 🔒      | —       | **o mesmo valor** do `AI_LOCAL_TOKEN` da API daquele ambiente | token exigido em toda leitura; recusa subir com menos de 32 caracteres |
| `OCR_THREADS`      | não                                 |         | `2`     | `2` (= o _CPU Limit_ da Application)                          | threads do ONNX; igual às CPUs do contêiner                            |
| `AI_MAX_QUEUE`     | não                                 |         | `2`     | `2`                                                           | leituras esperando atrás da que roda; acima disso, 503 `busy`          |
| `AI_QUEUE_WAIT_MS` | não                                 |         | `10000` | —                                                             | quanto uma leitura espera na fila antes do 503                         |
| `PORT`             | não                                 |         | `8080`  | — (a API chama a 8080)                                        | porta do serviço                                                       |

Réplicas, memória e CPU da IA não são variáveis: são _Replicas_ e
_Resources_ da Application (seção 13).

## 10. Comprovante de entrega

Todas opcionais. Sem certificado, o PDF sai "sem assinatura digital" e diz
isso; sem mapa/geocoder, imprime o endereço cadastrado.

| Variável                                        | Segredo             | Formato / padrão                           | Staging                                                                                  | Produção                                                               | Para quê                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROOF_VERIFICATION_TTL_DAYS`                   |                     | inteiro; padrão `1825`                     | padrão                                                                                   | padrão                                                                 | validade do link público do QR                                                                                                                                                                                                                                            |
| `PROOF_SIGNING_PFX_BASE64`                      | 🔒                  | base64 do `.pfx`                           | o de teste ([deploy.md §7.11](./deploy.md#711-certificado-do-comprovante-a1-icp-brasil)) | o A1 (e-CNPJ)                                                          | certificado ICP-Brasil (ou o `_PATH`, nunca os dois)                                                                                                                                                                                                                      |
| `PROOF_SIGNING_PFX_PATH`                        |                     | caminho de um arquivo montado no contêiner | vazio                                                                                    | alternativa ao base64 (arquivo em _Advanced → Volumes_ da Application) |                                                                                                                                                                                                                                                                           |
| `PROOF_SIGNING_PFX_PASSWORD`                    | 🔒                  |                                            | a do de teste                                                                            | a senha do A1                                                          |                                                                                                                                                                                                                                                                           |
| `PROOF_SIGNATURE_PROFILE`                       |                     | `pades-ad-rb`\|`cms`; padrão `pades-ad-rb` | —                                                                                        | —                                                                      | perfil da assinatura                                                                                                                                                                                                                                                      |
| `PROOF_SIGNING_DISABLED`                        |                     | `true`\|`false`; padrão `false`            | —                                                                                        | `true` só num incidente                                                | desliga a assinatura sem remover o certificado                                                                                                                                                                                                                            |
| `PROOF_SIGNER_LOCATION`, `PROOF_SIGNER_CONTACT` |                     | texto                                      | —                                                                                        | ex. `Rio de Janeiro, RJ`, e-mail de suporte                            | metadados da assinatura                                                                                                                                                                                                                                                   |
| `PROOF_SIGNER_BRAND`                            |                     | padrão `TRAJETTO`                          | —                                                                                        | —                                                                      | a marca no texto de garantia                                                                                                                                                                                                                                              |
| `PROOF_ISSUER_LEGAL_NAME`                       |                     | padrão `Trajetto Sistemas Ltda`            | —                                                                                        | a razão social                                                         | quem gerou um documento **sem** assinatura                                                                                                                                                                                                                                |
| `PROOF_ISSUER_CNPJ`                             |                     | CNPJ válido                                | —                                                                                        | o CNPJ                                                                 | idem (vazio = omitido)                                                                                                                                                                                                                                                    |
| `PROOF_MAP_TILE_URL`                            | 🔒 (pode ter chave) | template XYZ `https://…/{z}/{x}/{y}`       | opcional                                                                                 | provedor escolhido (nunca `tile.openstreetmap.org`)                    | mapa estático. Os tiles vão com `Referer` = origem de `HTTP_REQUEST` (a web do ambiente): a chave do MapTiler é a mesma do mapa da web e fica restrita às origens da web em _Allowed HTTP Origins_; sem o cabeçalho, o MapTiler responde 403 e o comprovante sai sem mapa |
| `PROOF_MAP_TILE_ATTRIBUTION`                    |                     | texto                                      | obrigatório com a URL                                                                    | idem                                                                   | crédito impresso no mapa                                                                                                                                                                                                                                                  |
| `PROOF_MAP_TIMEOUT_MS`                          |                     | ≥ 200; padrão `3000`                       | —                                                                                        | —                                                                      | orçamento de todos os tiles                                                                                                                                                                                                                                               |
| `REVERSE_GEOCODER_URL`                          |                     | URL Nominatim-compatível, https            | opcional                                                                                 | provedor (nunca `nominatim.openstreetmap.org`)                         | endereço do GPS do comprovante                                                                                                                                                                                                                                            |
| `REVERSE_GEOCODER_KEY`                          | 🔒                  |                                            |                                                                                          |                                                                        | chave do provedor                                                                                                                                                                                                                                                         |
| `REVERSE_GEOCODER_KEY_PARAM`                    |                     | padrão `key`                               |                                                                                          |                                                                        | nome do parâmetro da chave                                                                                                                                                                                                                                                |
| `REVERSE_GEOCODER_USER_AGENT`                   |                     | texto                                      |                                                                                          |                                                                        | User-Agent exigido por alguns provedores                                                                                                                                                                                                                                  |
| `REVERSE_GEOCODER_TIMEOUT_MS`                   |                     | ≥ 200; padrão `2500`                       |                                                                                          |                                                                        |                                                                                                                                                                                                                                                                           |

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

## 13. Configurações do Dokploy que não são variáveis

O que no compose antigo era variável da stack virou campo do Dokploy. Passo a
passo de cada um em [`deploy.md`](./deploy.md#7-montar-o-dokploy-do-zero-staging-e-produção).

| Antes (variável da stack)                                              | Agora (onde no Dokploy)                                                                                                                                                              | Staging                                           | Produção                                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `API_IMAGE_TAG`, `AI_IMAGE_TAG`                                        | _General → Provider → Docker → Docker Image_ de cada Application                                                                                                                     | `ghcr.io/trajetto-organization/<imagem>:staging`  | `ghcr.io/trajetto-organization/<imagem>:stable`                                              |
| credencial do GHCR (antes: `docker login` no host)                     | _General → Provider → Docker_: _Registry URL_ `ghcr.io`, _Username_, _Password_ (token classic `read:packages`)                                                                      | o mesmo token                                     | o mesmo token                                                                                |
| `API_HOST`, `ROUTER_PREFIX`, `TRAEFIK_CERTRESOLVER`, `TRAEFIK_NETWORK` | aba _Domains_ da `trajetto-api`: _Host_, _Container Port_ `3333`, _HTTPS_, _Let's Encrypt_ (rede: sempre `dokploy-network`)                                                          | `api-staging.intrajetto.com`                      | a definir (previsto `api.intrajetto.com`)                                                    |
| réplicas da API (2 fixas no compose), `AI_REPLICAS`                    | _Advanced → Cluster Settings → Replicas_                                                                                                                                             | API 2 (ou 1); IA 1                                | API 2; IA 1                                                                                  |
| `API_MEMORY_LIMIT`                                                     | _Advanced → Resources → Memory Limit_ da `trajetto-api`                                                                                                                              | `1073741824` (ou menos, com `NODE_OPTIONS` junto) | `1073741824`                                                                                 |
| `API_HEAP_MB`                                                          | variável `NODE_OPTIONS=--max-old-space-size=768` (seção 1)                                                                                                                           | idem                                              | idem                                                                                         |
| `AI_CPUS`, `AI_MEMORY_LIMIT`                                           | _Resources_ da `trajetto-ai` (_CPU Limit_ `2000000000`, _Memory Limit_ `1073741824`) e `OCR_THREADS` igual às CPUs                                                                   | idem                                              | idem                                                                                         |
| healthcheck, update/rollback, restart policy, stop grace               | _Advanced → Swarm Settings_ de cada Application (JSON pronto no `deploy.md`)                                                                                                         | idem                                              | idem                                                                                         |
| `POSTGRES_USERNAME`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`          | campos _Database User_, _Database Password_, _Database Name_ do Database PostgreSQL                                                                                                  | próprios                                          | próprios (e reaparecem na `DATABASE_URL`, na `MIGRATION_DATABASE_URL` e nas `PG*` do backup) |
| `POSTGRES_HOST`, `POSTGRES_PORT`                                       | _Internal Host_ (= App Name) e _Internal Port_ (5432) do Database                                                                                                                    | `trajetto-postgres-staging`                       | `trajetto-postgres-production`                                                               |
| `POSTGRES_IMAGE`                                                       | campo da imagem do Database, com digest                                                                                                                                              | `postgres:16-alpine@sha256:…`                     | idem                                                                                         |
| `POSTGRES_VOLUME`                                                      | criado e nomeado pelo Dokploy (_Advanced → Volumes_ do Database)                                                                                                                     | —                                                 | —                                                                                            |
| `PG_SHARED_BUFFERS` e demais `PG_*` de tuning                          | comando personalizado do Database (se a versão tiver)                                                                                                                                | defaults                                          | conforme a RAM                                                                               |
| `REDIS_PASSWORD`, `REDIS_HOST`, `REDIS_PORT`                           | _Database Password_, _Internal Host_ e _Internal Port_ do Database Redis                                                                                                             | próprios                                          | próprios (e reaparecem no `REDIS_URL`)                                                       |
| sem persistência e teto de memória do Redis                            | comando personalizado do Database Redis: `redis-server --requirepass <senha> --save "" --appendonly no --maxmemory 256mb --maxmemory-policy allkeys-lru`; _Memory Limit_ `536870912` | idem                                              | idem                                                                                         |

## 14. Backup do banco

**Não tem variável.** Desde 26/10/2026 o único backup do banco é o _Backup_ do
próprio Database PostgreSQL no Dokploy (aba _Backups_), configurado no painel:
um _S3 Destination_ do Cloudflare R2 (_Settings → S3 Destinations_, com o token
R2 só do bucket de backup), agenda diária e retenção de 30 cópias. O passo a
passo está em [`deploy.md`](./deploy.md#18-backup-e-restauração). O antigo
serviço `trajetto-backup` e as variáveis dele (`PG*`, `BACKUP_R2_*`,
`BACKUP_AGE_RECIPIENT`, `BACKUP_HEARTBEAT_URL`, `BACKUP_AT_UTC`,
`BACKUP_RUN_NOW`) não existem mais (tabela no fim deste documento).

Do script manual `infra/scripts/backup-postgres.sh` (dump à mão antes de uma
operação arriscada; passadas na linha de comando, não são variáveis de
Application): `POSTGRES_USERNAME`, `POSTGRES_DATABASE`, `POSTGRES_SERVICE` (o
App Name do Database: o script acha o contêiner) ou `POSTGRES_CONTAINER` (um
contêiner direto), `BACKUP_EXCLUDE_TRAIL`, `BACKUP_TRAIL_ONLY`. Do
`infra/scripts/restore-postgres.sh` (ensaio de restore de um dump no formato
custom): `POSTGRES_IMAGE` (a mesma imagem do Database), `KEEP_CONTAINER`.

## 15. Scripts de operação no host

Definidas no comando restrito do `~/.ssh/authorized_keys` do usuário de
deploy (ou na linha de comando, à mão):

| Variável                  | Script                      | Padrão            | Valor com as Applications                     | Para quê                                                             |
| ------------------------- | --------------------------- | ----------------- | --------------------------------------------- | -------------------------------------------------------------------- |
| `API_SERVICE`             | `run-release-migrations.sh` | — (obrigatória)   | `trajetto-api-production` (o App Name da API) | serviço cujo env o job de migrations reaproveita                     |
| `MIGRATE_NETWORK`         | idem                        | `dokploy-network` | padrão                                        | rede do job (onde o Postgres está)                                   |
| `MIGRATE_TIMEOUT_SECONDS` | idem                        | `900`             | padrão                                        | espera do job                                                        |
| `MIGRATE_POLL_SECONDS`    | idem                        | `5`               | padrão                                        | intervalo da espera                                                  |
| `ROLLOUT_TIMEOUT_SECONDS` | `verify-rollout.sh`         | `600`             | padrão                                        | prazo da convergência                                                |
| `ROLLOUT_POLL_SECONDS`    | idem                        | `5`               | padrão                                        | intervalo da conferência                                             |
| `POSTGRES_SERVICE`        | `backup-postgres.sh`        | —                 | `trajetto-postgres-production`                | acha o contêiner do Database pelo App Name (ou `POSTGRES_CONTAINER`) |

O serviço que o `verify-rollout.sh` confere vem do CI (variável
`SWARM_API_SERVICE`, seção 16).

## 16. GitHub Actions

No repositório `Trajetto-Organization/trajetto-api`, _Settings →
Environments_ (por ambiente) e _Settings → Secrets and variables → Actions_
(repositório).

### Environment `staging`

| Nome                                                           | Tipo     | Obrig.                                  | Valor / para quê                                                    |
| -------------------------------------------------------------- | -------- | --------------------------------------- | ------------------------------------------------------------------- |
| `DOKPLOY_URL`                                                  | secret   | sim (com as duas abaixo)                | painel do Dokploy, `https://`                                       |
| `DOKPLOY_API_KEY`                                              | secret   | sim                                     | chave de API do Dokploy (_Settings → Profile → API/CLI_)            |
| `DOKPLOY_API_APPLICATION_ID`                                   | secret   | sim                                     | applicationId da `trajetto-api` de staging (o fim da URL no painel) |
| `DOKPLOY_AI_APPLICATION_ID`                                    | secret   | não (sem ele: aviso, IA não atualizada) | applicationId da `trajetto-ai` de staging                           |
| `SWARM_API_SERVICE`                                            | variable | sim, com a conferência ligada           | `trajetto-api-staging` (o App Name da API)                          |
| `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS` | secrets  | idem                                    | acesso SSH ao host (conferência do rollout)                         |
| `DEPLOY_VERIFY_SSH_KEY`                                        | secret   | idem                                    | chave privada restrita ao `verify-rollout.sh`                       |

Sem nenhum dos três `DOKPLOY_*` obrigatórios: o deploy é pulado com aviso.
Com só alguns: o job falha.

### Environment `production` (com revisores obrigatórios)

Os mesmos nomes, com os applicationIds das Applications de produção,
`SWARM_API_SERVICE=trajetto-api-production` e mais `DEPLOY_SSH_KEY` (chave
privada restrita ao `run-release-migrations.sh`).

### Repositório

| Nome                      | Tipo       | Valores                                                                                           | Para quê                                                                                       |
| ------------------------- | ---------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `ROLLOUT_VERIFY`          | variable   | `off` (só emergência; pode ficar só num environment)                                              | desliga a conferência do rollout                                                               |
| `IMAGE_SCAN_ENFORCE`      | variable   | `true`                                                                                            | um achado do Trivy passa a falhar o build (falha no download do banco ou erro do Trivy, nunca) |
| `CLIENT_REPOS_READ_TOKEN` | secret     | token só leitura de `Trajetto-Organization/trajetto-ui` e `Trajetto-Organization/trajetto-mobile` | contrato de rotas no `ci.yml`                                                                  |
| `GITHUB_TOKEN`            | automático | —                                                                                                 | GHCR (push/retag), `gh api`, semantic-release                                                  |

Opcionais do `.github/scripts/dokploy-deploy.mjs` (não definidas hoje; o
workflow define as outras): `DOKPLOY_WAIT` (`false` só dispara),
`DOKPLOY_TIMEOUT_SECONDS` (900), `DOKPLOY_POLL_SECONDS` (10).

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

| Valor                                                                      | Produção                                                                            | Staging                                                  | Onde                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `APP_ENV`                                                                  | `production`                                                                        | `staging`                                                | `trajetto-api`; nada obriga, confira                                            |
| tag das imagens                                                            | `:stable`                                                                           | `:staging`                                               | _Docker Image_ das duas Applications                                            |
| domínio da API                                                             | a definir (previsto `api.intrajetto.com`)                                           | `api-staging.intrajetto.com`                             | _Domains_ da `trajetto-api`                                                     |
| hosts internos (App Names)                                                 | `trajetto-*-production`                                                             | `trajetto-*-staging`                                     | `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `REDIS_URL`, `AI_LOCAL_URL`, `PGHOST` |
| `HTTP_REQUEST`, `API_HTTP_REQUEST`                                         | origens de produção                                                                 | as de staging                                            | `trajetto-api`                                                                  |
| senhas do Postgres e do Redis, `JWT_*`, token da IA, `WEBHOOK_SECRETS_KEY` | próprios                                                                            | **outros**                                               | Databases e Applications; nunca compartilhar                                    |
| `R2_*`                                                                     | bucket de produção                                                                  | bucket de staging                                        | `trajetto-api` (CORS de cada bucket)                                            |
| `META_WHATSAPP_*`, `RESEND_*`                                              | reais                                                                               | de teste                                                 | `trajetto-api` (configuração, não trava no código)                              |
| backup do banco (aba _Backups_ do Database)                                | prefixo `trajetto-production/` (recomendado bucket próprio `trajetto-backups-prod`) | prefixo `trajetto-staging/` no bucket `trajetto-backups` | Dokploy, não é variável (deploy.md §18)                                         |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                           | `false`                                                                             | `true` só no primeiro boot                               | `trajetto-api`                                                                  |
| `RATE_LIMIT_TRUSTED_PROXY`                                                 | `cloudflare`                                                                        | `cloudflare`                                             | `trajetto-api`                                                                  |
| `SOCKET_ADAPTER_KEY`                                                       | vazio                                                                               | vazio                                                    | cada ambiente tem o próprio Redis                                               |
| IA                                                                         | `AI_PROVIDER=local` + Application `trajetto-ai`                                     | idem, ou `AI_PROVIDER=none` sem a Application            | `trajetto-api` / `trajetto-ai`                                                  |
| `PROOF_SIGNING_*`                                                          | o A1                                                                                | o de teste (deploy.md §7.11)                             | `trajetto-api`                                                                  |
| `SWARM_API_SERVICE`, `DOKPLOY_*_APPLICATION_ID`                            | os de produção                                                                      | os de staging                                            | environments do GitHub                                                          |

## Variáveis que não existem mais

Apague se ainda estiverem em algum Environment, `.env` ou secret:

| Variável                                                                                                                                                                                                                                                                                  | Por quê                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ROUTER_PREFIX`, `API_HOST`, `TRAEFIK_NETWORK`, `TRAEFIK_CERTRESOLVER`                                                                                                                                                                                                                    | eram labels do Traefik no compose; agora é a aba _Domains_ da Application (seção 13)                                                                                                                                                       |
| `API_IMAGE_TAG`, `AI_IMAGE_TAG`, `BACKUP_IMAGE_TAG`                                                                                                                                                                                                                                       | a tag é o _Docker Image_ de cada Application (e não há mais imagem de backup)                                                                                                                                                              |
| `API_HEAP_MB`, `API_MEMORY_LIMIT`, `AI_REPLICAS`, `AI_CPUS`, `AI_MEMORY_LIMIT`                                                                                                                                                                                                            | `NODE_OPTIONS`, _Replicas_ e _Resources_ das Applications                                                                                                                                                                                  |
| `POSTGRES_VOLUME`, `POSTGRES_IMAGE`, `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE`, `PG_WORK_MEM`, `PG_MAINTENANCE_WORK_MEM`, `PG_RANDOM_PAGE_COST`                                                                                                                                      | o banco é um Database do Dokploy (volume, imagem e comando são campos dele); `POSTGRES_IMAGE` continua só como entrada do `restore-postgres.sh`                                                                                            |
| `POSTGRES_*` e `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` em staging e produção                                                                                                                                                                                                           | campos dos Databases; a API lê só as URLs. Continuam no `.env` de desenvolvimento                                                                                                                                                          |
| `STACK_NAME` (scripts do host)                                                                                                                                                                                                                                                            | o `run-release-migrations.sh` não monta mais nomes de stack; use `API_SERVICE` (seção 15)                                                                                                                                                  |
| `REDIS_ENFORCE_AUTH`                                                                                                                                                                                                                                                                      | transição de um Redis sem senha; o Redis do Dokploy nasce com senha                                                                                                                                                                        |
| `DOKPLOY_COMPOSE_ID` (secret do GitHub)                                                                                                                                                                                                                                                   | era o id do app Compose; agora são os `DOKPLOY_*_APPLICATION_ID`                                                                                                                                                                           |
| `ANTHROPIC_API_KEY`, `AI_ANTHROPIC_MODEL`                                                                                                                                                                                                                                                 | a leitura de fotos é local (ADR 0010); `AI_PROVIDER=anthropic` impede o boot. Revogue a chave antiga                                                                                                                                       |
| `RABBITMQ_URL`                                                                                                                                                                                                                                                                            | o broker saiu em 09/2026; o Postgres é a fila                                                                                                                                                                                              |
| `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_HTTP_REQUEST`, `TRAJETTO_WHATSAPP_BUSINESS_PHONE`, `TRAJETTO_WHATSAPP_INSTANCE_NAME`                                                                                                                                                 | o WhatsApp é a Cloud API oficial da Meta                                                                                                                                                                                                   |
| `TWO_FACTOR_CHALLENGE_REQUIRED`                                                                                                                                                                                                                                                           | era a transição para builds da web e do app que não mandavam o desafio do 2FA; nenhum chegou a usuários reais, então o desafio é sempre exigido (25/10/2026)                                                                               |
| `TURNSTILE_REQUIRED`                                                                                                                                                                                                                                                                      | era a transição para a web que não repassava o token; agora `TURNSTILE_SECRET_KEY` definida basta para exigir o token (25/10/2026)                                                                                                         |
| `CLOUDINARY_LOGO_IMAGE`                                                                                                                                                                                                                                                                   | o logo dos e-mails é servido pela própria API em `/assets/trajetto-logo.png`, montado a partir de `API_HTTP_REQUEST` (25/10/2026)                                                                                                          |
| `R2_PUBLIC_DOMAIN`                                                                                                                                                                                                                                                                        | o bucket é privado; toda leitura é URL assinada                                                                                                                                                                                            |
| `STAGING_ENABLED` (variável do GitHub)                                                                                                                                                                                                                                                    | o deploy de staging depende só dos secrets do Dokploy                                                                                                                                                                                      |
| `PORTAINER_WEBHOOK_URL`, `PORTAINER_STAGING_WEBHOOK_URL` (secrets do GitHub)                                                                                                                                                                                                              | o deploy é pelo Dokploy                                                                                                                                                                                                                    |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `BACKUP_R2_ACCOUNT_ID`, `BACKUP_R2_BUCKET`, `BACKUP_R2_ACCESS_KEY_ID`, `BACKUP_R2_SECRET_ACCESS_KEY`, `BACKUP_AGE_RECIPIENT`, `BACKUP_HEARTBEAT_URL`, `BACKUP_AT_UTC`, `BACKUP_RUN_NOW` e `BACKUP_EXCLUDE_TRAIL` no Environment | eram do serviço `trajetto-backup`, removido em 26/10/2026: o backup do banco é o do próprio Dokploy (aba _Backups_ do Database, destino S3 no R2), sem variável. `BACKUP_EXCLUDE_TRAIL` segue só como opção do `backup-postgres.sh` manual |
| `DOKPLOY_BACKUP_APPLICATION_ID` (secret do GitHub)                                                                                                                                                                                                                                        | não há mais Application de backup para o pipeline atualizar                                                                                                                                                                                |
