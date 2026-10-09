# Traefik de produção — o que está versionado aqui

> O Traefik que atende `www.intrajetto.com`, `intrajetto.com` e
> `trajettoapi.thorsolucoes.com.br` é o do **Dokploy**: um contêiner
> (`dokploy-traefik`) na rede `dokploy-network`, configurado no host, fora de
> qualquer repositório. Os labels de cada serviço vivem no
> `compose.production.yaml` de cada repo (roteadores com o prefixo da stack,
> para staging e produção dividirem o mesmo Traefik); a configuração
> **estática** e as opções de TLS não cabem em label nenhum, e por isso ficam
> de referência aqui. Nada nesta pasta é aplicado por deploy: alguém com acesso
> ao host aplica. O deploy em si: `docs/deploy.md`.

## Uma imagem, duas stacks

Staging e produção rodam a **mesma imagem** de cada serviço, promovida por
digest (decisão 12.2): o `deploy.yml` da API publica só `sha-<sha>` a cada
push na branch `staging`, move a tag `staging` para o digest recém-construído
e, na promoção (o merge em `main`), move `stable` para o mesmo digest. A web também: a URL da API, a do socket, a chave do Turnstile, os
tiles do mapa e o `APP_ENV` são lidos em runtime do Environment da stack, não
embutidos no build. O que diferencia as stacks diante deste Traefik é só
Environment: `ROUTER_PREFIX` (nomes de roteadores e middlewares únicos por
stack), `WEB_HOST`/`WEB_APEX_HOST` e `API_HOST`. Nada aqui muda entre
ambientes.

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
  _Always Use HTTPS = On_, nas zonas `intrajetto.com` e `thorsolucoes.com.br`.
  O `tls.yaml` daqui passa a valer entre Cloudflare e origem (modo _Full
  (strict)_) e para qualquer acesso direto ao IP.
- **HSTS do apex.** `intrajetto.com` (`WEB_APEX_HOST`) só redireciona para o
  `www` (`WEB_HOST`), e é o Traefik quem responde. O middleware
  `<prefixo>-apex-hsts` no `trajetto-ui/compose.production.yaml` põe
  `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`
  no próprio 301 — requisito da lista de preload. O `www` já envia o mesmo
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
| resolver de certificados             | `letsencrypt` (o `TRAEFIK_CERTRESOLVER` dos composes)                                         |
| rede                                 | `dokploy-network` (o `TRAEFIK_NETWORK` dos composes)                                          |

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
4. Fazer o deploy do app da web (a imagem que a stack já roda, `stable` ou
   `staging`; não é preciso build novo) para os labels do HSTS do apex
   (`<prefixo>-apex-hsts`) valerem.

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
