# Simulação do dia de entregas

Um dia inteiro do módulo de Entregas, ponta a ponta, pela **API HTTP de
verdade**: o despacho monta e libera cinco rotas, cinco motoristas entram no
app (quatro por CPF e senha, um pelo QR Code), fazem o checklist, saem,
avisam que estão a caminho, chegam, comprovam, registram ocorrências, perdem
o sinal, recebem uma entrega nova no meio da rota e uma parada cancelada, e
uma rota fica esquecida até o despacho encerrá-la com pendências. Os
veículos andam pelas ruas reais de São Paulo, e a torre de controle os vê
deslizando no mapa.

Serve para três coisas:

1. **Provar o fluxo inteiro** com os mesmos cabeçalhos e corpos que o app e a
   web mandam. Toda resposta fora do planejado é um achado (vai para o log e
   faz o processo terminar com código 1).
2. **Provar o multi-réplica**: os telefones se dividem entre as réplicas, a
   torre fica na réplica A, e todo evento causado pela réplica B tem de chegar
   lá (adapter do Socket.IO no Redis).
3. **Filmar** o dia na web (`trajetto-ui/tests/simulation`), com marcos lidos
   do log.

Não roda em CI nenhum. É uma ferramenta manual, contra um banco descartável.

## Pré-requisitos

- Os containers de teste de sempre: `trajetto-test-pg` (127.0.0.1:54321,
  `postgres`/`postgres`) e `trajetto-test-redis` (127.0.0.1:63790). Nunca o
  `trajetto-database` nem o `trajetto-redis` do dia a dia.
- `yarn install` e `yarn prisma:generate` feitos.
- Para filmar: a web rodando localmente e o ffmpeg (no Windows,
  `C:/ProgramData/chocolatey/bin/ffmpeg.exe`; senão o do `PATH`).

## Como rodar

Tudo a partir da raiz do `trajetto-api`, cada passo num terminal.

```bash
# 1. O banco próprio da simulação, do zero (DROP + CREATE + migrate deploy).
#    Só aceita o banco trajetto_sim no container de teste (porta 54321). Apaga
#    também o sim-context.json da corrida anterior (a empresa dele sumiu com o
#    banco), para o gravador não filmar um dia morto.
npx tsx tests/simulation/scripts/prepare-database.ts

# 2. Duas réplicas da API (3341 e 3342), com workers, cron e leases cada uma.
#    O env delas é gerado em tests/simulation/output/replicas.env a partir das
#    CHAVES do .env.example, com valores descartáveis; o .env nunca é lido
#    (veja "Segurança").
npx tsx tests/simulation/scripts/start-replicas.ts

# 3. (Para filmar) a web na 3100, apontada para a réplica A, com o mesmo
#    guard do .env pré-carregado (o Next lê .env e .env.development sozinho,
#    e toda chave deixada vazia viria de lá). Comando completo em
#    trajetto-ui/docs/testes.md, "Simulação do dia de entregas (gravador)".
#    Ele usa as chaves de teste públicas do Turnstile da Cloudflare, que
#    sempre aprovam.
#    Depois, noutro terminal do trajetto-ui, o gravador (ele espera a
#    simulação):
#      npx playwright test -c tests/simulation/playwright.config.ts

# 4. A simulação.
SIM_API_URLS=http://127.0.0.1:3341,http://127.0.0.1:3342 \
  npx tsx tests/simulation/delivery-day.ts

# 5. Parar: Ctrl+C no terminal das réplicas. Se ele foi fechado:
npx tsx tests/simulation/scripts/stop-replicas.ts
```

Para rodar de novo, volte ao passo 1 (a simulação recusa um banco onde a
empresa simulada já existe).

Uma réplica só basta para um teste rápido:
`SIM_REPLICAS=1 npx tsx tests/simulation/scripts/start-replicas.ts` e
`SIM_API_URLS=http://127.0.0.1:3341`. Uma rota só:
`SIM_ROUTES=R-PIN SIM_SPEED=20`.

## Variáveis

