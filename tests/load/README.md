# Carga, estresse e soak

Os números das seções "O que foi medido" foram MEDIDOS nesta máquina, contra
o container descartável (porta 54321) e um processo da API em `NODE_ENV=test`
na porta 3334. Não são capacidade prometida — são o que uma réplica entregou
aqui, e servem para localizar gargalos e provar que uma correção corrigiu.

## A topologia: Traefik, como a produção

A produção é **Dokploy + Traefik** na frente de N réplicas da imagem da API
(`trajetto-api/docs/deploy.md`). O harness de
`compose.load.yaml` é essa forma numa máquina só:

|                 | produção                                                                                                                                                                                            | harness                                                                                                                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| borda           | Traefik v3 do Dokploy (provider swarm), TLS, `Host()`                                                                                                                                               | Traefik v3 fixado por digest (provider docker), HTTP na 8080, `PathPrefix(/)`                                                                                                                                                                                                                   |
| réplicas        | imagem `trajetto-api`, `NODE_ENV=production`, 1024M, 2 réplicas                                                                                                                                     | a mesma imagem, construída do `Dockerfile`, 1024M, `LOAD_REPLICAS` (padrão 2)                                                                                                                                                                                                                   |
| readiness no LB | **nenhuma**: o Traefik do Dokploy fala com o endereço virtual do serviço do Swarm, e um health check ali tiraria as duas réplicas juntas; quem tira uma réplica é o healthcheck do Swarm (liveness) | `/health/readiness`, 10 s, timeout 5 s, por contêiner (provider docker, um servidor por réplica): uma diferença conhecida                                                                                                                                                                       |
| `readTimeout`   | 120 s (`infra/traefik/traefik.reference.yaml`)                                                                                                                                                      | 120 s                                                                                                                                                                                                                                                                                           |
| banco / Redis   | Postgres 16, Redis 7 sem persistência                                                                                                                                                               | a imagem `trajetto-postgres` (`infra/postgres`, a que o Database passa a rodar com a troca do dono), construída pelo compose, com o teto de `LOAD_PG_MEMORY_MB` (padrão 2048, o da produção na VPS única) e `POSTGRES_MEMORY_LIMIT_MB` igual a ele, sem arquivamento; Redis igual; descartáveis |
| uploads         | R2                                                                                                                                                                                                  | credenciais falsas (nenhuma cena envia arquivo)                                                                                                                                                                                                                                                 |
| k6              | —                                                                                                                                                                                                   | dentro da mesma rede do Docker                                                                                                                                                                                                                                                                  |

**A pasta `nginx` foi removida.** Ela era um harness local de round-robin que
nenhum script subia, e nunca representou a produção; quem quiser o histórico
tem o git. O proxy de produção é o Traefik do Dokploy.

Verificado nesta máquina (28/09/2026), com uma imagem substituta no lugar da
API (a mesma base `node:22.21.1-alpine`, os dois modos do entrypoint e a mesma
recusa de banco vazio): `up -d --build` constrói uma vez, roda o `migrate` e
só depois de ele sair com 0 sobe as duas réplicas; o `multi-replica.sh`
(passo 0, pelo roteiro e não à mão) conta 20/20 no access log do Traefik
3.7.13. Um WebSocket (ocioso ou não) atravessa o Traefik por 15 s com
`readTimeout` de 5 s sem ser cortado — o `readTimeout` vale para receber a
requisição, não para uma conexão já promovida a WebSocket.

