# ADR 0013 — Camada de dados: PITR, standby, PgBouncer, roles e leituras explícitas

- **Status:** aceito em 19/11/2026 (plano de escala, onda 17, F4-61). Junta
  numa decisão só o que o plano tratava em dois rascunhos de ADR 0013: o
  PITR com o standby, e o PgBouncer com os roles e as leituras explícitas
  (decisão D58 do plano: o número 0013 ficou com a camada de dados).
- **Escopo:** `trajetto-api`: o Database PostgreSQL e a imagem
  `trajetto-postgres`, a Application `trajetto-pgbouncer`, os roles do
  banco (o `infra/sql`), os pools da API e o failover.
- **Depende de:** [ADR 0001](./0001-filas-e-mensageria.md) (o Postgres é a
  fila), [ADR 0008](./0008-escala-horizontal.md) (réplicas idênticas, o
  orçamento de conexões por papel), [ADR 0011](./0011-orm-prisma-6-7-8.md)
  (o adapter-pg manda statements sem nome) e
  [ADR 0012](./0012-papeis-de-processo.md) (um login por papel).

## Contexto

Tudo o que é durável mora num Postgres 16 só: um Database do Dokploy, com
o volume local, no mesmo servidor do resto. Antes do plano de escala, a
cópia era o dump diário do Dokploy (até 24 h de perda), o runtime conectava
como o usuário do Database (superusuário e dono de todas as tabelas), cada
réplica abria as próprias conexões direto no Postgres, e não havia standby
nem um caminho ensaiado para trocar de primário.

O alvo (5 M entregas por mês, milhares de transportadoras, cada uma um
tenant) pede mais: perder minutos e não um dia, voltar em minutos e não em horas, mais
processos do que o Postgres aguenta em conexões diretas, e as leituras
pesadas fora do primário. As restrições do dono valem para a camada toda:
nada de banco gerenciado fora do Dokploy, Kubernetes ou Compose; cada peça
é uma Application (ou um Database) com imagem do GHCR; e nada muda numa
instalação de hoje até o dono criar a peça ou ligar a variável.

## Decisão

Seis peças, cada uma com um papel só, cada uma desligada até o dono ligar.

### 1. PITR com pgBackRest, na imagem do banco

- A imagem `trajetto-postgres` (`infra/postgres/Dockerfile`) é a
  `postgres:16-alpine` pelo mesmo digest da CI (a mesma musl e a mesma
  colação, então serve no volume de hoje), mais o pgBackRest compilado da
  fonte. O `apk add pgbackrest` ficou de fora: na Alpine nova ele traz um
  segundo servidor Postgres inteiro. A mesma versão vale no primário, no
  standby e no ensaio.
- Os parâmetros vão na imagem (`infra/postgres/postgres.params`) e voltam
  com o digest; a memória sai de `POSTGRES_MEMORY_LIMIT_MB`; _Command_ e
  _Args_ do Database ficam vazios. `ALTER SYSTEM` só em emergência, porque
  fica no volume e sobrevive à volta do digest.
- O WAL vai continuamente para o R2 (`archive_timeout=60s`), cifrado no
  cliente (`infra/postgres/pgbackrest.conf`), com um full por semana, um
  diferencial por dia e 30 dias de retenção. Os backups e o ensaio mensal
  de restauração rodam por _Schedule Jobs_ do servidor, com os scripts da
  própria imagem (`infra/postgres/bin/trajetto-backup` e
  `infra/postgres/bin/trajetto-restore-drill`). O segundo repositório, noutra
  empresa e com Object Lock, é condição do primeiro cliente de escala.
- **A ordem é de segurança** (decisão D61): a produção só liga o
  arquivamento 7 dias depois de o runtime deixar de ser superusuário
  (`DATABASE_REQUIRE_RUNTIME_ROLE=true`). Com superusuário, uma injeção de
  SQL leria as chaves do PITR no ambiente do contêiner e apagaria os
  backups.
- O dump do Dokploy continua em paralelo, como cópia lógica independente,
  até o gatilho dele (D9).
- **Alvo** (D32): perda de até 2 min e volta em até 1 h com o PITR.
  Segundos e 15 min só com o standby noutro servidor (peças 4 e 6).

### 2. Roles: o runtime sem superusuário

- Os roles e os grants moram no `infra/sql` e são reaplicados pela etapa de
  release depois de todo `migrate deploy` (D18). Os arquivos só criam roles
  NOLOGIN e nunca mexem em login, senha ou DROP: o login e a senha são do
  dono, à mão, pelo `\password` do `psql`. Nenhuma migration do Prisma cita
  um role.
