# Carga, estresse e soak

Os números abaixo foram MEDIDOS nesta máquina, contra o container descartável
(porta 54321) e um processo da API em `NODE_ENV=test` na porta 3334. Não são
capacidade prometida — são o que uma réplica entregou aqui, e servem para
localizar gargalos e provar que uma correção corrigiu.

## Como rodar

```bash
# 1. Um banco só para a carga, e um conjunto de dados com MUITOS tenants:
#    a cardinalidade de businessId é o fator dominante em todo índice, e
#    medir contra um tenant só mede um banco que não existe.
docker exec trajetto-itest-pg psql -U trajetto -d postgres \
  -c "DROP DATABASE IF EXISTS load_test WITH (FORCE);" -c "CREATE DATABASE load_test;"

DATABASE_URL="postgresql://trajetto:trajetto-password@localhost:54321/load_test?schema=public" \
  npx prisma migrate deploy

LOAD_DRIVERS=40 DATABASE_URL="...load_test..." npx tsx tests/load/seed.ts

# 2. A API, sem migrations e sem seeds (não é `npm run dev`).
NODE_ENV=test DATABASE_URL="...load_test..." PORT=3334 npx tsx src/server.ts

# 3. k6 pelo Docker. MSYS_NO_PATHCONV=1 é necessário no Git Bash do Windows,
#    senão o caminho do volume vira C:/Program Files/Git/load.
MSYS_NO_PATHCONV=1 docker run --rm -i \
  -v "C:/dev/trajetto/trajetto-api/tests/load:/load" \
  -e LOAD_BASE_URL="http://host.docker.internal:3334" \
  grafana/k6:latest run /load/smoke.js
```

As quatro cenas, em ordem de utilidade:

| arquivo | pergunta |
|---|---|
| `smoke.js` | as outras três estão medindo alguma coisa real? |
| `load.js` | uma hora movimentada cabe? |
| `spike.js` | a frota inteira chegando de uma vez quebra ou enfileira? |
| `stress.js` | onde é o teto, e o que estoura primeiro? |
| `soak.js` | trinta minutos depois ainda está de pé? |

`smoke.js` primeiro, sempre: um teste de estresse contra uma URL que responde
404 reporta um p95 lindo, e essa é a forma mais comum de uma suíte de carga
mentir.

## O que foi medido, e o que mudou por causa disso

### Teto de uma réplica

| | antes | depois |
|---|---|---|
| vazão máxima (mix real) | ~195 req/s | **~303 req/s** |
| p95 com 3× o teto oferecido | 6,27 s | **63 ms** |
| `route.tower` p95 (261 mil posições) | 1,82 s | **12,6 ms** |
| `dashboard/overview` | 89 queries | **~15 queries** |

O gargalo é a CPU do processo Node, não o banco nem o pool: a 400 req/s
oferecidas o processo usava 2,4 cores e o Postgres tinha menos de 25 conexões
com metade ociosa. Aumentar o pool para 60 PIOROU (159 req/s contra 166),
que é a assinatura de mais concorrência contra um recurso já saturado.

A resposta é horizontal — que a arquitetura já suporta (socket.io com
redis-adapter, filas no Postgres com SKIP LOCKED). A régua: **uma réplica por
~300 req/s deste mix**.

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
   empresa, os entitlements e as permissões do perfil junto: três queries. No
   teto medido isso eram ~600 queries por segundo respondendo uma pergunta
   respondida um milissegundo antes. Agora há memória por REQUISIÇÃO, que
   esquece em qualquer escrita e não existe fora de uma requisição.

4. **`api_key.last_used_at` era escrito a cada chamada** — um UPDATE por
   requisição na MESMA linha, para uma coluna cujo único leitor é quem está
   decidindo revogar a chave. Agora tem limiar de cinco minutos.

### Soak de 30 minutos — executado

| | |
|---|---|
| duração | 30m02s a 60 req/s |
| requisições | 107.859 |
| falhas de superfície | **0** |
| p95 geral | 36,6 ms |
| p95 `delivery.list` | 25,2 ms |
| p95 `route.positions` | 60,8 ms |
| pico de latência | 2,32 s |
| iterações descartadas | 141 (0,08%) |

Nenhum sinal de vazamento: a latência do fim não difere da do começo. As 410
requisições que o k6 contou como `http_req_failed` (0,38%) são 429 das
superfícies que têm teto próprio e 404 de uma leitura por id sorteado — as duas
coisas são respostas corretas, e o mix as aceita de propósito.

O comando:

```bash
MSYS_NO_PATHCONV=1 docker run --rm -i \
  -v "C:/dev/trajetto/trajetto-api/tests/load:/load" \
  -e LOAD_BASE_URL="http://host.docker.internal:3334" \
  -e RUN_DURATION_MS=1800000 \
  grafana/k6:latest run /load/soak.js
```

`RUN_DURATION_MS` não é decoração — ver abaixo.

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

`bash tests/load/multi-replica.sh` sobe duas réplicas contra o mesmo banco e o
mesmo Redis e faz cinco perguntas. Quatro têm resposta aqui.

### O que foi verificado

**O tráfego se divide.** Com nginx em round-robin sobre as duas portas: 9.092 e
9.102 requisições. O balanceador não é o assunto — o assunto é que nenhuma
réplica se recusa a atender.

**O rate limit é compartilhado.** Quarenta chamadas alternando entre as
réplicas com a MESMA sessão: o `x-ratelimit-remaining` cai de um em um,
independente de quem atendeu. Se cada réplica contasse sozinha, o limite
efetivo seria N vezes o configurado — e o número existe justamente para não
ser N vezes maior.

**O socket atravessa as réplicas.** Painel conectado na réplica A, telefone
escrevendo posições na réplica B: o evento chega. É o que mais silenciosamente
quebra ao escalar — sem o adapter do Redis cada processo emite só para os
sockets que ele mesmo segura, e o sintoma é "às vezes o painel não atualiza",
que ninguém reproduz porque depende de onde o navegador caiu.

**A fila é disputada sem duplicar.** Sessenta webhooks enfileirados, duas
réplicas varrendo: 60 entregas, 60 POSTs, zero duplicados. `FOR UPDATE SKIP
LOCKED` fazendo o que promete. A falha aqui seria silenciosa do nosso lado — o
banco ficaria consistente e o CLIENTE é que receberia o mesmo evento duas
vezes.

### O que NÃO dá para medir aqui

**Se a vazão sobe.** Duas réplicas deram 269 req/s contra 303 de uma só — com
o Postgres em 0,17% de CPU, o que descarta o banco. A causa é o caminho: com o
nginx em container, cada requisição vira k6 (WSL2) → nginx (WSL2) →
`host.docker.internal` → Node (Windows), duas travessias da fronteira
WSL2/Windows, contra uma só na medição de réplica única.

Ou seja: a medição de duas réplicas mede a fronteira, não a aplicação. Um
número daqui seria pior do que nenhum. Escalonamento horizontal de VAZÃO
precisa de hosts separados; está registrado em `docs/PENDENCIAS-DO-USUARIO.md`.