| Variável            | Padrão                                        | O que faz                                                                                                                                                                           |
| ------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIM_API_URLS`      | uma URL por porta de `SIM_REPLICA_PORTS`      | as réplicas, separadas por vírgula. O despacho e a torre usam a primeira (A); cada motorista fica numa, distribuídos em roda. Só endereços desta máquina; 3333 e 3001 são recusadas |
| `SIM_SPEED`         | `8`                                           | quantas vezes o tempo simulado corre mais rápido que o relógio                                                                                                                      |
| `SIM_ROUTES`        | todas                                         | só estas rotas (`R-PIN,R-PER,R-BUT,R-MOE,R-CEN`); os cinco motoristas entram de qualquer jeito                                                                                      |
| `SIM_SEED_ONLY`     | —                                             | `1` para depois de montar o dia (empresa, cadastros, rotas liberadas): bom para explorar a web                                                                                      |
| `SIM_LOG`           | `output/delivery-day-<data>.jsonl`            | o log JSONL                                                                                                                                                                         |
| `SIM_FIX_SECONDS`   | `5`                                           | segundos simulados entre um fix de GPS e o próximo                                                                                                                                  |
| `SIM_FLUSH_SECONDS` | `60`                                          | o envio das posições do app (o minuto do `position-rules.ts`), em segundos simulados                                                                                                |
| `SIM_RANDOM_SEED`   | `20261103`                                    | a semente do sorteio (precisão do GPS, tempos na porta): duas corridas iguais dirigem o mesmo dia                                                                                   |
| `SIM_WORK_DIR`      | `tests/simulation/output`                     | onde vão o env das réplicas, os logs delas, os PIDs, o log JSONL e o `sim-context.json` (pasta no `.gitignore`)                                                                     |
| `SIM_DATABASE_URL`  | `postgresql://…@127.0.0.1:54321/trajetto_sim` | o banco; qualquer outro nome, host ou porta é recusado (`lib/sim-config.ts`)                                                                                                        |
| `SIM_REDIS_URL`     | `redis://127.0.0.1:63790/9`                   | o Redis das réplicas (banco 9: os contadores ficam longe das suítes E2E)                                                                                                            |
| `SIM_REPLICAS`      | `2`                                           | quantas réplicas o `start-replicas.ts` sobe                                                                                                                                         |
| `SIM_REPLICA_PORTS` | `3341,3342`                                   | as portas delas; 3333 e 3001 são recusadas (API e web de desenvolvimento)                                                                                                           |
| `SIM_WEB_URL`       | `http://localhost:3100`                       | a origem da web (CORS das réplicas e o `sim-context.json` do gravador)                                                                                                              |
| `SIM_API_LOG_LEVEL` | `warn`                                        | o `LOG_LEVEL` das réplicas                                                                                                                                                          |

## Relógio de parede e tempo simulado

Tudo o que o telefone manda é **horário de parede**: `occurred_at`,
`recorded_at` dos pontos, `position_recorded_at` e `X-Client-Sent-At`. O
servidor compara esses instantes com o próprio relógio — a janela de 2
minutos da geocerca, o comprovante atrasado (K7), a regra das 16 h da rota
esquecida, o filtro de 5 minutos de relógio adiantado dos pontos — e um
horário "simulado" no futuro seria descartado ou mal julgado.

O que `SIM_SPEED` acelera é o mundo: o caminhão anda pela polilinha da rua
`SIM_SPEED` vezes mais rápido, e o tempo na porta, os intervalos do GPS e o
envio das posições encolhem na mesma proporção. O campo `speed` dos pontos
continua realista (a velocidade simulada, em m/s, como o `expo-location`
manda), e por isso a torre mostra "Em rota" e não um foguete. Consequência:
com `SIM_SPEED=8`, os 3 minutos sem sinal do R-BUT duram 22,5 s de parede, e
o comprovante da fila chega ao servidor segundos depois do toque — o que a
cena prova é que ele guarda o horário do toque, não o do envio.

O log grava os dois: `wall` (parede) e `sim` (o dia simulado, que começa no
instante de parede em que a simulação começou).

## GPS e a torre deslizando

O telefone tira um fix a cada `SIM_FIX_SECONDS` simulados ao longo da rua,
com precisão de 5 a 12 m e o rumo da própria rua, passa cada um pelo filtro
de parado do app (25 m ou o _keep-alive_ de 5 minutos) e envia o buffer como
o `reporter.ts`: a cada minuto simulado ou 20 pontos, até 200 por requisição.
Quando a API responde `tracking: false` (a rota terminou), o GPS para e o
resto do buffer é descartado; a volta ao CD não é rastreada, como no app.