- Um login por papel: `trajetto_http` (as requisições), `trajetto_worker`
  (os workers), `trajetto_batch` (o cron: expurgos, partições, métricas
  pesadas), `trajetto_read` (só SELECT, as leituras pesadas), mais o grupo
  `trajetto_app`, o dono das partições `trajetto_partitions` e os dois das
  peças seguintes, `pgbouncer_auth` e `trajetto_replication`. A trilha das
  entregas (`delivery_event`) tem grants por role, fora do grupo.
- Os tetos são do role, por `ALTER ROLE`: `lock_timeout` de 5 s e
  `idle_in_transaction_session_timeout` de 60 s em todos;
  `statement_timeout` de 30 s no http e no worker, 30 min no batch e 10 s
  no read (D51). Assim eles valem pelo PgBouncer, que não repassa esses
  parâmetros.
- O boot confere o login (`src/shared/database/runtime-role-check.ts`):
  com `DATABASE_REQUIRE_RUNTIME_ROLE=true`, um boot como o dono das tabelas
  é recusado. A migração (`trajetto-api-migrate`) continua com o usuário do
  Database, direto, porque é ela que cria as tabelas e roda o `infra/sql`.

### 3. PgBouncer em modo transaction, o endpoint estável

- Uma imagem própria, `trajetto-pgbouncer` (`infra/pgbouncer/Dockerfile`):
  o PgBouncer 1.26.1 ou mais novo, compilado da fonte sobre Alpine, sem
  privilégio, com a configuração gerada a cada partida a partir do
  _Environment_ (`infra/pgbouncer/entrypoint.sh`). Modo transaction, que o
  código já aceita: os statements vão sem nome, só há
  `pg_advisory_xact_lock` e nenhum `LISTEN`.
- **Nenhuma senha de aplicação no PgBouncer.** O verificador SCRAM de cada
  login vem do banco pelo `auth_query`, com a função fechada
  `pgbouncer.user_lookup` (`infra/sql/30-pgbouncer-auth.sql`), que não
  devolve nada para superusuário, replicação nem o dono das tabelas. O
  console de administração só aceita de dentro do contêiner; o de
  estatística, pela rede, só `SHOW`.
- **Uma URL pelo PgBouncer leva só o `TimeZone`** no `options`, e cada
  conexão vive até 60 s: o boot recusa o resto
  (`src/shared/database/pool-config.ts`). Os 60 s fazem um rolling, um
  retarget ou uma segunda réplica do PgBouncer chegarem a todo processo em
  um minuto.
- **O batch e a migração nunca pelo PgBouncer**: o job de partições destaca
  com `CONCURRENTLY` e troca o role da sessão, e a etapa de release usa
  locks de sessão, que o modo transaction quebra em silêncio. O boot recusa
  a `BATCH_DATABASE_URL` na porta 6432, e a etapa de release recusa a
  porta 6432 na URL dela.
- As recusas dele viram 503 com `Retry-After`, nunca 500
  (`src/shared/errors/database-error-map.ts`): espera de fila como
  `SERVICE_BUSY`, queda como `SERVICE_UNAVAILABLE`. A readiness tem um
  alias próprio (`trajetto_probe`, pool de 2), para nunca esperar atrás do
  tráfego (`src/shared/health/readiness-probe.ts`). As métricas vêm do login
  de estatística, lidas pelo processo do cron, com três alertas
  (`src/shared/health/pgbouncer-metrics.ts`).
- Uma réplica, start-first, com 90 s de grace; duas, em nós diferentes, só
  quando houver nós, com uma task por nó e o rolling stop-first
  ([swarm-multi-no](../runbooks/swarm-multi-no.md)). Primeiro a staging no
  2º VPS; a produção da VPS 1 uma semana depois (D30). Um reinício
  planejado do Postgres passa por `PAUSE` e `RESUME`: quem chega espera,
  e só uma espera de mais de 5 s vira 503.

### 4. Standby físico, pronto na imagem

- O `pg_hba` vem da imagem (`infra/postgres/pg_hba.conf`, pelo
  `hba_file`), com as mesmas regras que o volume tinha, e uma linha de
  replicação só, para o endereço de `POSTGRES_REPLICATION_CIDR` (IPv4, de
  /16 a /32), com o role `trajetto_replication`
  (`infra/sql/40-replication.sql`), que só tem REPLICATION e fica sem
  login até existir um standby.
- O mesmo digest vira standby com `POSTGRES_STANDBY_PRIMARY_HOST`: num
  volume vazio, ele clona o primário e segue o WAL; a senha fica num
  passfile, nunca no `primary_conninfo`. A imagem **nunca** rebaixa um
  primário e **nunca** cria um banco novo num volume vazio de standby que
  não conseguiu clonar (para com o código 64).
- O standby de produção só noutro servidor, o prod-db-2 da onda 23 (D31);
  até lá, o ensaio do failover usa um standby temporário na staging.

