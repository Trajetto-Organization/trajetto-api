# Carga, estresse e soak

Os números das seções "O que foi medido" foram MEDIDOS nesta máquina, contra
o container descartável (porta 54321) e um processo da API em `NODE_ENV=test`
na porta 3334. Não são capacidade prometida — são o que uma réplica entregou
aqui, e servem para localizar gargalos e provar que uma correção corrigiu.

## A topologia: Traefik, como a produção

A produção é **Dokploy + Traefik** na frente de N réplicas da imagem da API
(`trajetto-api/docs/deploy.md`). O harness de
`compose.load.yaml` é essa forma numa máquina só:

|                 | produção                                                        | harness                                                                       |
| --------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| borda           | Traefik v3 do Dokploy (provider swarm), TLS, `Host()`           | Traefik v3 fixado por digest (provider docker), HTTP na 8080, `PathPrefix(/)` |
| réplicas        | imagem `trajetto-api`, `NODE_ENV=production`, 1024M, 2 réplicas | a mesma imagem, construída do `Dockerfile`, 1024M, `LOAD_REPLICAS` (padrão 2) |
| readiness no LB | `/health/readiness`, 10 s, timeout 5 s                          | os mesmos rótulos (um teste mantém os dois iguais)                            |
| `readTimeout`   | 120 s (`infra/traefik/traefik.reference.yaml`)                  | 120 s                                                                         |
| banco / Redis   | Postgres 16, Redis 7 sem persistência                           | idem, descartáveis                                                            |
| uploads         | R2                                                              | credenciais falsas (nenhuma cena envia arquivo)                               |
| k6              | —                                                               | dentro da mesma rede do Docker                                                |

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
`docs/desempenho/carga-2026-10.md` (raiz do workspace).

## Como rodar

```bash
# 1. O harness: Traefik + Postgres + Redis, o `migrate` (a imagem de
#    migração, trajetto-api-migrate: migrations e seeds no load_test vazio,
#    uma vez) e, só depois de ele sair com 0, as réplicas da imagem de
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
`mint-master.ts`, `mint-browser-users.ts` (a CI noturna,
`trajetto-ui/.github/workflows/browser-suites.yml`, roda os três nessa ordem).
Com `NODE_ENV=test` (como as suítes de navegador sobem a API), o 2FA e a
criação de usuário guardam o e-mail numa caixa em memória do processo: nenhum
servidor de e-mail é chamado e o executor não precisa de rede de saída para
isso. Em desenvolvimento, eles vão para o Ethereal.

### O que cada medida pede

| medida                                       | de onde vem                                                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| RPS, p50/p95/p99, erro, timeout              | resumo do k6 (`surface_latency`, `surface_failures`, `surface_throttled` por superfície)                                             |
| CPU e RAM por réplica, banco, Redis, Traefik | `docker stats` durante a corrida (o `multi-replica.sh` tira uma foto no fim)                                                         |
| pool do Prisma, backlog das filas, runtime   | `GET /health/metrics` (MASTER; token em `fixtures/browser-sessions.json` do `mint-master.ts`)                                        |
| latência do banco                            | `pg_stat_statements` (carregado no Postgres do harness; `CREATE EXTENSION IF NOT EXISTS pg_stat_statements;` uma vez no `load_test`) |
| Redis                                        | `docker compose ... exec redis redis-cli info stats`                                                                                 |
| conexões WebSocket                           | **sem contador exposto hoje** — lacuna registrada junto das cenas abaixo                                                             |

Cenas que ainda não existem (auth/refresh, frota, escrita de entregas,
upload, envio de chat, SSE de notificações, escrita da API pública, WebSocket
em volume) estão listadas como lacuna em `docs/PENDENCIAS-DO-USUARIO.md`: as
cinco abaixo medem leitura, a trilha de posições e o chat lido.

As quatro cenas, em ordem de utilidade:

| arquivo     | pergunta                                                 |
| ----------- | -------------------------------------------------------- |
| `smoke.js`  | as outras três estão medindo alguma coisa real?          |
| `load.js`   | uma hora movimentada cabe?                               |
| `spike.js`  | a frota inteira chegando de uma vez quebra ou enfileira? |
| `stress.js` | onde é o teto, e o que estoura primeiro?                 |
| `soak.js`   | trinta minutos depois ainda está de pé?                  |

`smoke.js` primeiro, sempre: um teste de estresse contra uma URL que responde
404 reporta um p95 lindo, e essa é a forma mais comum de uma suíte de carga
mentir.

## O que foi medido, e o que mudou por causa disso

### Teto de uma réplica

> **Substituído em 07/10/2026.** Com histórico (empresa de 300 mil entregas) e
> a imagem de produção, o joelho é **~110–120 req/s por réplica**; ver
> `docs/desempenho/carga-2026-10.md`. A tabela abaixo é a medição de setembro,
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
   número de PINGS, e a régua de capacidade põe pings em 670/s. Virou uma
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
(`docs/desempenho/carga-2026-10.md`, seção 7.3). Numa máquina só ela diz se a aplicação escala até a
CPU da máquina, não quantos hosts a produção precisa — isso continua em
`docs/PENDENCIAS-DO-USUARIO.md`.