A API emite **um** `driverPosition` por envio, com o ponto mais novo do lote
(`record-driver-positions-usecase.ts`). A torre anima cada atualização ao
longo do intervalo entre os `recordedAt` (`vehicle-motion.ts`, entre 600 ms e
8 s; acima de 5 km, salta). Com `SIM_SPEED=8`, o envio de minuto acontece a
cada 7,5 s de parede, o intervalo entre os `recordedAt` também, e o caminhão
desliza sem parar. Abaixo de `SIM_SPEED=7,5` o intervalo passa de 8 s e o
caminhão espera entre um deslize e outro; baixe `SIM_FLUSH_SECONDS` se quiser
filmar devagar. Cada telefone faz `60 × SIM_SPEED / SIM_FLUSH_SECONDS` envios
por minuto de parede, contra o limite de 120 por minuto por usuário do
`/route/positions`: o padrão usa 8. Os limites nunca são alterados; um 429
(ou 503) espera o `Retry-After` — segundos ou data HTTP, lido como o app lê,
no máximo 60 s; sem o cabeçalho, 2 s, nunca na hora — tenta de novo até 5
vezes e vira achado.

O ponto tem as chaves do `asPing` do app (`background-task.ts`): `speed` em
m/s, `heading` só em movimento e `battery: null`, porque o app não lê a
bateria.

## As cenas

| Cena | Rota         | O que acontece                                                                                                                                                    | O que prova                                                                                           |
| ---- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1    | todas        | o despacho cadastra filial, combustível, embarcador, tipos de ocorrência, motivo, motoristas, veículos, 30 entregas com coordenadas e 5 rotas, e libera           | os cadastros como a web faz, com `Idempotency-Key` nas criações do painel                             |
| 2    | todas        | 4 motoristas entram por CPF + senha (2 com a senha do cadastro, 2 com a senha redefinida pelo gestor) e 1 pelo QR Code                                            | D2 fase N e D3/D8; `deviceId` no login e em toda renovação; configurações da empresa no `/user/me`    |
| 3    | todas        | checklist de saída da rota (`routeId` + `phase`), "Deseja realmente iniciar a rota?", início                                                                      | C4/K6 e o início da rota                                                                              |
| 4    | todas        | a caminho de cada parada, GPS fluindo                                                                                                                             | `on-the-way`, posições, `driverPosition` na torre                                                     |
| 5    | R-PIN        | uma chegada tocada a ~600 m da porta (raio de 300 m, modo ALERTAR)                                                                                                | o app pede confirmação, o servidor aceita e sinaliza `OUTSIDE`                                        |
| 6    | R-PIN, R-MOE | comprovantes com canhoto e assinatura (PUT pré-assinado); "Cliente ausente" com foto; "Entregue a vizinho" espera a torre, o despacho autoriza, o motorista segue | a entrega como ocorrência de categoria ENTREGA (contrato 3), o efeito impeditivo e a autorização      |
| 7    | R-BUT        | 3 minutos simulados sem sinal: as posições ficam no buffer, a chegada e o comprovante vão para a fila e saem em ordem na volta                                    | o buffer de posições, a fila com `occurred_at` congelado e o `delivered_at` igual ao horário do toque |
| 8    | R-PER        | o despacho põe uma entrega nova na rota em andamento (no caminho de volta)                                                                                        | K12 e o aviso em tempo real ao motorista (`route.stops_changed`)                                      |
| 9    | R-CEN        | o cliente liga e o despacho cancela uma parada                                                                                                                    | o cancelamento pelo painel e a lista do motorista atualizada                                          |
| 10   | todas, R-MOE | checklist de chegada; as rotas concluem sozinhas; a R-MOE fica aberta com uma parada e o despacho encerra com pendências                                          | C4 (chegada) e K11                                                                                    |
| 11   | todas        | telefones divididos entre as réplicas, torre na A                                                                                                                 | todo `driverPosition` e `routeEvent` causado pela réplica B chega à A                                 |

No fim, a simulação lê o dia de volta pela API (rotas, paradas, entregas) e
imprime as verificações. O processo termina com código 1 se houve qualquer
resposta inesperada ou verificação falha.

A cena 11 tem duas verificações por rota. A primeira vale para todas: os
quadros `driverPosition` do telefone chegaram à torre. A segunda vale para
cada rota cujo telefone está numa réplica diferente da torre (a B, com duas
réplicas) e confere parada por parada, não por contagem. O socket da torre na
A tem de ter recebido:

