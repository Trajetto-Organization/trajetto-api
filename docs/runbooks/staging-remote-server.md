# staging-remote-server — A staging num Remote Server (2º VPS)

**Quando:** onda 16 (G-03), depois dos portões B e do 100k no 2º VPS vazio (G-01 e G-02) e do Dokploy na v0.31.x com o ensaio de transferência (onda 13, decisão D73).

## O que significa

Hoje a staging divide a VPS 1 com a produção: a RAM, a CPU, o disco e a rede `dokploy-network`. Este procedimento leva a staging inteira (API e papéis, migrate, IA, web, PgBouncer e os dois Databases) para um 2º VPS do **mesmo plano e da mesma região** da VPS 1 (EUA), com a rede privada ligada entre os dois. O 2º VPS entra primeiro vazio, como bancada dos portões B e do 100k (environment `bancada`, decisão D74), e só depois vira o servidor da staging, cadastrado como _Remote Server_ do mesmo Dokploy (o painel continua na VPS 1).

Há dois caminhos, e o ensaio da onda 13 escolhe entre eles:

- **(a) Transferência** pelo Dokploy v0.31.x (PR #5396 do Dokploy): cada Application muda de servidor e mantém o App Name e o `applicationId`. Só vale se o ensaio com uma Application descartável (e com um Database descartável, para os Databases) passou: deploy, logs, Environment, Domain e Schedules iguais depois de transferir.
- **(b) Recriação**: as Applications nascem de novo no 2º VPS, com App Names e `applicationId` novos, e a lista fechada abaixo é trocada inteira, de uma vez.

Nos dois caminhos: os Databases da staging nascem vazios no 2º VPS e recebem **só o seed** (nenhum dado é copiado de um servidor para o outro, e nunca dado da produção); a staging antiga é apagada da VPS 1; e a RAM volta à produção (G-04).

Os nomes `trajetto-*-staging` abaixo são marcadores dos App Names ([deploy.md, seção 7.2](../deploy.md#72-nomes-name-e-app-name)); nenhum valor de segredo aparece aqui.

## Primeira ação

### Antes, nos dois caminhos

1. O _Web Server Backup_ do Dokploy (F0-04) com menos de 24 h, e o Dokploy na v0.31.x.
2. O 2º VPS: firewall da Contabo igual ao da VPS 1 ([deploy.md, seção 6.1](../deploy.md#61-firewall-da-vps-contabo)), o `daemon.json` com a rotação de logs ([seção 6](../deploy.md#6-preparar-o-servidor-uma-vez)), a limpeza diária de imagens, o earlyoom (F0-11) e o agente do Beszel.
3. Dokploy → _Remote Servers_ → o 2º VPS → _Setup Server_ (se ainda não feito na bancada), e o environment `bancada` já apagado (G-02).
4. Inventário do que existe hoje, para a lista do caminho (b) e para apagar no fim:

   ```sh
   docker service ls --format '{{.Name}} {{.Image}}' | grep -- '-staging'
   ```

   e, no painel, o `applicationId` de cada Application da staging (está na URL).

5. Aviso: nenhum push na `staging` da API, da web e do app durante a janela.

### Caminho (a): transferência

1. Os Databases não são transferidos: a staging recebe só o seed. Crie-os vazios no 2º VPS primeiro, como no caminho (b), passo 1, porque uma Application transferida já precisa achar o banco na rede do servidor novo.
2. No _Environment_ de cada Application, as URLs com os App Names novos dos Databases (as linhas de Environment e "Hosts dos Databases" da lista fechada abaixo). **Save**, sem Deploy.
3. Para cada Application da staging (`trajetto-api-staging`, as de papel que existirem, `trajetto-api-migrate-staging`, `trajetto-ai-staging`, `trajetto-pgbouncer-staging` e, no projeto `trajetto-ui`, `trajetto-ui-staging`): a ação de transferir para o 2º VPS, com o nome que o botão tem na versão instalada (anotado no ensaio da onda 13). Uma por vez; depois de cada uma, **Deploy** e os logs.
4. A migrate e o F1a como no caminho (b), passos 3 e 4.
5. Ficam iguais na transferência: os secrets `DOKPLOY_*_APPLICATION_ID` e as vars `SWARM_*_SERVICE`. Mudam mesmo assim, da lista fechada: a conferência por SSH (`DEPLOY_SSH_*` e o forced command no 2º VPS), a `RELEASE_SERIALIZE_WITH_APPLICATION_ID`, os Schedules do servidor (são do servidor, não da Application) e o DNS.
6. Siga em "Nos dois caminhos, no fim".

### Caminho (b): recriação

1. No 2º VPS, os Databases primeiro: _Create Service → Database_ PostgreSQL e Redis, como em [deploy.md, seções 7.4 e 7.5](../deploy.md#74-postgresql-database), com senhas **novas**. O PostgreSQL com a imagem `trajetto-postgres` por digest e o _Environment_ da coluna da staging em [deploy.md, seção 27](../deploy.md#27-pitr-com-pgbackrest), mais `PGBACKREST_REPO1_PATH=/staging-2`: o cluster novo tem outro system-id, e o repositório antigo, na raiz do bucket, tem WAL sob a trava de 14 dias, que não deixa a stanza antiga sair. A regra de Bucket Lock passa a `staging-2/archive/trajetto/1` (`infra/r2/bucket-locks.md`).
2. As Applications, pelo guia de [deploy.md, seção 7](../deploy.md#7-montar-o-dokploy-do-zero-staging-e-produção) e pela seção 3.4 do plano de escala para as de papel, com o Environment copiado da staging antiga e a lista fechada abaixo aplicada.
3. A `trajetto-api-migrate-staging` nova uma vez com `ALLOW_EMPTY_DATABASE_BOOTSTRAP=true` (banco vazio, [deploy.md, seção 8](../deploy.md#8-primeiro-deploy-na-ordem-com-conferências), passo 4), depois `false`. Ela aplica as migrations e o seed.
4. O F1a no Database novo ([deploy.md, seção 27](../deploy.md#27-pitr-com-pgbackrest)), com a stanza no caminho `/staging-2`.

**A lista fechada do caminho (b).** Tudo o que guarda um App Name, um `applicationId` ou o host da VPS 1, e muda junto, no mesmo dia:

| Onde                                                      | O quê                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub da API, environment `staging`, secrets             | `DOKPLOY_API_APPLICATION_ID`, `DOKPLOY_AI_APPLICATION_ID`, `DOKPLOY_MIGRATE_APPLICATION_ID` e, se existirem, `DOKPLOY_WORKER_APPLICATION_ID`, `DOKPLOY_SCHEDULER_APPLICATION_ID`, `DOKPLOY_WORKER_EXTERNAL_APPLICATION_ID`, `DOKPLOY_REALTIME_APPLICATION_ID`, `DOKPLOY_INGEST_APPLICATION_ID` e `DOKPLOY_PGBOUNCER_APPLICATION_ID` |
| GitHub da API, environment `staging`, vars                | `SWARM_API_SERVICE` e, se existirem, `SWARM_WORKER_SERVICE`, `SWARM_SCHEDULER_SERVICE`, `SWARM_WORKER_EXTERNAL_SERVICE`, `SWARM_REALTIME_SERVICE`, `SWARM_INGEST_SERVICE` e `SWARM_PGBOUNCER_SERVICE`; `ROLLOUT_VERIFY` e `ROLLOUT_ROLES_EXPECTED` conferidas                                                                       |
| GitHub da API, os dois environments                       | `RELEASE_SERIALIZE_WITH_APPLICATION_ID` sai (a migrate de um ambiente não espera mais a do outro: estão em servidores diferentes)                                                                                                                                                                                                   |
| GitHub da API, conferência por SSH (`ROLLOUT_VERIFY=ssh`) | `DEPLOY_SSH_HOST` (o 2º VPS), `DEPLOY_SSH_USER`, `DEPLOY_SSH_KNOWN_HOSTS` (`ssh-keyscan -t ed25519 <host>`) e um par novo em `DEPLOY_VERIFY_SSH_KEY`                                                                                                                                                                                |
| Host do 2º VPS                                            | o forced command do verify-rollout: o script instalado em `/usr/local/bin/trajetto-verify-rollout` e a linha `command="/usr/local/bin/trajetto-verify-rollout",…` no `authorized_keys` ([deploy.md, seção 14](../deploy.md#14-conferir-a-convergência))                                                                             |
| GitHub da web, environment `staging`                      | `DOKPLOY_UI_APPLICATION_ID`                                                                                                                                                                                                                                                                                                         |
| Environment da `trajetto-api-staging` e das de papel      | `DATABASE_URL` (e `BATCH_DATABASE_URL`, `DATABASE_READ_URL`, `READINESS_DATABASE_URL`, se existirem) com o host novo do Postgres ou do PgBouncer, `REDIS_URL`, `AI_LOCAL_URL`, `PGBOUNCER_STATS_URL` e `PGBOUNCER_STATS_HOSTS`                                                                                                      |
| Environment da `trajetto-api-migrate-staging`             | `DATABASE_URL` com o host novo do Postgres (sempre direto, nunca pelo PgBouncer)                                                                                                                                                                                                                                                    |
| Environment da `trajetto-pgbouncer-staging`               | `PGBOUNCER_PRIMARY_HOST` com o host novo do Postgres                                                                                                                                                                                                                                                                                |
| Environment da `trajetto-ui-staging`                      | `HTTP_REQUEST` interno, `http://<App Name novo da API>:3333`                                                                                                                                                                                                                                                                        |
| Hosts dos Databases                                       | os App Names novos do Postgres e do Redis em todas as URLs acima                                                                                                                                                                                                                                                                    |
| Schedules do servidor                                     | o backup e o ensaio do PITR da staging recriados no 2º VPS, com o App Name novo no `label=com.docker.swarm.service.name=` ([deploy.md, seção 27](../deploy.md#os-schedule-jobs-do-servidor))                                                                                                                                        |
| Cloudflare                                                | os registros DNS de `api-staging` e `staging` apontando para o IPv4 do 2º VPS, com o proxy ligado                                                                                                                                                                                                                                   |

Ficam iguais: `DOKPLOY_URL` e `DOKPLOY_API_KEY` (o mesmo painel), `API_PUBLIC_URL` e os domínios, os buckets e os tokens do R2, os segredos de JWT e de webhooks, os checks do healthchecks.io e a staging do app (EAS), que só conhece o domínio.

### Nos dois caminhos, no fim

1. Um push completo na `staging` da API, depois o da web: os dois verdes, com o deploy no 2º VPS.
2. Na VPS 1, o que sobrou da staging: _Stop_ em tudo, um dia de observação, e então **Delete** de cada Application e de cada Database (o volume vai junto: só depois do push verde).
3. Os tetos da produção na VPS 1 sobem para a fase E (G-04).

## Como confirmar

- `docker service ls` no 2º VPS lista os serviços da staging, e o da VPS 1 não lista nenhum `-staging`:

  ```sh
  docker service ls --format '{{.Name}}' | grep -c -- '-staging'
  ```

- `curl -s https://api-staging.intrajetto.com/health/liveness` responde o commit do último push, e a web de staging abre e faz login.
- Na staging nova, `trajetto-backup diff` e o ensaio do PITR pingam sucesso (deploy.md, seção 27).
- O Beszel da VPS 1 mostra a RAM da staging liberada.

## Quando escalar

Um push vermelho na staging nova depois da troca, um serviço da staging que continua rodando na VPS 1, ou a transferência que muda um App Name ou um `applicationId`: pare, volte a staging antiga (ela só é apagada no passo 2 do fim) e chame o dono antes de qualquer outra troca.
