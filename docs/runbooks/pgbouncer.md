# pgbouncer — Adoção e operação do PgBouncer

**Quando:** onda 17 (plano de escala F4-39): criar a Application `trajetto-pgbouncer`, trocar as URLs do runtime para ela, reiniciar o Postgres de propósito, redeployar o PgBouncer, ou voltar ao Postgres direto.

## O que significa

O PgBouncer fica entre as Applications do runtime e o Postgres, em modo transaction: muitos clientes dividem poucas conexões de servidor, e cada transação vai para a conexão que estiver livre. Ele também é o endpoint estável do failover: as URLs apontam para ele, e trocar o primário é trocar só o `PGBOUNCER_PRIMARY_HOST` dele. A imagem, a configuração e as senhas estão em [deploy.md, PgBouncer](../deploy.md#pgbouncer-a-imagem-trajetto-pgbouncer-onda-17).

**Onde e quando.** Primeiro a staging, já no 2º VPS (G-03). Uma semana depois, a produção da VPS 1, e só depois de a staging sair da VPS única (regra R1 da seção 3 do plano de escala): os tetos da tabela abaixo foram somados sem a staging na VPS 1. Uma réplica, start-first. Duas réplicas em nós diferentes só quando houver nós (onda 23, com a constraint `trajetto.db`, `MaxReplicas` 1, o rolling stop-first e o `PGBOUNCER_MAX_DB_CONNECTIONS` de cada uma pela metade: [swarm-multi-no](./swarm-multi-no.md)).

**Antes de tudo**, o corte dos roles (onda 6) precisa estar feito no ambiente: o `auth_query` não serve superusuário nem o dono das tabelas, então as URLs do runtime já usam os logins `trajetto_*` ([deploy.md, roles do banco](../deploy.md#roles-do-banco-logins-urls-e-conexões)).

**O que passa pelo PgBouncer e o que nunca passa:**

| Application                                 | Variável                                       | Login                 | `connection_limit` | Destino                             |
| ------------------------------------------- | ---------------------------------------------- | --------------------- | ------------------ | ----------------------------------- |
| `trajetto-api` (papel `api` ou `all`)       | `DATABASE_URL`                                 | `trajetto_http`       | 6                  | o PgBouncer, banco `trajetto`       |
| `trajetto-api`                              | `DATABASE_READ_URL`                            | `trajetto_read`       | 3                  | o PgBouncer, banco `trajetto`       |
| `trajetto-api` e os papéis de borda         | `READINESS_DATABASE_URL`                       | `trajetto_http`       | 1                  | o PgBouncer, alias `trajetto_probe` |
| `trajetto-worker`                           | `DATABASE_URL`                                 | `trajetto_worker`     | 8                  | o PgBouncer, banco `trajetto`       |
| `trajetto-worker-external`                  | `DATABASE_URL`                                 | `trajetto_worker`     | 4                  | o PgBouncer                         |
| `trajetto-realtime`                         | `DATABASE_URL`                                 | `trajetto_http`       | 3                  | o PgBouncer                         |
| `trajetto-ingest`                           | `DATABASE_URL`                                 | `trajetto_http`       | 6                  | o PgBouncer                         |
| quem roda o cron (`all`, worker, scheduler) | `BATCH_DATABASE_URL`                           | `trajetto_batch`      | 3                  | **o Postgres, direto, sempre**      |
| `trajetto-scheduler`                        | `DATABASE_URL`                                 | `trajetto_batch`      | 3                  | **o Postgres, direto**              |
| `trajetto-api-migrate`                      | `DATABASE_URL` (ou `MIGRATION_DATABASE_URL`)   | o usuário do Database | 2                  | **o Postgres, direto, sempre**      |
| quem roda o cron                            | `PGBOUNCER_STATS_URL`, `PGBOUNCER_STATS_HOSTS` | `pgbouncer_stats`     | —                  | o console do PgBouncer (só `SHOW`)  |

A `BATCH_DATABASE_URL` e a URL da migração nunca vão pelo PgBouncer: o job de partições destaca com `CONCURRENTLY` e troca o role da própria sessão, e a etapa de release usa locks de sessão, o que o modo transaction quebra em silêncio. O boot recusa a `BATCH_DATABASE_URL` na porta 6432 ou com `pgbouncer=true`, e a etapa de release recusa a porta 6432. O login de administração (`pgbouncer_admin`) nunca entra no _Environment_ de nenhuma Application além da própria `trajetto-pgbouncer`: `PAUSE`, `RESUME`, `KILL` e `SHUTDOWN` são só do dono.

**O que a API já faz com ele:** a URL pelo PgBouncer leva só o `TimeZone` no `options` e cada conexão vive até 60 s (o boot recusa o resto, F4-31); as recusas dele viram 503 com `Retry-After`, nunca 500 (F4-32); os pools aparecem em `pgbouncer` no `/health/metrics`, com três alertas (F4-36); a readiness tem o pool próprio no alias (F4-37).

**O orçamento.**

| Recurso                               | Staging (2º VPS)                                         | Produção (VPS 1)                                |
| ------------------------------------- | -------------------------------------------------------- | ----------------------------------------------- |
| Memória / CPU da `trajetto-pgbouncer` | `33554432` (32 MiB) / `100000000` (0,1)                  | `67108864` (64 MiB) / `250000000` (0,25)        |
| Réplicas                              | 1, start-first                                           | 1, start-first (2 em nós diferentes na onda 23) |
| Conexões ao Postgres pelo PgBouncer   | até 60 (`PGBOUNCER_MAX_DB_CONNECTIONS`) + 2 do alias     | até 60 + 2                                      |
| Conexões diretas                      | batch 3 por processo com cron, migração 2, ferramentas 8 | as mesmas                                       |
| Clientes do PgBouncer                 | cada processo: as `connection_limit` da tabela acima     | idem; muito abaixo do `max_client_conn` de 2000 |

Cada par de banco e login tem até `default_pool_size` (20) conexões de servidor, e os pares juntos ficam no teto de 60: com os do runtime, o Postgres vê no máximo 62 pelo PgBouncer mais umas 15 diretas, abaixo dos 200 de `max_connections`. Medido sem carga, o PgBouncer usa uns 10 MB de memória: acompanhe o `docker stats` dele na semana de observação.

## Primeira ação

### Criar a Application (staging)

1. No `psql` do Database (`docker exec -it $(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-staging) psql -U trajetto -d trajetto`): `ALTER ROLE pgbouncer_auth LOGIN;` e o meta-comando `\password pgbouncer_auth`, com uma senha de `openssl rand -hex 32`. Nunca escreva a senha num SQL.
2. Dokploy → projeto `trajetto-api` → environment `staging` → **Create Service → Application**: Name `trajetto-pgbouncer`, App Name `trajetto-pgbouncer-staging`.
3. **General** → Provider **Docker**: Docker Image `ghcr.io/trajetto-organization/trajetto-pgbouncer:staging`, Registry URL `ghcr.io`, o usuário e o PAT de leitura do GHCR ([deploy.md, 7.3](../deploy.md#73-credencial-do-ghcr)). **Save**. Sem Autodeploy e sem Domain.
4. **Environment**: `PGBOUNCER_DATABASE=trajetto`, `PGBOUNCER_PRIMARY_HOST=trajetto-postgres-staging`, `PGBOUNCER_AUTH_PASSWORD` (a mesma do passo 1), `PGBOUNCER_STATS_PASSWORD` e `PGBOUNCER_ADMIN_PASSWORD` (cada uma de `openssl rand -hex 32`, diferentes entre si) e `PGBOUNCER_MAX_DB_CONNECTIONS=60`. **Save**. A senha de administração fica só aqui e no seu cofre.
5. **Advanced → Resources**: Memory Limit `33554432`, CPU Limit `100000000`. **Cluster Settings**: Replicas `1`.
6. **Advanced → Swarm Settings** (os campos não citados ficam vazios; o Health Check também, para valer o da imagem, o `pg_isready` no console local):
   - Restart Policy: `{ "Condition": "any", "Delay": 5000000000, "MaxAttempts": 0 }`
   - Update Config: `{ "Parallelism": 1, "Delay": 5000000000, "FailureAction": "rollback", "Monitor": 30000000000, "Order": "start-first" }`
   - Rollback Config: `{ "Parallelism": 1, "Delay": 5000000000, "Monitor": 30000000000, "Order": "start-first" }`
   - Stop Grace Period: `90000000000`
   - Placement: só depois dos labels do nó (onda 17, F4-52): `{ "Constraints": ["node.labels.trajetto.db==true"] }`, sem `MaxReplicas` enquanto houver uma réplica só: com start-first, a task nova ficaria sem vaga ([swarm-multi-no](./swarm-multi-no.md))
7. **Deploy**. Em _Logs_: a linha `trajetto-pgbouncer: imagem <commit>; trajetto e trajetto_probe em trajetto-postgres-staging:5432; …` e nenhum `ERRO`.
8. GitHub → Settings → Environments → `staging`: o secret `DOKPLOY_PGBOUNCER_APPLICATION_ID` (o applicationId da Application, na URL dela) e a variável `SWARM_PGBOUNCER_SERVICE=trajetto-pgbouncer-staging`. Sem o secret, o CI só move a tag e não implanta.
9. Reinstale o `infra/scripts/verify-rollout.sh` no host ([deploy.md, 14](../deploy.md#14-conferir-a-convergência)): a versão nova aceita `trajetto-pgbouncer`.
10. Confira o console pelo login de estatística, no terminal da tarefa do PgBouncer (Dokploy → `trajetto-pgbouncer` → _Terminal_, ou `docker exec` nela): `psql -h 127.0.0.1 -p 6432 -U pgbouncer_stats pgbouncer -c 'SHOW POOLS'`.

### Trocar as URLs, uma Application por vez

Cada passo é **Save** → **Deploy** na Application, e a conferência do fim desta seção antes do próximo. Os formatos (troque só o usuário, a senha, o host e o `connection_limit`; na produção, `-production`):

```
postgresql://trajetto_http:<SENHA>@trajetto-pgbouncer-staging:6432/trajetto?schema=public&connection_limit=6&pool_timeout=5&connect_timeout=5&socket_timeout=60&pgbouncer=true
postgresql://trajetto_http:<SENHA>@trajetto-pgbouncer-staging:6432/trajetto_probe?schema=public&connection_limit=1&connect_timeout=3&pgbouncer=true
postgresql://pgbouncer_stats:<SENHA DE ESTATÍSTICA>@trajetto-pgbouncer-staging:6432/pgbouncer
```

Sem `options`: os tetos vêm do `ALTER ROLE` de cada login, e o boot recusa uma URL pelo PgBouncer com eles no `options`.

1. Na Application que roda o cron (a `trajetto-api` no papel `all`, a `trajetto-worker` depois da separação, a `trajetto-scheduler` quando existir): `PGBOUNCER_STATS_URL` e `PGBOUNCER_STATS_HOSTS=tasks.trajetto-pgbouncer-staging`. Nenhum tráfego muda; em até 2 min, `pgbouncer.status` é `up` em `/health/metrics`.
2. `trajetto-worker`: a `DATABASE_URL` com `trajetto_worker` pelo PgBouncer e `connection_limit=8`. A `BATCH_DATABASE_URL` fica direta.
3. `trajetto-api`: a `DATABASE_URL` (`trajetto_http`, 6), a `DATABASE_READ_URL` (`trajetto_read`, 3) e a `READINESS_DATABASE_URL` (o alias), juntas.
4. `trajetto-worker-external`, `trajetto-realtime` e `trajetto-ingest`, quando existirem, com os limites da tabela.
5. A `trajetto-api-migrate` e as `BATCH_DATABASE_URL` não mudam.

Depois da staging, **uma semana de observação** (a conferência abaixo, todo dia). Na produção, os mesmos passos com `-production`, Memory `67108864`, CPU `250000000` e o environment `production` do GitHub.

### Reinício planejado do Postgres (PAUSE, CHECKPOINT, redeploy, RESUME)

Fora do horário (00h–05h BRT), com aviso, staging antes:

1. Abra o console de administração dentro do contêiner do PgBouncer (só dali: pela rede ele é recusado) e deixe a sessão aberta: `psql -h 127.0.0.1 -p 6432 -U pgbouncer_admin pgbouncer`, com a senha de administração do cofre.
2. `PAUSE trajetto;` volta quando as transações em andamento terminam e o PgBouncer fecha as conexões de servidor desse banco. Daí em diante, os pedidos esperam no PgBouncer; quem espera mais de 5 s (`query_wait_timeout`) recebe 503 `SERVICE_BUSY` com `Retry-After`, e o app e a web tentam de novo (medido na pilha do E2E: 5,6 s até a recusa). O alias `trajetto_probe` não pausa: a readiness vê o Postgres fora enquanto ele reinicia. Pause o monitor externo durante a janela.
3. No `psql` do Database: `CHECKPOINT;` (o reinício fica curto).
4. Dokploy → o Database → **Deploy**, e espere o `pg_isready` dentro dele.
5. Na sessão do passo 1: `RESUME trajetto;`. `SHOW DATABASES` mostra `paused` 0.

Quanto mais curto entre o passo 2 e o 5, menos pedidos recebem 503: prepare tudo antes de pausar.

### Redeploy do PgBouncer (rolling)

O CI só reimplanta o PgBouncer quando o digest muda (`infra/pgbouncer`); uma variável trocada pede **Deploy** no painel. No start-first, a tarefa nova sobe e a antiga recebe o SIGTERM, que é o `SHUTDOWN WAIT_FOR_CLIENTS`: ela recusa logins novos e espera os clientes saírem. Os pools do runtime trocam cada conexão em até 60 s, dentro dos 90 s do _Stop Grace Period_. O portão é o burn-in da staging ([deploy.md, burn-in](../deploy.md#ensaio-de-carga-na-staging-burn-in)) com o **Deploy** da `trajetto-pgbouncer` no meio da carga, no lugar do da `trajetto-api`: zero respostas 5xx. Um login novo que encontra a tarefa antiga fechando recebe 503 `SERVICE_UNAVAILABLE`, nunca 500; se o burn-in mostrar algum, anote quantos e quando.

## Como confirmar

- `/health/metrics`: `pgbouncer.status` `up`, `pgbouncer.totals.cl_waiting` 0 fora de pico e `server_usage_percent` abaixo de 70%; `runtime.prisma_pool` sem espera.
- `/health/readiness` 200 nas réplicas.
- No log da API, nenhum `unsupported startup parameter` (uma URL com `options`), nenhum 500 novo e os `Database busy` com `reason` `pgbouncer_*` só em pico.
- No `psql` do Database, as sessões do runtime com nome (`trajetto-<papel>`) e a do `auth_query` como `trajetto-pgbouncer-auth`; nenhuma sem nome, que seguraria as contrações da etapa de release:

  ```sql
  SELECT usename, application_name, count(*) FROM pg_stat_activity
   WHERE datname = current_database() GROUP BY 1, 2 ORDER BY 3 DESC;
  ```

- Aceite: uma semana na staging sem erro novo, e o rolling do PgBouncer sob o burn-in sem 5xx.

## Quando escalar

**Voltar ao Postgres direto** (uma Application por vez, na ordem inversa da troca: os papéis de borda, a `trajetto-api`, a `trajetto-worker`): as URLs de antes, na porta 5432 e com o `options` dos tetos, como em [deploy.md, roles do banco](../deploy.md#roles-do-banco-logins-urls-e-conexões); a `READINESS_DATABASE_URL` vazia (a readiness volta à `DATABASE_URL`). Por último, as `PGBOUNCER_STATS_*` vazias e a `trajetto-pgbouncer` em Replicas 0. A decisão de voltar é do dono.

O PgBouncer fora do ar derruba todas as Applications que passam por ele: os alertas [pgbouncer-down](./pgbouncer-down.md), [pgbouncer-clients-waiting](./pgbouncer-clients-waiting.md) e [pgbouncer-server-saturation](./pgbouncer-server-saturation.md) dizem o que olhar. Subir os pools (`PGBOUNCER_DEFAULT_POOL_SIZE`, `PGBOUNCER_MAX_DB_CONNECTIONS`) mexe no orçamento do Postgres e é decisão do dono. A troca do primário (failover) é a troca do `PGBOUNCER_PRIMARY_HOST` com um **Deploy** da `trajetto-pgbouncer`, pelo `infra/pgbouncer/retarget.sh`: [failover-standby](./failover-standby.md).
