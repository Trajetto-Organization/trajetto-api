# Roteamento por Path: o realtime e o ingest no host da API

Plano de escala F5-26. A `trajetto-realtime` e a `trajetto-ingest` são
Applications próprias, alcançadas no **mesmo host da API** por uma
_Domain_ com _Path_: `/socket.io` no realtime e `/route/positions` no
ingest ([deploy.md, seção 19](../deploy.md#19-papéis-da-mesma-imagem),
passo 4). Este runbook diz como o Traefik do Dokploy escolhe o roteador,
como conferir no host antes e depois de criar a _Domain_, como provar o
mesmo na bancada e o que fazer quando um caminho cai no papel errado.

## O que significa

O Dokploy escreve cada _Domain_ em
`/etc/dokploy/traefik/dynamic/<App Name>.yml`, sem prioridade:

- o roteador `<App Name>-router-<n>` no `web` (com o middleware
  `redirect-to-https`) e o `<App Name>-router-websecure-<n>` no
  `websecure` (com `certResolver: letsencrypt`);
- a regra ``Host(`<host da API>`)``, e com _Path_
  ``Host(`<host da API>`) && PathPrefix(`<path>`)``;
- o serviço `<App Name>-service-<n>` em `http://<App Name>:3333`, com
  `passHostHeader: true`, e nenhum middleware de prefixo com _Strip Path_
  desligado.

Sem prioridade, o Traefik ordena os roteadores pelo **tamanho da regra**: a
regra com _Path_ é mais longa que a do host puro da `trajetto-api`, então
`/socket.io` vai para o realtime e `/route/positions` para o ingest, e
qualquer outro caminho (inclusive `/route/live`, ao lado) fica na API. Três
consequências:

- **sem réplica, 502.** Com a _Domain_ criada e _Replicas_ 0, o roteador
  do _Path_ continua lá e ganha da API: todo pedido daquele caminho recebe
  o 502 do Traefik. Por isso a _Domain_ do ingest só existe com
  _Replicas_ ≥ 1, e se apaga antes de zerar;
- **uma prioridade à mão quebra a ordem.** Uma `priority` no roteador da
  API (no _Advanced → Traefik_ dela) maior que o tamanho da regra com
  _Path_ leva `/socket.io` de volta para a API, que, depois do corte
  (`SOCKETS_ENABLED=false`), recusa todo socket;
- **_Strip Path_ ligado** tira o `/socket.io` do caminho, e o Socket.IO do
  realtime não acha o próprio endpoint.

## Primeira ação

Se um caminho cai no papel errado ou responde 502 em massa:

1. **Socket recusado em massa depois do corte**: volte
   `SOCKETS_ENABLED=true` na `trajetto-api` **primeiro** (ela volta a
   aceitar sockets), e só então investigue a _Domain_ do realtime.
2. **`POST /route/positions` com 502**: confira se a `trajetto-ingest`
   tem task de pé (_Replicas_ e o `docker service ps`). Sem task, apague a
   _Domain_ dela (o caminho volta para a API na hora, e o app reenvia o
   lote dele) e só depois mexa nas réplicas.
3. Confira o arquivo do roteador no host (abaixo, "Como confirmar"): uma
   `priority`, um _Strip Path_ ligado ou um host diferente do da API são a
   causa. Corrija pela aba _Domains_ da Application, nunca editando o
   arquivo (o Dokploy o reescreve).

## Como confirmar

No host, antes de criar a _Domain_ e depois dela (troque pelo App Name do
ambiente):

```sh
cat /etc/dokploy/traefik/dynamic/trajetto-realtime-staging.yml
cat /etc/dokploy/traefik/dynamic/trajetto-ingest-staging.yml
cat /etc/dokploy/traefik/dynamic/trajetto-api-staging.yml
```

Os dois primeiros têm a regra com `&& PathPrefix(...)`; nenhum dos três
tem `priority:` nem middleware `stripprefix`. Pela borda, se o access log
do Traefik do Dokploy estiver ligado no host, o roteador que atendeu cada
pedido está nele (`RouterName`):

```sh
docker logs --since 5m dokploy-traefik 2>&1 | grep '"RequestPath":"/socket.io' | tail -n 3
```

A prova completa, sem tocar a staging, é a da bancada: o harness carrega
as mesmas regras, no formato do Dokploy, para o host
`roles.load.localhost` (`tests/load/traefik/dokploy-roles.yml`), e o
`tests/load/roles-routing.sh` confere pelo access log cada caminho no seu
papel, `/route/live` na API e o 502 do ingest com 0 réplicas, e a volta:

```sh
LOAD_API_ROLE=api LOAD_API_SOCKETS=false docker compose --env-file .env \
  -f tests/load/compose.load.yaml --profile roles --profile realtime \
  --profile ingest up -d --build
bash tests/load/roles-routing.sh
```

O script também roda contra um Traefik avulso com servidores de mentira
no lugar dos papéis (`ROUTING_TRAEFIK_CONTAINER` e
`ROUTING_INGEST_CONTAINER`), como foi provado com o Traefik 3.7.13 na
onda 18. Na staging, quem roda a conferência pela borda é o dono, com o
LOAD-05 (a frota de sockets) e o `curl` de um caminho de cada papel.

## Quando escalar

- O arquivo do roteador está certo e ainda assim o caminho cai na API: o
  Traefik do Dokploy pode estar numa versão que ordena de outro jeito.
  Anote `docker exec dokploy-traefik traefik version` e o arquivo, e
  volte o corte (`SOCKETS_ENABLED=true` na API, _Domain_ apagada) até
  entender.
- 502 com task de pé: o serviço não está na `dokploy-network` ou a porta
  da _Domain_ não é a `3333`. É configuração da Application, não do
  código; registre o `docker service inspect` dela.