- `route.started`;
- um `route-stop.on_the_way` de cada parada cujo "a caminho" a API aceitou do
  telefone (resposta 2xx, na hora ou depois, pela fila offline);
- o `route-stop.settled` ARRIVED de cada parada cuja chegada a API aceitou;
- o `route-stop.settled` de cada parada com o status em que ela terminou;
- `route.completed`;
- na rota do K12, `route.stops_changed`.

O telefone guarda, por rota, as paradas em que o "a caminho" e a chegada
deram 2xx. Uma chamada recusada ou ainda presa na fila não entra, porque não
gerou quadro. Uma rota da B sem nenhum "a caminho" aceito também falha: não
haveria o que provar. Na rota do K11, o `route.completed` é o do encerramento
com pendências, e as paradas que ele cancela não têm quadro próprio
(`lib/tower-checks.ts`). Com uma réplica só, a segunda verificação não
aparece.

## O log JSONL

Uma linha por evento. Toda linha tem `wall`, `sim`, `actor` e `kind`:

- `http`: toda chamada, com `replica`, `method`, `path` (sem tokens na query),
  `status`, `latencyMs` e `unexpected: true` quando a resposta não era a
  planejada;
- `event`, com o nome em `type`: `position` (o lote inteiro, para o replay),
  `socket-frame`, `queued`, `outbox-sent`, `offline-gap`, `geofence-prompt`,
  `stop-arrived`, `authorization-seen`, `tracking-stopped`, `anomaly`…; o
  `queued` e o `outbox-sent` trazem `route`, `submissionKind` (o tipo do
  envio na fila, como `delivery-arrival` ou `delivery-on-the-way`),
  `submissionId` e `occurredAt` (o horário do toque), e o `outbox-sent` traz
  também `sentAt`, `heldWallMs` (quanto tempo de parede o envio esperou) e
  `response`; o `socket-frame` da torre (`actor: "torre"`) traz cada
  `driverPosition` recebido na réplica A, com `driverId`, `routeId`,
  `latitude`, `longitude`, `speed`, `heading` e `recordedAt`: é dele que sai a suavidade do filme (o intervalo entre dois
  quadros do mesmo motorista e qualquer salto acima dos 5 km da torre). O
  mesmo vale para cada `routeEvent`, com `frameType`, `routeId` e, quando o
  quadro traz, `stopId`, `stopStatus`, `deliveryId`, `onTheWayAt`,
  `completedAt` e `planVersion`. Com eles o filme se audita parada por
  parada: o `stopId` liga o quadro ao `POST /route/on-the-way/<stopId>/…` do
  telefone, e o `deliveryId` à chegada e ao comprovante, que vão por entrega
  (`/delivery/arrival/<deliveryId>/…`). O `route-stop.on_the_way` chega com
  `stopStatus` PENDING; os `route-stop.settled` de uma parada chegam com
  ARRIVED e depois com o status final;
- `milestone`, com o nome em `name`: `company-seeded`, `settings-saved`,
  `drivers-signed-in`, `route-released`, `routes-released`,
  `checklist-start`, `route-started`, `proof`, `geofence-flag`,
  `occurrence-absent`, `authorization-requested`, `authorization-answered`,
  `offline-start`, `offline-end`, `k12-added`, `stop-cancelled`,
  `route-completed`, `route-left-open`, `route-closed-with-pending`,
  `checklist-end`, `day-finished` — o que o gravador fotografa;
- `info`: avisos da própria simulação, com `message` (onde ficou o log, com a
  velocidade, as réplicas e as rotas, e onde ficou o `sim-context.json`);
- `summary`: a última linha, com os contadores, as verificações, a lista de
  achados e, por telefone, os quadros da torre (`towerFrames` e
  `towerRouteEvents`, os `routeEvent` da rota dele por tipo), as paradas que
  a API aceitou dele (`acceptedStops`, com `onTheWay` e `arrived`) e as
  paradas que a torre viu "a caminho" (`towerOnTheWayStops`).

O `sim-context.json` (mesma pasta) traz o login descartável do despacho, as
rotas e o caminho do log: é o que o gravador lê.

## Como conferir o filme

O gravador deixa em `trajetto-ui/tests/simulation/output/<data>/` o `raw.mp4`
(tempo real), o `timelapse.mp4` (4x), uma foto da torre por marco em
`marcos/` (e do detalhe da `SIM_FOCUS_ROUTE` nos marcos dela) e o
`marcos.json`. Com `SIM_SPEED=8`, o dia simulado (cerca de 83 min) dá uns
10 min de `raw.mp4`. A foto de um marco é tirada quando o gravador lê a linha
do log, e os primeiros marcos saem em rajada; por isso as fotos deles podem
mostrar a torre alguns segundos depois do marco.