**Com a imagem real da API o harness rodou em 07/10/2026**: 1, 2 e 4 réplicas,
smoke, carga, estresse até a saturação e o `multi-replica.sh`. Números,
gargalos e as quatro correções que saíram de lá em
[`docs/desempenho/README.md`](../../docs/desempenho/README.md) ("Carga de
07/10/2026"; o relatório original ficou fora do repositório). Os relatórios
de portão seguem o [`TEMPLATE.md`](../../docs/desempenho/TEMPLATE.md).

## Como rodar

```bash
# 1. O harness: Traefik + Postgres + Redis, o `migrate` (a imagem de
#    migração, trajetto-api-migrate: migrations e seeds no load_test vazio,
#    uma vez, com o comando `migrate`, que sai ao terminar; o padrão da
#    imagem, `release`, fica parado para o Swarm do Dokploy ler o
#    healthcheck) e, só depois de ele sair com 0, as réplicas da imagem de
#    produção. A imagem da API não migra: as réplicas rodam
#    NODE_ENV=production, o guard de bootstrap recusa banco vazio e o de
#    schema recusa banco sem as migrations do build; sem o `migrate` antes,
#    elas saíam na hora.
#    --env-file .env: as réplicas precisam do MESMO JWT_SECRET que assina os
#    tokens do seed. A porta 54321 é a do banco descartável. O
#    trajetto-itest-pg costuma ocupá-la e é compartilhado com as suítes: em
#    vez de pará-lo, exporte LOAD_PG_PORT (ex.: 54331) para o Postgres do
#    harness. Os scripts que escrevem (seed.ts, mint-*.ts) aceitam só 54321
#    ou a LOAD_PG_PORT declarada, em localhost (lib/disposable-database.ts).
docker compose --env-file .env -f tests/load/compose.load.yaml up -d --build

# 2. Um conjunto de dados com MUITOS tenants: a cardinalidade de businessId é
#    o fator dominante em todo índice, e medir contra um tenant só mede um
#    banco que não existe. O schema já está lá (passo 1).
LOAD_DRIVERS=40 LOAD_BASE_URL=http://traefik \
  DATABASE_URL="postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public" \
  npx tsx tests/load/seed.ts

# 2b. (Recomendado) O mesmo, com HISTÓRICO no tenant principal: meses de
#     entregas finalizadas, dois eventos por entrega e uma ocorrência a cada
#     vinte. Sem isso, tudo que cresce com a idade do cliente (contagens da
#     listagem, "hoje" do dashboard, eventos da torre, exportações) é medido
#     contra uma empresa nascida no momento do seed.
LOAD_DRIVERS=40 LOAD_PRIMARY_DELIVERIES=300000 LOAD_PRIMARY_HISTORY_DAYS=180 \
  LOAD_BASE_URL=http://traefik DATABASE_URL="...load_test..." npx tsx tests/load/seed.ts

# 3. k6 (fixado: grafana/k6:2.2.0) DENTRO da rede do harness. No Git Bash,
#    MSYS_NO_PATHCONV=1, senão /load/smoke.js vira um caminho do Windows.
docker compose --env-file .env -f tests/load/compose.load.yaml --profile k6 \
  run --rm k6 run /load/smoke.js

# 4. Desmontar só o que o harness criou: containers e volumes do projeto do
#    compose (-v) e as duas imagens construídas no passo 1 (tags
#    trajetto-api:load e trajetto-api-migrate:load, ou as LOAD_API_IMAGE e
#    LOAD_MIGRATE_IMAGE que você passou). Não use `docker builder prune` nem
#    `docker system prune`: o cache de build e as imagens são da máquina
#    inteira, de outros projetos também.
docker compose --env-file .env -f tests/load/compose.load.yaml --profile k6 down -v
docker rmi "${LOAD_API_IMAGE:-trajetto-api:load}" "${LOAD_MIGRATE_IMAGE:-trajetto-api-migrate:load}"
```

Variáveis que a medição de 07/10/2026 acrescentou:

| variável                                                     | onde        | para quê                                                                                                                                  |
| ------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `LOAD_PRIMARY_DRIVERS`                                       | `seed.ts`   | motoristas só da empresa medida (o limite de posições é 120/min por motorista: o pico de referência sobre 40 motoristas mede o limitador) |
| `LOAD_RATE`, `LOAD_DURATION`, `LOAD_PRE_VUS`, `LOAD_MAX_VUS` | `load.js`   | taxa e orçamento de VUs (o padrão acompanha a taxa; o antigo teto fixo de 400 VUs limitava a corrida a ~300 req/s)                        |
| `STRESS_TARGETS`, `STRESS_STEP`, `STRESS_MAX_VUS`            | `stress.js` | degraus da rampa (ex.: `100,150,200,250,350`)                                                                                             |

`load.js` e `stress.js` trazem p50/p95/p99, falha e 429 de **todas** as
superfícies no resumo (`perSurfaceBreakdown` em `lib/api.js`); passe
`--summary-export` para guardar.

Sem o harness, para iterar rápido num perfil (a régua antiga): a API como
processo (`NODE_ENV=test DATABASE_URL=...load_test... PORT=3334 npx tsx
src/server.ts`) e o k6 pelo Docker com
`-e LOAD_BASE_URL=http://host.docker.internal:3334`
(`MSYS_NO_PATHCONV=1 docker run --rm -i -v "C:/dev/trajetto/trajetto-api/tests/load:/load" grafana/k6:2.2.0 run /load/smoke.js`).
Esse caminho cruza a fronteira WSL2/Windows a cada requisição: serve para
achar gargalo, não para número de capacidade.

### Seed por degrau (`LOAD_TIER`, plano de escala LOAD-02)

Com `LOAD_TIER`, o `seed.ts` semeia pelo Prisma só o tenant que a carga
mede (usuários e tokens precisam de bcrypt e JWT) e a população inteira em
SQL de massa (`generate_series`), pelos arquivos `NN-*.sql` de
[`seed-tiers/`](./seed-tiers), em ordem e numa sessão só, que guarda as
contagens do degrau como configurações `load.<nome>`
([`lib/load-tiers.ts`](./lib/load-tiers.ts)). Sem `LOAD_TIER`, nada muda: os
`LOAD_TENANTS` tenants iguais de sempre.

| degrau      | transportadoras (Zipf) | pequenas | entregas    | dias | motoristas | trilha                      | para quê                                       |
| ----------- | ---------------------- | -------- | ----------- | ---- | ---------- | --------------------------- | ---------------------------------------------- |
| `tiny`      | 10                     | 20       | 5 mil       | 30   | 40         | 2 dias × 48 pontos          | conferir o SQL em segundos                     |
| `100k`      | 100                    | 500      | 300 mil     | 180  | 400        | 7 dias × 240 pontos         | o portão do 100k                               |
| `1m`        | 720                    | 500      | 3 milhões   | 90   | 4 mil      | 2 dias × 240 pontos         | o portão do 1M                                 |
| `5m`        | 3.600                  | 500      | 15 milhões  | 90   | 20 mil     | 30 dias × 240 pontos        | o portão do 5M (clone temporário do alvo)      |
| `prod-like` | as da produção         | 0        | as da prod. | idem | idem       | a média por motorista e dia | os ensaios das ondas 10 e 11, só com contagens |

- **Cauda longa:** a transportadora de posição k recebe k^-1,1 das entregas
  e dos motoristas (Zipf, s = 1,1), pelo menos um de cada. No `100k`, a
  primeira tem 23 % das entregas e a última, 442. O planejador escolhe
  planos diferentes para um `businessId` com 23 % de uma tabela e para um
  com 0,1 %, e tenants iguais não medem nenhum dos dois.
- **Paradas abertas:** 150 mil paradas `PENDING`, em rotas liberadas hoje,
  nas 500 empresas pequenas (o caso dos planos do anti-join, F2-21).
- **Por entrega:** dois eventos (chegada e comprovante), uma linha de
  `activity` e uma ocorrência a cada vinte; as entregas dos últimos 7 dias
  em rotas, uma por motorista e dia.
- **Filas assentadas:** 30 dias de eventos `PUBLISHED` (com a chave em
  `outbox_event_key`), entregas de notificação `DELIVERED` (com
  `business_id`), sino e webhooks entregues: o estado de regime que as
  varreduras das filas atravessam.
- **Ids:** uuid v7 cunhado no SQL a partir do instante de cada linha (a
  trilha das entregas é particionada pelo id); só as `activity_v4` linhas
  de `prod-like` levam v4, como as antigas da produção, para o ensaio da
  re-chave (onda 11).
- **Carga em massa:** os índices não únicos das tabelas grandes saem antes
  (`05-indexes-off.sql`) e voltam depois (`85-indexes-on.sql`, que o
  `seed.ts` roda também quando um arquivo falha), e, com superusuário, as
  chaves estrangeiras não são conferidas linha a linha
  (`session_replication_role = replica`); o `95-references.sql` confere
  as referências uma vez no fim e falha se alguma quebrou.

```bash
# Um degrau, no banco descartável (a guarda de lib/disposable-database.ts
# continua: 54321 ou a LOAD_PG_PORT, em localhost), já migrado.
LOAD_TIER=100k LOAD_BASE_URL=http://traefik \
  DATABASE_URL="postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public" \
  npx tsx tests/load/seed.ts
```

**`prod-like`:** recebe só as CONTAGENS da produção, nunca uma linha dela.

1. Na produção, só leitura, rode
   [`seed-tiers/prod-counts.sql`](./seed-tiers/prod-counts.sql) (Dokploy →
   Database da produção → terminal → `psql`, colando o arquivo): ele abre
   uma transação `READ ONLY`, imprime uma linha JSON de contagens e faz
   `ROLLBACK`.
2. Na máquina que semeia, passe essa linha (ou o caminho de um arquivo com
   ela) em `LOAD_PROD_COUNTS`. O seed recusa qualquer chave que não seja
   uma das contagens, e qualquer valor que não seja inteiro ≥ 0.
3. O Database descartável dos ensaios fica no servidor: a guarda só aceita
   localhost, então o caminho é um túnel para ele numa porta local
   declarada em `LOAD_PG_PORT`, com o banco já migrado
   (`yarn prisma:migrate:deploy` pelo mesmo túnel). Apague o Database no
   fim.

**Medido** (17/11/2026, nesta máquina: Docker Desktop, 16 vCPUs, Postgres
16 num contêiner de 2 GiB com a configuração do harness: shared_buffers
448 MB, `max_wal_size` 8 GB, `checkpoint_timeout` 15 min):

| degrau | tempo do seed | banco   | o que mais pesa                                                 |
| ------ | ------------- | ------- | --------------------------------------------------------------- |
| `tiny` | 9 s           | —       | —                                                               |
| `100k` | 1,6 min       | 1,5 GiB | a volta dos índices (39 s) e as entregas com o histórico (22 s) |

Antes da carga em massa, o mesmo `100k` levava 4,0 min: 4,6 mil entregas por
segundo com os 20 índices de `delivery` (um GIN de trigramas entre eles) e as
chaves estrangeiras conferidas linha a linha; sem os dois, 39 mil.

**O `1m` não foi medido aqui:** ele ocupa ~15 GiB, mais o WAL, e esta máquina
tinha 16 GB livres. A projeção linear do `100k` dá 16 a 20 min (a volta dos
índices cresce um pouco mais que linear), abaixo dos 30 min do aceite. A
medida fica para uma máquina com ≥ 40 GB livres (a bancada do G-02 serve),
anotada aqui com o tempo de cada arquivo que o `seed.ts` imprime.

### Contas das suítes de navegador (web)

As suítes de navegador da web (`trajetto-ui/tests/ui`, `tests/a11y`,
`tests/responsive`) usam este mesmo `load_test`. O passo a passo completo
(servidores, variáveis do Next e do Playwright) está em
`trajetto-ui/tests/ui/README.md`; aqui ficam os scripts que preparam as contas,
todos só para o banco descartável de teste:

| script                                     | o que faz                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seed.ts`                                  | o conjunto de dados (empresas, administradores, motoristas); recusa um banco já semeado: recrie o `load_test` antes de semear de novo                                                                                                                                                                          |
| `mint-master.ts`                           | o MASTER e as sessões de vida longa que as specs do `/admin` abrem por cookie (`fixtures/browser-sessions.json`)                                                                                                                                                                                               |
| `mint-browser-users.ts`                    | contas reais **com senha**, que entram pelo formulário: MASTER, BUSINESS_ADMIN (e um segundo admin da mesma empresa), BUSINESS_USER com perfil completo, BUSINESS_USER só leitura, conta com 2FA, motorista, empresa sem Entregas e empresa sem Frota. Grava só e-mails e ids em `fixtures/browser-users.json` |
| `mint-two-factor-code.ts <email> <código>` | troca o código de dois fatores pendente por um que a spec conhece (o real vai por e-mail; o desafio, as tentativas e a validade continuam valendo)                                                                                                                                                             |
| `mint-password.ts <email>`                 | dá a senha de teste a uma conta criada no meio de uma jornada (o lugar de quem leria o e-mail com a senha gerada)                                                                                                                                                                                              |

A senha das contas é `WEB_E2E_PASSWORD`; sem ela, o padrão documentado de
teste `Navegador@E2E2026`. Ela nunca é gravada em disco. Ordem: `seed.ts`,
`mint-master.ts`, `mint-browser-users.ts` (as suítes de navegador da web, no
passo `Prepare the API` dos jobs `Browser suites (1/2)` e `(2/2)` do
`trajetto-ui/.github/workflows/validate.yml`, rodam os três nessa ordem).
Com `NODE_ENV=test` (como as suítes de navegador sobem a API), o 2FA e a
criação de usuário guardam o e-mail numa caixa em memória do processo: nenhum
servidor de e-mail é chamado e o executor não precisa de rede de saída para
isso. Em desenvolvimento, eles vão para o Ethereal.

### O que cada medida pede

| medida                                       | de onde vem                                                                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPS, p50/p95/p99, erro, timeout              | resumo do k6 (`surface_latency`, `surface_failures`, `surface_throttled` por superfície)                                                                                                                      |
| CPU e RAM por réplica, banco, Redis, Traefik | `docker stats` durante a corrida (o `multi-replica.sh` tira uma foto no fim)                                                                                                                                  |
| pool do Prisma, backlog das filas, runtime   | `GET /health/metrics` (MASTER; token em `fixtures/browser-sessions.json` do `mint-master.ts`)                                                                                                                 |
| latência do banco                            | `pg_stat_statements` (pré-carregado pela imagem do banco, como nos servidores, com `pg_stat_statements.track=all` só no harness; `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` uma vez no `load_test`) |
| Redis                                        | `docker compose ... exec redis redis-cli info stats`                                                                                                                                                          |
| conexões WebSocket                           | **sem contador exposto hoje** — lacuna registrada junto das cenas abaixo                                                                                                                                      |

Cenas que ainda não existem (frota, escrita da API pública, WebSocket em
volume, que é o `socket-fleet` do LOAD-05) estão listadas como lacuna em
`docs/PENDENCIAS-DO-USUARIO.md`.

As cenas, em ordem de utilidade (as cinco últimas são do plano de escala,
LOAD-03, mais abaixo):

| arquivo           | pergunta                                                                              |
| ----------------- | ------------------------------------------------------------------------------------- |
| `smoke.js`        | as outras estão medindo alguma coisa real?                                            |
| `load.js`         | uma hora movimentada cabe?                                                            |
| `spike.js`        | a frota inteira chegando de uma vez quebra ou enfileira?                              |
| `stress.js`       | onde é o teto, e o que estoura primeiro?                                              |
| `soak.js`         | trinta minutos depois ainda está de pé?                                               |
| `write-mix.js`    | as escritas juntas (posições, sino, presign, chat, entrega e refresh) cabem?          |
| `positions.js`    | a trilha de N motoristas, cada um com o próprio token e honrando o `nextFlushAfterMs` |
| `tower.js`        | 50 abas da Torre de uma empresa e 500 empresas com 2 abas, no tique espalhado         |
| `noisy-tenant.js` | uma empresa a 10× tira o p95 das outras 20 do lugar?                                  |
| `outage.js`       | 2 min sem a API: os celulares de contrato 7 e 8 martelam a volta?                     |

`smoke.js` primeiro, sempre: um teste de estresse contra uma URL que responde
404 reporta um p95 lindo, e essa é a forma mais comum de uma suíte de carga
mentir.

### As cenas do plano de escala (LOAD-03)

Cada uma grava o resumo com `--summary-export`, numa pasta montada no k6 (o
`/load` do harness é só leitura; `tests/load/results/` fica fora do Git), e o
aceite que compara janelas da mesma corrida sai de `lib/verdicts.mjs`, que lê
esse JSON:

```bash
H="docker compose --env-file .env -f tests/load/compose.load.yaml --profile k6"
R="-v $PWD/tests/load/results:/results"

$H run --rm $R k6 run --summary-export /results/write-mix.json /load/write-mix.js
$H run --rm $R k6 run --summary-export /results/positions.json /load/positions.js
$H run --rm $R k6 run --summary-export /results/tower.json /load/tower.js
$H run --rm $R k6 run --summary-export /results/noisy-tenant.json /load/noisy-tenant.js
$H run --rm $R k6 run --summary-export /results/outage.json /load/outage.js
$H run --rm $R -e SPIKE_ACCEPTANCE=true k6 run --summary-export /results/spike.json /load/spike.js

node tests/load/lib/verdicts.mjs noisy-tenant tests/load/results/noisy-tenant.json
node tests/load/lib/verdicts.mjs outage tests/load/results/outage.json
node tests/load/lib/verdicts.mjs spike tests/load/results/spike.json
```

O seed traz o que elas pedem: o embarcador do tenant principal
(`shipperId`), uma sessão de BUSINESS_ADMIN em cada uma de
`LOAD_PANEL_TENANTS` outras empresas com Entregas (20 por padrão; a Torre
pede 500, com `LOAD_TENANTS` ou um `LOAD_TIER` que tenha essas empresas) e
`LOAD_REFRESH_SESSIONS` sessões com refresh token de verdade (200), cada uma
de uma família, para o refresh do `write-mix.js`.

- **`write-mix.js`** (`WRITE_RATE`, 40/s por `WRITE_DURATION`, 3 min): posições
  35, a lista do sino em NDJSON (`/notification/stream`) 25, o presign de uma
  foto do canhoto 15, uma mensagem do escritório para o motorista 13 e uma
  entrega cadastrada no painel 12. O refresh roda num cenário próprio
  (`WRITE_REFRESH_VUS`, 20, a cada `WRITE_REFRESH_EVERY_S`, 30 s): o refresh
  token gira a cada uso e cada sessão é de um VU só (`exec.vu.idInTest`),
  porque duas usando a mesma acionariam a detecção de reuso, que encerra a
  sessão. Por isso `LOAD_REFRESH_SESSIONS` ≥ `WRITE_MAX_VUS` +
  `WRITE_REFRESH_VUS`; o VU sem sessão própria pula e conta em
  `refresh_sessions_missing`, que reprova.
- **`positions.js`** (`POSITIONS_DRIVERS`, até os tokens do fixture, por
  `POSITIONS_DURATION`, 10 min): cada VU é um motorista e faz o que o app do
  contrato 8 faz (F2-27): manda os pontos do minuto e espera o maior entre o
  próprio minuto e o `nextFlushAfterMs` da resposta (60, 120 ou 300 s), preso
  em [1 min, 5 min]; uma recusa espera o backoff, nunca menos que o
  Retry-After. O POST/s sai da frota, não do harness: os ~333 POST/s da régua
  no 5M são vinte mil motoristas (`LOAD_PRIMARY_DRIVERS`). `POSITIONS_CONTRACT=7`
  manda como o app antigo, sem ler a dica.
- **`tower.js`** (`TOWER_PRIMARY_TABS` 50, `TOWER_TENANTS` 500,
  `TOWER_TABS_PER_TENANT` 2, `TOWER_PERIOD_MS` 60000, `TOWER_DURATION` 10
  min): cada aba lê a Torre e o sino a cada tique, no período alinhado ao
  relógio mais um deslocamento sorteado no período inteiro (F2-29, D25). Uma
  leitura recusada com Retry-After segura as próximas por max(Retry-After,
  período), como o `readsHeldUntil` da web.
- **`noisy-tenant.js`** (`NOISY_NORMALS` 20, `NOISY_TENANT_RATE` 3 leituras/s
  por empresa, `NOISY_FACTOR` 10, `NOISY_BASELINE` 3 min, `NOISY_DURATION` 3
  min): primeiro só as normais (`stage:baseline`), depois o tenant principal
  a dez vezes ao lado delas (`stage:noisy`), alternando Torre, quadro e
  rotas (3, 10 e 10 no orçamento do painel). O aceite: o p95 das normais muda
  no máximo 10% e nenhuma leitura delas falha; com
  `TENANT_PANEL_BUDGET_MODE=enforce` nas réplicas, o barulhento também
  precisa receber 429 (`'{"expectThrottle":true}'` como terceiro argumento do
  verdicts).
- **`outage.js`** (`OUTAGE_PHONES`, `OUTAGE_CONTRACT` 7, 8 ou `mixed` com
  `OUTAGE_CONTRACT8_SHARE` 0,9, `OUTAGE_BASE` 2 min, `OUTAGE_DOWN` 2 min,
  `OUTAGE_AFTER` 3 min): cada VU é um celular de um contrato. O 7 reenvia com
  o próximo fix, 15 s depois, em todos ao mesmo tempo, e despeja o acúmulo de
  uma vez; o 8 espera o backoff com jitter e manda o acúmulo em pedaços de 200
  pontos, de 0,5 a 2 s um do outro. Com `OUTAGE_MODE=simulated` (o padrão) a
  queda é o `OUTAGE_URL`, uma porta fechada que recusa na hora; com
  `external`, a cena continua mandando para a API e outra coisa a derruba na
  janela que o setup imprime (`docker compose stop` das réplicas). O aceite
  (com ≥ 90% de contrato 8): POST/s no máximo 1,2× a base durante a queda e
  1,5× no primeiro minuto depois (passe `baseSeconds` e `downSeconds` ao
  verdicts quando mudar os tempos).
- **`spike.js`** ganhou o aceite do descarte de carga (F2-24), com
  `SPIKE_ACCEPTANCE=true` e `SHED_MODE=enforce` nas réplicas: 0 falha de
  produto, p95 abaixo de 1 s, nada acima de 10 s, e cada janela de calma
  depois de uma parede (`window:recovery`, 45 e 60 s) de volta abaixo de 1 s.
  Sem a variável, ficam os limiares medidos de sempre.

Duas mudanças de régua valem para todas as cenas desde 17/11/2026:

- uma recusa 429 ou 503 **com Retry-After** é uma resposta, em qualquer
  superfície: conta em `surface_throttled` ou `surface_shed`, nunca em
  `surface_failures` (`record` em `lib/api.js`). Antes só as três superfícies
  que listavam o 429 tinham isso, e o descarte de carga fazendo o seu
  trabalho apareceria como produto quebrando;
- no `lib/mix.js`, as posições pesam 10 de 83 (12%), e não mais 34 (um
  terço): ~333 POST/s de ~3.000 requisições por segundo no degrau de 5M. Um
  número medido antes dessa data veio do mix mais pesado em posições.

## O que foi medido, e o que mudou por causa disso

### Teto de uma réplica

> **Substituído em 07/10/2026.** Com histórico (empresa de 300 mil entregas) e
> a imagem de produção, o joelho é **~110–120 req/s por réplica**; ver
> [`docs/desempenho/README.md`](../../docs/desempenho/README.md). A tabela
> abaixo é a medição de setembro,
> sem histórico, mantida pelo registro.

|                                      | antes      | depois          |
| ------------------------------------ | ---------- | --------------- |
| vazão máxima (mix real)              | ~195 req/s | **~303 req/s**  |
| p95 com 3× o teto oferecido          | 6,27 s     | **63 ms**       |
| `route.tower` p95 (261 mil posições) | 1,82 s     | **12,6 ms**     |
| `dashboard/overview`                 | 89 queries | **~15 queries** |

O gargalo é a CPU do processo Node, não o banco nem o pool: a 400 req/s
oferecidas o processo usava 2,4 cores e o Postgres tinha menos de 25 conexões
com metade ociosa. Aumentar o pool para 60 PIOROU (159 req/s contra 166),
que é a assinatura de mais concorrência contra um recurso já saturado.

A resposta é horizontal — que a arquitetura já suporta (socket.io com
redis-adapter, filas no Postgres com SKIP LOCKED). A régua: **uma réplica por
~300 req/s deste mix**.

> **Limite desta régua.** Ela foi medida sobre o seed padrão: 40 tenants × 500
> entregas (~20 mil), todas criadas no instante do seed, sem eventos nem
> ocorrências. Nessa base o gargalo ser a CPU e não o banco é quase inevitável.
> Antes de usá-la para dimensionar, refaça a medição com o histórico
> (`LOAD_PRIMARY_DELIVERIES=300000 LOAD_PRIMARY_HISTORY_DAYS=180`, passo 1b) e
> publique o número novo ao lado deste. O que já tem teste de plano contra
> histórico, sem depender da carga: `tests/E2E/history-plans.test.ts`
> (resumo da operação e exportações) e `tests/E2E/query-plans.test.ts`.

### Quatro correções que saíram da medição

1. **A torre lia a última posição com `DISTINCT ON` sobre a trilha.** Com 261
   mil linhas de UM dia: Seq Scan na partição inteira mais sort em disco de
   14 MB, 408 ms no banco, para devolver 40 linhas. O custo crescia com o
   número de PINGS, e a régua de capacidade de então punha pings em 670/s
   (a de hoje: ~333 POST/s com ~1.333 pontos/s no 5M, estimada). Virou uma
   tabela `driver_last_position`, uma linha por motorista. 145× mais rápido.

2. **`dashboard/overview` fazia 89 queries.** Nove entidades × oito meses, uma
   contagem por vez, mais todas as ordens de serviço de seis meses puxadas
   para somar em JavaScript. Agrupado no banco: uma query para as contagens e
   uma para os custos.

   A primeira tentativa disparou as nove em PARALELO — o total de queries caiu
   oito vezes e o p95 da API inteira ficou quinze vezes PIOR, porque uma
   visualização passou a segurar nove conexões de uma vez. Menos queries não é
   o objetivo; menos queries E menos concorrência é. Viraram um `UNION ALL`.

3. **Toda requisição autenticada carregava o usuário duas vezes** — uma no
   middleware de sessão, outra dentro do caso de uso — e cada carga traz a
   empresa, os entitlements e as permissões do perfil junto: de quatro a seis
   statements (o Prisma faz um SELECT por relação — usuário, empresa,
   entitlements, perfil, permissões, motorista). No teto medido isso eram
   ~600 queries por segundo respondendo uma pergunta respondida um
   milissegundo antes. Agora há memória por REQUISIÇÃO, que esquece em
   qualquer escrita e não existe fora de uma requisição.

   O `POST /route/positions` de um motorista com rota de 40 paradas ainda
   custava 16 statements, só 2 deles escritas: a sessão relia o motorista
   (com filial e usuário) para checar status, o guard de módulo relia os
   entitlements já carregados, e o caso de uso montava a rota inteira com
   paradas e entregas para ler `id` e `status`. Agora são 9 — usuário,
   empresa, entitlements, motorista, filial, família do refresh token, a rota
   em andamento e as 2 escritas —, afirmado em
   `tests/E2E/driver-positions-statement-budget.test.ts`.

4. **`api_key.last_used_at` era escrito a cada chamada** — um UPDATE por
   requisição na MESMA linha, para uma coluna cujo único leitor é quem está
   decidindo revogar a chave. Agora tem limiar de cinco minutos.

### Soak de 30 minutos — executado

|                       |                   |
| --------------------- | ----------------- |
| duração               | 30m02s a 60 req/s |
| requisições           | 107.859           |
| falhas de superfície  | **0**             |
| p95 geral             | 36,6 ms           |
| p95 `delivery.list`   | 25,2 ms           |
| p95 `route.positions` | 60,8 ms           |
| pico de latência      | 2,32 s            |
| iterações descartadas | 141 (0,08%)       |

Nenhum sinal de vazamento: a latência do fim não difere da do começo. As 410
requisições que o k6 contou como `http_req_failed` (0,38%) são 429 das
superfícies que têm teto próprio e 404 de uma leitura por id sorteado — as duas
coisas são respostas corretas, e o mix as aceita de propósito.

O comando (hoje, pelo harness; `SOAK_DURATION` padrão 30m):

```bash
docker compose --env-file .env -f tests/load/compose.load.yaml --profile k6 \
  run --rm k6 run /load/soak.js
```

A fase `late` sai da própria duração do soak desde 28/09/2026. Antes, sem
`RUN_DURATION_MS`, todo ponto era marcado `all` e os dois limiares
`{phase:late}` passavam sem amostra nenhuma — ver abaixo.

### O soak não media o que ele dizia medir

O comentário no topo de `soak.js` sempre disse que o limiar que importa é a
ÚLTIMA janela, porque um vazamento aparece como latência que SOBE e uma média
de trinta minutos esconde a subida atrás de um começo saudável. Os limiares,
porém, eram sobre a corrida inteira: vinte e cinco minutos a 25 ms e cinco a
200 ms ainda fecham num p95 confortável, e a execução passaria reportando o
oposto do que aconteceu.

Agora cada medição é marcada com a fase (`early`/`late`, o último quinto) a
partir de `exec.instance.currentTestRunDuration` — relógio global, não por VU,
porque os VUs começam em momentos diferentes — e existe limiar separado para
`phase:late`. Com o mesmo teto do limiar geral, e não um mais apertado: a
afirmação é "não piorou", então um limite que o começo já cumpre só falha se o
fim tiver degradado de verdade.

Verificado que o limiar realmente casa com a sub-métrica: com `p(95)<1` no
lugar, a execução falha com `✗ 'p(95)<1' p(95)=64.3ms`. Um erro de digitação na
tag passaria despercebido para sempre, porque um limiar que não casa com nada
nunca falha.

Junto veio `surface_throttled`, também com limiar. Três superfícies aceitam 429
como resposta correta — elas têm teto próprio e recusar além dele é o
comportamento sob teste — mas uma requisição barrada no limitador não chegou ao
código que a execução mede. Sem essa métrica, uma corrida em que um terço da
carga quicou tem exatamente o mesmo resumo de uma em que nada quicou.

### O primeiro teste de carga mentiu

Vale registrar: a primeira execução reportou 55% de falhas com p95 de 14 ms —
uma máquina parada enquanto o teste a chamava de sobrecarregada. Todas as
requisições de gestor iam com o MESMO token, e o rate limit é por usuário. O
teste passou a semear cinquenta gestores e rotacionar por VU.

### O pico — executado

`spike.js`, novo. As outras três cenas fazem a carga SUBIR; esta pergunta outra
coisa, e é a que se parece com o uso real: a carga não rampa. A frota inteira de
uma transportadora começa a manhã dentro dos mesmos dez minutos, todo telefone
descarrega o buffer da noite no instante em que pega sinal no pátio, e uma
notificação põe todas as abas abertas na mesma tela no mesmo segundo.

Duas paredes de propósito: a primeira também paga por tudo o que estava frio, e
um sistema que só sobrevive porque a segunda encontrou tudo quente não se
recuperou — foi carregado.

Vinte por segundo em repouso, 400/s em cinco segundos, trinta segundos de
parede, e de volta. Duas vezes.

```
surface_failures ... 0,00%   (0 de 28.329)
surface_throttled .. 11,95%  (3.386 de 28.329 — 429, que é uma resposta)
surface_latency .... med=2,74s  p90=5,57s  p95=6,55s  max=10,56s
http_reqs .......... 131,5/s
```

**A leitura é a taxa de falha, sempre primeiro.** Zero falhas de produto em
vinte e oito mil requisições, com 12% recusadas pelo limitador, é exatamente o
formato que esta cena existe para confirmar: sob vinte vezes a taxa estável o
sistema **enfileira e recusa — e não quebra**. Uma parede que devolve 500 por
trinta segundos e volta é saudável; uma que fica quebrada depois que o tráfego
foi embora tem fila, lock ou vazamento, e a diferença só aparece na descida.

O limiar do `route.positions` foi **medido, não desejado**: a primeira versão
deste arquivo pedia p99 < 8 s e cruzava em uma rodada de cada duas — o pior tipo
de limiar, o que reprova por causa do tempo. Doze segundos fica acima do teto
medido com folga para a máquina ocupada e continua reprovando se a fila parar
de drenar.

**O que esta cena NÃO mede:** quanto tempo a fila leva para drenar depois da
parede. A mediana agregada não responde isso — 400/s durante setenta segundos
contra 20/s no resto significa que praticamente todo o tráfego É a parede, e a
mediana descreve a parede. Medir a recuperação precisa de série temporal
(`--out json`) e de uma máquina que não esteja rodando também o Postgres, o
Redis, o Next em dev e uma suíte de navegador.

### O chat não estava em cena nenhuma

A lista de conversas é a leitura mais pesada do chat — uma linha por conversa
com a última mensagem, a contagem de não lidas e a entrega por trás — e o
escritório de uma transportadora a deixa aberta ao lado do quadro o dia inteiro.
Não aparecia em nenhuma mistura de carga, então a única superfície onde um
escritório inteiro fica parado-mas-conectado nunca entrou numa medição. Entrou
(`chat.threads`, peso 4; `chat.messages`, peso 3) e a carga estável não se
mexeu: p95 de 25 ms a 116 req/s.

### A chave de API do fixture estava revogada

O `smoke.js` existe porque um teste de estresse contra uma URL que responde 404
reporta um p95 lindo. Ele ganhou o salário: a chave do `load-context.json` tinha
sido revogada em algum momento, então **toda rodada reportava 8% de falha na
superfície de integração** — um número que mandaria alguém procurar um defeito
no produto. Foi reemitida.

E o limiar `http_req_failed` foi trocado por `surface_throttled`: a métrica do
próprio k6 conta qualquer não-2xx, então um limitador fazendo o trabalho dele
empurrava uma rodada perfeitamente saudável para o vermelho — zero falhas de
produto, p95 de 25 ms, e uma violação causada inteiramente pelos 429 que o
produto deve mesmo enviar. Uma suíte que reprova numa rodada boa é uma suíte que
as pessoas param de ler.

## Failure injection

`bash tests/load/failure-injection.sh` derruba Redis e Postgres de verdade e
imprime status + latência de quatro superfícies em cada estado. Não é um teste
automatizado: cada passo para um container, e o que interessa é o
comportamento.

### O que foi encontrado

**Com o Postgres fora, toda rota autenticada respondia 401.** Os dois clientes
leem 401 como "sua sessão acabou" — o mobile chama `handleUnauthorized()`
direto no callback de logout. Trinta segundos de banco indisponível deslogariam
todo motorista em campo, no meio da rota, sem volta até sinal e credenciais se
alinharem.

A causa era um `try` só em volta do middleware inteiro: a verificação do token
e as consultas ao banco dividiam o mesmo `catch`, que transformava tudo em
AUTH_TOKEN_INVALID. Um banco fora do ar não é um token inválido. Agora é 503
com `AUTH_SESSION_UNAVAILABLE`, e o token continua sendo 401 — com teste dos
dois lados e mutação nas duas direções.

**O `/health` levava 1,03 s com o Redis fora**, contra 220 ms normais, porque
as sondas rodavam em sequência e a do Redis esperava o timeout inteiro. Um load
balancer com timeout de um segundo tiraria toda réplica de rotação por causa de
um soluço do Redis que a API já tinha sobrevivido — que é exatamente a queda
que o desenho evita ao marcar Redis como não-crítico. Agora as sondas rodam em
paralelo e cada uma tem relógio de 500 ms.

### O que já estava certo

- Redis fora: tudo continua respondendo 200. O `skipOnError: true` do rate
  limit funciona como projetado, e agora está verificado em vez de pretendido.
- Postgres fora: `/health` responde 503 — que é o que faz o healthcheck do
  Docker reciclar o container — e `/health/liveness` não toca em dependência
  nenhuma, então uma queda externa não vira laço de restart.
- Tudo volta sozinho quando os containers voltam. Nenhum restart de processo
  foi necessário em nenhum dos cenários.

## Multi-réplica

`bash tests/load/multi-replica.sh`, com o harness de pé, faz seis perguntas
às réplicas atrás do Traefik (cada uma também responde numa porta própria,
3341 e 3342, para as perguntas que precisam acertar UMA réplica). Toda chamada
ao `docker compose` leva o mesmo arquivo de env do `up` (`LOAD_ENV_FILE`,
padrão o `.env` da raiz): sem ele o compose recusa o arquivo (JWT_SECRET é
obrigatório), e o passo 0 lia o log vazio como "uma réplica só atendeu".
`LOAD_STEPS="0 2"` faz só algumas perguntas; o roteiro sai com erro se alguma
falhar.

### O que foi verificado

**O tráfego se divide.** O access log do Traefik diz qual réplica atendeu cada
requisição (`ServiceURL`), e o roteiro conta. (A medição anterior, 9.092 contra
9.102, foi com o harness nginx, que não existe mais.) O balanceador não é o
assunto — o assunto é que nenhuma réplica se recusa a atender.

**O rate limit é compartilhado.** Quarenta chamadas alternando entre as
réplicas com a MESMA sessão: o `x-ratelimit-remaining` cai de um em um,
independente de quem atendeu. Se cada réplica contasse sozinha, o limite
efetivo seria N vezes o configurado — e o número existe justamente para não
ser N vezes maior.

**O socket atravessa as réplicas.** Painel conectado na réplica A, telefone
escrevendo posições na réplica B: o evento chega. (`socket-across-replicas.mjs`
importava o cliente de `../trajetto-fleet-manager-ui`, pasta que foi renomeada:
o passo morria no import. Agora usa `lib/socket-client.mjs`, o mesmo contrato do
`tests/E2E/support/socket-client.ts`.) É o que mais silenciosamente
quebra ao escalar — sem o adapter do Redis cada processo emite só para os
sockets que ele mesmo segura, e o sintoma é "às vezes o painel não atualiza",
que ninguém reproduz porque depende de onde o navegador caiu.

**A fila é disputada sem duplicar — mas a prova não é deste roteiro.** A
medição original (sessenta webhooks, duas réplicas, 60 POSTs, zero
duplicados) deixou de ser reproduzível no dia seguinte: o guarda de SSRF passou
a verificar o destino a cada envio e recusa o receptor em `127.0.0.1`, então
todas as linhas viravam FAILED sem nenhum POST. O script
`queue-across-replicas.mjs` foi removido por isso. A prova agora é
`tests/E2E/queue-claim-concurrency.test.ts`, no vitest, para as quatro filas
(webhook_delivery, domain_outbox_event, notification_delivery e
ai_analysis_request): uma transação segura linhas como uma réplica no meio do
claim e o claim precisa pulá-las sem esperar. Nas quatro, várias instâncias
também drenam o mesmo backlog com cada linha entregue exatamente uma vez — na
ai_analysis_request, cada foto lida uma vez e cada unidade de quota consumida
uma vez (desde 28/10/2026). Tirar o `SKIP LOCKED`
de qualquer claim reprova o arquivo. A falha aqui seria silenciosa do nosso
lado — o banco ficaria consistente e o CLIENTE é que receberia o mesmo evento
duas vezes.

### O que ainda não foi medido

**Se a vazão sobe.** A medição antiga (duas réplicas: 269 req/s contra 303 de
uma) media a fronteira WSL2/Windows, não a aplicação: k6 (WSL2) → nginx (WSL2)
→ `host.docker.internal` → Node (Windows). No harness novo tudo roda na mesma
rede do Docker, e a comparação 1 × 2 réplicas é o passo 5 do
`multi-replica.sh`. **Executada em 07/10/2026**: platô de ~140 req/s com 1
réplica, ~205 com 2 e ~250–285 com 4, quando a CPU da máquina acaba
([`docs/desempenho/README.md`](../../docs/desempenho/README.md), "Carga de
07/10/2026"). Numa máquina só ela diz se a aplicação escala até a
CPU da máquina, não quantos hosts a produção precisa — isso continua em
`docs/PENDENCIAS-DO-USUARIO.md`.

## Rolling num Swarm descartável (`swarm-rolling.sh`, LOAD-06)

O deploy da API é um rolling do Swarm: sobe a réplica nova, espera o
healthcheck, tira a velha do endereço virtual e só então manda o SIGTERM
(_start-first_). O risco é a velha fechar uma conexão keep-alive enquanto o
Traefik escreve um POST nela: 502, que o Go não repete. O roteiro ensaia isso
num Swarm de um nó, com as flags que o Dokploy dá à API
([`docs/deploy.md`](../../docs/deploy.md) §7.7):

```bash
docker build --target migrate -t trajetto-api-migrate:rolling .
docker build -t trajetto-api:rolling .
ROLLING_IMAGE=trajetto-api:rolling ROLLING_MIGRATE_IMAGE=trajetto-api-migrate:rolling \
  bash tests/load/swarm-rolling.sh
```

- **O que ele cria** (tudo com o prefixo `ROLLING_PREFIX`, removido no fim):
  rede overlay _attachable_ (como a `dokploy-network`), Postgres 16 e Redis 7
  como serviços em tmpfs, a etapa de release uma vez, o `seed.ts` pequeno
  (porta `ROLLING_PG_PORT`, 54391), a API com 3 réplicas e o Traefik
  apontando para `http://<prefixo>-api:3333`, o endereço virtual do serviço,
  que é o que o Dokploy escreve para o domínio de uma Application. As flags da
  API são as do guia: _Stop Grace Period_ 40 s, _Update_ e _Rollback Config_
  `start-first`, uma por vez, 5 s entre elas, 30 s de monitor, rollback na
  falha, reinício em qualquer saída; o healthcheck é o da imagem (o mesmo teste
  que o guia cola). `swarm-rolling-script.test.ts` compara as flags com o JSON
  do guia e com o `HEALTHCHECK` do `Dockerfile`.
- **Onde ele recusa rodar**: num nó que já está num Swarm com serviços (é o
  formato de um servidor do Dokploy, a produção inclusive) e num worker. Fora de
  qualquer Swarm, faz `docker swarm init` só no loopback e sai do Swarm no fim
  (removendo a `docker_gwbridge` que o init criou); num Swarm vazio, usa e
  deixa como estava. Nunca puxa a imagem do GHCR: as imagens são locais
  (`--no-resolve-image`).
- **Pergunta 1, rolling**: `service update --force` (o _Redeploy_) sob
  `ROLLING_RATE` (50 req/s) do `rolling.js`. Aprova com **zero** 5xx, zero
  pedidos sem resposta e cada réplica substituída com saída 0 e a linha
  `shutdown complete` no log (o desligamento coube no grace).
- **Pergunta 2, escala**: de 3 para 6 réplicas sob a mesma carga; na janela
  depois de as novas ficarem saudáveis, a mais ocupada atende no máximo 1,3
  vez a média (contagem das linhas `request completed` de cada réplica). As
  réplicas rodam com o teto da produção: `HTTP_MAX_REQUESTS_PER_SOCKET` fica
  sem valor, como na Application, e vale o padrão da imagem (1.000 pedidos
  por conexão). O que a razão mede depende de quantas conexões se renovam na
  janela (ritmo × janela ÷ teto): com 15 (300 s a 50 req/s com 1.000) ela
  mediu como elas caíram (1,48 em 15/11/2026, com o teto funcionando); com
  150 (teto de 100) mediu 1,00, porque o Swarm entrega as conexões novas em
  rodízio e a réplica mais ocupada fica uma conexão acima da média. Por isso
  a janela é a maior entre 300 s e 60 renovações: 1.200 s a 50 req/s, e o
  passo de escala leva uns 24 min. `ROLLING_MAX_REQUESTS_PER_SOCKET=100` é a
  conferência rápida só do mecanismo (janela de 300 s), e o veredito diz que
  não é o valor da produção.
- `ROLLING_STOP_GRACE=10s` ensaia o Dokploy sem o campo _Stop Grace Period_
  (o padrão de 10 s do Docker); `ROLLING_STEPS=rolling` faz só a primeira
  pergunta; `ROLLING_KEEP=1` deixa tudo de pé para olhar.

`rolling.js` é autocontido (roda por stdin, `k6 run -`, num host sem o
repositório) e lê os tokens de `ROLLING_CONTEXT_JSON`: o `seed.ts` aqui, a
`staging-fixture.mjs` na staging. A mistura é a do motorista (posições,
lista do dia) com 15% de leituras de gestor; o veredito é `rolling_5xx`
`count==0`, nunca uma taxa.

## Burn-in na staging (`staging-burn-in.sh`, LOAD-09)

Curto, limitado e só de madrugada: a staging divide a VPS com a produção, e
o que ele prova é a fiação e o rolling sem 5xx, nunca capacidade. Roda **no
host da VPS**, com o passo a passo em
[`docs/deploy.md`](../../docs/deploy.md#ensaio-de-carga-na-staging-burn-in) (a
empresa 'Carga (staging)' e o administrador dela são do dono).

- **Recusa antes de tudo**: o host da produção (`api.intrajetto.com`,
  `www`) e qualquer host sem o rótulo `staging`; mais de 30 req/s, 10 minutos
  ou 200 sockets; fora das 06:00–08:00 UTC (03:00–05:00 BRT, a `load-window`
  de [`docs/operacao/jobs.md`](../../docs/operacao/jobs.md)), no dia 1 (o
  ensaio de restauração) e no domingo (a janela do histórico).
- **A fixture** (`staging-fixture.mjs`) roda num contêiner Node na
  `dokploy-network`, contra o Traefik com o Host da staging: entra com o
  administrador de 'Carga (staging)' e prepara pela API, de forma idempotente,
  os motoristas e os logins deles, um veículo cada, a rota do dia com as
  entregas, liberada e iniciada pela sessão do motorista (o QR Code, como no
  app). Recusa a produção e qualquer empresa com outro nome **antes de
  escrever**. Os tokens ficam na memória do script, nunca em disco.
- **As sondas abortam tudo**: a `/health/readiness` da produção (uma ida ao
  banco, pelo Traefik do próprio host) com p95 acima de 2× a base medida antes
  da carga, ou 3 falhas; a base e a sonda são o p95 de 12 amostras, e o
  limite nunca fica abaixo do piso de 20 ms (o dobro de uma base de poucos
  ms é ruído), que vai no máximo a 50 ms
  (`BURN_IN_PROBE_FLOOR_MS`; acima disso o roteiro recusa, para a sonda não
  ficar desligada); o `vmstat` do host com iowait acima de 20% ou steal
  acima de 10%. O k6 roda limitado
  (`--cpus 0.5 --memory 256m`).
- Saída: 0 aprovado (zero 5xx), 1 reprovado, 2 recusou começar, 3 abortado
  por uma sonda.

`staging-burn-in.test.ts` e `staging-fixture.test.ts` executam os dois com
stubs (docker, curl, vmstat, date e um falso da API).
