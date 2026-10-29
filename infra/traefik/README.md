# Traefik de produção — o que está versionado aqui

> O Traefik que atende a web (`www.intrajetto.com`, `intrajetto.com`,
> `staging.intrajetto.com`) e a API (`api-staging.intrajetto.com`; em
> produção, o host a definir, previsto `api.intrajetto.com`) é o do
> **Dokploy**: um contêiner
> (`dokploy-traefik`) na rede `dokploy-network`, configurado no host, fora de
> qualquer repositório. Cada serviço é um **Application** do Dokploy (imagem
> do GHCR, sem compose): o domínio, a porta e o HTTPS de cada um são campos do
> Application, e o Dokploy escreve o roteador correspondente em
> `/etc/dokploy/traefik/dynamic/<appName>.yml` (editável em _Advanced →
> Traefik_). A configuração **estática** e as opções de TLS não cabem ali, e
> por isso ficam de referência aqui. Nada nesta pasta é aplicado por deploy: alguém com acesso
> ao host aplica. O deploy em si: `docs/deploy.md`.

## Uma imagem, dois ambientes

Staging e produção rodam a **mesma imagem** de cada serviço, promovida por
digest (decisão 12.2): o `deploy.yml` da API publica só `sha-<sha>` a cada
push na branch `staging`, move a tag `staging` para o digest recém-construído
e, na promoção (o merge em `main`), move `stable` para o mesmo digest. A web também: a URL da API, a do socket, a chave do Turnstile, os
tiles do mapa e o `APP_ENV` são lidos em runtime do Environment do
Application, não embutidos no build. Diante deste Traefik, o que diferencia
staging de produção é o domínio configurado em cada Application (o Dokploy dá
a cada um o seu roteador, nomeado pelo appName, então não há colisão de
nomes). Nada aqui muda entre ambientes.

## Arquivos

| Arquivo                  | O que garante                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `traefik.reference.yaml` | Entrypoint `web` (:80) redireciona tudo para `websecure` (:443), permanente; carrega o provider de arquivo. |
| `dynamic/tls.yaml`       | TLS mínimo 1.2 para todo router que não pedir outras opções.                                                |

## O que depende de onde

- **Cloudflare na frente (proxy laranja).** O navegador negocia TLS com a
  Cloudflare, não com o Traefik. Então o TLS mínimo e o redirect HTTP→HTTPS que
  o usuário vê são configurações da zona na Cloudflare:
  _SSL/TLS → Edge Certificates → Minimum TLS Version = 1.2_ e
  _Always Use HTTPS = On_, na zona `intrajetto.com`.
  O `tls.yaml` daqui passa a valer entre Cloudflare e origem (modo _Full
  (strict)_) e para qualquer acesso direto ao IP.
- **HSTS do apex.** `intrajetto.com` (`WEB_APEX_HOST`) só redireciona para o
  `www` (`WEB_HOST`), e é o Traefik quem responde. O redirect e o
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  no próprio 301 (requisito da lista de preload) vão na configuração Traefik
  do Application da web (_Advanced → Traefik_): o Dokploy não tem campo
  para middleware. O `www` já envia o mesmo
  header pelo `next.config.mjs`.
- **WebSocket e `readTimeout`.** O `readTimeout` vale para receber a
  requisição, não para uma conexão já promovida: medido localmente no Traefik
  3.7.13 (`tests/load/compose.load.yaml`), um WebSocket ocioso ficou 15 s
  aberto com `readTimeout` de 5 s. Em staging, `tests/load/socket-hold.mjs`
  confirma pelo caminho inteiro.

## Onde fica no Dokploy

Conferir no host antes de aplicar (são os padrões do Dokploy, não garantia):

| O quê                                | Onde                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------- |
| configuração estática                | `/etc/dokploy/traefik/traefik.yml` (também editável no painel: _Settings → Server → Traefik_) |
| pasta dinâmica (provider de arquivo) | `/etc/dokploy/traefik/dynamic`                                                                |
| contêiner                            | `dokploy-traefik` (`docker exec dokploy-traefik traefik version`)                             |
| resolver de certificados             | `letsencrypt` (o que o Dokploy usa quando o domínio pede HTTPS)                               |
| rede                                 | `dokploy-network` (onde o Dokploy põe todo Application e Database)                            |
| roteador de cada Application         | `/etc/dokploy/traefik/dynamic/<appName>.yml` (_Advanced → Traefik_ no Application)            |

## Aplicar

1. No host, juntar as chaves de `traefik.reference.yaml` ao `traefik.yml` do
   Dokploy (manter os `providers` swarm/docker/file e o `certificatesResolvers`
   dele como estão).
   - Se o Traefik sobe com flags na linha de comando (`--entrypoints...`) em
     vez de `traefik.yml`, a configuração estática vem só delas: acrescentar as
     flags equivalentes, e não criar um arquivo que seria ignorado:
     ```
     --entrypoints.web.http.redirections.entrypoint.to=websecure
     --entrypoints.web.http.redirections.entrypoint.scheme=https
     --entrypoints.web.http.redirections.entrypoint.permanent=true
     --providers.file.directory=/etc/traefik/dynamic
     --providers.file.watch=true
     --entrypoints.websecure.transport.respondingtimeouts.readtimeout=120s
     ```
   - Endereço do cliente, `mode: host` das portas e trava da origem: ver
     `docs/deploy.md` (seção "Domínios, TLS e a borda").
2. Colocar `dynamic/tls.yaml` na pasta que o provider de arquivo lê.
   **O Traefik aceita um provider de arquivo só.** O Dokploy já tem o dele
   (`/etc/dokploy/traefik/dynamic`): copiar o `tls.yaml` para essa pasta e não
   mexer no `directory`: apontá-lo para outro lugar descarrega todas as rotas
   e middlewares que o Dokploy mantém lá.
3. Reiniciar o Traefik (configuração estática só é lida na partida):
   `docker restart dokploy-traefik`, ou _Reload_ no painel.
4. Conferir a configuração Traefik do Application da web (redirect do apex
   com HSTS); não é preciso build novo.

## Verificar

```sh
# :80 redireciona para https, no mesmo host
curl -sI http://intrajetto.com | grep -iE '^(HTTP|location)'
curl -sI http://www.intrajetto.com | grep -iE '^(HTTP|location)'

# O apex manda HSTS com preload no 301
curl -sI https://intrajetto.com | grep -iE '^(HTTP|strict-transport-security|location)'
# esperado: strict-transport-security: max-age=63072000; includeSubDomains; preload

# TLS 1.1 recusado, 1.2 aceito (na borda que o navegador vê)
openssl s_client -connect www.intrajetto.com:443 -servername www.intrajetto.com -tls1_1 </dev/null 2>&1 | grep -iE 'alert|handshake failure|no protocols'
openssl s_client -connect www.intrajetto.com:443 -servername www.intrajetto.com -tls1_2 </dev/null 2>&1 | grep -E '^ *Protocol'
```

Com tudo acima confirmado, submeter `intrajetto.com` em
<https://hstspreload.org>. Preload é difícil de desfazer (meses para sair das
listas dos navegadores): todo subdomínio de `intrajetto.com` passa a exigir
HTTPS.