O que a torre, na visão Painel, tem de mostrar em cada marco (conferido nas
fotos da corrida de 03/11/2026). Aquela corrida foi filmada com o zoom fixo 12,
o padrão do gravador na época: o reenquadramento sozinho, na segunda linha, é o
comportamento do Painel com a correção do achado F1, e não aparece naquelas
fotos.

| Marcos                                                                 | Na torre                                                                                                                                                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `company-seeded` a `routes-released`                                   | nenhum caminhão no mapa: as rotas estão liberadas, mas ninguém saiu                                                                                                                                              |
| `checklist-start`, `route-started`                                     | os caminhões surgem no CD da Vila Leopoldina, um a um, e "N em andamento · N no mapa" sobe até 5. O mapa se enquadra sozinho conforme a frota se espalha; caminhões próximos podem aparecer agrupados num número |
| `proof`                                                                | os caminhões em azul ("Em rota") deslizando pelas ruas, sem saltos, parados na porta enquanto o motorista comprova                                                                                               |
| `geofence-flag` (R-PIN), `k12-added` (R-PER), `stop-cancelled` (R-CEN) | no mapa, só os caminhões; estas cenas se provam nas verificações do fim                                                                                                                                          |
| `offline-start`, `offline-end` (R-BUT)                                 | o caminhão da R-BUT parado uns 35 s; na volta do sinal, ele desliza até o ponto novo (menos de 5 km: anima, não salta). As fotos `-rota` são do detalhe da R-BUT nesses momentos                                 |
| `authorization-requested` (R-MOE)                                      | o aviso "Pedido de autorização" (Entregue a vizinho, com o destinatário e o motorista) no canto inferior direito                                                                                                 |
| `occurrence-absent` (R-PIN)                                            | o aviso "Ocorrência" com "Cliente ausente"                                                                                                                                                                       |
| `route-completed`                                                      | o caminhão fica verde ("Rota concluída") e "N rotas concluídas nas últimas 2 h" sobe                                                                                                                             |
| `route-left-open`, `route-closed-with-pending` (R-MOE)                 | a R-MOE é a última em andamento; encerrada pelo despacho, fica verde também                                                                                                                                      |
| `day-finished`                                                         | "0 em andamento · 0 no mapa", "5 rotas concluídas nas últimas 2 h" e cinco marcadores verdes                                                                                                                     |
| `fim-rota.png`, `fim-entregas.png`                                     | o detalhe da rota focada e o quadro de entregas: 31 entregas, 0 em rota, 28 entregues (90%) e 1 insucesso (3%)                                                                                                   |

Sem `SIM_MAP_ZOOM`, quem enquadra o mapa é o Painel. Um mapa preso num
caminhão só, em zoom de rua, enquanto o contador diz "5 no mapa", é o achado
F1 de volta: defeito do produto, não do gravador.

A suavidade se mede nos `socket-frame` `driverPosition` da torre no JSONL,
agrupados por `driverId` na ordem de chegada. Na corrida de 03/11/2026, com
duas réplicas e `SIM_SPEED=8`, os números foram estes:

- intervalo de parede entre dois quadros do mesmo motorista com p50 de cerca
  de 7 s (7,1 s). Com o caminhão em movimento, p50 de 7,0 s e p95 de 7,6 s,
  dentro da janela de animação da torre (600 ms a 8 s): o caminhão desliza
  sem parar;
- intervalos acima de 8 s só com o caminhão parado: na porta (comprovante,
  ocorrência, os 38 s da autorização) e no trecho sem sinal da R-BUT
  (34-35 s). A torre o segura parado, como deve;
- nenhum salto acima dos 5 km de teletransporte da torre
  (`vehicle-motion.ts`). O maior ficou entre 756 e 776 m nas três corridas,
  cerca de 1 min simulado a 46 km/h;
- nenhum `recordedAt` voltando no tempo;
- do ponto gravado no aparelho ao quadro na torre: p50 de 62 ms e p95 de
  3,9 s.