### 5. Leituras explícitas, nunca por padrão

- Os pools de lado ficam em `infra/database.ts`: o `databaseRead` (o
  bulkhead no primário, `trajetto_read`, 3 conexões, 10 s), o
  `databaseBatch` (o cron, sempre direto) e, com `DATABASE_REPLICA_URL`, o
  pool do standby.
- O `readDatabase()` devolve o standby só enquanto o replica-guard
  (`src/shared/database/replica-guard.ts`) o mede no máximo 15 s atrás.
  A medida é a idade de uma linha (`replica_heartbeat`) que cada processo
  grava no primário a cada 5 s e lê de volta no standby: ela envelhece com o
  replay parado, com o streaming cortado e com o primário ocioso, então
  "sem notícia" nunca passa por "em dia". Uma rodada ruim volta ao primário
  na hora; três boas seguidas voltam ao standby; todo processo começa no
  primário. Sem a variável, nada disso roda.
- **No standby, só LISTAS** (D53): as exportações e as contagens delas, as
  listas do MASTER, as listas e o resumo das atividades e as listas da
  integração. Um GET por id logo depois de um POST daria 404, e um caminho
  de escrita decidiria sobre uma linha de até 15 s atrás. A guarda
  `tests/unitaires/database/read-routing-guard.test.ts` confere método a
  método, e recusa o `readDatabase()` em middleware, admissão de socket,
  claim ou worker de fila, idempotência e usecase que escreve.
- **Uma lista no standby pagina pelo valor do id**, nunca pelo `cursor`
  do Prisma: a página anterior pode ter vindo do primário, por outra
  réplica, e o standby que ainda não tem a linha do cursor devolveria uma
  página vazia, encerrando a lista sem as linhas de qualquer idade depois
  dela. A exportação, que gera o próprio cursor, lê os lotes por um walk
  (`readDatabaseWalk()`) que pode ir do standby ao primário, nunca de
  volta.
- O feed de eventos só vai ao standby com
  `INTEGRATION_EVENTS_READ_REPLICA=true` e a ordem de commit, lendo a
  página inteira lá; sem o aval do replica-guard, ele lê onde lê hoje.

### 6. Failover manual, com a época do cluster

- Manual e ensaiado a cada trimestre (D6): parar o primário antigo de vez,
  promover o standby, as URLs diretas à mão, a etapa de release direto no
  promovido e só então o PgBouncer apontando para ele
  (`infra/pgbouncer/retarget.sh`, que troca só o
  `PGBOUNCER_PRIMARY_HOST`), que devolve o tráfego. O passo a passo está
  em [failover-standby](../runbooks/failover-standby.md).
- **A época do cluster sobe** depois de um promote, de um PITR ou de um
  restore (`infra/sql/50-cluster-epoch.sql`, pela timeline do WAL atual,
  que muda já no promote). Um cursor do feed de outra época é convertido a
  partir do piso dele: eventos podem se repetir, nenhum é pulado (D67).
  Entre o promote e a etapa, o feed não serve página (503 com
  `Retry-After`): a linha de `cluster_epoch` ainda é da história de antes.
- Meta do ensaio: RTO < 15 min e RPO < 10 s. Failover automático
  (Patroni) só se um contrato pedir RTO < 5 min: ele exige um armazenamento
  de consenso em três nós.

## Por quê

- **Uma peça por papel, cada uma com volta.** O PITR protege contra o erro
  humano e a perda do volume; o standby encurta a volta e tira as listas do
  primário; o PgBouncer junta as conexões e é o endereço que não muda no
  failover; os roles tiram do runtime o poder de apagar o que protege os
  dados. Cada uma é desligável sem as outras.
- **O que ficou de fora**, com o motivo do plano (seção 1.2):
  - banco gerenciado, Kubernetes ou Compose: contrariam a restrição do dono;
  - Patroni ou failover automático agora: o consenso em três nós custa mais
    do que os 15 min do manual, que bastam;
  - `@prisma/extension-read-replicas`: manda as leituras à réplica por
    padrão, o contrário do que a admissão e a sessão exigem;
  - `LISTEN/NOTIFY`: não passa pelo PgBouncer em modo transaction;
  - `synchronous_commit=off`: perderia escritas já confirmadas ao
    telefone;
  - as senhas da aplicação no `auth_file` do PgBouncer: duas fontes de
    verdade para a mesma senha; o `auth_query` deixa a senha só no banco.

## Consequências