Um p50 bem acima de 8 s, ou um salto acima de 5 km, é um caminhão que para e
pula no filme. Confira o `SIM_SPEED` (abaixo de 7,5 o intervalo passa de 8 s;
veja "GPS e a torre deslizando") e os logs das réplicas. O que o filme não
mostra, as verificações do fim mostram: a cena 11 confere sozinha que os
`driverPosition` e os `routeEvent` causados pela réplica B chegaram à torre
na A.

## Testes da própria simulação

```bash
npx vitest run --config tests/simulation/vitest.config.mts
```

`lib/geometry.ts`, `lib/clock.ts`, os documentos simulados, a trava do
banco e das URLs, o `Retry-After` do cliente HTTP, o ponto do GPS, as
paradas que o telefone guarda como aceitas (com um servidor HTTP local: só o
"a caminho" e a chegada que deram 2xx, na hora ou pela fila, e nunca o que a
fila envia e a API recusa), as linhas `queued` e `outbox-sent` do JSONL
(com `kind` `event` e o tipo do envio em `submissionKind`), os quadros
`driverPosition` e `routeEvent` da torre (com um Socket.IO local; os
`routeEvent` contados por rota, por tipo e, nos `route-stop.settled` e
`route-stop.on_the_way`, por parada), a verificação da cena 11 por rota
(`lib/tower-checks.ts`), a prova de que ela falha sem o adaptador Redis
(`lib/scene11-adapter.test.ts`: dois servidores Socket.IO locais no papel das
réplicas A e B, a torre na A e os quadros do telefone emitidos só na B; sem
repasse, a verificação falha, e com um único quadro perdido, seja o
`route-stop.on_the_way` de uma parada, o ARRIVED dela ou o status final, ela
aponta a parada) e a trava do
`.env` (com um `.env` falso numa pasta temporária; o de verdade nunca é
aberto). Ficam fora do CI de propósito (as suítes do CI são
`--dir tests/unitaires`, `--dir ./tests/E2E` e `tests/ai-local`); o typecheck
do repositório cobre a pasta, como cobre `tests/load`.

## Segurança

- Só o banco `trajetto_sim` em 127.0.0.1:54321 (reaproveita a trava de
  `tests/load/lib/disposable-database.ts` e exige o nome). Só réplicas desta
  máquina, nunca nas portas 3333 e 3001 (`SIM_REPLICA_PORTS` e
  `SIM_API_URLS`).
- Nenhum processo da simulação lê o `.env`. As réplicas e o
  `prisma migrate deploy` rodam da pasta da API, onde está o `.env` de
  verdade, e o `src/env` (e o `prisma.config.ts`) chama o dotenv ali. Dar
  valor a toda chave não basta: o dotenv-expand copia o valor do arquivo por
  cima de toda variável definida e **vazia** — justamente as que o env da
  simulação deixa em branco para desligar uma integração. Por isso esses
  processos sobem com `lib/no-env-file.cjs` pré-carregado
  (`lib/guarded-node.ts`): para eles, todo `.env*` não existe (o
  `.env.example` continua legível), como num container. O log de cada
  réplica registra a leitura recusada.
- O env das réplicas desliga tudo o que sairia da máquina: IA
  (`AI_PROVIDER=none`, o container trajetto-ai nunca é chamado), geocodificador,
  mapa do comprovante, WhatsApp, e-mail (`NODE_ENV=test`: caixa em memória),
  push na Expo e _health pings_. As fotos ficam em `./tmp` da API (a pasta que o
  `/tmp/` local serve), com o coletor de órfãos desligado.
- Pessoas, documentos (CPF e CNPJ com dígito válido, faixa fictícia), placas
  e telefones são inventados; os e-mails usam o domínio reservado `.invalid`.
  As senhas são sorteadas a cada corrida e só vão para `output/`.

## Geometria das ruas

`fixtures/delivery-day-geometry.json` foi gerado uma vez com o serviço _trip_
do OSRM (router.project-osrm.org): um CD na Vila Leopoldina e cinco viagens de
ida e volta, com as paradas na ordem escolhida pelo OSRM e cada perna como
polilinha `[lng, lat]`. As coordenadas de cada parada são as da entrega (nada
é geocodificado durante a corrida). A entrega da cena 8 fica a 45% da perna de
volta da R-PER; o endereço dela é ilustrativo.

Dados do mapa © colaboradores do OpenStreetMap, disponíveis sob a Open
Database License (ODbL) — <https://www.openstreetmap.org/copyright>. A mesma
atribuição está no campo `generatedFrom` do arquivo.