- **Nada muda sem o dono.** Sem a Application `trajetto-pgbouncer`, as URLs
  continuam diretas; sem `DATABASE_REPLICA_URL`, o `readDatabase()` é o
  bulkhead; sem `POSTGRES_STANDBY_PRIMARY_HOST`, o Database é o primário de
  sempre; sem `POSTGRES_REPLICATION_CIDR`, nenhuma linha de replicação
  abre. Cada valor e onde ele mora estão em
  [variaveis-de-ambiente.md](../variaveis-de-ambiente.md#2-banco-de-dados).
- **A conta das conexões**: com o PgBouncer, o Postgres vê no máximo 60
  pelo PgBouncer mais 2 do alias e umas 15 diretas (batch, migração,
  ferramentas), abaixo dos 200 de `max_connections`, qualquer que seja o
  número de réplicas.
- **Regras para o código novo:**
  - uma consulta que precisa de estado de sessão (lock de sessão, `SET`
    sem `LOCAL`, `LISTEN`, statement com nome) não roda no pool pelo
    PgBouncer: um `SET` de sessão vaza para o próximo cliente da mesma
    conexão de servidor, e o `SET LOCAL` não (medido na fase infra do
    E2E);
  - um pool de lado que cai numa URL pelo PgBouncer roda com o teto do
    login dela, não com o próprio;
  - uma leitura nova no standby precisa ser uma lista e entrar na lista
    fechada da guarda; o resto lê no primário.
- **Operação nova:** os runbooks [pgbouncer](../runbooks/pgbouncer.md),
  [failover-standby](../runbooks/failover-standby.md),
  [drills](../runbooks/drills.md),
  [restore-drill](../runbooks/restore-drill.md) e
  [pitr-restore](../runbooks/pitr-restore.md); o ensaio de restauração
  todo mês, o de failover a cada trimestre e o game day a cada semestre.
- **Limites conhecidos:** o `pg_hba` do PgBouncer não consegue recusar um
  pedido de replicação lógica (o Postgres recusa, porque nenhum login do
  runtime tem REPLICATION); com `ROLLOUT_VERIFY=http`, o rollout do
  PgBouncer não é conferido; com tasks em mais de um nó, a conferência por
  SSH e o `retarget.sh` só veem o nó em que rodam
  ([swarm-multi-no](../runbooks/swarm-multi-no.md)).
- **Medido** na pilha local da fase infra do E2E (Docker Desktop, 11/2026):
  uma requisição que espera mais de 5 s durante um `PAUSE` recebe 503
  `SERVICE_BUSY` com `Retry-After`; a época sobe já no promote, sem
  esperar checkpoint (o `pg_control_checkpoint()` ainda dizia a timeline
  antiga 3 s depois); o PgBouncer sem carga usa uns 10 MB. **Não medido
  ainda:** o RTO e o RPO do ensaio na staging (o primeiro ensaio é do dono,
  em [drills](../runbooks/drills.md)) e o PgBouncer sob a carga do burn-in.

## Fontes

- [`deploy.md` → Roles do banco](../deploy.md#roles-do-banco-logins-urls-e-conexões),
  [PgBouncer](../deploy.md#pgbouncer-a-imagem-trajetto-pgbouncer-onda-17),
  [Standby](../deploy.md#standby-o-pg_hba-da-imagem-e-o-ramo-standby-onda-17),
  [27. PITR com pgBackRest](../deploy.md#27-pitr-com-pgbackrest) e
  [Nós, labels e placement](../deploy.md#nós-labels-e-placement-onda-17).
- [`arquitetura.md` → Conexão com o Postgres](../arquitetura.md#conexão-com-o-postgres).
- [`infra/sql/README.md`](../../infra/sql/README.md) e os passos
  `infra/sql/20-runtime-roles.sql`, `infra/sql/30-pgbouncer-auth.sql`,
  `infra/sql/40-replication.sql` e `infra/sql/50-cluster-epoch.sql`.
- As imagens: `infra/postgres/trajetto-entrypoint.sh` e
  `infra/pgbouncer/entrypoint.sh`.
- O código: `infra/database.ts`, `src/shared/database/pool-config.ts`,
  `src/shared/database/replica-guard.ts`,
  `src/shared/errors/database-error-map.ts` e
  `src/shared/health/pgbouncer-metrics.ts`.
- As provas: `tests/unitaires/database/read-routing-guard.test.ts`,
  `tests/unitaires/database/replica-guard.test.ts`,
  `tests/unitaires/database/database-read-guard.test.ts`,
  `tests/unitaires/lifecycle/pgbouncer-image.test.ts`,
  `tests/E2E/pgbouncer-user-lookup.test.ts`,
  `tests/E2E/replication-role.test.ts` e a fase infra do E2E
  (`tests/E2E/infra/`: PgBouncer e standby de verdade).
- O plano de escala (documento do workspace, fora do repositório): as
  seções 2.3 e 2.4 e as decisões D6, D9, D18, D30, D31, D32, D51, D53, D58,
  D61 e D67.
