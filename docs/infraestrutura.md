# Infraestrutura do Trajetto — o mapa

> O mapa de tudo o que existe fora do código para o Trajetto rodar: a VPS da
> Contabo, o Dokploy, a Cloudflare, o GitHub, a Expo, o Resend e os demais
> provedores. Para cada peça: o que é, onde fica no painel (caminho exato), como
> foi criada, por que foi decidida assim, quais tokens e credenciais existem e
> como recriar tudo do zero.
>
> **Não usamos Terraform nem nenhuma outra ferramenta de infraestrutura como
> código.** Tudo foi configurado à mão, nos painéis web. Este arquivo é o único
> registro dessas configurações: uma mudança feita num painel que não chega
> aqui se perde.
>
> Última revisão: 30/10/2026.

## Sumário

1. [Para quem é e como ler](#1-para-quem-é-e-como-ler)
2. [Visão geral](#2-visão-geral)
3. [Contas e acessos](#3-contas-e-acessos)
4. [Contabo: a VPS](#4-contabo-a-vps)
5. [Dokploy](#5-dokploy)
6. [Cloudflare](#6-cloudflare)
7. [GitHub](#7-github)
8. [Expo e EAS](#8-expo-e-eas)
9. [E-mail (Resend)](#9-e-mail-resend)
10. [Monitoramento e backups](#10-monitoramento-e-backups)
11. [Inventário de tokens e credenciais](#11-inventário-de-tokens-e-credenciais)
12. [Histórico de mudanças](#12-histórico-de-mudanças)
13. [Procedimentos](#13-procedimentos)
14. [Pendências conhecidas](#14-pendências-conhecidas)

---

## 1. Para quem é e como ler

Para qualquer pessoa que entra no projeto e precisa entender onde as
aplicações rodam, e para quem vai mexer em algum painel. Leia as seções 2 e 3
primeiro (o desenho, as decisões em uma linha e as contas). As seções 4 a 9
cobrem um provedor por seção, na ordem de montagem: da base (o servidor e o
Dokploy) para a borda (a Cloudflare) e depois os serviços de fora (GitHub,
Expo, Resend). O caminho de uma requisição, da borda até o servidor, é o
desenho da [seção 2.1](#21-o-caminho-de-uma-requisição). A 10 é monitoramento
e backups, a 11 o inventário de credenciais, a 12 o histórico, a 13 os
procedimentos e a 14 a checklist de pendências.

Onde um fato ainda não foi conferido no painel, o texto diz
**A confirmar com o dono:** em vez de supor. A
[seção 14](#14-pendências-conhecidas) reúne todos esses itens numa checklist,
com o que pode derrubar o sistema ou abrir uma brecha primeiro.

### Regra de ouro: este arquivo não guarda valores

Aqui ficam **nomes, caminhos de painel, permissões e procedimentos**. Nenhum
valor. Os valores ficam em quatro lugares:

| Onde                                             | O que guarda                                                                       | Quem lê                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------- |
| _Environment_ de cada Application no Dokploy     | a cópia viva de todo segredo de runtime (API, IA, web) e as senhas dos Databases   | quem tem acesso ao painel (vê produção inteira) |
| _Secrets_ do GitHub (repositório e environments) | o que o pipeline precisa (chave do Dokploy, ids, tokens de leitura, token da Expo) | só o pipeline; no painel, só se sobrescreve     |
| EAS (expo.dev)                                   | variáveis e arquivos do app, keystore e credenciais de push                        | membros da organização na Expo                  |
| O gerenciador de senhas da equipe                | a cópia de segurança de tudo, inclusive o que só aparece uma vez na criação        | quem administra                                 |

**A confirmar com o dono:** qual gerenciador de senhas é o oficial e quem tem
acesso a ele.

Hoje o dono também guarda cópias de todos os segredos de staging e produção
em arquivos locais na própria máquina (`.env.staging` e `.env.production` nos
três repositórios). Eles estão no `.gitignore` e nunca são versionados, mas
não são a fonte da verdade nem material para repassar: **nenhum dev recebe
cópia deles**. Quem precisa de um valor pede acesso ao lugar certo da tabela
acima.

### O que nunca entra aqui (o repositório pode ficar público)

Este arquivo vive num repositório que, em alguns momentos, fica público (o
porquê está na [seção 7.2](#72-visibilidade-e-a-cota-do-actions)). Por isso,
nunca escreva aqui:

- endereços IP dos nossos servidores, o nome automático (DNS reverso) que a
  Contabo dá à VPS ou o id da máquina;
- e-mails de contas, inclusive os que estão na política do Cloudflare Access;
- Zone ID e Account ID da Cloudflare;
- valores de token, chave ou senha, públicos ou secretos (inclusive as site
  keys do Turnstile e a chave do MapTiler, que o navegador vê);
- nomes de banco junto com credenciais.

Os nomes de serviço com sufixo aleatório do Dokploy também ficam de fora: são
vistos no painel ([seção 5.4](#54-nomes-com-sufixo-aleatório)).

A regra vale também fora deste arquivo: mensagens de commit, descrições de
PR, o `CHANGELOG.md` e os GitHub Releases (o semantic-release copia os
assuntos dos commits), comentários de código, testes e a saída de logs ou
artefatos do Actions, inclusive trechos de erro colados (como um
`read tcp [IPv6]:porta->…`). Troque os endereços por marcadores, como
`<IPv6 da VPS>` ou `<IP_DA_VPS>`.

O histórico do Git guarda as versões antigas dos documentos e as mensagens de
commit. Apagar um dado do texto não o tira do histórico. **Isso já
aconteceu**: o histórico da `trajetto-api` contém o nome automático que a
Contabo dá à VPS (ele resolve para o IPv4 da VPS) e o endereço IPv6 dela, no
`deploy.md` dos commits `577fc5a` e `d413cb1` e na mensagem do `577fc5a`
(enviados por volta das 03:15 UTC de 29/10/2026, hoje na `main` e na
`staging`). Esses commits estiveram públicos nas janelas da
[seção 7.2](#72-visibilidade-e-a-cota-do-actions), e o certificado do Let's
Encrypt emitido para o nome automático está nos logs públicos de Certificate
Transparency. Por isso o IP e o nome da VPS são tratados como públicos desde
29/10/2026: a proteção da origem é o firewall
([seção 4.3](#43-firewall)), não o sigilo.

### Como este arquivo se liga aos outros

Este é o **mapa** e o **registro das decisões e das configurações de
painel**. Os procedimentos longos ficam onde já estavam, e aqui há o link:

| Documento                                                                                                                                              | O que tem                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`deploy.md`](./deploy.md)                                                                                                                             | o pipeline, o Dokploy clique a clique (cada Application e Database), o firewall e o IPv4, a borda, migrations, rollback, backup e restore |
| [`variaveis-de-ambiente.md`](./variaveis-de-ambiente.md)                                                                                               | cada variável da API: para que serve, formato, valor por ambiente, como gerar                                                             |
| [`trajetto-ui/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/deploy.md)                                       | a Application da web, o redirect do apex, os Rulesets do GitHub                                                                           |
| [`trajetto-ui/docs/variaveis-de-ambiente.md`](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/variaveis-de-ambiente.md)         | cada variável da web e os secrets do GitHub da web                                                                                        |
| [`trajetto-mobile/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/deploy.md)                               | EAS Build e Update, perfis, canais, OTA assinada, Firebase e Play Store                                                                   |
| [`trajetto-mobile/docs/variaveis-de-ambiente.md`](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/variaveis-de-ambiente.md) | as variáveis e as credenciais do EAS                                                                                                      |

Se um procedimento lá contradiz o estado registrado aqui, vale o daqui:
corrija lá e anote na [seção 12](#12-histórico-de-mudanças).

### Quando atualizar

Toda mudança feita à mão num painel (Contabo, Dokploy, Cloudflare, GitHub,
Expo, Resend, R2) atualiza este arquivo no mesmo dia, com:

1. o novo estado na seção do provedor;
2. uma linha com a data na [seção 12](#12-histórico-de-mudanças);
3. o token novo, ou o apagado, na [seção 11](#11-inventário-de-tokens-e-credenciais).

"No mesmo dia" vale para o texto, não para o push. O `deploy.yml` da API não
ignora mudanças em `docs/`: um commit só de documentação sem `[skip ci]` roda
o pipeline inteiro (cerca de 1 hora de runner, da cota da
[seção 7.2](#72-visibilidade-e-a-cota-do-actions)) e reimplanta o staging.
Para subir só o doc, ponha `[skip ci]` na mensagem do commit: o GitHub não
roda workflow nenhum para ele, e desde 30/10/2026 isso é seguro nos três
repositórios. Um commit que só muda `*.md` ou `docs/` vai para a produção com
o build do commit mais próximo que o staging rodou (o mesmo conteúdo de
imagem), então o PR `staging → main` e a promoção não travam mais por ele
([`deploy.md` → Commits só de documentação](./deploy.md#commits-só-de-documentação)).
Pode subir a qualquer hora, inclusive enquanto o pipeline do commit anterior
ainda roda: o deploy de staging daquele commit continua valendo, porque a
ponta nova só acrescenta documentação.
`[skip ci]` só para documentação: um commit que mexe em qualquer outro
arquivo precisa do pipeline. E o GitHub não roda os checks de um PR cuja
ponta tem `[skip ci]`: com o commit de doc na ponta do PR `staging → main`,
os checks exigidos ficam pendentes até um _Run workflow_ na `staging` (ou
um commit sem `[skip ci]`), e um `[skip ci]` no título do PR vai para o
merge commit e impede a promoção
([`deploy.md` → Commits só de documentação](./deploy.md#commits-só-de-documentação)).

---

## 2. Visão geral

Uma única VPS da Contabo, nos EUA, roda o Dokploy (Docker Swarm de um nó com
o Traefik na frente). Staging e produção dividem a mesma VPS e o mesmo Dokploy,
em environments separados. A Cloudflare fica na frente de tudo e é o único
caminho de entrada. As imagens são construídas uma vez pelo GitHub Actions,
guardadas no GHCR e promovidas por digest do staging para a produção. O app
do motorista não passa pelo Dokploy: é publicado pela Expo (EAS).

### 2.1 O caminho de uma requisição

```
navegador · app do motorista · ERP de cliente · webhooks (Meta, Resend)
        │  HTTPS, IPv4 ou IPv6 (HTTP/3 quando o cliente aceita)
        ▼
Cloudflare — zona intrajetto.com, plano Free                      (seção 6)
  DNS com proxy · certificado de borda e HSTS · DDoS e WAF gerenciados
  Access (só na web de staging) · redirect intrajetto.com → www
  Turnstile nos formulários · Web Analytics · Tiered Cache e Early Hints
        │  só IPv4, só a partir das faixas de IP da Cloudflare, portas 80/443
        ▼
Firewall da Contabo (só a entrada)                                 (seção 4.3)
  80 e 443: só das faixas da Cloudflare · 22 (SSH) · o resto da entrada: DROP
        ▼
VPS Contabo (EUA), Ubuntu 24.04                                    (seção 4)
  Traefik do Dokploy (contêiner dokploy-traefik, :80 e :443)        (seção 5)
  certificados Let's Encrypt; roteia pelo Host para o serviço certo
        ▼
  rede overlay dokploy-network
   ├─ environment production: trajetto-api · trajetto-ai
   │                          PostgreSQL · Redis · trajetto-ui
   └─ environment staging:    trajetto-api · trajetto-ai
                              PostgreSQL · Redis · trajetto-ui
   (réplicas de cada serviço: seção 2.3)
        │  saída (preferindo IPv4, seção 4.4)
        ▼
  Cloudflare R2 (fotos e backups) · Resend · Expo Push · healthchecks.io
  LocationIQ · MapTiler · GHCR (pull das imagens)
```

O servidor da web chama a API pela URL pública (dá a volta pela Cloudflare).
A API fala com o Postgres, o Redis e a IA pelo nome interno de cada serviço na
`dokploy-network`, sem sair da máquina. Nenhum serviço publica porta no host
além do Traefik (80 e 443) e do próprio painel do Dokploy (3000, fechada pelo
firewall; [seção 4.3](#43-firewall)). Desenho detalhado:
[`deploy.md` → A topologia no servidor](./deploy.md#4-a-topologia-no-servidor).

### 2.2 O caminho de um deploy

```
push em staging ──▶ GitHub Actions (deploy.yml)
                     ├─ validação completa
                     ├─ build ÚNICO ──▶ GHCR: sha-<7> (imutável) + tag staging
                     ├─ API do Dokploy (https://dokploy.intrajetto.com, pela Cloudflare)
                     │    se as migrations mudaram: deploy da trajetto-api-migrate
                     │    e espera a etapa terminar (seção 5.2)
                     │    POST application.deploy ──▶ o Dokploy puxa :staging do GHCR
                     │    (com o token read:packages, seção 5.7)
                     └─ conferência: /health/liveness (API) ou /build-id.json (web)

PR staging → main ──▶ a mesma validação + "o staging rodou este commit?"

merge em main ──▶ aprovação no environment production
                  ├─ migrations, se mudaram (trajetto-api-migrate de produção)
                  ├─ tag stable movida para o MESMO digest (sem rebuild)
                  ├─ API do Dokploy: deploy das Applications de produção
                  ├─ conferência
                  └─ semantic-release (tag, CHANGELOG, GitHub Release)

app do motorista ──▶ eas update / eas build na expo.dev (sem Dokploy)
```

O detalhe de cada job, as tags e o rollback estão em
[`deploy.md` → Os workflows em detalhe](./deploy.md#3-os-workflows-em-detalhe)
e [Como o pipeline fala com o Dokploy](./deploy.md#como-o-pipeline-fala-com-o-dokploy).

### 2.3 Staging e produção

|                        | Staging                                   | Produção                                                                                                         |
| ---------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| VPS e Dokploy          | os mesmos                                 | os mesmos                                                                                                        |
| environment do Dokploy | `staging`                                 | `production`                                                                                                     |
| tag das imagens        | `:staging`                                | `:stable` (o mesmo digest que o staging validou)                                                                 |
| web                    | `staging.intrajetto.com`, atrás do Access | `www.intrajetto.com`, pública                                                                                    |
| API                    | `api-staging.intrajetto.com`, sem Access  | `api.intrajetto.com`                                                                                             |
| réplicas da API        | 1                                         | instruído: 2; em 29/10 o serviço estava com 1 réplica (`x/1` no `docker service ls`). **A confirmar com o dono** |
| segredos               | próprios                                  | outros; **nunca** compartilhados com o staging                                                                   |
| bucket de fotos (R2)   | `trajetto-staging-storage`                | `trajetto-prod-storage`                                                                                          |
| backup do banco        | prefixo `trajetto-staging/` no R2         | prefixo `trajetto-production/` (seção 10.2)                                                                      |
| environment do GitHub  | `staging`, sem aprovação                  | `production`, com aprovação                                                                                      |
| app do motorista       | APK interno, canal `staging`              | AAB, canal `production` (Play Store ainda não configurada)                                                       |

A produção entrou no ar em 29/10/2026: API em `api.intrajetto.com` (commit
`01526b0`, já com o Prisma 7) e web em `www.intrajetto.com` (commit `a1c5242`,
release v1.1.0).

### 2.4 Os hostnames

Todos na zona `intrajetto.com` da Cloudflare. Só subdomínios de um nível
(`api-staging`, nunca `api.staging`): o certificado universal gratuito da
Cloudflare cobre só `*.intrajetto.com`.

| Host                         | Papel                                                                                                                                                               | Proteção na borda                                                  | Destino na origem                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- |
| `www.intrajetto.com`         | web de produção (site público e sistema logado)                                                                                                                     | proxy                                                              | Application `trajetto-ui` de produção, porta 3000  |
| `intrajetto.com` (apex)      | só redireciona com 301 para `https://www.intrajetto.com`, com caminho e query                                                                                       | proxy; Redirect Rule (seção 6.3)                                   | nenhum: a Cloudflare responde                      |
| `staging.intrajetto.com`     | web de staging                                                                                                                                                      | proxy e Cloudflare Access (seção 6.4)                              | Application `trajetto-ui` de staging, porta 3000   |
| `api.intrajetto.com`         | API de produção: REST, Socket.IO, webhooks e integrações                                                                                                            | proxy                                                              | Application `trajetto-api` de produção, porta 3333 |
| `api-staging.intrajetto.com` | API de staging                                                                                                                                                      | proxy, **sem** Access de propósito (seção 6.4)                     | Application `trajetto-api` de staging, porta 3333  |
| `dokploy.intrajetto.com`     | painel do Dokploy e a API dele, que o pipeline chama                                                                                                                | proxy; regra de Skip do WAF em `/api/`                             | o painel do Dokploy                                |
| `mail.intrajetto.com`        | domínio de envio do Resend (só registros de e-mail; não é site)                                                                                                     | registros DNS                                                      | o Resend                                           |
| `uptime.intrajetto.com`      | Uptime Kuma, o monitor de disponibilidade (informado pelo dono em 30/10/2026). **A confirmar com o dono:** onde roda, o que vigia, para onde avisa e quem tem login | proxy (responde com `server: cloudflare`, conferido em 30/10/2026) | **A confirmar com o dono**                         |
| `monitor.intrajetto.com`     | Beszel, o monitor de recursos do servidor (informado pelo dono em 30/10/2026). **A confirmar com o dono:** onde roda, o que vigia, se alerta e quem tem login       | proxy (idem)                                                       | **A confirmar com o dono**                         |

A IA (`trajetto-ai`) não tem hostname: só a API a alcança, pela rede interna.

### 2.5 Decisões e porquês em uma linha

| Decisão                                                               | Por quê, em uma linha                                                                                    | Detalhe                                                                                                             |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Bot Fight Mode desligado                                              | no Free vale para o domínio inteiro, sem exceção, e desafiava o app, os ERPs, os webhooks e o CI         | [6.5](#bot-fight-mode-desligado)                                                                                    |
| JavaScript Detections desligado (pela API)                            | no Free não protege nada sozinho e derrubava o Lighthouse; não existe chave no painel                    | [6.5](#javascript-detections-desligado-29102026)                                                                    |
| Email Address Obfuscation desligado                                   | o script que ela injeta era bloqueado pela CSP e quebrava os e-mails das páginas                         | [6.5](#email-address-obfuscation-desligado)                                                                         |
| Rocket Loader, 0-RTT, Speed Brain e Cloudflare Fonts desligados       | reescrevem scripts (quebram a CSP), permitem replay ou não têm efeito aqui                               | [6.6](#66-speed)                                                                                                    |
| Web Analytics mantido                                                 | sem cookie; a CSP o libera e a política de privacidade o declara                                         | [6.8](#68-web-analytics)                                                                                            |
| Firewall: 80/443 só da Cloudflare, 22 aberta, o resto da entrada DROP | fecha o atalho para a origem (Access e WAF não podiam ser pulados); a 80 é da renovação do Let's Encrypt | [4.3](#43-firewall)                                                                                                 |
| IPv6 não desligado; a saída prefere IPv4                              | resolve os pulls do GHCR que caíam pelo IPv6 sem tirar o servidor do padrão do Ubuntu                    | [4.4](#44-saída-preferindo-ipv4-sem-desligar-o-ipv6)                                                                |
| Todo serviço é Application ou Database do Dokploy, nunca Compose      | o pipeline acompanha cada deploy até o fim, um serviço por vez, e o backup nativo só existe no Database  | [5.3](#53-por-que-application-e-nunca-compose)                                                                      |
| `www` é o domínio da web; o apex só redireciona                       | o apex como domínio da Application deu 526 no `www`, e o CORS da API só aceita o `www`                   | [5.5](#55-domínios-e-certificados-lets-encrypt) e [6.3](#63-rules)                                                  |
| Registro DNS sempre com proxy, inclusive para emitir certificado      | o firewall só admite a Cloudflare, e um registro sem proxy publica o IP da origem para sempre            | [5.5](#55-domínios-e-certificados-lets-encrypt)                                                                     |
| Access na web de staging, nunca na API de staging                     | o app, os ERPs e os webhooks chamam a API sem login do Access; a API já exige login nas rotas privadas   | [6.4](#64-zero-trust-access-staging)                                                                                |
| A API exige Turnstile só no orçamento                                 | o login do app quebraria; o login direto na API é protegido pelos rate limits                            | [6.9](#69-turnstile)                                                                                                |
| HSTS de 12 meses com `preload` no cabeçalho, sem inscrição na lista   | 12 meses é o máximo do painel; a inscrição é manual e difícil de desfazer                                | [6.2](#62-ssltls-e-hsts)                                                                                            |
| Repositórios abertos temporariamente em 29/10                         | a cota do Actions acabou, e repositório público tem Actions grátis; é o último recurso                   | [7.2](#72-visibilidade-e-a-cota-do-actions) e [13.6](#136-abrir-e-fechar-um-repositório-para-usar-o-actions-grátis) |

---

## 3. Contas e acessos

### 3.1 As contas

| Conta                                            | Para quê                                                        | Quem administra                                                                                                                        | 2FA                          |
| ------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Contabo                                          | a VPS, o firewall, o console VNC, o Auto Backup da VM           | a conta foi criada por outra pessoa; o dono tem acesso total ao painel                                                                 | **A confirmar com o dono**   |
| Cloudflare                                       | DNS, TLS, segurança, Access, Turnstile, Web Analytics, R2       | o dono                                                                                                                                 | **A confirmar com o dono**   |
| Dokploy (`dokploy.intrajetto.com`)               | Applications, Databases, variáveis, domínios, backups           | dois usuários: a conta dona (criada na instalação) e a conta admin pessoal do dono (seção 5.10)                                        | pendente nas duas (seção 14) |
| GitHub, organização `Trajetto-Organization`      | código, Actions, GHCR, secrets                                  | **A confirmar com o dono:** quem são os owners da organização                                                                          | **A confirmar com o dono**   |
| Expo, organização `trajetto`                     | EAS Build e Update, credenciais do app                          | o dono; o CI usa o robot `github-actions`                                                                                              | **A confirmar com o dono**   |
| Firebase, projeto `trajetto`                     | push do Android (FCM)                                           | o dono                                                                                                                                 | **A confirmar com o dono**   |
| Resend                                           | e-mail transacional                                             | o dono                                                                                                                                 | **A confirmar com o dono**   |
| healthchecks.io                                  | o heartbeat da API (seção 10)                                   | o dono                                                                                                                                 | **A confirmar com o dono**   |
| MapTiler                                         | tiles do mapa (web e comprovante)                               | o dono                                                                                                                                 | **A confirmar com o dono**   |
| LocationIQ                                       | geocodificação reversa                                          | o dono                                                                                                                                 | **A confirmar com o dono**   |
| Meta (Business Manager)                          | WhatsApp; hoje bloqueado por política da Meta e não configurado | o dono                                                                                                                                 | **A confirmar com o dono**   |
| Google Play Console                              | publicação do app                                               | ainda não configurado                                                                                                                  | —                            |
| Registrador do domínio `intrajetto.com`: GoDaddy | os nameservers que apontam para a Cloudflare                    | o dono, pela conta Google da Trajetto (informado em 30/10/2026). **A confirmar com o dono:** o titular do registro (pessoa ou empresa) | **A confirmar com o dono**   |

As contas dos provedores (Cloudflare, GitHub, Expo, Firebase, Resend,
healthchecks.io, MapTiler, LocationIQ, Meta, GoDaddy e, quando existir, a
Google Play) estão na conta Google da Trajetto, e o acesso administrativo é
feito por ela (informado pelo dono em 30/10/2026; o endereço não entra aqui).
A exceção é a Contabo, criada por outra pessoa. Quem entra nessa conta Google
recupera a senha de quase todos os provedores: o 2FA dela é o item mais
importante da [seção 14.2](#142-segurança).

Regras para todas: 2FA ligado, uma conta por pessoa (nada de conta
compartilhada) e acesso removido no dia em que alguém sai
([seção 13.2](#132-entrada-e-saída-de-um-dev)). Nos painéis que aceitam
membros (Dokploy, Cloudflare Access, GitHub, Expo), cada dev entra com o
próprio usuário, não com a conta Google da Trajetto.

### 3.2 Dar acesso a um dev novo (o mínimo)

O padrão é **não** dar acesso a painéis de infraestrutura. Um dev que só
programa precisa de:

| Onde                   | O que dar                                                                                                                                              | Por quê                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub                 | membro da organização, papel **Write** nos repositórios em que vai trabalhar (nunca Admin nem owner), **só depois** das duas proteções do aviso abaixo | push de branches e PRs; Write dá acesso aos secrets pelo código de um workflow (aviso abaixo)                                               |
| Cloudflare Access      | o e-mail dele na política `Equipe Trajetto` da aplicação `Staging web` (seção 6.4)                                                                     | abrir `staging.intrajetto.com`; não exige conta na Cloudflare                                                                               |
| Expo (se mexer no app) | membro da organização `trajetto` com papel _Viewer_; _Developer_ só para quem precisa publicar (aviso abaixo)                                          | baixar os APKs de staging e o dev client, que é gerado por quem tem _Developer_ (README do `trajetto-mobile`, passo 3), e acompanhar builds |
| Desenvolvimento local  | nada de produção: o `.env` local nasce do `.env.example` de cada repositório                                                                           | segredos de staging e produção nunca vão para a máquina de um dev                                                                           |

**Write no GitHub não protege os secrets.** Quem tem Write pode dar push num
workflow modificado e rodá-lo, e o código do workflow lê os secrets: os de
repositório, em qualquer branch (na `trajetto-mobile`, o `EXPO_TOKEN`, que
publica OTA), e os de um environment, em qualquer branch que o environment
aceite. Como a `staging` não exige PR (o dono dá push direto,
[seção 7.1](#71-organização-e-repositórios)), um dev com Write pode dar push
em `staging` e ler os secrets do environment `staging`, entre eles o
`DOKPLOY_API_KEY`, que hoje controla o painel inteiro, produção incluída
([seção 5.8](#58-chave-de-api-do-dokploy-usada-pelo-ci)). Antes de dar Write a
qualquer pessoa:

1. um Ruleset em `staging` exigindo PR com revisão para todos, com só o dono
   na _Bypass list_ ([seção 7.5](#75-proteção-das-branches));
2. a chave do Dokploy separada por ambiente, com a de staging gerada por um
   membro restrito ao staging (seção 5.8).

Até lá, ninguém além do dono recebe Write.

**Developer na Expo publica OTA.** O papel _Developer_ pode rodar
`eas update --channel production` da própria máquina. Os binários de produção
não têm certificado de assinatura ([seção 8.3](#83-ota-e-build-manual)), então
aceitam update sem assinatura: esse dev atualizaria o app de todos os
motoristas sem passar pelo pipeline. Por isso o padrão é _Viewer_ (instalar
builds e acompanhar), e _Developer_ fica só para quem precisa publicar, com o
nome da pessoa anotado nesta seção (sem e-mail), até a OTA assinada existir.
**A confirmar com o dono:** os membros atuais da organização `trajetto` na
Expo e o papel de cada um.

O que **não** se dá a um dev por padrão, e por quê:

- **Dokploy**: todo usuário com acesso a um projeto vê o _Environment_ das
  Applications e as senhas dos Databases, inclusive de produção. Só quem pode
  ver produção entra.
- **Cloudflare**: se for mesmo preciso, convide em _Manage Account → Members_
  com um papel só de leitura; nunca _Administrator_.
- **Contabo**: só o dono.
- **SSH da VPS**: só o dono (seção 4.2).

---

## 4. Contabo: a VPS

### 4.1 A máquina

| Item              | Valor                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Plano             | Cloud VPS 6 NVMe (2026): 6 vCPU, 12 GB de RAM, 100 GB NVMe, cerca de US$ 15/mês                          |
| Região            | United States (Central)                                                                                  |
| Sistema           | Ubuntu 24.04 LTS, imagem da Contabo com o Dokploy pré-instalado via cloud-init (instalado em 20/10/2026) |
| Arquitetura       | amd64 (as imagens do GHCR são `linux/amd64`)                                                             |
| Relógio           | UTC (a agenda do backup, `0 3 * * *`, é 03:00 UTC = 00:00 em São Paulo)                                  |
| Uso em 29/10/2026 | disco em 14,2% de ~96 GB, memória em 24%                                                                 |
| IP e hostname     | no painel da Contabo, na página da VPS. Não escreva aqui (seção 1)                                       |

Itens da Contabo que **não** usamos: as zonas de DNS da Contabo (todo o DNS
está na Cloudflare), IPs adicionais e rede privada. O DNS reverso (PTR) do IP
aponta para o nome automático que a Contabo criou: é inofensivo e não precisa
ser mexido.

**Auto Backup da Contabo**: está ligado na VPS. São cópias diárias da máquina
inteira (cerca de 1 a 7 GB cada; o painel listava uns 9 dias). É independente
do backup do banco ([seção 10.2](#102-backups)). A própria Contabo avisou que
o Auto Backup da região US-central teve problemas de desempenho (cópias
atrasadas e restauração temporariamente indisponível).
**A confirmar com o dono:** se ele continua ligado, a retenção e o custo.

O orçamento de memória dos serviços está em
[`deploy.md` → Recursos da VPS e logs](./deploy.md#23-recursos-da-vps-e-logs).

### 4.2 SSH e console de emergência

- **SSH**: só o dono acessa. No Windows, o cliente é o OpenSSH que já vem no
  PowerShell. **O endurecimento do SSH está pendente** e é a primeira
  pendência de segurança ([seção 14](#14-pendências-conhecidas)). O passo a
  passo, numa ordem que não tranca ninguém do lado de fora, está na
  [seção 13.8](#138-endurecer-o-ssh). Feito, registre aqui o estado novo.
- **Console de emergência (VNC)**: o painel da Contabo não tem terminal no
  navegador. O VNC está ligado: painel → a VPS → _Manage_ → _VNC_ mostra o
  endereço, a porta e a senha do VNC. Precisa de um cliente externo (por
  exemplo, RealVNC Viewer), e colar texto costuma não funcionar. Fica como
  saída de emergência se o SSH cair.
- **_Password reset_ do painel**: pode reiniciar a VPS, o que derruba
  staging e produção. Use só como último recurso, numa janela calma, e leia o
  aviso do painel antes de confirmar. **A confirmar com o dono:** o que o
  botão faz nesta VPS (reinicia ou não).
- **O CI não usa SSH.** Desde 31/10/2026 a imagem da API não migra no boot,
  e as migrations rodam pela Application `trajetto-api-migrate` do Dokploy,
  chamada pela API do Dokploy como as outras
  ([seção 5.2](#52-environments-projetos-e-serviços);
  [`deploy.md` → 15](./deploy.md#15-migrations)). O usuário de deploy e a
  chave restrita descritos em
  [`deploy.md`](./deploy.md#14-conferir-a-convergência) só são necessários
  com `ROLLOUT_VERIFY=ssh`, que não está em uso. **A confirmar com o dono:**
  se existe no host algum usuário criado por nós, além dos da imagem (um
  usuário `deploy` criado para o caminho por SSH das migrations, que não
  chegou a ser usado, pode ser apagado).

### 4.3 Firewall

**Onde**: painel da Contabo → _Network Services → Firewall_. O firewall
precisa estar **aplicado à VPS** (um firewall sem VPS associada não filtra
nada).

**Regras de entrada, nesta ordem** (aplicadas em 29/10/2026):

| Nome                | Ação   | Protocolo | Porta    | Fonte(s)                                  | Por quê                                                                             |
| ------------------- | ------ | --------- | -------- | ----------------------------------------- | ----------------------------------------------------------------------------------- |
| `HTTPS Cloudflare`  | ACCEPT | TCP       | 443      | as faixas IPv4 publicadas pela Cloudflare | todo o tráfego dos sites e da API chega pela Cloudflare                             |
| `HTTP Cloudflare`   | ACCEPT | TCP       | 80       | as mesmas faixas                          | a renovação do Let's Encrypt (desafio HTTP-01) chega pela Cloudflare na porta 80    |
| `SSH`               | ACCEPT | TCP       | 22       | qualquer IPv4                             | administração do servidor; endurecimento e restrição da origem pendentes (seção 14) |
| `Block all traffic` | DROP   | qualquer  | qualquer | qualquer                                  | a regra fixa da Contabo, sempre a última: fecha todas as outras portas, IPv4 e IPv6 |

As regras valem só para conexões **de entrada**. A saída do servidor (pull do
GHCR, R2, Resend por SMTP, Expo Push, healthchecks.io, LocationIQ) não passa
por elas, e as respostas das conexões que o servidor abre voltam
normalmente: depois das regras de 29/10, os deploys continuaram puxando as
imagens do GHCR e a produção subiu. Uma falha de saída se investiga pela
[seção 4.4](#44-saída-preferindo-ipv4-sem-desligar-o-ipv6) (IPv4 e IPv6), não
pelo firewall.

As fontes das duas primeiras regras são as **faixas de IP da Cloudflare**
(não da Contabo). A lista vem de `src/config/trusted-edge.ts`, copiada de
<https://www.cloudflare.com/ips-v4>, e a linha pronta para colar está em
[`deploy.md` → 6.1 Firewall da VPS](./deploy.md#61-firewall-da-vps-contabo).
O campo _Fonte(s)_ da Contabo aceita CIDRs **separados por vírgula**; uma
faixa por linha é recusada com "forneça um ou mais endereços IPv4 ou IPv6
válidos".

**Por que o firewall existe.** Antes dele, qualquer um alcançava a origem
direto, pulando a Cloudflare. Sondagens só de leitura, feitas de fora em 27 e
28/10/2026, mostraram:

- o painel do Dokploy aberto na porta 3000 em HTTP simples, por IPv4 e IPv6;
- o painel do Dokploy também aberto pelo nome automático da Contabo, em HTTPS,
  com certificado próprio do Let's Encrypt (existe um roteador do Traefik para
  esse nome);
- o staging e a API respondendo direto na origem: o `/login` do staging dava
  200 **sem passar pelo Cloudflare Access** (pela Cloudflare, 302 para o
  login do Access).

A Contabo já tinha um firewall chamado `default` (443 e 22 para qualquer
IPv4, e o DROP), mas ele não estava aplicado a nenhuma VPS. O dono o aplicou
entre a noite de 27/10 e a madrugada de 29/10 (a porta 3000 passou a cair no
DROP) e, em 29/10, entre 02:51 e 03:00 UTC, trocou as regras pelas da tabela
acima. Conferido de fora às 03:01 UTC: nada responde direto na origem, nem por
IPv4 nem por IPv6, e `staging`, `api-staging` e `dokploy.intrajetto.com` pela
Cloudflare funcionam por IPv4 e IPv6. Os deploys do CI continuaram funcionando,
porque o `DOKPLOY_URL` passa pela Cloudflare.

**Por que cada porta está como está:**

- **443 só da Cloudflare**: é o que fecha o atalho para a origem. Sem isso, o
  Access do staging e o WAF podiam ser pulados.
- **80 aberta (só da Cloudflare)**: fechada, a renovação do Let's Encrypt
  falha em silêncio e, quando o certificado vence, a Cloudflare responde 526
  (modo _Full (strict)_). Os certificados de staging vencem entre 19 e
  22/01/2027 (a renovação começa por volta de 20/12/2026).
- **3000 sem regra**: o DROP a fecha. O painel só abre por
  `https://dokploy.intrajetto.com`, pela Cloudflare (ou, numa emergência ou
  numa VPS nova, por um túnel SSH; seção 13.1, passo 4). Por isso o secret
  `DOKPLOY_URL` do GitHub tem de ser esse endereço, nunca o IP.
- **22 para qualquer IPv4**: é o estado atual, para o dono administrar o
  servidor de qualquer rede. Nada do CI entra pela 22 (as migrations vão
  pela API do Dokploy, e a conferência do rollout é a `http`), então a
  origem **pode** ser restrita ao IP do dono, com o VNC como saída de
  emergência. **A confirmar com o dono:** o motivo de não restringir (por
  exemplo, um IP que muda). O endurecimento
  ([seção 13.8](#138-endurecer-o-ssh)) e a restrição da origem são a
  primeira pendência de segurança ([seção 14](#14-pendências-conhecidas)).
  Se um dia usar `ROLLOUT_VERIFY=ssh`, a 22 precisa voltar a aceitar o
  runner do GitHub, que não tem IP fixo.
- **Nenhuma regra IPv6 de entrada**: a Cloudflare chega à origem por IPv4. Os
  usuários que usam IPv6 falam com a borda da Cloudflare, que fala com a
  origem por IPv4. Não existem registros AAAA na zona.
- **Banco, Redis e IA**: não publicam porta no host (sondadas de fora em
  27/10: 3306, 5432, 6379 e 8080 fechadas). O DROP é uma segunda barreira.

**As portas alternativas da Cloudflare.** A Cloudflare também faz proxy das
portas HTTP alternativas (2052, 2053, 2082, 2083, 2086, 2087, 2095, 2096,
8080, 8443 e 8880), e scanners da internet as sondam pelos nossos hostnames.
É inofensivo: a Cloudflare repassaria esses pedidos à origem na mesma porta, e
o firewall só admite 80 e 443. Nada responde nelas.

**O IP e o nome da VPS são públicos.** Desde 29/10/2026 eles são tratados
como conhecidos: estão no histórico da `trajetto-api`, que esteve público
([seção 1](#o-que-nunca-entra-aqui-o-repositório-pode-ficar-público)), e o
certificado emitido para o nome automático está nos logs públicos de
Certificate Transparency. A proteção da origem é este firewall, não o
sigilo. O histórico não é reescrito (seção 13.6), e pedir um IP novo à
Contabo só vale se o risco justificar: o IP novo também teria de ficar fora de
todo texto versionado. A consequência imediata é priorizar o endurecimento do
SSH e o da conta dona do Dokploy ([seção 14](#14-pendências-conhecidas)).

**O que ainda não foi feito** (defesa em profundidade; o DROP já cobre):
tirar a publicação da porta 3000 do serviço do Dokploy no Swarm e remover o
roteador do Traefik que atende o nome automático da Contabo
([seção 14](#14-pendências-conhecidas)).

**Faixas que mudam**: o workflow semanal `.github/workflows/cloudflare-ranges.yml`
compara `trusted-edge.ts` com a lista publicada pela Cloudflare toda segunda,
às 09:00 UTC (06:00 em São Paulo), e falha se houver diferença ou se a lista
não puder ser lida em 3 tentativas. O GitHub manda e-mail ao dono do
agendamento. O procedimento está na
[seção 13.4](#134-atualizar-as-faixas-da-cloudflare).

### 4.4 Saída preferindo IPv4 (sem desligar o IPv6)

**O problema.** As camadas das imagens do GHCR vêm de
`pkg-containers.githubusercontent.com`, que tem endereço IPv4 e IPv6 (o
`ghcr.io` em si só tem IPv4). A rota IPv6 da VPS até o GitHub derrubava
downloads longos no meio, com `connection reset by peer`: em 26/10 na imagem
da web, em 27/10 na da IA (duas falhas no log do Dokploy, e o run
40551925038 falhou 3/3) e em 28/10 na da API (a camada de 46 MB nas 6
tentativas). O login no GHCR dava certo sempre: era a rede, não a
credencial.

**O que foi feito** (pelo dono, por SSH, em 29/10/2026, por volta das 13:23
UTC):

1. a linha `precedence ::ffff:0:0/96 100` acrescentada ao `/etc/gai.conf`, a
   tabela padrão de preferência de endereços do sistema (RFC 6724). É a linha
   que o próprio arquivo traz comentada "para sites que preferem IPv4";
2. o _drop-in_ `/etc/systemd/system/docker.service.d/prefer-ipv4.conf` com
   `Environment="GODEBUG=netdns=cgo"`. O Docker é escrito em Go, e o resolvedor
   próprio do Go ignora o `gai.conf`; essa variável faz o daemon usar o
   resolvedor do sistema, que lê o arquivo;
3. `systemctl daemon-reload && systemctl restart docker`, que reiniciou todos
   os contêineres por cerca de 1 minuto.

Antes, o `gai.conf` não tinha nenhuma linha ativa e o _drop-in_ não existia.
Conferido logo depois: o `getent`
devolve o endereço IPv4 do GitHub (`185.199.x.x`) primeiro, o
`systemctl show docker -p Environment` mostra o `GODEBUG`, o `dockerd` usa a
libc (então o `GODEBUG` vale) e um `docker pull` de teste só abriu conexões
IPv4. Os 14 testes de fumaça do staging passaram depois do restart. Comandos
de aplicar, conferir e desfazer:
[`deploy.md` → 6.2](./deploy.md#62-downloads-do-ghcr-pelo-ipv4-preferência-do-sistema).

**Por que não desligamos o IPv6.** O plano de 27/10 era desligar o IPv6 por
`sysctl` (`/etc/sysctl.d/99-disable-ipv6.conf`), mas ele nunca foi aplicado.
Preferir IPv4 resolve o problema com o mecanismo padrão do sistema, e só
quando o destino tem os dois endereços. Desligar o IPv6 é mais amplo do que o
problema: destinos que só têm IPv6 deixariam de funcionar e o servidor sairia
do padrão do Ubuntu, sem ganho nenhum na entrada (que já é só IPv4, pela
Cloudflare). Um script próprio de `ip6tables` também chegou a ser escrito e
foi descartado pelo dono por ser gambiarra. Junto disso, o pipeline repete um
deploy que termina em erro (até 6 vezes, com espera crescente).

### 4.5 Outras configurações do host

O [`deploy.md` → 6. Preparar o servidor](./deploy.md#6-preparar-o-servidor-uma-vez)
pede duas configurações manuais no host:

- rotação de log do Docker em `/etc/docker/daemon.json` (`json-file`, 50 MB ×
  5 arquivos por contêiner);
- a configuração estática do Traefik de `infra/traefik/` (redirect da 80 para
  a 443, `readTimeout` de 120 s e TLS mínimo 1.2 entre a Cloudflare e a
  origem).

**A confirmar com o dono:** se as duas foram aplicadas na VPS. Não há registro
de que tenham sido.

### 4.6 Manutenção pendente

Em 29/10/2026 o banner do SSH mostrava 14 atualizações pendentes e
`*** System restart required ***`. O reboot ficou para uma janela calma, porque
derruba todos os contêineres (staging e produção) por alguns instantes. Antes
de reiniciar, rode `CHECKPOINT` nos dois Postgres, o de staging e o de
produção ([`deploy.md` → Postgres e Redis](./deploy.md#10-postgres-e-redis)). Depois,
confira `docker service ls` (todos os serviços com as réplicas de pé) e a
[seção 13.7](#137-conferir-a-borda-depois-de-mexer-na-cloudflare).

---

## 5. Dokploy

### 5.1 O painel

- **Versão**: `dokploy/dokploy:v0.30.10` em 29/10/2026 (aparece em
  `docker service ls`). Instalado em 20/10/2026.
- **Endereço**: `https://dokploy.intrajetto.com`, com proxy da Cloudflare. A
  porta 3000 direta está fechada pelo firewall.
- **Proteção**: só o login do próprio Dokploy, **sem** Cloudflare Access. O
  endurecimento das contas (2FA e credenciais) está pendente
  ([seção 5.10](#510-usuários-e-conta-dona)). No WAF da Cloudflare há uma
  regra que pula as regras gerenciadas em `/api/` deste host, para as
  chamadas do pipeline ([seção 6.5](#65-security-ddos-waf-e-bots)).
- **Recomendado, pendente** ([seção 14](#14-pendências-conhecidas)): pôr o
  painel atrás do Cloudflare Access. O pipeline continua passando com uma
  aplicação de _Bypass_ restrita às quatro rotas que ele chama
  (`/api/application.deploy`, `/api/deployment.all`, `/api/application.one`
  e `/api/docker.getServiceContainersByAppName`; as duas últimas são da etapa
  de release) ou com um _Service Token_ (este exige mandar os cabeçalhos
  `CF-Access-Client-Id` e `CF-Access-Client-Secret` nos dois scripts,
  `.github/scripts/dokploy-deploy.mjs` e `.github/scripts/dokploy-release.mjs`).
- **Domínio do painel**: nas versões recentes do Dokploy ele fica em
  _Settings → Web Server_, no cartão do domínio do servidor.
  **A confirmar com o dono:** que foi essa a tela usada na v0.30.10.

### 5.2 Environments, projetos e serviços

Dois environments, `staging` e `production`, cada um com dois projetos:

| Projeto        | Serviço                | Tipo no Dokploy       | Imagem                                                                   | Domínio (porta)                                            | Recursos                                                               |
| -------------- | ---------------------- | --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `trajetto-api` | `trajetto-postgres`    | Database → PostgreSQL | `postgres:16-alpine`, fixada por digest; banco e usuário `trajetto`      | nenhum; _External Port_ vazio                              | sem teto, de propósito                                                 |
| `trajetto-api` | `trajetto-redis`       | Database → Redis      | `redis:7-alpine`, sem persistência, `--requirepass`                      | nenhum; _External Port_ vazio                              | 512 MiB                                                                |
| `trajetto-api` | `trajetto-ai`          | Application (Docker)  | `ghcr.io/trajetto-organization/trajetto-ai:staging` / `:stable`          | nenhum                                                     | 1 GiB e 2 CPUs; 1 réplica                                              |
| `trajetto-api` | `trajetto-api`         | Application (Docker)  | `ghcr.io/trajetto-organization/trajetto-api:staging` / `:stable`         | `api-staging.intrajetto.com` / `api.intrajetto.com` (3333) | 1 GiB por réplica; 1 réplica em staging; produção na seção 2.3         |
| `trajetto-api` | `trajetto-api-migrate` | Application (Docker)  | `ghcr.io/trajetto-organization/trajetto-api-migrate:staging` / `:stable` | nenhum                                                     | 1 réplica, _Restart Policy_ `none`; parado depois da etapa (alguns MB) |
| `trajetto-ui`  | `trajetto-ui`          | Application (Docker)  | `ghcr.io/trajetto-organization/trajetto-ui:staging` / `:stable`          | `staging.intrajetto.com` / `www.intrajetto.com` (3000)     | 768 MiB; 1 réplica                                                     |

A `trajetto-api-migrate` roda as migrations e os seeds antes de cada deploy
que os muda: o pipeline pede o deploy dela pela API do Dokploy e espera o
Swarm dizer que a etapa terminou (`Running`, pelo `HEALTHCHECK` da imagem) ou
falhou (`Failed`); depois o contêiner fica parado até o próximo deploy. O
pipeline só a roda quando o digest da imagem difere da tag
`trajetto-api-migrate:staging-applied` (`:stable-applied` na produção) do
GHCR, que ele move só depois do sucesso; um Database trocado precisa dela de
novo, à mão ([seção 13.1](#131-recriar-tudo-do-zero), passo 9). Antes do
deploy, se o Dokploy responde vazia a lista de tarefas do serviço (lida até
3 vezes), o vazio só é aceito quando o histórico de deployments prova que
nunca houve um deploy com sucesso (nenhum `done` e menos de 10 registros: o
Dokploy guarda só os 10 mais recentes); nos outros casos o passo falha antes
de implantar qualquer coisa. O
_Environment_ dela tem só a URL do banco sem
tetos de runtime; o das duas `trajetto-api` mantém
`RUN_MIGRATIONS_ON_BOOT=false` enquanto um build anterior a 31/10/2026
puder voltar por rollback (seção 5.6). Configuração e porquês:
[`deploy.md` → 15](./deploy.md#15-migrations). **A criar pelo
dono** (staging e produção): até lá, o deploy de cada ambiente falha logo no
começo, com "configuração parcial" (falta `DOKPLOY_MIGRATE_APPLICATION_ID`),
sem mexer em nada.

O próprio Dokploy roda como os serviços `dokploy` e `dokploy-postgres` (o
banco interno dele, que guarda a configuração e o _Environment_ de todas as
Applications), mais o contêiner `dokploy-traefik`.

O _Autodeploy_ das Applications fica **desligado**: quem decide o deploy é o
pipeline. Passo a passo de cada serviço:
[`deploy.md` → Montar o Dokploy do zero](./deploy.md#7-montar-o-dokploy-do-zero-staging-e-produção)
e, para a web,
[`trajetto-ui/docs/deploy.md` → 6](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/deploy.md#6-criar-a-application-trajetto-ui-de-staging).

**A confirmar com o dono:** o Redis de staging foi criado sem o comando
personalizado (`--requirepass` com `--save ""`, `--appendonly no`,
`--maxmemory 256mb` e `--maxmemory-policy allkeys-lru`) e sem limite de
memória (observado em 27/10). O de produção foi instruído com os dois.
Decidir se o de staging é corrigido.

### 5.3 Por que Application e nunca Compose

Decisão do dono de 22/10/2026: **todo serviço é um recurso próprio do
Dokploy** (Application com provider Docker puxando a imagem pronta do GHCR, e
Databases PostgreSQL e Redis), **nunca** Compose nem template. O
`compose.production.yaml` foi apagado. Os motivos:

- **O pipeline sabe se o deploy deu certo.** Ele pede o deploy de cada
  Application pela API do Dokploy e acompanha aquele deployment até o fim. Um
  webhook de redeploy responde assim que enfileira e nunca diz se deu certo.
- **Um serviço por vez, na ordem certa.** A IA vai antes da API e só quando o
  digest dela muda. Um deploy da IA que falha para o job antes de tocar na API.
- **Tudo visível e editável no painel**: imagem, variáveis, domínio, réplicas,
  limites e healthcheck ficam nas abas de cada recurso.
- **O backup nativo do Database** (aba _Backups_) só existe num Database do
  Dokploy.

O que se perdeu na troca (health check no balanceador, rede interna isolada,
`read_only` na IA, _placement_) está em
[`deploy.md` → 5](./deploy.md#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora).

### 5.4 Nomes com sufixo aleatório

Cada serviço tem um _Name_ (o rótulo no painel) e um _App Name_ (o nome do
serviço no Swarm e o nome de rede pelo qual os outros o encontram). Na
montagem, o Dokploy gerou os App Names com um sufixo aleatório, e o App Name
não pode ser editado depois de criado. Por isso:

- os nomes reais são únicos no servidor inteiro, e staging e produção nunca
  colidem na `dokploy-network`;
- os nomes `trajetto-*-staging` e `trajetto-*-production` que aparecem no
  `deploy.md` são marcadores: troque pelo App Name que o painel mostra;
- o App Name aparece no topo da página do serviço (nos Databases, em
  _General → Internal Host_). No host, `docker service ls` lista todos;
- o App Name da web de produção ficou no formato `trajetto-trajettoui-<sufixo>`,
  fora do padrão dos outros. Não tem efeito nenhum.

Os App Names entram em `DATABASE_URL` (da API e da `trajetto-api-migrate`),
`REDIS_URL` e `AI_LOCAL_URL` (seção 5.6). Recriar um serviço gera outro sufixo, e essas
variáveis precisam ser atualizadas. Um Database PostgreSQL recriado também
precisa da etapa de release de novo, antes da API
([seção 13.1](#131-recriar-tudo-do-zero), passo 9).

### 5.5 Domínios e certificados (Let's Encrypt)

Cada Application com endereço público tem o domínio na aba _Domains_:
_Host_, _Path_ `/`, _Container Port_ (3333 na API, 3000 na web), _HTTPS_
ligado e _Certificate Provider_ `Let's Encrypt`. O Dokploy grava o roteador em
`/etc/dokploy/traefik/dynamic/<App Name>.yml`: o roteador `web` (redireciona
para HTTPS), o `websecure` com `certResolver: letsencrypt` e o
`passHostHeader`. Ajuste manual nesse arquivo é sobrescrito quando a aba
_Domains_ muda.

**Como os certificados foram emitidos até aqui**:

- **Staging** (22/10/2026, antes do firewall): o registro nasceu sem proxy
  (nuvem cinza), o Let's Encrypt validou direto na origem, e depois o registro
  passou para com proxy (nuvem laranja). **Não repita esse caminho**: o
  firewall de hoje o derruba, e um registro sem proxy publica o IP da origem
  no DNS público, onde serviços de DNS passivo o guardam para sempre.
- **Produção** (29/10/2026, com o firewall só da Cloudflare ativo desde as
  03:00 UTC): os certificados de `www` e `api` saíram à tarde, com o registro
  já com proxy. O desafio HTTP-01 chegou pela Cloudflare na porta 80, o único
  caminho que o firewall deixa (o 526 do `www` antes de o certificado existir
  mostra que o registro já estava com proxy). **A confirmar com o dono:**
  conferir no host que foi assim
  (`docker logs dokploy-traefik 2>&1 | grep -iE 'acme|www.intrajetto|api.intrajetto'`).

**Como emitir o próximo** (um host novo):

1. Na Cloudflare, o registro A nasce **já com proxy** (laranja). **Nunca crie
   um registro sem proxy apontando para a VPS.**
2. No Dokploy, o domínio na aba _Domains_ e **Deploy**.
3. Confira a emissão no log do Traefik
   (`docker logs dokploy-traefik 2>&1 | grep -i acme`) e rode o teste do
   desafio, abaixo, também para o host novo.

Se o certificado não sair (a Cloudflare responde 526): crie uma
_Configuration Rule_ (_Rules → Configuration Rules_) só para o hostname novo,
com _SSL_ = _Full_, espere o certificado aparecer no log do Traefik e **apague
a regra** logo depois. Nunca mude a zona inteira para _Full_ (sem strict):
isso enfraquece a produção toda. Se o HTTP-01 pela Cloudflare deixar de
funcionar, há duas outras saídas, nenhuma testada aqui: um certificado do
_Cloudflare Origin CA_ instalado no Traefik (vale até 15 anos e é aceito pelo
_Full (strict)_), ou o desafio DNS-01 com um token da Cloudflare restrito a
_Zone · DNS · Edit_ só na zona `intrajetto.com`. Detalhe em
[`deploy.md` → 7.8](./deploy.md#78-o-traefik-da-api-o-que-os-labels-faziam).

**Teste do desafio HTTP-01** (rode depois de toda mudança na Cloudflare e,
de todo modo, antes de 20/12/2026):

```sh
for h in www.intrajetto.com api.intrajetto.com staging.intrajetto.com api-staging.intrajetto.com dokploy.intrajetto.com; do
  echo "== $h"; curl -sI -m 15 "http://$h/.well-known/acme-challenge/teste" | grep -iE '^(HTTP|location)'
done
```

O esperado é `404` em todos, **sem** linha `location` (nem o redirect para
`https://`, nem o 302 do Access no staging): o pedido chegou ao Traefik pela
porta 80. Conferido em 29/10/2026, por volta das 23:50 UTC: os cinco
responderam 404 sem redirect, enquanto um caminho comum em `http://` responde
301 para `https://`. Se o caminho do desafio passar a responder 301, a
renovação vai falhar em silêncio: corrija antes de 20/12/2026.

**Renovação**: automática pelo Traefik, cerca de 30 dias antes de vencer, pelo
desafio HTTP-01 na porta 80, que chega pela Cloudflare. No staging, o
Cloudflare Access tem um bypass para `/.well-known/acme-challenge/*`, senão o
desafio cairia na tela de login do Access ([seção 6.4](#64-zero-trust-access-staging)).
Os certificados de staging vencem entre 19 e 22/01/2027. Os de produção foram
emitidos em 29/10/2026 e, pelo prazo de 90 dias do Let's Encrypt, vencem por
volta de 27/01/2027. A renovação pela Cloudflare ainda não rodou nenhuma vez
no staging (lá os certificados saíram pela nuvem cinza), e a primeira começa
por volta de 20/12/2026. Confira em 22/12/2026 (staging) e em 30/12/2026
(produção) com o comando de validade da
[seção 13.7](#137-conferir-a-borda-depois-de-mexer-na-cloudflare) (itens da
seção 14). Uma falha não avisa ninguém: vira 526 por volta de 19/01/2027 no
staging e de 27/01/2027 na produção.

**O apex nunca é domínio de Application.** A web de produção chegou a ser
cadastrada com `intrajetto.com`. O `www` ficou sem certificado na origem, a
Cloudflare respondeu 526, a conferência do pipeline falhou e, de todo modo, o
CORS da API só aceita o `www`. O domínio da Application passou a ser
`www.intrajetto.com`, e o apex é redirecionado pela Cloudflare
([seção 6.3](#63-rules)).

### 5.6 Variáveis por Application

Só os nomes e de onde vem cada valor. O formato, o porquê e o valor por
ambiente de cada uma estão em [`variaveis-de-ambiente.md`](./variaveis-de-ambiente.md)
(API e IA),
[`trajetto-ui/docs/variaveis-de-ambiente.md`](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/variaveis-de-ambiente.md)
(web) e
[`trajetto-mobile/docs/variaveis-de-ambiente.md`](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/variaveis-de-ambiente.md)
(app, que não passa pelo Dokploy).

**Application `trajetto-api`**:

| Variável(is)                                                                                                                         | De onde vem o valor                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                                                                                                            | `staging` ou `production`                                                                                                                                                                                                                            |
| `NODE_OPTIONS`, `LOG_LEVEL`                                                                                                          | fixos: `--max-old-space-size=768` e `info`                                                                                                                                                                                                           |
| `DATABASE_URL`                                                                                                                       | senha do Database PostgreSQL + o App Name dele, porta 5432, banco e usuário `trajetto` (modelo em `deploy.md` 7.7)                                                                                                                                   |
| `RUN_MIGRATIONS_ON_BOOT`                                                                                                             | `false`, enquanto um build anterior a 31/10/2026 (`main-<sha>`, ou `sha-<7>` de antes da separação) puder ser alvo de rollback: esses builds a leem com padrão `true` e voltariam a migrar no boot. As imagens novas a ignoram, então basta **Save** |
| `MIGRATION_DATABASE_URL`                                                                                                             | nenhum build a lê com `RUN_MIGRATIONS_ON_BOOT=false` (as imagens novas nunca; as anteriores, só ao migrar no boot), e a URL sem tetos foi para a `trajetto-api-migrate`; pode sair                                                                   |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`                                                                                                     | `false`, sempre: quem prepara um banco vazio é a `trajetto-api-migrate`                                                                                                                                                                              |
| `REDIS_URL`                                                                                                                          | senha do Database Redis + o App Name dele, porta 6379                                                                                                                                                                                                |
| `HTTP_REQUEST`                                                                                                                       | a origem pública da **web** do ambiente; é a única origem que o CORS da API aceita                                                                                                                                                                   |
| `API_HTTP_REQUEST`                                                                                                                   | a origem pública da **própria API** (logo dos e-mails, servidor da documentação)                                                                                                                                                                     |
| `JWT_SECRET`, `JWT_SECRET_REFRESH_TOKEN`                                                                                             | gerados por nós ([seção 11.3](#113-segredos-gerados-por-nós))                                                                                                                                                                                        |
| `MASTER_USER_EMAIL`, `MASTER_USER_INITIAL_PASSWORD`                                                                                  | e-mail da equipe; senha gerada                                                                                                                                                                                                                       |
| `RATE_LIMIT_TRUSTED_PROXY`                                                                                                           | `cloudflare`                                                                                                                                                                                                                                         |
| `RATE_LIMIT_FORWARDER_SECRET`                                                                                                        | gerado; **o mesmo valor** da web do mesmo ambiente                                                                                                                                                                                                   |
| `TURNSTILE_SECRET_KEY`                                                                                                               | o widget do ambiente (seção 6.9); **o mesmo valor** da web                                                                                                                                                                                           |
| `UPLOAD_STORAGE_TYPE`, `UPLOAD_ORPHAN_GC`                                                                                            | `r2` e `dry-run`                                                                                                                                                                                                                                     |
| `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                                        | Cloudflare → R2: o id da conta (o mesmo nos dois ambientes), o bucket do ambiente e o token só desse bucket                                                                                                                                          |
| `AI_PROVIDER`, `AI_LOCAL_URL`, `AI_LOCAL_TOKEN`                                                                                      | `local`; `http://<App Name da IA>:8080`; **o mesmo valor** do `AI_TOKEN` da IA                                                                                                                                                                       |
| `RESEND_SECRET_KEY`, `RESEND_FROM_EMAIL`, `RESEND_WEBHOOK_SECRET`                                                                    | Resend: chave de API, remetente do domínio verificado, segredo do webhook ([seção 9](#9-e-mail-resend))                                                                                                                                              |
| `HEALTHCHECK_PING_URL`                                                                                                               | healthchecks.io, o check do ambiente (seção 10.1)                                                                                                                                                                                                    |
| `PROOF_MAP_TILE_URL`, `PROOF_MAP_TILE_ATTRIBUTION`                                                                                   | MapTiler (a URL leva a chave; a mesma chave da web)                                                                                                                                                                                                  |
| `REVERSE_GEOCODER_URL`, `REVERSE_GEOCODER_KEY`, `REVERSE_GEOCODER_KEY_PARAM`                                                         | LocationIQ                                                                                                                                                                                                                                           |
| `PROOF_SIGNING_PFX_BASE64`, `PROOF_SIGNING_PFX_PASSWORD`, `PROOF_SIGNER_LOCATION`, `PROOF_SIGNER_CONTACT`, `PROOF_ISSUER_LEGAL_NAME` | certificado A1 do comprovante: de teste no staging; `PROOF_SIGNING_*` vazias em produção até existir o e-CNPJ                                                                                                                                        |
| `DOCS_USER`, `DOCS_PASSWORD`                                                                                                         | gerados; os mesmos ficam no environment `production` da web, para o gate de rotas                                                                                                                                                                    |
| `WEBHOOK_SECRETS_KEY`                                                                                                                | gerado (32 bytes); perder é irrecuperável                                                                                                                                                                                                            |
| `META_WHATSAPP_*`                                                                                                                    | não configuradas em nenhum ambiente (a Meta bloqueou a conta)                                                                                                                                                                                        |

**Application `trajetto-ai`**: `AI_TOKEN` (gerado; igual ao `AI_LOCAL_TOKEN`
da API), `OCR_THREADS=2` (igual ao limite de CPU) e `AI_MAX_QUEUE=2`.

**Application `trajetto-ui`**: `APP_ENV`, `METADATA_BASE` (a origem da própria
web), `HTTP_REQUEST` e `PUBLIC_API_URL` (a URL pública da API do ambiente),
`TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY` (o widget do ambiente),
`RATE_LIMIT_FORWARDER_SECRET` (igual ao da API), `MAP_TILE_URL`,
`MAP_TILE_ATTRIBUTION` e `MAP_TILE_URL_DARK` (MapTiler),
`CSP_STORAGE_ORIGINS` (a origem do bucket do ambiente,
`https://<bucket>.<ACCOUNT_ID>.r2.cloudflarestorage.com`) e
`NODE_OPTIONS=--max-old-space-size=512`. `BACKGROUND_TRACKING` não está
definida.

**Convenções**:

- Banco, Redis e IA pelo **nome interno** (App Name). As URLs que saem da
  máquina ou que o navegador usa são **públicas**.
- Na produção, o `HTTP_REQUEST` da API e o `METADATA_BASE` da web são
  `https://www.intrajetto.com` (nunca o apex: o CORS só aceita o `www`).
- `PORT` e `NODE_ENV` nunca se definem: as imagens já trazem.
- Uma variável por linha, `NOME=valor`, sem aspas e sem espaços em volta do
  `=`.
- **Onde editar**: Dokploy → o projeto (`trajetto-api` ou `trajetto-ui`) do
  environment → o serviço → aba _Environment_ → editar → **Save** →
  **Deploy**.
- **Save não reinicia nada**: a mudança vale no próximo **Deploy**.
- Segredos nunca são iguais entre staging e produção.

**A confirmar com o dono:**

- que `ALLOW_EMPTY_DATABASE_BOOTSTRAP=false` está salvo na API de staging
  **e** na de produção (a de produção subiu a primeira vez com `true`, e a de
  staging ainda estava com `true` em 29/10);
- que `RUN_MIGRATIONS_ON_BOOT=false` está salvo nas duas APIs (ausente, um
  rollback para um build anterior a 31/10/2026 volta a migrar no boot);
- o valor salvo no `HTTP_REQUEST` da **web** nos dois ambientes. A decisão
  vigente é a URL pública da API, mas as notas locais do dono têm um endereço
  interno em `http`;
- que `NODE_ENV` não está no _Environment_ de nenhuma Application (as notas
  locais de staging têm `NODE_ENV=staging`, que o schema da API não aceita).

**Application `trajetto-api-migrate`** (a criar; [`deploy.md` → 15](./deploy.md#15-migrations)):

| Variável(is)                                                                          | De onde vem o valor                                                                                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                        | a URL do banco **sem** `statement_timeout` nem `lock_timeout` (`connection_limit=2&connect_timeout=10`; modelo no `.env.example`) |
| `ALLOW_EMPTY_DATABASE_BOOTSTRAP`, `MASTER_USER_EMAIL`, `MASTER_USER_INITIAL_PASSWORD` | só no primeiro deploy de uma instalação nova (banco vazio); apagar depois                                                         |

**O incidente do primeiro boot de produção** (29/10/2026): a `DATABASE_URL` e
a `MIGRATION_DATABASE_URL` de produção foram salvas com o host escrito como
`:5432:5432`, e a API ficou parada em "Waiting for Postgres". O dono corrigiu
as duas e a API subiu. Ao copiar URLs, confira a porta.

### 5.7 Credencial do GHCR

As imagens em `ghcr.io/trajetto-organization/` são privadas. A conexão do
Dokploy com o GitHub (a GitHub App de _Settings → Git_) só clona código: não
dá acesso ao registry. Para puxar as imagens existe um **token classic do
GitHub só com o escopo `read:packages`** (o GHCR não aceita token
fine-grained de forma confiável). O log de cada deploy mostra
`Login Succeeded`.

- Criado em: GitHub → foto de perfil → _Settings → Developer settings →
  Personal access tokens → Tokens (classic)_.
- Usado por: as Applications `trajetto-api`, `trajetto-api-migrate`,
  `trajetto-ai` e `trajetto-ui` dos dois ambientes (o mesmo token).
- Vencido: todo deploy falha no pull, com `unauthorized` ou `denied`.

**A confirmar com o dono:**

- o nome real do token (o `deploy.md` da API sugere `dokploy-ghcr-pull` e o
  da web, `dokploy-ghcr-read`), a conta dona e a data de validade;
- onde ele está cadastrado: nos campos do provider Docker de cada Application
  ([`deploy.md` → 7.3](./deploy.md#73-credencial-do-ghcr)) ou no registry
  global de _Settings → Registry_
  ([`trajetto-ui/docs/deploy.md` → 5.1](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/deploy.md#51-credencial-do-ghcr)).

### 5.8 Chave de API do Dokploy (usada pelo CI)

- **Criada em**: Dokploy → _Settings → Profile → API/CLI → Generate_. Aparece
  uma única vez.
- **Sugestão usada na criação** (26/10/2026): nome `github-trajetto-api-staging`,
  validade de 1 ano e _Rate Limiting_ desligado (o pipeline consulta a cada
  10 s por até 15 min em cada deploy e, na etapa de release, a cada 5 s por
  até 30 min). O prefixo da chave faz parte do valor e não entra
  aqui.
  **A confirmar com o dono:** o nome e a data de validade reais.
- **Poder**: controle total do painel inteiro, staging **e** produção. Trate
  como senha de root.
- **Onde fica**: secret `DOKPLOY_API_KEY` nos environments `staging` e
  `production` da `trajetto-api` e da `trajetto-ui`. É o mesmo valor nos
  quatro.
- **Separar por ambiente** (recomendado, pendente;
  [seção 14](#14-pendências-conhecidas)): uma chave herda os poderes do
  usuário que a gera. Uma segunda chave gerada pelo mesmo usuário admin
  também controla o painel inteiro e não isola nada. O isolamento exige gerar
  a chave de staging com um **membro** do Dokploy restrito aos projetos e
  serviços de staging (conferir na v0.30.10 as permissões de membro e se ele
  pode gerar chave de API) e deixar a chave do admin só nos environments
  `production`. Isso também limita o que um dev com Write no GitHub alcança
  ([seção 3.2](#32-dar-acesso-a-um-dev-novo-o-mínimo)).

Os ids das Applications (o último pedaço da URL no painel,
`.../services/application/<id>`) viram os secrets `DOKPLOY_API_APPLICATION_ID`,
`DOKPLOY_AI_APPLICATION_ID` e `DOKPLOY_UI_APPLICATION_ID`, um por environment.
Não são segredos fortes, mas ficam como secret.

### 5.9 Backups do banco

O único backup do banco é a aba _Backups_ de cada Database PostgreSQL
(decisão de 26/10/2026; o antigo serviço `trajetto-backup` saiu do código).
Os destinos ficam em Dokploy → _Settings → S3 Destinations_, cada um com um
token R2 que só existe ali. O estado de cada ambiente está na
[seção 10.2](#102-backups), e o passo a passo de configurar e restaurar em
[`deploy.md` → Backup e restauração](./deploy.md#18-backup-e-restauração).

O alerta de falha é um canal em Dokploy → _Settings → Notifications_ com o
evento de backup de Database marcado. **A confirmar com o dono:** se o canal
existe e qual provedor usa.

A aba _Monitoring_ de cada serviço mostra CPU e memória, mas não alerta
ninguém.

### 5.10 Usuários e conta dona

| Usuário                              | Criado                       | Situação em 29/10/2026                               |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------- |
| conta dona (_owner_)                 | na instalação, em 20/10/2026 | endurecimento pendente: 2FA e credenciais (seção 14) |
| conta admin, a conta pessoal do dono | 26/10/2026                   | 2FA pendente                                         |

O plano: credenciais próprias e fortes para a conta dona (ou transferir a
propriedade para a conta pessoal), 2FA nas duas, e só apagar a conta dona
depois de confirmar que a admin tem todos os poderes. O Dokploy guarda todos
os segredos de produção, e o painel não tem Access
([seção 5.1](#51-o-painel)): faça isso antes de qualquer nova janela pública
dos repositórios ([seção 13.6](#136-abrir-e-fechar-um-repositório-para-usar-o-actions-grátis)).

Em 26/10 um _Settings → Server → Reload_ foi clicado por engano. Ele só
reiniciou o painel e a configuração do Traefik; as aplicações não caíram.

### 5.11 Lacunas conhecidas

Sem health check no balanceador do Traefik, rede `dokploy-network` compartilhada
por tudo, IA sem `read_only`, Databases sem _placement_ e o _Stop Grace Period_
que depende da versão. Detalhe e contornos em
[`deploy.md` → 5](./deploy.md#5-applications-em-vez-de-compose-o-que-mudou-e-o-que-ficou-de-fora).
**A confirmar com o dono:** se o campo _Stop Grace Period_ existe no Dokploy
v0.30.10 instalado (sem ele, o desligamento ordenado da API, de até 35 s, é
cortado em 10 s).

---

## 6. Cloudflare

Uma zona, `intrajetto.com`, no **plano Free**. Algumas coisas são da zona
(DNS, SSL/TLS, Rules, Security, Speed, Caching) e outras são da conta, fora
da zona (Turnstile, R2, Zero Trust, tokens de API, Web Analytics). O Zone ID e
o Account ID ficam na página _Overview_ da zona, na coluna da direita, em
_API_. Não escreva aqui.

### 6.1 DNS

**Onde**: zona `intrajetto.com` → _DNS → Records_.

| Nome                    | Tipo                       | Proxy                                                             | Para quê                                                                                  |
| ----------------------- | -------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `intrajetto.com` (apex) | A, para o IPv4 da VPS      | sim (laranja)                                                     | só o redirect para o `www`; precisa de proxy para a regra rodar                           |
| `www`                   | A, para o IPv4 da VPS      | sim                                                               | web de produção                                                                           |
| `staging`               | A, para o IPv4 da VPS      | sim                                                               | web de staging (com Access)                                                               |
| `api`                   | A, para o IPv4 da VPS      | sim                                                               | API de produção                                                                           |
| `api-staging`           | A, para o IPv4 da VPS      | sim                                                               | API de staging                                                                            |
| `dokploy`               | A, para o IPv4 da VPS      | sim                                                               | painel do Dokploy                                                                         |
| `uptime`, `monitor`     | **A confirmar com o dono** | sim (respondem com `server: cloudflare`, conferido em 30/10/2026) | Uptime Kuma (`uptime`) e Beszel (`monitor`); destino na origem **a confirmar com o dono** |
| `mail` e subnomes       | os que o Resend pediu      | não (registros de e-mail)                                         | verificação do domínio de envio ([seção 9](#9-e-mail-resend))                             |

Não há registros AAAA (confirmado pelo dono em 27/10/2026): a origem não
recebe IPv6. `uptime` e `monitor` aparecem na lista de origens do Tiered Cache
e, em 30/10/2026, responderam com `server: cloudflare`: têm proxy.

**A confirmar com o dono:** a lista completa de registros (tipo, proxy e para
que serve cada um), inclusive os do Resend em `mail.intrajetto.com` (SPF,
DKIM, MX de retorno), um eventual DMARC no apex e o MX que recebe o e-mail do
endereço de contato do site. Basta um _Export_ do DNS ou um print, sem IPs no
que vier para cá.

**Regras para um registro novo**: um nível de subdomínio só; o host novo
**precisa** ter HTTPS (o HSTS da zona vale para todo subdomínio, seção 6.2);
nada de AAAA enquanto a origem não aceitar IPv6.

### 6.2 SSL/TLS e HSTS

| Onde                                                           | Configuração                                                                                                     |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| _SSL/TLS → Overview_                                           | modo **Full (strict)**: a Cloudflare exige certificado válido na origem (o do Let's Encrypt)                     |
| _SSL/TLS → Edge Certificates_                                  | certificado universal gratuito (apex e `*.intrajetto.com`); _Minimum TLS Version_ 1.2; _Always Use HTTPS_ ligado |
| _SSL/TLS → Edge Certificates → HTTP Strict Transport Security_ | ligado: _Max Age_ 12 meses, _includeSubDomains_ ligado, _Preload_ ligado, _No-Sniff_ ligado (desde 29/10/2026)   |
| _Speed_ / _Network_                                            | HTTP/3 e compressão zstd já vinham ligados                                                                       |

**A confirmar com o dono:** o modo _Full (strict)_, o TLS mínimo 1.2 e o
_Always Use HTTPS_ foram instruídos na montagem e há prova indireta do
primeiro (só o _Full (strict)_ dá o erro 526 que apareceu no `www` antes do
certificado existir), mas ninguém conferiu as três telas.

**Sobre o HSTS**:

- 12 meses é o máximo que o painel oferece (2 anos não existe ali). O
  `trajetto-ui/docs/deploy.md` ainda fala em 2 anos e está desatualizado.
- _Preload_ marcado só põe a palavra `preload` no cabeçalho. **Não** inscreve
  o domínio em <https://hstspreload.org>; isso é um passo manual, que não foi
  feito e é difícil de desfazer.
- Com _includeSubDomains_, todo subdomínio de `intrajetto.com` passa a exigir
  HTTPS nos navegadores que já viram o cabeçalho, por 12 meses. Desligar o
  HSTS no painel não desfaz isso nesses navegadores.
- A web também manda `Strict-Transport-Security` com 2 anos pelo
  `next.config.mjs`. **A confirmar com o dono:** qual valor chega ao navegador
  em `www`, no apex e em `api`
  (`curl -sI https://www.intrajetto.com | grep -i strict-transport`).

### 6.3 Rules

**Redirect Rule do apex** (desde 29/10/2026). Onde: _Rules → Redirect Rules →
Create rule_ (_Single Redirect_):

- _When_: _Hostname equals_ `intrajetto.com`;
- _Then_: _Dynamic_, expressão
  `concat("https://www.intrajetto.com", http.request.uri.path)`, status
  **301**, _Preserve query string_ ligado.

Conferido em 29/10: o apex responde 301 para o `www`, com caminho e query,
por HTTP e por HTTPS. O passo a passo original está em
[`trajetto-ui/docs/deploy.md` → 8](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/deploy.md#8-domínio-sem-www-hsts-e-cloudflare).
O mesmo documento descreve um redirect alternativo por arquivo do Traefik:
os dois não podem estar ligados juntos, e o ativo é o da Cloudflare.
**A confirmar com o dono:** que o arquivo
`/etc/dokploy/traefik/dynamic/trajetto-ui-production-apex.yml` não existe no
host.

**Configuration Rules**: nenhuma em uso. Duas ficam como receita:
`Sem ofuscacao de e-mail` (todas as requisições, _Email Obfuscation_ Off), se
a ofuscação voltar a ligar sozinha (seção 6.5), e o _I'm Under Attack_ só no
host do site, numa emergência (nunca na API).

**Transform Rules**: nenhuma. A regra opcional que acrescenta o cabeçalho
`x-trajetto-edge-secret` (para o `RATE_LIMIT_EDGE_SECRET` da API) não está
configurada. Como ligar:
[`deploy.md` → Domínios, TLS e a borda](./deploy.md#11-domínios-tls-e-a-borda).

### 6.4 Zero Trust Access (staging)

O Zero Trust foi ativado no plano Free (até 50 usuários). Ele protege a web
de staging: só a equipe a abre.

**Aplicação A, `Staging web`** (criada em 22/10/2026). Onde: Zero Trust →
_Access → Applications_.

| Campo           | Valor                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| Tipo            | _Self-hosted and private_ → _Public DNS_                                                    |
| Destino         | subdomínio `staging`, domínio `intrajetto.com`, caminho vazio (o site inteiro)              |
| Política        | `Equipe Trajetto`: _Allow_, _Include → Emails_ = os e-mails da equipe (não escreva aqui)    |
| Método de login | _One-time PIN_ (código por e-mail), em _Settings → Authentication → Login methods_          |
| Opções          | _Accept all IdPs_ e _Apply instant authentication_ ligados; Cloudflare One Client desligado |
| Sessão          | 24 h; cookie _HTTP Only_ ligado; CORS sem mudança                                           |

**Aplicação B, `Staging web - automação`** (22/10/2026):

| Campo    | Valor                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------- |
| Destinos | `staging.intrajetto.com/build-id.json` e `staging.intrajetto.com/.well-known/acme-challenge/*` |
| Política | `Automação`: _Bypass_, _Include → Everyone_                                                    |

Os dois bypasses são intencionais:

- **`/build-id.json`**: o pipeline da web confere o commit que está no ar
  lendo esse arquivo, a partir dos runners do GitHub, que não fazem login e
  mudam de IP. O arquivo só contém o commit.
- **`/.well-known/acme-challenge/*`**: o desafio HTTP-01 do Let's Encrypt
  precisa chegar ao Traefik para renovar o certificado.

O caminho mais específico vence: o resto do site continua pedindo login.
Conferido em 22/10: a raiz pede login e o `/build-id.json` abre.

A Cloudflare mostra a recomendação _Overprovisioned Access Policies — Exposed
infrastructure · staging.intrajetto.com/build-id.json_ (de 25/10). Ela deve ser
dispensada com _Dismiss_ (risco aceito: o arquivo só tem o commit). Não clique
em _Get started_. **A confirmar com o dono:** se já foi dispensada.

**O que fica sem Access, de propósito**:

- **`api-staging.intrajetto.com`**: o navegador (Socket.IO e uploads), o APK
  de staging, os ERPs e os webhooks a chamam sem passar por login do Access. As
  rotas privadas já exigem login na própria API.
- **`dokploy.intrajetto.com`**: hoje protegido só pelo login do Dokploy
  (seção 5.1).

**No dia a dia**: para dar acesso a alguém, edite a política `Equipe Trajetto`
e acrescente o e-mail. Para uma automação (um script ou um serviço externo),
use um _Service Token_ (Zero Trust → _Access → Service Auth_) e uma política
_Service Auth_ na aplicação, nunca um _Bypass_ para _Everyone_. Trocar a
política da `Staging web` por _Bypass_ para _Everyone_ tira o Access do site
inteiro e reabre o `/login` do staging a qualquer um: se for mesmo
necessário, prefira uma aplicação de _Bypass_ com caminho específico, ou
sessão curta, registre a janela na [seção 12](#12-histórico-de-mudanças),
reverta no mesmo dia e nunca faça isso com dados reais no staging. Nunca mexa
na aplicação de automação. Os logs ficam em Zero Trust → _Logs → Access_.

### 6.5 Security: DDoS, WAF e bots

**DDoS**: o _HTTP DDoS attack protection_ (ruleset gerenciado) fica sempre
ativo, em todos os planos, sem configuração.

**WAF**:

- O _Cloudflare managed ruleset_ está ligado.
- Regra custom `Dokploy - chamadas da pipeline` (26/10/2026). Onde: dentro da
  zona, _Security → Security rules_ (antes, _WAF → Custom rules_); a tela de
  WAF da conta é só do plano Enterprise. Expressão: _Hostname equals_ o host do
  Dokploy **e** _URI Path starts with_ `/api/`. Ação: _Skip → All managed
  rules_ (e _Security Level_ e _Browser Integrity Check_, quando a tela
  oferece). Status ativo, _Log matching requests_ ligado. Por quê: as chamadas
  do pipeline à API do Dokploy vêm de IPs de datacenter do GitHub e eram
  desafiadas.
- **Restringir essa regra** (recomendado, pendente;
  [seção 14](#14-pendências-conhecidas)): `/api/` cobre também o login e o
  tRPC do próprio painel, que hoje ficam sem as regras gerenciadas do WAF. O
  pipeline só chama `/api/application.deploy`, `/api/deployment.all`,
  `/api/application.one` e `/api/docker.getServiceContainersByAppName`,
  sempre com o cabeçalho `x-api-key` (`.github/scripts/dokploy-deploy.mjs` e,
  na etapa de release, `.github/scripts/dokploy-release.mjs`). Na regra,
  _Edit expression_, troque a expressão por:

  ```
  (http.host eq "dokploy.intrajetto.com" and (starts_with(http.request.uri.path, "/api/application.deploy") or starts_with(http.request.uri.path, "/api/deployment.all") or starts_with(http.request.uri.path, "/api/application.one") or starts_with(http.request.uri.path, "/api/docker.getServiceContainersByAppName")) and any(len(http.request.headers["x-api-key"][*]) > 0))
  ```

  Depois, rode um deploy de staging e confira em _Security → Events_ que as
  chamadas do pipeline continuam passando (a regra aparece com a ação
  _Skip_); `application.one` e `docker.getServiceContainersByAppName` só
  aparecem num run que roda a etapa de release. Se o editor do plano Free
  recusar o campo de cabeçalho, fique só com os quatro caminhos. Opcional: uma
  regra de rate limiting nos caminhos de autenticação do painel (a regra
  gratuita pode já estar ocupada; ver abaixo).

- O plano Free tem uma regra gratuita de rate limiting, e o roteiro de
  ataque ("Sob ataque", abaixo) conta com ela.

Itens que aparecem em _Security → Settings_ (29/10/2026), sem mudança nossa:
_Browser integrity check_, _Challenge passage_ (padrão), _Leaked credentials
detection_ com uma regra _Rate limit authentication requests_, _Continuous
script monitoring_, _Hotlink protection_, _IP access rules_ e _Replace insecure
JS libraries_. **A confirmar com o dono:** quem criou a regra de rate limit de
autenticação, o que ela cobre e se ela já ocupa a regra gratuita de rate
limiting. O _AI Labyrinth_ deve continuar desligado: ele
injeta links escondidos nas páginas.

#### Bot Fight Mode: desligado

Desligado pelo dono em 26/10/2026, por volta das 14:41 UTC, e **deve
continuar assim**. Onde: _Security → Settings → Bot traffic → Bot fight mode_
(conferir o nome exato no painel). Conferível pela API: o
`GET /zones/{zone_id}/bot_management` da
[seção 13.5](#135-reverter-o-javascript-detections) devolve
`"fight_mode": false`.

- **Por quê**: no plano Free ele vale para o domínio inteiro e não aceita
  exceção. Ele desafiava os clientes legítimos que não são navegador: o app
  Android do motorista, os ERPs dos clientes em `/integration/v1`, os webhooks
  da Meta e do Resend e o GitHub Actions chamando o Dokploy e o
  `/build-id.json`. A primeira chamada real do CI recebeu 403 com a página
  "Just a moment".
- O _Super Bot Fight Mode_ (planos Pro e acima) aceitaria exceções por
  caminho, se um dia for preciso.
- O `trajetto-ui/docs/deploy.md` ainda sugere criar uma exceção no Bot Fight
  Mode: no Free isso não existe.

#### JavaScript Detections: desligado (29/10/2026)

**O que é.** O _JavaScript Detections_ (JSD) é um script da Cloudflare
(`/cdn-cgi/challenge-platform/scripts/jsd/main.js`, com um carregador inline)
que a Cloudflare injeta em toda página HTML, mesmo com o Bot Fight Mode
desligado, para marcar quem executa JavaScript.

**Por que desligamos.**

- No plano Free o resultado só serve para regras no Enterprise
  (`cf.bot_management.js_detection.passed`). Sozinho, ele não bloqueia nada.
  Ou seja: não dava nada à zona.
- Ele derrubava o _Best Practices_ do Lighthouse para 77: usava APIs
  obsoletas (`FencedFrame`, `StorageType.persistent`) e o carregador inline
  gerava relatórios de Trusted Types.

**Por que pela API.** O painel do plano Free não tem chave para o JSD.

**Como foi feito**, passo a passo (o dono, no Git Bash, por volta das 22:33
UTC):

1. **Token temporário.** Cloudflare → foto de perfil → _My Profile → API
   Tokens → Create Token → Create Custom Token_, com o nome
   `temporario-bot-management`:

   - _Permissions_: _Zone · Bot Management · Edit_;
   - _Zone Resources_: _Include · Specific zone · intrajetto.com_;
   - validade: até o fim do dia seguinte (30/10/2026, 23:59);
   - sem filtro de IP de cliente.

   O token aparece uma vez só e nunca foi colado em chat nem em print.

2. **Token só na memória do shell**: `read -rs CF_TOKEN` (nada aparece na
   tela nem vai para o histórico) e `export CF_TOKEN`. A conferência foi só do
   tamanho (`echo ${#CF_TOKEN}`).
3. **Zone ID**: copiado da _Overview_ da zona → _API_.
4. **Leitura**: `GET /client/v4/zones/{zone_id}/bot_management`, para ter o
   estado atual.
5. **Escrita**: `PUT` no mesmo endereço, reenviando **todos os campos
   graváveis com o mesmo valor**, menos `"enable_js": false`. A documentação
   não diz se um campo omitido volta ao padrão, então nada foi omitido, exceto
   `using_latest_model`, que é só de leitura.
6. **Efeito colateral**: o `PUT` recalculou o campo antigo
   `ai_bots_protection` de `block` para `disabled`. A Cloudflare migrou o
   antigo "Block AI bots" para uma tela nova, e o campo antigo deixou de
   refletir a configuração. As políticas de IA foram refeitas nessa tela
   (próxima subseção).
7. **Conferência**: um novo `GET` mostrou `enable_js` false, `fight_mode`
   false, `ai_training` block, `ai_search` e `ai_user` disabled (ou seja,
   liberados), `is_robots_txt_managed` true e `bot_preference_sync_enabled`
   true. O HTML de `/`, `/login` e `/blog` não traz mais o script do JSD.
8. **Limpeza**: o dono apagou o token em 29/10/2026, logo depois do uso:
   _My Profile → API Tokens_ → menu ⋯ na linha do token → _Delete_ →
   confirmar. A prova é o token não aparecer mais nessa lista (se o painel
   registrar tokens de usuário no _Manage Account → Audit Log_, a criação e a
   exclusão aparecem lá, com a hora). Depois, `unset CF_TOKEN` e o terminal
   fechado. Ele expiraria sozinho em 30/10/2026, 23:59, de todo modo.

**Resultado**: o _Best Practices_ do Lighthouse foi de 77 para 100 na home, no
blog e nas páginas legais. Em produção, depois da mudança: home 99/100/100/100,
blog e política de privacidade 100/100/100/100 (Performance, Acessibilidade,
Best Practices, SEO). O `/login` ficou em 100/96/96/66: o que falta são três
correções de código da web que, em 29/10, ainda esperavam o push para o
staging (Trusted Types do Turnstile, contraste do título "Notificações" e
login indexável).

**Como reverter**: o mesmo `PUT` com `"enable_js": true`
([seção 13.5](#135-reverter-o-javascript-detections)).

**Por que não reduz a proteção**: o JSD não bloqueava nada no Free. O que
protege continua igual (subseção "O que continua protegendo").

**Rever depois**: a Cloudflare está lançando o "Precursor", que substitui o
JSD. Quando ele aparecer no painel, confira se volta a injetar script nas
páginas.

#### Políticas de bots de IA

Onde: _Security → Settings → Bot traffic → Configure AI bot policies_ (29/10/2026):

| Categoria | Política                 | Por quê                                                                     |
| --------- | ------------------------ | --------------------------------------------------------------------------- |
| Training  | **Block**                | robôs que coletam conteúdo para treinar modelos recebem 403                 |
| Search    | **Allow** (não bloquear) | o site continua aparecendo em buscadores e buscas de IA                     |
| Agent     | **Allow** (não bloquear) | assistentes que abrem a página a pedido de uma pessoa continuam funcionando |

_Enable Bot Preference Sync_ ligado. Antes, Training estava como _Disallow_,
que é só um pedido no `robots.txt`; agora é bloqueio de verdade. Conferido em
29/10: os user agents do GPTBot, do CCBot e do ClaudeBot recebem 403, e um
navegador recebe 200.

O _robots.txt gerenciado_ está ligado: a Cloudflare acrescenta, antes do
`robots.txt` da aplicação, os blocos `Content-Signal` e os `Disallow` para os
robôs de IA.

Esse bloco traz `User-agent: *` com `Allow: /`. Os buscadores juntam os grupos
do mesmo robô, aplicam a regra mais longa e, no empate, a que libera. Por isso
um `Disallow: /` da aplicação empata com ele e não bloqueia nada. A API, que
responde o próprio `robots.txt` desde 30/10/2026, fecha o host com
`Disallow: /*` e libera só o console de integração de produção (detalhes em
[`arquitetura.md`](arquitetura.md), "Integrações externas"). A web de staging
ainda responde `Disallow: /`; o que a protege de verdade é o Cloudflare Access
e o `noindex`.

#### Email Address Obfuscation: desligado

Desligado em 29/10/2026, por volta das 17:03 UTC. Onde fica agora: _Security →
Settings → Client side abuse_ (antes, _Scrape Shield_).

**Por quê**: a ofuscação troca os e-mails do HTML e injeta o script
`email-decode.min.js` para desfazer a troca no navegador. A CSP do site
bloqueava esse script em `/legal/*` e `/contato`, e os endereços apareciam
quebrados. Conferido depois: o script sumiu e o endereço de contato aparece.
Se a opção voltar a ligar sozinha, a saída é a Configuration Rule
`Sem ofuscacao de e-mail` (seção 6.3).

#### O que continua protegendo

O Bot Fight Mode e o JSD **classificam** robôs; nenhum dos dois mitiga DDoS.
A proteção de DDoS de rede (camadas 3 e 4) e o ruleset gerenciado de DDoS
HTTP continuam ativos em qualquer plano e com qualquer configuração dessas
duas opções. Com os dois desligados, a proteção é:

1. a proteção de DDoS de rede (camadas 3 e 4), automática;
2. o ruleset gerenciado de DDoS HTTP (sempre ativo);
3. o ruleset gerenciado do WAF;
4. o Turnstile, validado pelo servidor da web no login e no "esqueci a
   senha", e pela API só no formulário público de orçamento (seção 6.9);
5. os rate limits da própria API, por IP e por conta, com o IP real vindo da
   Cloudflare (`RATE_LIMIT_TRUSTED_PROXY=cloudflare`). São eles que protegem o
   login direto na API (o app do motorista, scripts e ataques de
   credenciais), que não tem Turnstile;
6. o Cloudflare Access no staging;
7. o firewall da Contabo, que só admite a Cloudflare (seção 4.3).

#### Sob ataque

Não religue o Bot Fight Mode (ele derruba o app, os ERPs e os webhooks). Em vez
disso: veja _Security → Events_; bloqueie ou desafie por IP, país ou ASN com uma
regra custom; use a regra gratuita de rate limiting; e, se preciso, ligue o
_I'm Under Attack_ por uma Configuration Rule **só no host do site**, nunca na
API.

### 6.6 Speed

Mudanças de 29/10/2026:

| Recurso            | Onde                                                                  | Estado e conferência                                                                                                                                                         |
| ------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Smart Tiered Cache | _Caching → Tiered Cache_ (agora apresentado dentro de _Smart Shield_) | ligado por volta das 21:50 UTC; topologia _Smart Tiered Cache_; as camadas superiores são escolhidas pela Cloudflare perto da origem (ORD/YYZ); _Origin Configuration_ vazia |
| Early Hints        | _Speed → Settings → Content Optimization_                             | ligado por volta das 21:58 UTC; o `/login` responde 103 com o preload das duas fontes woff2 a partir do segundo pedido; a home não tem preload e não muda                    |

O Early Hints se confere com Node, porque o `curl` do Git Bash não fala
HTTP/2. Rode **duas vezes** (o primeiro pedido prepara o cache da Cloudflare);
o cabeçalho `user-agent` de navegador é necessário, porque sem ele a
Cloudflare não manda o 103:

```sh
node -e "const c=require('node:http2').connect('https://www.intrajetto.com');const r=c.request({':path':'/login','user-agent':'Mozilla/5.0 Chrome/130.0','accept':'text/html'});r.on('headers',h=>h[':status']===103&&console.log('103',h.link));r.on('response',h=>console.log(h[':status']));r.resume();r.on('end',()=>c.close());r.end()"
```

O esperado é uma linha `103` com os dois _preloads_ `woff2` e depois `200`
(conferido assim em 29/10/2026). No Linux ou no WSL, a alternativa é
`curl --http2 -sI` com o mesmo `user-agent` (não testada aqui).

**Já vinham ligados**: HTTP/3 e compressão zstd.

**Não ligar, e por quê** (a coluna _Onde_ é onde conferir que está desligado;
"conferir" marca o caminho que ninguém viu no painel):

| Recurso                                       | Onde                                                            | Motivo                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0-RTT                                         | _Speed → Settings → Protocol Optimization_ (conferir)           | permite repetir (replay) requisições, e vale também para o host da API; o ganho é mínimo |
| Speed Brain                                   | _Speed → Settings → Content Optimization_ (conferir)            | não tem efeito com a CSP de nonce e `strict-dynamic` da web                              |
| Cloudflare Fonts                              | _Speed → Settings → Content Optimization_ (conferir)            | as fontes já são servidas pela própria web                                               |
| Rocket Loader e otimizações automáticas de JS | _Speed → Settings → Content Optimization_ (conferir)            | reescrevem os scripts e quebram a CSP e o Next.js                                        |
| Argo                                          | _Traffic_ (conferir; o nome do menu mudou com o _Smart Shield_) | pago                                                                                     |

### 6.7 Caching

O HTML ainda **não** é cacheado na borda: as páginas respondem
`cf-cache-status: DYNAMIC`, e cada visualização paga a ida e volta do Brasil
até a origem nos EUA (cerca de 180 ms). Nas medições, o ponto de presença da
Cloudflare para quem está no Brasil foi o do Rio (GIG).

O próximo projeto é cachear as páginas públicas pré-renderizadas, com um passo
de _purge_ a cada deploy. Nesse projeto, as rotas que respondem
`Cache-Control: no-store` precisam continuar fora do cache: `/build-id.json`,
`/api/health`, `/public-config.json` e o relay da API.

### 6.8 Web Analytics

O Cloudflare Web Analytics (configuração automática, RUM) fica **ligado**, por
decisão do dono. Ele não usa cookie.

- A CSP da web libera `https://static.cloudflareinsights.com` (o
  `beacon.min.js`). O beacon envia para `/cdn-cgi/rum` na própria origem.
- Até o commit `e9d4389` da web, o beacon era bloqueado nas páginas públicas
  pré-renderizadas. Agora carrega em todas.
- A política de privacidade o declara (§3 e §9). Um teste da web
  (`legal-facts.test.ts`) exige que todo host liberado pela CSP esteja
  declarado ali. Desligar o Web Analytics, ou trocar de ferramenta, muda a CSP
  e a política juntas.

### 6.9 Turnstile

**Onde**: no menu da conta, fora da zona → _Turnstile_. Um widget por
ambiente.

| Widget                         | Hostnames                             | Modo                                 | Estado                                                                           |
| ------------------------------ | ------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------- |
| `trajetto-staging-security`    | `staging.intrajetto.com`              | _Managed_, _pre-clearance_ desligado | criado em 24/10/2026                                                             |
| `trajetto-production-security` | só `www.intrajetto.com` (recomendado) | _Managed_                            | nome e hostname recomendados. **A confirmar com o dono:** nome e hostnames reais |

Nenhum widget inclui `intrajetto.com`: um hostname cobre também os
subdomínios dele. No widget de staging, ele faria o widget servir à produção;
no de produção, faria o widget valer também em `staging.intrajetto.com` e em
qualquer outro subdomínio. E o apex só redireciona: nunca mostra o widget. Se
o widget de produção foi criado com `intrajetto.com`, troque por
`www.intrajetto.com` na lista de hostnames do widget (_Turnstile_ → o
widget; as chaves não mudam).

**As chaves** (valores nunca aqui):

- _Site Key_ (pública, o navegador vê) → `TURNSTILE_SITE_KEY` da web do
  ambiente;
- _Secret Key_ → `TURNSTILE_SECRET_KEY` na web **e** na API do mesmo
  ambiente, com o mesmo valor.

**Quem valida cada formulário** (a web mostra o Turnstile nos três):

| Formulário                     | Quem valida o token                                                                                     | Com `TURNSTILE_SECRET_KEY` vazia                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| login e "esqueci a senha"      | o servidor da web (`src/actions/validate-turnstile`, chamado por `login-user` e `forgot-password-user`) | em staging e produção a web **não sobe**: a _Secret Key_ é obrigatória com `NODE_ENV=production` (`src/env/server.ts`); só na máquina de um dev, sem ela, o token não é conferido    |
| orçamento (formulário público) | a API                                                                                                   | em staging e produção a API **não sobe** (`src/schemas/env-schema/index.ts`: sem ela o orçamento ficaria sem verificação de robô); só em desenvolvimento a vazia desliga a exigência |

Nunca na API em geral: o login do app quebraria. O login direto na API (o
app do motorista, scripts) não tem Turnstile e é protegido pelos rate limits
da API (seção 6.5).

Rotação: [seção 13.3](#133-rotacionar-um-segredo).

### 6.10 R2

**Buckets** (menu da conta → _R2_):

| Bucket                     | Para quê                                                                             | Acesso                                    |
| -------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------- |
| `trajetto-staging-storage` | fotos, assinaturas, anexos e avatares do staging                                     | privado; só URL assinada de curta duração |
| `trajetto-prod-storage`    | o mesmo, de produção                                                                 | privado; só URL assinada                  |
| `trajetto-backups`         | dumps do Postgres; prefixo `trajetto-staging/` (e, previsto, `trajetto-production/`) | privado; só o Dokploy escreve             |
| `trajetto-backups-prod`    | bucket próprio para os dumps de produção (recomendado)                               | **A confirmar com o dono:** se foi criado |

Os buckets de fotos foram criados em 24/10/2026. Nenhum bucket tem domínio
próprio: o `assets.intrajetto.com` chegou a ser ligado ao bucket de produção e
foi removido até 25/10, porque o bucket precisa ser privado. O endereço S3
`https://<bucket>.<ACCOUNT_ID>.r2.cloudflarestorage.com` é automático e não é
domínio próprio. **A confirmar com o dono:** que a URL pública `r2.dev` está
desligada nos buckets.

**CORS** (cada bucket de fotos → _Settings → CORS Policy_): _AllowedOrigins_ =
a origem da web do ambiente (`https://staging.intrajetto.com` ou
`https://www.intrajetto.com`, nunca `*`), métodos `PUT`, `GET` e `HEAD`,
cabeçalho `content-type`, expõe `ETag`, `MaxAgeSeconds` 3600. O JSON está em
[`deploy.md` → 22](./deploy.md#22-bucket-r2-e-retenção-no-ghcr). Sem a regra,
o upload do navegador falha sem aparecer em log nenhum.

**Tokens** (_R2 → Manage API Tokens_; um por bucket, _Object Read & Write_ só
naquele bucket):

| Token                                                       | Bucket                     | Onde fica                                                      |
| ----------------------------------------------------------- | -------------------------- | -------------------------------------------------------------- |
| `trajetto-upload-token`                                     | `trajetto-prod-storage`    | `R2_ACCESS_KEY_ID` e `R2_SECRET_ACCESS_KEY` da API de produção |
| token de staging (sugerido `trajetto-staging-upload-token`) | `trajetto-staging-storage` | as mesmas variáveis da API de staging                          |
| token do bucket de backup                                   | `trajetto-backups`         | só no _S3 Destination_ do Dokploy                              |

**A confirmar com o dono:** o nome real do token de staging; se existe token
e destino próprios para o backup de produção; e para que serve o
`CLOUDFLARE_R2_API_TOKEN` que está nas notas locais.

**O que não tem backup**: os objetos dos buckets de fotos. O dump do banco só
guarda as chaves, e fotos de entrega e assinaturas são prova documental. A
proteção prevista (Bucket Lock nos prefixos de prova e cópia periódica para
outro bucket) é pendência
([`deploy.md` → O que o dump não cobre](./deploy.md#o-que-o-dump-não-cobre)).

### 6.11 Tokens da API da Cloudflare

Nenhum sistema nosso usa um token permanente da API da Cloudflare.
**A confirmar com o dono:** que não existe nenhum token antigo em _My Profile →
API Tokens_ além do temporário de 29/10.

O único usado foi o `temporario-bot-management`, criado e apagado em
29/10/2026 para desligar o JSD (seção 6.5). A regra para os próximos: token
**custom**, com a menor permissão, só na zona `intrajetto.com`, validade de um
dia, guardado só numa variável do shell e apagado logo depois do uso. Nunca a
_Global API Key_.

---

## 7. GitHub

### 7.1 Organização e repositórios

Organização `Trajetto-Organization`, com três repositórios: `trajetto-api`,
`trajetto-ui` e `trajetto-mobile` (`trajetto-ui` e `trajetto-mobile` foram
renomeados de `trajetto-fleet-manager-*`). A branch padrão é `main`. O fluxo
nos três:

- `staging`: integração. Todo push roda a validação completa e publica o
  staging. O dono pode fazer push direto.
- `main`: produção. Só recebe PR **de `staging`**, com **merge commit**
  (nunca _squash_ nem _rebase_: eles criam um commit que o staging nunca
  construiu, e a promoção recusa).

Detalhe: [`deploy.md` → Branches e pull requests](./deploy.md#2-branches-e-pull-requests).

### 7.2 Visibilidade e a cota do Actions

Os três repositórios são **privados** por padrão. Em 29/10/2026 a
`trajetto-api` e a `trajetto-ui` ficaram públicas em janelas temporárias
(abaixo), e às 23:44 UTC as duas ainda estavam públicas.

**A cota**: a organização está no GitHub Free, sem forma de pagamento. Isso
dá 2.000 minutos de runner Linux por mês para repositórios privados (os
"US$ 12 incluídos", a US$ 0,006 por minuto). Há quatro _budgets_ em US$ 0 com
_Usage blocked_ (entre eles Actions, Packages e Codespaces), e o armazenamento de
Actions e Packages incluído é de 0,5 GB (0 GB usado em 29/10). A cota renova no
dia 1º de cada mês. Cada push custa por volta de 1 hora de runner por
repositório: os 2.000 minutos dão cerca de 33 horas, uns 30 pushes por mês
somando os três repositórios. Onde ver: organização → _Settings → Billing and
licensing_ → _Usage_ (os minutos gastos) e _Budgets and alerts_ (os
budgets).

Quando a cota acaba, os runs não começam, com a mensagem "recent account
payments have failed or your spending limit needs to be increased".

**O que aconteceu entre 26 e 29/10/2026**: a cota acabou. Em 29/10, para
continuar subindo o staging e a produção, o dono deixou os repositórios
**públicos temporariamente** (repositório público tem Actions grátis) e depois
voltou a privados:

- `trajetto-api` e `trajetto-ui` por volta das 12:45 UTC;
- `trajetto-mobile` por volta das 14:11 UTC;
- `trajetto-api` e `trajetto-ui` de novo, para os merges de produção e o
  release `a1c5242` da web.

Conferido depois da terceira janela: os três privados (git anônimo recusado,
a API do GitHub responde 404 sem login). Depois disso começou uma quarta
janela, para os pushes de staging da noite: a `trajetto-ui` por volta das
22:42 UTC e a `trajetto-api` por volta das 22:48 UTC (a hora da última
mudança no repositório, que a API do GitHub mostra). Às 23:44 UTC a API
anônima do GitHub ainda respondia `"visibility": "public"` para as duas, e
404 para a `trajetto-mobile`. **A confirmar com o dono:** a hora em que a
quarta janela foi fechada (registre na seção 12).

**O risco de abrir um repositório**: enquanto ele está público, o código, o
histórico inteiro, os logs e os artefatos do Actions ficam visíveis, e o que
alguém copiou nesse tempo (forks, clones, caches) continua copiado para
sempre. Antes de abrir a `trajetto-api`, confirmou-se que a única chave real
que o histórico tem (uma `ANTHROPIC_API_KEY` antiga, no commit `2926c01`) já
estava revogada e excluída no console da Anthropic (confirmado em 29/10); a
fingerprint dela está no `.gitleaksignore`, e o histórico não é reescrito. O
procedimento seguro está na
[seção 13.6](#136-abrir-e-fechar-um-repositório-para-usar-o-actions-grátis).

**O que a conferência não pegou**: o histórico da `trajetto-api` também
contém o nome automático e o IPv6 da VPS (commits `577fc5a` e `d413cb1`,
enviados por volta das 03:15 UTC de 29/10, antes da primeira janela; seção 1).
Eles ficaram públicos em todas as janelas e são tratados como públicos desde
então ([seção 4.3](#43-firewall)).

**Para gastar menos**: o agendamento noturno das suítes de navegador da web
(`browser-suites.yml`, `cron: "0 6 * * *"`) foi removido no commit `7f83d8c`.
Ele só para de rodar quando esse commit chegar à `main`, porque um workflow
agendado roda pelo arquivo da branch padrão. O arquivo com o agendamento
chegou à `main` em 29/10, às 15:12 UTC (`a5ffb13`): antes disso o agendamento
não rodava e não causou o esgotamento de 26 a 29/10; dali em diante, passaria
a consumir cerca de 1 hora por noite. As suítes já rodam em todo push em
`staging` e em todo PR para `main`.

### 7.3 Environments

Onde: cada repositório → _Settings → Environments_.

| Environment  | Revisores                     | Branches permitidas |
| ------------ | ----------------------------- | ------------------- |
| `staging`    | nenhum (deploy automático)    | `staging`           |
| `production` | _Required reviewers_ (o dono) | só `main`           |

**A confirmar com o dono:** a configuração real nos três repositórios. Os
docs divergem sobre o _Prevent self-review_: o da web manda deixar desmarcado
com um aprovador só, e o do app pede ligado com "o dono e mais uma pessoa".
Com um aprovador só e o _Prevent self-review_ ligado, ninguém consegue aprovar.

### 7.4 Secrets e variables

Onde: cada repositório → _Settings → Secrets and variables → Actions_ (abas
_Secrets_ e _Variables_, nível do repositório) e _Settings → Environments_ →
o environment (nível do environment).

**`trajetto-api`**:

| Nome                             | Tipo e nível                       | Para quê                                                                                                                      | Onde se gera o valor                                                |
| -------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `DOKPLOY_URL`                    | secret, `staging` e `production`   | o endereço do painel, `https://dokploy.intrajetto.com` (nunca o IP)                                                           | —                                                                   |
| `DOKPLOY_API_KEY`                | secret, `staging` e `production`   | chama a API do Dokploy                                                                                                        | Dokploy → _Settings → Profile → API/CLI_ (seção 5.8)                |
| `DOKPLOY_API_APPLICATION_ID`     | secret, `staging` e `production`   | qual Application da API implantar                                                                                             | o fim da URL da Application no painel                               |
| `DOKPLOY_AI_APPLICATION_ID`      | secret, `staging` e `production`   | qual Application da IA implantar (sem ele, a IA não é atualizada)                                                             | idem                                                                |
| `DOKPLOY_MIGRATE_APPLICATION_ID` | secret, `staging` e `production`   | qual Application `trajetto-api-migrate` roda as migrations; obrigatório com os outros `DOKPLOY_*`                             | idem                                                                |
| `API_PUBLIC_URL`                 | variable, `staging` e `production` | a conferência do rollout pela `/health/liveness` pública                                                                      | `https://api-staging.intrajetto.com` / `https://api.intrajetto.com` |
| `ROLLOUT_VERIFY`                 | variable                           | como o pipeline prova o rollout; em uso: `http`                                                                               | —                                                                   |
| `IMAGE_SCAN_ENFORCE`             | variable, repositório              | `true`: um CRITICAL corrigível no Trivy falha o build (só um achado: falha no download do banco ou erro do Trivy viram aviso) | —                                                                   |
| `CLIENT_REPOS_READ_TOKEN`        | secret, repositório                | o contrato de rotas do `ci.yml` lê a web e o app                                                                              | GitHub, token fine-grained (seção 11.1)                             |

`SWARM_API_SERVICE`, `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`,
`DEPLOY_SSH_KNOWN_HOSTS` e `DEPLOY_VERIFY_SSH_KEY` só são usados com
`ROLLOUT_VERIFY=ssh`, e não estão configurados.

**A confirmar com o dono:** se o `ROLLOUT_VERIFY=http` está no repositório ou
em cada environment; o `DOKPLOY_MIGRATE_APPLICATION_ID` nos dois
environments (a criar com a Application `trajetto-api-migrate`); que a
variável `MIGRATIONS_VIA_JOB` foi apagada e que não sobrou um secret
`DEPLOY_SSH_KEY` (nenhum dos dois é lido); que o `CLIENT_REPOS_READ_TOKEN`
existe; e que o `DOKPLOY_AI_APPLICATION_ID` de produção está cadastrado.

**`trajetto-ui`**:

| Nome                                         | Tipo e nível                     | Para quê                                                                                                                                                                         |
| -------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METADATA_BASE`                              | secret, repositório              | build arg e conferência da produção (`https://www.intrajetto.com`)                                                                                                               |
| `API_REPO_READ_TOKEN`                        | secret, repositório              | lê a API (suítes de navegador e contrato)                                                                                                                                        |
| `IMAGE_SCAN_ENFORCE`                         | variable, repositório            | `true`: o Trivy falha o build                                                                                                                                                    |
| `DOKPLOY_URL`, `DOKPLOY_API_KEY`             | secret, `staging` e `production` | os mesmos da API                                                                                                                                                                 |
| `DOKPLOY_UI_APPLICATION_ID`                  | secret, `staging` e `production` | qual Application da web implantar                                                                                                                                                |
| `METADATA_BASE_STAGING`                      | secret, `staging`                | conferência do staging (`https://staging.intrajetto.com`)                                                                                                                        |
| `API_DOCS_URL`, `DOCS_USER`, `DOCS_PASSWORD` | secret, `production`             | o gate de rotas lê o `/docs/json` da API de produção antes de promover                                                                                                           |
| `ROLLOUT_VERIFY`                             | variable                         | **não definir**; só o valor `off` tem efeito: desliga a espera pelo `/build-id.json` no staging e na produção (o run avisa com `::warning::`). Só em emergência, e apague depois |

Lista completa:
[`trajetto-ui/docs/variaveis-de-ambiente.md` → GitHub Actions](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/variaveis-de-ambiente.md#github-actions-secrets-e-variables).

**`trajetto-mobile`**:

| Nome                      | Tipo e nível                     | Para quê                                                                    |
| ------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `EXPO_TOKEN`              | secret, repositório              | EAS Build e Update (robot `github-actions`, seção 8)                        |
| `API_REPO_READ_TOKEN`     | secret, repositório              | lê a API                                                                    |
| `PLAY_SUBMIT_ENABLED`     | variable, repositório            | envio automático do AAB para a Play Store; só depois do primeiro AAB manual |
| `EXPO_UPDATE_PRIVATE_KEY` | secret, `staging` e `production` | assinatura da OTA; **ainda não existe** (seção 8.3)                         |

**A confirmar com o dono:** o valor do `PLAY_SUBMIT_ENABLED`. Na montagem ele
ficou sem valor, mas as notas locais dizem `true`, e a Play Store ainda não
foi configurada.

**`GITHUB_TOKEN`** (automático, nos três): push e retag no GHCR, pull do
Trivy e o semantic-release. Cada job pede só a permissão de que precisa.

**Apague se ainda existirem** (nada mais lê): `DOKPLOY_COMPOSE_ID`,
`DOKPLOY_BACKUP_APPLICATION_ID`, `STAGING_ENABLED`, `PORTAINER_WEBHOOK_URL`,
`PORTAINER_STAGING_WEBHOOK_URL`, `DOKPLOY_STAGING_WEBHOOK_URL` e
`DOKPLOY_PRODUCTION_WEBHOOK_URL`; na web, também os listados em
[`trajetto-ui/docs/variaveis-de-ambiente.md`](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/variaveis-de-ambiente.md#para-apagar-nada-mais-lê).
**A confirmar com o dono:** se já foram apagados.

### 7.5 Proteção das branches

O manual da web pede **Rulesets** (_Settings → Rules → Rulesets_), com o app
**GitHub Actions** na _Bypass list_ em _Always allow_: o semantic-release faz
push do commit do `CHANGELOG.md` direto em `main` com o `GITHUB_TOKEN`, e a
proteção clássica não deixa esse token passar. O manual da API ainda descreve
a proteção clássica. Nos três, só _Allow merge commits_ fica habilitado em
_Settings → General → Pull Requests_.

**A confirmar com o dono:** o que existe de fato em cada repositório
(Rulesets ou proteção clássica, os checks exigidos, o bypass do GitHub
Actions, o bloqueio de force push em `staging`). O recomendado é Rulesets nos
três, como na web:
[`trajetto-ui/docs/deploy.md` → 4](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/deploy.md#4-configurar-o-github-uma-vez).

**Antes de dar Write a alguém** ([seção 3.2](#32-dar-acesso-a-um-dev-novo-o-mínimo)):
um Ruleset em `staging` exigindo PR com revisão para todos, com só o dono na
_Bypass list_. Sem ele, quem tem Write dá push direto em `staging` e o
workflow dele lê os secrets do environment `staging`.

### 7.6 GHCR

Pacotes privados em `ghcr.io/trajetto-organization/`: `trajetto-api`,
`trajetto-ai` e `trajetto-ui` (o `trajetto-backup` existiu até 26/10). Cada
pacote fica ligado ao seu repositório, com papel _Write_ em _Package settings →
Manage Actions access_.

Tags: `sha-<7>` (imutável), `staging` e `stable` (móveis), `staged-<7>`
(marcador de que o staging rodou), `src-<hash>` (só a IA) e `main-<sha>`
(legado). Não existe `latest`. O pipeline da API lê e move as tags só pelo
`.github/scripts/ghcr.sh`, que separa "a tag não existe" de "o GHCR não
respondeu" (este repete e, se persistir, falha dizendo que o GHCR está fora). Não há limpeza automática: as versões antigas
são apagadas à mão, com cuidado
([`deploy.md` → 22](./deploy.md#22-bucket-r2-e-retenção-no-ghcr)).

Conferido privado em 29/10/2026, às 23:45 UTC, com a quarta janela aberta: o
pedido anônimo do manifest dos três pacotes responde 403. A visibilidade do
pacote é uma configuração separada da do repositório: confira de novo a cada
janela ([seção 13.6](#136-abrir-e-fechar-um-repositório-para-usar-o-actions-grátis)).

### 7.7 Dependabot e varredura de segredos

| Repositório       | Ecossistemas                                               | Quando                                            | PRs contra                                   |
| ----------------- | ---------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------- |
| `trajetto-api`    | npm, github-actions e docker; pip da IA e compose de carga | segunda, 06:00 (São Paulo); pip e compose mensais | `staging`                                    |
| `trajetto-ui`     | npm, github-actions e docker                               | segunda, 06:00 (São Paulo)                        | `staging`                                    |
| `trajetto-mobile` | npm e github-actions                                       | segunda, 06:00 (São Paulo)                        | `main` (sem `target-branch`; ver pendências) |

Ligados fora dos arquivos, nas configurações do repositório ou da organização:
_Dependabot alerts_, _security updates_, _CodeQL default setup_ e a política
de actions fixadas por SHA. **A confirmar com o dono:** o que está ligado.

Desde 30/10/2026, os _Dependabot alerts_ e os _security updates_ são o vigia
contínuo das dependências: o `audit-ci` do CI só bloqueia um push que muda
dependência e, nos outros, só relata
([`deploy.md` → 21](./deploy.md#21-cadeia-de-suprimentos-e-segredos)). O
Dependabot também não move o que está fixado dentro dos workflows: o
`node-version` (a mesma versão da base do `Dockerfile`) e os digests do
Postgres, do Redis e do BuildKit sobem à mão, nos três repositórios de uma
vez ([`deploy.md` → Versões fixas](./deploy.md#versões-fixas)).

**Varredura de segredos**: o gitleaks roda em todo push, em todo o histórico
de todas as branches, nos três repositórios (job `secrets`). A baseline fica
em `.gitleaksignore`. Um alerta é tratado como vazamento: revogar primeiro,
depois limpar ([`deploy.md` → 21](./deploy.md#21-cadeia-de-suprimentos-e-segredos)).

### 7.8 Workflows agendados

| Workflow                                  | Repositório    | Agenda                                        | Estado                                                                                                                                                                   |
| ----------------------------------------- | -------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.github/workflows/cloudflare-ranges.yml` | `trajetto-api` | toda segunda, 09:00 UTC, e _Run workflow_     | ativo (seção 4.3)                                                                                                                                                        |
| rodada noturna de `browser-suites.yml`    | `trajetto-ui`  | toda noite, 06:00 UTC, pelo arquivo da `main` | removida no commit `7f83d8c`; para de rodar quando ele chegar à `main` (passaria a consumir ~1 h por noite desde que o agendamento chegou à `main`, em 29/10; seção 7.2) |

Nenhum outro workflow tem agenda. O antigo heartbeat de backup saiu junto com
o serviço `trajetto-backup` em 26/10.

---

## 8. Expo e EAS

### 8.1 Projeto, perfis e canais

| Item           | Valor                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Organização    | `trajetto` na expo.dev                                                                                                  |
| Projeto        | slug `trajetto-fleet-manager-mobile` (nome do app `Trajetto`, no `app.json`); o slug precisa ser igual ao do `app.json` |
| Pacote Android | `com.trajetto.fleetmanager`; só Android                                                                                 |
| projectId      | em `app.json` → `extra.eas.projectId` (não copie para cá)                                                               |

Um projeto duplicado foi criado por engano e pode ser apagado. Identifique-o
pelo slug ou pelo projectId que o painel mostra, nunca pelo nome: o projeto
certo é o de slug `trajetto-fleet-manager-mobile`, com o projectId do
`app.json`. **A confirmar com o dono:** se o duplicado já foi apagado.

**Perfis do `eas.json`**: `development` (dev client), `preview` (APK interno,
a base que o `staging` estende), `staging` (canal `staging`, lê o ambiente EAS
`preview`) e `production` (AAB, canal `production`). O plano da conta Expo só
tem os ambientes `development`, `preview` e `production`; um ambiente próprio
de staging exige plano pago, e por isso o perfil `staging` lê o `preview`.
Nada publica OTA no canal `preview`. Detalhe:
[`trajetto-mobile/docs/deploy.md` → Perfis de build](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/deploy.md#perfis-de-build-easjson).

### 8.2 Variáveis e credenciais no EAS

Onde: expo.dev → projeto → _Environment variables_ (ou `eas env:create`).

| Variável                          | Ambiente EAS `preview` (staging)       | Ambiente EAS `production` (valor esperado) |
| --------------------------------- | -------------------------------------- | ------------------------------------------ |
| `EXPO_PUBLIC_API_URL`             | `https://api-staging.intrajetto.com`   | `https://api.intrajetto.com`               |
| `EXPO_PUBLIC_WEB_APPLICATION_URL` | `https://staging.intrajetto.com/login` | `https://www.intrajetto.com/login`         |
| `EXPO_PUBLIC_BACKGROUND_TRACKING` | `false`                                | `false`                                    |
| `APP_ENV`                         | `preview`                              | `production`                               |
| `GOOGLE_SERVICES_JSON`            | arquivo, visibilidade _Secret_         | o mesmo arquivo                            |

**A confirmar com o dono:** que as variáveis do ambiente `production` já
foram cadastradas (na montagem só o `preview` foi feito).

**Credenciais** (expo.dev → projeto → _Credentials_ → Android, ou
`eas credentials`):

- keystore Android: já existia no EAS e foi reaproveitada.
  **A confirmar com o dono:** se há cópia de segurança no gerenciador de
  senhas;
- chave de conta de serviço FCM V1 (push): enviada em 26/10. Precisa estar no
  campo _FCM V1 service account key_, não no de envio à Play Store.
  **A confirmar com o dono:** em qual campo ficou;
- conta de serviço do Google Play (envio automático): ainda não existe.

Os passos do Firebase e da Play Store estão em
[`trajetto-mobile/docs/deploy.md` → Firebase e push](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/deploy.md#firebase-e-push-fcm)
e [Play Store](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/deploy.md#play-store).

**Token do CI**: expo.dev → organização `trajetto` → _Settings → Access tokens →
Robot users_ → robot `github-actions`, papel _Developer_ → token
`github-trajetto-mobile` → secret de repositório `EXPO_TOKEN` na
`trajetto-mobile` (um só, para staging e produção). Feito em 26/10/2026. Nunca
um token pessoal.

### 8.3 OTA e build manual

- **Staging**: o CI publica OTA no canal `staging` **sem assinatura** (com
  aviso).
- **Produção**: o CI nunca publica OTA sem assinatura. Como a assinatura (code
  signing) ainda não foi configurada, a OTA de produção não é publicada pelo
  CI hoje. Configurar exige gerar o certificado, versionar o
  `certs/certificate.pem` e guardar a chave privada como
  `EXPO_UPDATE_PRIVATE_KEY`. Pode exigir plano pago e muda o runtime de forma
  permanente
  ([`trajetto-mobile/docs/deploy.md` → OTA assinada](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/deploy.md#ota-assinada-code-signing)).
- **Build manual** (_Actions → Release (EAS) → Run workflow_): oferece
  `development`, `staging` e `production` desde o commit `213d6b0` (29/10).
  O `preview` saiu da lista porque é só a base do `staging`.
- **Rollback de OTA**: `ota-rollback.yml`, que republica um grupo anterior.

### 8.4 Push e Firebase

- Projeto Firebase `trajetto` (Analytics desligado), app Android
  `com.trajetto.fleetmanager`.
- O `google-services.json` vai para o EAS como `GOOGLE_SERVICES_JSON` (seção
  8.2). A cópia local em `trajetto-mobile/google-services.json` é ignorada pelo
  Git e precisa ser idêntica. O `.fingerprintignore` a tira do cálculo do
  runtime (isso corrigiu um "Runtime version mismatch").
- A API envia o push para a Expo Push API (`exp.host`) **sem token de acesso
  da Expo**: a Expo repassa ao FCM com a credencial do projeto. Por isso o
  _Enhanced Security for Push Notifications_ do projeto Expo precisa continuar
  **desligado**; ligado, ele exigiria um token que a API não envia, e todo push
  falharia. Fica nas configurações do projeto na expo.dev (conferir o caminho
  exato). **A confirmar com o dono:** que está desligado.
- O JSON de admin do Firebase (`firebase-adminsdk`) dá acesso de administrador
  ao projeto: fica só no EAS e no gerenciador de senhas.

---

## 9. E-mail (Resend)

| Item             | Estado                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domínio de envio | `mail.intrajetto.com`, verificado no Resend (já existia antes da montagem do staging)                                                                                                                                                                                                                                                                                                                                   |
| Remetente        | em `RESEND_FROM_EMAIL`; o mesmo endereço nos dois ambientes, segundo as notas locais                                                                                                                                                                                                                                                                                                                                    |
| Chaves de API    | uma por ambiente, diferentes (staging sugerida como `trajetto-staging`, com _Sending access_ só para o domínio)                                                                                                                                                                                                                                                                                                         |
| Webhook          | `https://<host da API do ambiente>/webhooks/resend`; os eventos que a API entende são os de `RESEND_STATUS_RANK` (`src/shared/providers/mail-provider/resend-webhook.ts`): `email.sent`, `email.delivery_delayed`, `email.delivered`, `email.bounced`, `email.failed`, `email.suppressed` e `email.complained`; os outros são ignorados. O _Signing Secret_ vira `RESEND_WEBHOOK_SECRET` (sem ele, a rota responde 404) |
| Como a API envia | SMTP `smtp.resend.com` (nodemailer), com `Resend-Idempotency-Key`; o `/health/providers` sonda `GET /domains`                                                                                                                                                                                                                                                                                                           |
| Fora da produção | o Resend só entra com `NODE_ENV=production` (a imagem, staging incluído); em desenvolvimento, uma conta de teste do Ethereal; com `NODE_ENV=test` (o E2E e as suítes de navegador da web), uma caixa em memória do processo, sem servidor de e-mail (30/10/2026)                                                                                                                                                        |

**A confirmar com o dono:**

- os registros DNS que o Resend pediu para `mail.intrajetto.com` (SPF, DKIM,
  MX de retorno) e se existe DMARC (seção 6.1);
- o nome da chave de produção e se o webhook de produção foi criado;
- quais eventos foram marcados no painel, em cada webhook;
- se o staging deve mesmo usar o domínio real. O `deploy.md` da API diz que o
  staging usaria um domínio de teste, mas as notas locais mostram o mesmo
  remetente nos dois ambientes;
- para que serve a chave `RESEND_SECRET_KEY_DOKPLOY_LOGS` das notas locais
  (parece ser das notificações do Dokploy);
- qual provedor recebe o e-mail do endereço de contato do site (o MX).

O alerta de falha da operação nunca deve depender do Resend: o heartbeat
avisa por outro canal (seção 10.1).

---

## 10. Monitoramento e backups

### 10.1 O que existe

| O quê                                  | Onde                                                                                                          | O que avisa                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Heartbeat da API (_dead man's switch_) | healthchecks.io, check `trajetto-api-staging` (período 1 min, tolerância 3 min, alerta por e-mail e Telegram) | a API pinga a cada minuto; uma regra quebrada manda `/fail` com os motivos; banco fora ou scheduler parado = silêncio = alerta |
| Heartbeat de produção                  | **A confirmar com o dono:** se o check de produção e o `HEALTHCHECK_PING_URL` de produção existem             | —                                                                                                                              |
| Disponibilidade (Uptime Kuma)          | `uptime.intrajetto.com`                                                                                       | **A confirmar com o dono:** o que vigia, para onde avisa e onde roda (se roda na mesma VPS, não avisa quando a VPS cai)        |
| Recursos do servidor (Beszel)          | `monitor.intrajetto.com`                                                                                      | **A confirmar com o dono:** o que vigia e se alerta                                                                            |
| Prontidão dos provedores               | `GET /health/providers`, só MASTER (_Sistema → Provedores_ na web)                                            | Resend, Expo, R2, IA, certificado e heartbeat, sem enviar nada                                                                 |
| Conferência do deploy                  | o próprio pipeline                                                                                            | `/health/liveness` da API e `/build-id.json` da web respondendo o commit novo                                                  |
| Falha de backup                        | Dokploy → _Settings → Notifications_                                                                          | **A confirmar com o dono:** se o canal existe                                                                                  |
| Faixas da Cloudflare                   | workflow `cloudflare-ranges.yml`                                                                              | e-mail do GitHub quando a lista muda                                                                                           |
| Aba _Monitoring_ do Dokploy            | cada serviço                                                                                                  | só mostra; não alerta                                                                                                          |
| Eventos de segurança e analytics       | Cloudflare: _Security → Events_, _Analytics_ e Web Analytics                                                  | só mostram                                                                                                                     |

As regras do heartbeat e a primeira ação para cada motivo estão em
[`deploy.md` → Alertas e monitoramento](./deploy.md#20-alertas-e-monitoramento).
A URL do check é segredo: quem a tem pode silenciar o alerta.

### 10.2 Backups

| O quê                    | Onde                                                                                                                    | Agenda e retenção                                                              | Restaurar                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Postgres de staging      | Dokploy → Database → _Backups_ → _S3 Destination_ `r2-backups` → bucket `trajetto-backups`, prefixo `trajetto-staging/` | `0 3 * * *` (03:00 UTC); as 30 cópias mais recentes                            | [`deploy.md` → Restaurar a partir do R2](./deploy.md#restaurar-a-partir-do-r2) |
| Postgres de produção     | o mesmo mecanismo, prefixo `trajetto-production/`                                                                       | a mesma agenda e as mesmas 30 cópias (a política de privacidade depende disso) | idem                                                                           |
| A VM inteira             | Auto Backup da Contabo (seção 4.1)                                                                                      | diário; o painel listava uns 9 dias                                            | painel da Contabo                                                              |
| Fotos e assinaturas (R2) | **nenhum**                                                                                                              | —                                                                              | pendência (seção 6.10)                                                         |
| Segredos                 | _Environment_ do Dokploy, secrets do GitHub, EAS e o gerenciador de senhas                                              | —                                                                              | [seção 13.3](#133-rotacionar-um-segredo)                                       |
| Redis                    | nenhum, de propósito (só guarda chaves que expiram)                                                                     | —                                                                              | —                                                                              |

**A confirmar com o dono:** o backup de produção (o _S3 Destination_ usado, se
foi criado o bucket `trajetto-backups-prod` recomendado, e se um backup manual
foi rodado e conferido no bucket). Ele foi instruído em 27/10 e não foi
confirmado.

**O banco interno do Dokploy** (serviço `dokploy-postgres`) guarda a
configuração e o _Environment_ de todas as Applications. Até onde se sabe, só o
Auto Backup da Contabo o cobre. **A confirmar com o dono:** se há outra cópia.

Política: uma cópia por dia, 30 dias, RPO de até 24 h, sem PITR. As cópias não
são cifradas por nós (o R2 cifra em repouso). O RTO medido em 15/09/2026 foi de
10,5 s para 94 MB. A política de privacidade e os termos prometem exatamente
"diárias, guardadas por 30 dias": um teste da web compara esse texto com a
seção de backup do `deploy.md`, então a agenda e a retenção não mudam sem
mudar os dois.

### 10.3 O que falta

- monitores de uptime externos para `https://api.intrajetto.com/health/readiness`
  e `https://www.intrajetto.com/api/health`. O Uptime Kuma de
  `uptime.intrajetto.com` é o lugar natural deles. **A confirmar com o dono:**
  se já os vigia, e onde ele roda (na mesma VPS, ele não avisa quando a VPS
  cai);
- um alerta de validade dos certificados **da origem**. Um monitor externo de
  expiração do TLS vê o certificado de borda da Cloudflare (que ela renova
  sozinha), não o do Let's Encrypt na origem, que é o que vence e causa 526 no
  modo _Full (strict)_. Hoje a única conferência é manual: o comando por SSH
  da [seção 13.7](#137-conferir-a-borda-depois-de-mexer-na-cloudflare), com o
  lembrete de 22/12/2026 da seção 14;
- alerta de disco, de restarts de contêiner e métricas do Traefik (não há
  pilha de métricas);
- heartbeat de backup (um backup que simplesmente deixou de rodar não avisa);
- um ensaio de restauração com uma cópia real do Dokploy;
- backup dos objetos do R2.

---

## 11. Inventário de tokens e credenciais

Uma linha por credencial. Nenhum valor. "Notas locais" são os arquivos
`.env.staging` e `.env.production` do dono (seção 1).

### 11.1 Credenciais de infraestrutura e de CI

| Credencial                                             | Onde é criada                                                                                                      | Permissões                                                    | Onde fica                                                        | Quem usa                                                                                         | Validade e rotação                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Token classic do GHCR (`dokploy-ghcr-pull` ou `-read`) | GitHub → _Settings → Developer settings → Tokens (classic)_                                                        | só `read:packages`                                            | Dokploy (seção 5.7) e notas locais                               | o Dokploy, para puxar as imagens das Applications                                                | **A confirmar com o dono:** a validade. Renovar antes de vencer                                     |
| Chave de API do Dokploy                                | Dokploy → _Settings → Profile → API/CLI_                                                                           | o painel inteiro, staging e produção                          | `DOKPLOY_API_KEY` nos environments da API e da web; notas locais | os pipelines da API e da web                                                                     | sugerida com 1 ano. **A confirmar com o dono:** a data                                              |
| `CLIENT_REPOS_READ_TOKEN`                              | GitHub, token fine-grained, _Resource owner_ `Trajetto-Organization`                                               | _Contents: Read-only_ em `trajetto-ui` e `trajetto-mobile`    | secret de repositório da `trajetto-api`                          | o `ci.yml` da API (contrato de rotas)                                                            | **A confirmar com o dono:** se existe, a validade e a conta dona                                    |
| `API_REPO_READ_TOKEN`                                  | GitHub, token fine-grained, _Resource owner_ `Trajetto-Organization` (criado em 22/10/2026)                        | _Contents: Read-only_ só em `trajetto-api`                    | secret de repositório na web e no app; notas locais              | os pipelines da web e do app                                                                     | **A confirmar com o dono:** a validade e a conta dona. A organização pode exigir aprovação do token |
| `GITHUB_TOKEN`                                         | automático                                                                                                         | por job (`contents: read`; `packages: write` só onde publica) | —                                                                | GHCR, Trivy (ler as imagens; o banco de vulnerabilidades baixa sem credencial), semantic-release | automática                                                                                          |
| `EXPO_TOKEN`                                           | expo.dev → org `trajetto` → _Access tokens → Robot users_ (robot `github-actions`, token `github-trajetto-mobile`) | papel _Developer_                                             | secret de repositório na `trajetto-mobile`                       | o pipeline do app                                                                                | sem validade conhecida; revogar e recriar no mesmo lugar                                            |
| Acesso administrativo à VPS (SSH)                      | na compra da VPS (painel da Contabo)                                                                               | tudo no servidor                                              | com o dono                                                       | o dono, por SSH                                                                                  | endurecimento do SSH pendente (seções 13.8 e 14)                                                    |
| Senha do VNC                                           | painel da Contabo → VPS → _Manage_ → _VNC_                                                                         | console da VPS                                                | painel da Contabo                                                | emergência                                                                                       | trocável no painel                                                                                  |
| Usuários do Dokploy (dona e admin)                     | Dokploy                                                                                                            | painel inteiro                                                | com o dono                                                       | o dono                                                                                           | endurecimento da conta dona pendente: 2FA e credenciais (seção 5.10)                                |
| Chave SSH do CI (`verify-trajetto`)                    | `ssh-keygen` ([`deploy.md` → 14](./deploy.md#14-conferir-a-convergência))                                          | _forced command_ restrito                                     | secret `DEPLOY_VERIFY_SSH_KEY`                                   | ninguém                                                                                          | **não configurada** (só com `ROLLOUT_VERIFY=ssh`)                                                   |

### 11.2 Credenciais de provedores

| Credencial                                            | Onde é criada                                             | Permissões                                                                  | Onde fica                                                                                                 | Quem usa                            | Validade e rotação                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------- |
| Token R2 de fotos, produção (`trajetto-upload-token`) | Cloudflare → _R2 → Manage API Tokens_                     | _Object Read & Write_ só em `trajetto-prod-storage`                         | `R2_ACCESS_KEY_ID` e `R2_SECRET_ACCESS_KEY` da API de produção                                            | a API                               | recriar e trocar as duas variáveis                                                 |
| Token R2 de fotos, staging                            | idem                                                      | só em `trajetto-staging-storage`                                            | as mesmas variáveis da API de staging                                                                     | a API                               | idem                                                                               |
| Token R2 de backup                                    | idem                                                      | só no bucket de backup                                                      | só no _S3 Destination_ do Dokploy                                                                         | o Dokploy                           | idem; **A confirmar com o dono:** se a produção tem token próprio                  |
| `CLOUDFLARE_R2_API_TOKEN`                             | **A confirmar com o dono**                                | **A confirmar com o dono**                                                  | notas locais                                                                                              | **A confirmar com o dono**          | —                                                                                  |
| Turnstile: _Secret Key_ de cada widget                | Cloudflare → _Turnstile_ → widget                         | valida o token do formulário                                                | `TURNSTILE_SECRET_KEY` na web e na API do ambiente                                                        | web e API                           | _Rotate secret key_ no widget e trocar nos dois lados                              |
| Turnstile: _Site Key_                                 | idem                                                      | pública                                                                     | `TURNSTILE_SITE_KEY` da web                                                                               | o navegador                         | muda só se o widget for recriado                                                   |
| Resend: chave de API (uma por ambiente)               | Resend → _API Keys_                                       | _Sending access_ restrito ao domínio (sugerido)                             | `RESEND_SECRET_KEY` da API                                                                                | a API                               | criar outra, trocar e revogar a antiga                                             |
| Resend: segredo do webhook (um por ambiente)          | Resend → _Webhooks_ → endpoint                            | assina os eventos                                                           | `RESEND_WEBHOOK_SECRET` da API                                                                            | a API                               | recriar o endpoint                                                                 |
| `RESEND_SECRET_KEY_DOKPLOY_LOGS`                      | Resend                                                    | **A confirmar com o dono**                                                  | notas locais (e, talvez, as _Notifications_ do Dokploy)                                                   | **A confirmar com o dono**          | —                                                                                  |
| URLs do healthchecks.io (uma por ambiente)            | healthchecks.io → o check                                 | quem tem a URL pinga ou silencia o alerta                                   | `HEALTHCHECK_PING_URL` da API                                                                             | a API                               | recriar o check e trocar                                                           |
| Chave do MapTiler                                     | MapTiler → _API keys_ (o plano gratuito tem uma chave só) | pública no navegador, restrita por _Allowed HTTP Origins_ (staging e `www`) | dentro de `MAP_TILE_URL*` da web e de `PROOF_MAP_TILE_URL` da API                                         | o navegador e a API (com `Referer`) | **A confirmar com o dono:** se a origem de produção já está nas origens permitidas |
| Tokens do LocationIQ                                  | my.locationiq.com → _Access Tokens_                       | geocodificação; sem restrição de _Referrer_ (chamada do servidor)           | `REVERSE_GEOCODER_KEY` da API                                                                             | a API                               | recomendado um token separado para produção                                        |
| JSON de admin do Firebase (FCM V1)                    | Firebase → contas de serviço                              | administrador do projeto Firebase                                           | EAS (_Credentials_) e gerenciador de senhas                                                               | a Expo, para entregar o push        | gerar outra chave, trocar no EAS e apagar a antiga                                 |
| `GOOGLE_SERVICES_JSON`                                | Firebase → app Android                                    | configuração do app                                                         | EAS, arquivo _Secret_                                                                                     | o build                             | só muda se o app do Firebase mudar                                                 |
| Keystore Android                                      | EAS                                                       | assina o app                                                                | EAS                                                                                                       | o build                             | não se troca (Play App Signing, quando houver)                                     |
| Certificado A1 de teste (ICP-Brasil)                  | gerado por nós, autoassinado                              | assina o comprovante de staging                                             | `PROOF_SIGNING_*` da API de staging; arquivos em `trajetto-certificates`, fora do Git, na máquina do dono | a API de staging                    | vence em 1 ano; produção não tem A1 ainda                                          |
| Meta WhatsApp                                         | —                                                         | —                                                                           | —                                                                                                         | —                                   | não configurado (conta bloqueada pela Meta)                                        |

### 11.3 Segredos gerados por nós

Um valor diferente por ambiente, guardado no _Environment_ do Dokploy e no
gerenciador de senhas. Os comandos estão em
[`variaveis-de-ambiente.md` → Como gerar os segredos](./variaveis-de-ambiente.md#como-gerar-os-segredos).

| Segredo                        | Onde precisa estar, igual                                                    | O que acontece ao trocar                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| senha do Postgres              | o Database PostgreSQL, a `DATABASE_URL` da API e a da `trajetto-api-migrate` | a API cai até as três baterem (e a etapa de release falha)                                                                                              |
| senha do Redis                 | o Database Redis (e o comando dele), `REDIS_URL`                             | a API segue no ar, degradada, até as duas baterem: os limites de requisição deixam de contar e o tempo real para (`src/config/redis-client-options.ts`) |
| `AI_TOKEN` / `AI_LOCAL_TOKEN`  | a IA e a API                                                                 | a leitura de fotos dá 401 até as duas baterem                                                                                                           |
| `JWT_SECRET`                   | a API                                                                        | os tokens de acesso emitidos deixam de valer                                                                                                            |
| `JWT_SECRET_REFRESH_TOKEN`     | a API                                                                        | **todo mundo é deslogado**                                                                                                                              |
| `WEBHOOK_SECRETS_KEY`          | a API                                                                        | **irrecuperável**: os segredos de webhook dos clientes, cifrados com ela, se perdem                                                                     |
| `RATE_LIMIT_FORWARDER_SECRET`  | a API e a web do ambiente                                                    | enquanto diferirem, todos os logins contam como um IP só (429 para todo mundo)                                                                          |
| `DOCS_USER` / `DOCS_PASSWORD`  | a API e o environment `production` da web                                    | o gate de rotas da web falha até bater                                                                                                                  |
| `MASTER_USER_INITIAL_PASSWORD` | a API                                                                        | só vale na criação do usuário master                                                                                                                    |

### 11.4 Temporárias e aposentadas

| Credencial                                                  | O que foi                                                                             | Estado                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Token da Cloudflare `temporario-bot-management`             | _Zone · Bot Management · Edit_, só em `intrajetto.com`, validade até 30/10/2026 23:59 | criado em 29/10 entre 22:23 e 22:26 UTC, usado em uma sessão (`GET`, `PUT`, `GET`) e apagado pelo dono no mesmo dia (seção 6.5) |
| `ANTHROPIC_API_KEY` antiga (commit `2926c01`)               | a API não usa mais a Anthropic                                                        | revogada e excluída no console (confirmado em 29/10); ainda está no `.env` e no `.env.development` locais do dono: apagar       |
| `EXPO_TOKEN` pessoal                                        | token de usuário nas notas locais do app                                              | revogar; o CI usa só o robot                                                                                                    |
| `R2_BACKUP_*`                                               | credenciais de backup nas notas locais da API (diferentes entre staging e produção)   | **A confirmar com o dono:** se são do antigo `trajetto-backup` (então revogar) ou dos _S3 Destinations_ atuais                  |
| Webhooks do Dokploy e do Portainer (`*_WEBHOOK_URL`)        | o deploy antigo por webhook                                                           | substituídos pela chave de API; apagar dos secrets (seção 7.4)                                                                  |
| `GITHUB_ACCESS_TOKEN` de um `.env.production` antigo da web | token antigo                                                                          | revogar, se ainda existir                                                                                                       |

---

## 12. Histórico de mudanças

Horários em UTC (São Paulo = UTC−3). Do mais antigo para o mais novo.

| Data            | Mudança                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 14 e 15/09/2026 | ensaios de restauração do Postgres (o de 15/09, com 94 MB, mediu o RTO de 10,5 s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 24/09/2026      | faixas da Cloudflare copiadas para `src/config/trusted-edge.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 20/10/2026      | VPS da Contabo com o Dokploy pré-instalado; conta dona do Dokploy criada na instalação                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| até 21/10/2026  | a API subia como app Compose (Docker Stack) com `compose.production.yaml`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 22/10/2026      | decisão: cada serviço é uma Application ou um Database do Dokploy, nunca Compose; DNS e domínios do staging; Zero Trust ativado, aplicações `Staging web` e `Staging web - automação`; `API_REPO_READ_TOKEN` criado                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 24/10/2026      | widget do Turnstile de staging; buckets R2 de fotos e tokens; chave e webhook do Resend de staging; check de heartbeat de staging                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 25/10/2026      | variáveis removidas do código (`TWO_FACTOR_CHALLENGE_REQUIRED`, `TURNSTILE_REQUIRED`, `CLOUDINARY_LOGO_IMAGE`, `PUBLIC_SOCKET_URL`); nenhum bucket com domínio próprio; Meta bloqueada                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 26/10/2026      | Bot Fight Mode desligado (~14:41); regra de Skip do WAF para o Dokploy; backup do banco passa a ser só o do Dokploy (serviço `trajetto-backup` removido); backup de staging configurado; chave de API do Dokploy; conta admin do Dokploy; robot e token da Expo; ambiente EAS `preview`, Firebase e FCM V1; primeira falha de pull do GHCR por IPv6 (web); a cota do Actions começa a acabar                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 27/10/2026      | a web passa a implantar pela API do Dokploy (webhook removido); sondagens mostram a origem exposta; pull da IA falha 3/3 por IPv6; MapTiler e LocationIQ configurados; instruções da produção                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 28/10/2026      | pull da API falha 6/6 por IPv6; exposição da origem medida; `API_PUBLIC_URL` criada no environment `staging` (conferência `http`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 29/10/2026      | entre 27/10 à noite e 02:14, firewall `default` aplicado à VPS; 02:51–03:00, regras só da Cloudflare; ~03:15, commits `577fc5a` e `d413cb1` da API enviados com o nome automático e o IPv6 da VPS (no texto e numa mensagem de commit; tratados como públicos depois das janelas abaixo, seção 1); ~12:45 e ~14:11, repositórios públicos temporariamente, depois privados (terceira janela da API e da web para os merges de produção); ~13:23, preferência por IPv4 no host; produção no ar (API `01526b0`, web `a1c5242`/v1.1.0), com a correção das URLs do banco e os certificados de `www` e `api` emitidos com o registro já com proxy; domínio da web de produção trocado do apex para `www`; Redirect Rule do apex; HSTS na borda; ~17:03, Email Obfuscation desligado; Web Analytics mantido (CSP e política); build manual do app sem `preview` (`213d6b0`); agendamento noturno das suítes da web removido no commit `7f83d8c` (vale quando chegar à `main`); ~21:50, Smart Tiered Cache; ~21:58, Early Hints; 22:23–22:26, token temporário criado, usado e apagado no mesmo dia; ~22:33, JSD desligado e políticas de bots de IA refeitas; ~22:42 (web) e ~22:48 (API), quarta janela pública, ainda aberta às 23:44 (fechamento a confirmar); ~23:45, pacotes do GHCR conferidos privados; ~23:50, teste do desafio HTTP-01 nos cinco hosts: 404 sem redirect                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 30/10/2026      | `APP_ENV=production` na Application da API de produção (o console de integração passa a ser indexável; o staging segue com `noindex`); produção promovida pelo dono, com o `robots.txt` e o `/sitemap.xml` da API (`2d3e547`, `0208102`: em produção, só `/integration/docs`) e, na web, `/login`, `/forgot` e os guias de `/docs` no sitemap; a `trajetto-api` respondia como pública na API do GitHub às ~15:05 (fechamento a confirmar); o dono informa o registrador (GoDaddy), a titularidade das contas na conta Google da Trajetto e o que roda em `uptime` (Uptime Kuma) e `monitor` (Beszel); o `yarn dev` da API passa a gerar o client do Prisma antes de esperar o banco; o dev client do app passa a ser gerado por quem tem _Developer_ na Expo e baixado pelos _Viewers_; auditoria de instabilidade do CI (testes e código da API): com `NODE_ENV=test` o e-mail fica numa caixa em memória (sem Ethereal), nenhum teste conecta fora da máquina (trava do `setupTests.ts`), o `yarn test:e2e` roda em duas fases (réplicas por último, uma por vez) e o pipeline de notificações aproveita o ciclo em andamento em vez de perder o despertar; CI da API sem vermelho que não seja do código: `timeout-minutes` em todo job, `bash -eo pipefail` em todo workflow, Node `22.21.1` em todo job, Postgres, Redis e BuildKit por digest, o `audit-ci` bloqueando só push que muda dependência, o GHCR lido pelo `ghcr.sh` (separa "não existe" de "não respondeu"), o banco do Trivy com cache, os pesos PP-OCRv5 da IA versionados no repositório (o build não fala mais com o ModelScope), cache dos engines do Prisma, retentativas do Dokploy e da conferência pela liveness visíveis, e commit só de documentação promovido com o build do ancestral que o staging rodou (`[skip ci]` só para documentação passa a ser seguro) |

---

## 13. Procedimentos

### 13.1 Recriar tudo do zero

Na ordem. Cada passo aponta para o detalhe.

1. **Contas** (seção 3): as contas, com 2FA, e o gerenciador de senhas.
2. **Domínio e Cloudflare**: a zona `intrajetto.com` na Cloudflare e os
   nameservers no registrador. Depois, na zona: _SSL/TLS_ (seção 6.2), as
   escolhas de _Security_ (Bot Fight Mode desligado, JSD desligado pela API
   conforme a [seção 13.5](#135-reverter-o-javascript-detections) com
   `"enable_js": false`, Email Obfuscation desligado, políticas de IA; seção
   6.5) e de _Speed_ (seção 6.6).
3. **VPS**: o plano da seção 4.1 com o Dokploy. Logo em seguida, para a
   origem ficar exposta o menor tempo possível: o firewall
   ([`deploy.md` → 6.1](./deploy.md#61-firewall-da-vps-contabo)), com a 22
   aberta, o que mantém o painel alcançável pelo túnel do passo 4; o
   endurecimento do SSH ([seção 13.8](#138-endurecer-o-ssh)); a preferência
   por IPv4
   ([`deploy.md` → 6.2](./deploy.md#62-downloads-do-ghcr-pelo-ipv4-preferência-do-sistema));
   a rotação de log e o Traefik
   ([`deploy.md` → 6](./deploy.md#6-preparar-o-servidor-uma-vez)).
4. **Painel do Dokploy**. Com o firewall ativo, a porta 3000 cai no DROP e o
   domínio do painel ainda não existe: o primeiro acesso é por um túnel SSH,
   `ssh -N -L 3000:127.0.0.1:3000 <usuário>@<IP_DA_VPS>`, abrindo
   `http://localhost:3000` no navegador. Por ele: a conta dona, com
   credenciais próprias e 2FA (seção 5.10); o registro `dokploy` na
   Cloudflare **já com proxy** e o domínio do painel (seções 5.1 e 5.5); a
   partir daí, o painel abre por `https://dokploy.intrajetto.com`. Depois: a
   regra de Skip do WAF com a expressão restrita (seção 6.5); a conta admin
   com 2FA; a chave de API (seção 5.8); a credencial do GHCR (seção 5.7); os
   _S3 Destinations_ e as _Notifications_
   ([`deploy.md` → 18](./deploy.md#18-backup-e-restauração)). Alternativa sem
   túnel: aplicar o firewall só depois que o domínio do painel e o
   certificado existirem, aceitando a origem aberta até lá.
5. **R2**: buckets, CORS e um token por bucket (seção 6.10).
6. **Turnstile** e **Access** (seções 6.9 e 6.4).
7. **Provedores**: Resend (seção 9), healthchecks.io, MapTiler, LocationIQ,
   Firebase e Expo (seção 8).
8. **GitHub**: environments, secrets, Rulesets, merge commit, pacotes (seção
   7).
9. **Staging**: DNS (sempre com proxy) e domínios, pelo procedimento "Como
   emitir o próximo" da seção 5.5, com o teste do desafio HTTP-01;
   Databases, IA, `trajetto-api-migrate` e API na ordem de
   [`deploy.md` → 8](./deploy.md#8-primeiro-deploy-na-ordem-com-conferências).
   O GHCR sobrevive à reconstrução, e a tag
   `trajetto-api-migrate:staging-applied` (`:stable-applied` na produção)
   registra o que rodou no banco **antigo**: com o mesmo digest, o pipeline
   pula a etapa de release. Com o Database novo (recriado ou restaurado), dê
   **Deploy** na `trajetto-api-migrate` do ambiente (a tag `:staging` ou
   `:stable` já existe num ambiente que já rodou) e espere `Running` antes do
   deploy da API. Não apague a versão de `-applied` no GHCR: uma versão é o
   digest, o mesmo de `sha-<7>`, `src-<hash>` e da tag do ambiente, e
   apagá-la leva todas junto. Vale também para um Database trocado fora de
   uma reconstrução. Depois: o
   backup; a web
   ([`trajetto-ui/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-ui/blob/staging/docs/deploy.md));
   o app
   ([`trajetto-mobile/docs/deploy.md`](https://github.com/Trajetto-Organization/trajetto-mobile/blob/staging/docs/deploy.md)).
10. **Produção**: a mesma ordem, com a tag `stable` criada antes
    ([`deploy.md` → 8](./deploy.md#8-primeiro-deploy-na-ordem-com-conferências)).
    Recuperando de um desastre: restaure o banco do R2 antes de subir a API
    ([`deploy.md` → Restaurar a partir do R2](./deploy.md#restaurar-a-partir-do-r2)),
    rode a `trajetto-api-migrate` sobre ele como no passo 9 e **não** ligue
    `ALLOW_EMPTY_DATABASE_BOOTSTRAP` (nem na API, nem na
    `trajetto-api-migrate`).
11. **Conferir**: a [seção 13.7](#137-conferir-a-borda-depois-de-mexer-na-cloudflare)
    e o checklist de
    [`deploy.md` → 25](./deploy.md#25-checklist-do-primeiro-deploy).
12. Atualize este arquivo com o que mudou.

Os segredos gerados por nós (seção 11.3) podem ser novos numa reconstrução,
**exceto** o `WEBHOOK_SECRETS_KEY` se o banco for restaurado: sem a mesma
chave, os segredos de webhook dos clientes no dump não abrem.

### 13.2 Entrada (e saída) de um dev

**Entrada**:

1. Convite para a organização do GitHub, papel _Write_ nos repositórios
   necessários, com 2FA obrigatório, **só depois** do Ruleset em `staging` e
   da chave do Dokploy separada por ambiente: Write permite ler os secrets
   pelo código de um workflow
   ([seção 3.2](#32-dar-acesso-a-um-dev-novo-o-mínimo)).
2. O e-mail dele na política `Equipe Trajetto` do Access, para ver o staging.
3. Se for mexer no app: membro da organização `trajetto` na Expo, com papel
   _Viewer_; _Developer_ só para quem precisa publicar, porque ele publica OTA
   na produção sem passar pelo pipeline (seção 3.2).
4. Leitura: este arquivo, o `README.md` e os docs de arquitetura e de testes
   do repositório.
5. Desenvolvimento local com o `.env.example`. Nenhum segredo de staging ou
   produção.

**Saída**: o inverso, no mesmo dia. Se a pessoa tinha acesso ao Dokploy, ela
viu todos os segredos de produção: rotacione os da seção 11.3 e as chaves de
provedores (seção 13.3). Se tinha Write no GitHub, trate como vistos os
secrets que ela alcançava (os de repositório e os do environment `staging`,
seção 3.2) e rotacione-os. Se tinha acesso a uma conta compartilhada (não
deveria), troque a senha dela.

### 13.3 Rotacionar um segredo

A regra geral:

1. gere o valor novo no lugar de origem (painel do provedor ou `openssl`);
2. ponha o valor em **todos** os lugares em que ele precisa estar igual (seção
   11.3 e
   [`deploy.md` → Os três repositórios juntos](./deploy.md#26-os-três-repositórios-juntos));
3. **Save** e **Deploy** em cada Application afetada (salvar sozinho não vale);
4. confira (login, _Sistema → Provedores_, um deploy de teste);
5. só então revogue o valor antigo e atualize o gerenciador de senhas.

Casos com ordem própria:

| Segredo                       | Ordem                                                                                                                                                                                                                                                                                        |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| token do GHCR                 | criar o novo → trocar no Dokploy (cada Application, a `trajetto-api-migrate` inclusive, ou o registry, seção 5.7) → **Deploy** manual da `trajetto-api-migrate` (seguro; esperar `Running`: o pipeline só a roda quando a imagem de migração muda) e um deploy das outras → revogar o antigo |
| chave de API do Dokploy       | gerar a nova → trocar `DOKPLOY_API_KEY` nos quatro environments (API e web, staging e produção) → um push em `staging` → apagar a antiga                                                                                                                                                     |
| `RATE_LIMIT_FORWARDER_SECRET` | API e web do mesmo ambiente em seguida, uma logo depois da outra: enquanto diferirem, o login responde 429 para todos                                                                                                                                                                        |
| _Secret Key_ do Turnstile     | _Rotate_ no widget → web e API do ambiente → Deploy das duas                                                                                                                                                                                                                                 |
| token da IA                   | a IA primeiro, depois a API; entre os dois deploys a leitura de fotos dá 401                                                                                                                                                                                                                 |
| senha do Postgres ou do Redis | o Database, a `DATABASE_URL` da API e a da `trajetto-api-migrate` (no Redis, a `REDIS_URL` da API) na mesma janela; a API fica fora (e a etapa de release falha) enquanto não batem                                                                                                          |
| `JWT_SECRET_REFRESH_TOKEN`    | desloga todo mundo: avise antes                                                                                                                                                                                                                                                              |
| `WEBHOOK_SECRETS_KEY`         | **não rotacione** sem um plano: os segredos cifrados com a chave antiga se perdem, e cada cliente precisa gerar um segredo de webhook novo                                                                                                                                                   |
| tokens R2                     | criar o novo token só no bucket → trocar as variáveis (ou o _S3 Destination_) → Deploy → testar um upload (ou um backup manual) → revogar                                                                                                                                                    |
| `EXPO_TOKEN`                  | criar outro token no robot → trocar o secret → rodar o build manual de `staging` → revogar o antigo                                                                                                                                                                                          |

### 13.4 Atualizar as faixas da Cloudflare

Quando o workflow `Cloudflare ranges` ficar vermelho (o log diz o que
acrescentar ou tirar):

1. Atualize `src/config/trusted-edge.ts` numa branch e leve para `staging` pelo
   fluxo normal (a API passa a confiar na faixa nova para o rate limit).
2. Atualize a linha pronta para colar em
   [`deploy.md` → 6.1](./deploy.md#61-firewall-da-vps-contabo) (um teste exige
   que todas as faixas IPv4 de `trusted-edge.ts` estejam ali).
3. No painel da Contabo, cole a lista nova nas **duas** regras
   (`HTTPS Cloudflare` e `HTTP Cloudflare`), separada por vírgula. Se a
   diferença for só nas faixas IPv6, atualize só o `trusted-edge.ts`: o
   firewall não muda (ele só tem as regras IPv4).
4. Rode o workflow à mão (_Actions → Cloudflare ranges → Run workflow_) e
   confira que ficou verde.
5. Confira a borda (seção 13.7).

Faixa nova que falta no firewall dá erro 522 para os usuários que caem nela.

### 13.5 Reverter o JavaScript Detections

Para religar o JSD (ou desligar de novo numa zona nova), o mesmo caminho de
29/10, com `"enable_js": true` (ou `false`):

1. Crie o token temporário como na seção 6.5 (_Zone · Bot Management · Edit_,
   só em `intrajetto.com`, validade de um dia, nome que diga que é
   temporário).
2. No Git Bash, numa pasta temporária (nunca dentro de um repositório), com o
   token só na memória do shell. A função `cf` passa o cabeçalho pela entrada
   padrão do `curl` (`-K -`), então o token não aparece na lista de processos
   nem no histórico do shell:

   ```sh
   D="$(mktemp -d)" && cd "$D"
   read -rs CF_TOKEN && export CF_TOKEN   # cole o token; nada aparece na tela
   ZONE_ID='<Zone ID da Overview → API>'
   cf() { printf 'header = "Authorization: Bearer %s"\n' "$CF_TOKEN" | curl -s -K - "$@"; }
   cf "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/bot_management" > bot-management-antes.json
   ```

3. Gere o corpo do `PUT` sem editar à mão: o `result` do arquivo acima,
   inteiro e com os mesmos valores, sem o `using_latest_model` (só leitura) e
   com o `enable_js` trocado. O Git Bash não traz `jq`; com o Node (troque
   `false` por `true` para religar):

   ```sh
   node -e "const r=require('./bot-management-antes.json').result;delete r.using_latest_model;r.enable_js=process.argv[1]==='true';require('fs').writeFileSync('bot-management.json',JSON.stringify(r))" false
   ```

   Com `jq`, o equivalente é
   `jq '.result | del(.using_latest_model) | .enable_js = false' bot-management-antes.json > bot-management.json`.
   Campos vistos no `GET` de 29/10 (lista parcial; o arquivo é a fonte):
   `enable_js`, `fight_mode`, `ai_bots_protection`, `ai_training`,
   `ai_search`, `ai_user`, `is_robots_txt_managed`,
   `bot_preference_sync_enabled` e `using_latest_model`.

4. Envie e confira (o segundo comando deve mostrar o `enable_js` novo e
   `"success": true`):

   ```sh
   cf -X PUT -H "Content-Type: application/json" --data @bot-management.json \
     "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/bot_management"
   cf "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/bot_management"
   ```

5. Abra _Security → Settings → Bot traffic → Configure AI bot policies_ e
   confira (ou refaça) Training = Block, Search = Allow, Agent = Allow e o
   _Bot Preference Sync_: o `PUT` pode recalcular o campo antigo de IA.
6. Confira que um robô de IA leva 403 e um navegador leva 200 (o user agent é
   um exemplo; use o atual do GPTBot):

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -A 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)' https://www.intrajetto.com/
   curl -s -o /dev/null -w '%{http_code}\n' https://www.intrajetto.com/
   ```

7. Confira o HTML. Com o JSD desligado, o comando dá `0` (em 29/10 deu `0`
   no `/login` e na home); religado, dá `1` ou mais:

   ```sh
   curl -s https://www.intrajetto.com/login | grep -c 'challenge-platform/scripts/jsd'
   ```

8. Limpeza: apague o token no painel (_My Profile → API Tokens_ → menu ⋯ na
   linha do token → _Delete_), confira que ele sumiu da lista, e no terminal:

   ```sh
   unset CF_TOKEN; cd ~ && rm -rf "$D"
   ```

   Feche o terminal. Os arquivos JSON só tinham configuração, sem segredo, e
   saem junto com a pasta temporária.

9. Registre a mudança nas seções 6.5, 11.4 e 12.

Com o JSD religado, o Lighthouse volta a apontar o script (Best Practices
abaixo de 100).

### 13.6 Abrir e fechar um repositório para usar o Actions grátis

Prefira, nesta ordem: esperar o dia 1º (a cota renova), ou cadastrar uma forma
de pagamento com um _budget_ limitado. Abrir o repositório é o último recurso.

**Antes de abrir**:

1. O job `secrets` (gitleaks) do último push está verde: o histórico inteiro,
   de todas as branches, não tem segredo fora da baseline.
2. Todo segredo que já esteve no histórico foi revogado (hoje, só a
   `ANTHROPIC_API_KEY` antiga, já revogada).
3. O texto atual dos documentos, e as mensagens de commit desde a última
   janela, não têm IPs, hostname da VPS, e-mails nem ids (seção 1). O
   histórico da `trajetto-api` **já contém** o nome automático e o IPv6 da
   VPS (seção 1): abrir esse repositório os expõe de novo, e quem abre aceita
   esse risco conscientemente. O histórico não é reescrito: isso não desfaz a
   exposição (forks, clones e caches já existem) e quebra os SHAs que o
   pipeline usa (`sha-<7>`, `staged-<7>`).
4. Os pacotes do GHCR continuam privados (_Package settings → Danger Zone →
   Change visibility_ mostra o estado).
5. Os artefatos e logs do Actions não têm nada sensível (os secrets são
   mascarados nos logs, mas relatórios de cobertura e de teste ficam visíveis).
6. O endurecimento do SSH ([seção 4.2](#42-ssh-e-console-de-emergência)) e o
   da conta dona do Dokploy ([seção 5.10](#510-usuários-e-conta-dona)) estão
   feitos. Com o IP da VPS público, eles são a defesa que sobra: não abra o
   repositório enquanto uma dessas seções disser "pendente".

**Abrir**: repositório → _Settings → General → Danger Zone → Change repository
visibility → Change to public_. Rode só o que for preciso (o push e o pipeline).

**Fechar**, assim que o run terminar: o mesmo caminho, _Change to private_.
Confira de uma rede sem login: `git ls-remote https://github.com/Trajetto-Organization/<repo>.git`
precisa falhar (pede credencial ou diz que o repositório não existe), e `https://api.github.com/repos/Trajetto-Organization/<repo>`
precisa responder 404.

**Registre** a janela (repositório, horário de abrir e de fechar) na seção 12.

O que vazou durante a janela não volta: forks e clones feitos nesse tempo
continuam com quem os fez.

### 13.7 Conferir a borda depois de mexer na Cloudflare

```sh
# o apex redireciona para o www, mantendo caminho e query
curl -sI 'https://intrajetto.com/blog?x=1' | grep -iE '^(HTTP|location)'
# a web de produção responde, com HSTS
curl -sI https://www.intrajetto.com/ | grep -iE '^(HTTP|strict-transport-security|cf-cache-status)'
# o staging pede o login do Access (302), mas o /build-id.json abre (200)
curl -s -o /dev/null -w '%{http_code}\n' https://staging.intrajetto.com/login
curl -s -o /dev/null -w '%{http_code}\n' https://staging.intrajetto.com/build-id.json
# as APIs respondem pela borda
curl -s https://api-staging.intrajetto.com/health/liveness
curl -s https://api.intrajetto.com/health/liveness
# a origem NÃO responde direto (tem de estourar o tempo: 000)
curl -m 5 -sk -o /dev/null -w '%{http_code}\n' -H 'Host: staging.intrajetto.com' https://<IP_DA_VPS>/
```

O IP da VPS está no painel da Contabo. Não cole a saída com o IP em lugar
nenhum versionado.

Depois de mexer em SSL/TLS, _Always Use HTTPS_, Rules ou Access, rode também
o teste do desafio HTTP-01 da
[seção 5.5](#55-domínios-e-certificados-lets-encrypt): é ele que diz se a
próxima renovação dos certificados vai funcionar.

**Validade dos certificados da origem.** Um teste de fora vê o certificado
de borda da Cloudflare, não o do Let's Encrypt na origem. Para ver o da
origem, rode no host, por SSH:

```sh
for h in www.intrajetto.com api.intrajetto.com staging.intrajetto.com api-staging.intrajetto.com dokploy.intrajetto.com; do
  printf '%s: ' "$h"
  echo | openssl s_client -connect 127.0.0.1:443 -servername "$h" 2>/dev/null | openssl x509 -noout -issuer -enddate | tr '\n' ' '
  echo
done
```

O esperado é o emissor do Let's Encrypt e uma data futura em todos. Rode em
22/12/2026 (seção 14): os certificados de staging, que vencem entre 19 e
22/01/2027, já devem mostrar uma data nova (por volta de março de 2027); se
ainda mostram janeiro, a renovação pela Cloudflare falhou. Os de produção
renovam por volta de 28/12/2026: confira de novo em 30/12/2026.

### 13.8 Endurecer o SSH

Uma ordem que não tranca ninguém do lado de fora: a sessão aberta e o console
VNC ([seção 4.2](#42-ssh-e-console-de-emergência)) ficam como saída até o
fim. `<usuário>` e `<IP_DA_VPS>` estão com o dono e no painel da Contabo.

1. Na máquina do dono, gere a chave (com uma frase-senha):
   `ssh-keygen -t ed25519 -C "<rótulo da máquina>"`.
2. Instale a chave pública no servidor. Com o `ssh-copy-id` (Linux, WSL, Git
   Bash): `ssh-copy-id -i ~/.ssh/id_ed25519.pub <usuário>@<IP_DA_VPS>`. No
   PowerShell, sem ele:

   ```powershell
   Get-Content $env:USERPROFILE\.ssh\id_ed25519.pub | ssh <usuário>@<IP_DA_VPS> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
   ```

3. Abra uma **segunda** sessão e entre com a chave:
   `ssh -i ~/.ssh/id_ed25519 <usuário>@<IP_DA_VPS>`. Deixe a primeira aberta
   até o passo 6.
4. No servidor, crie `/etc/ssh/sshd_config.d/10-hardening.conf`:

   ```
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PermitRootLogin prohibit-password
   ```

   O nome começa com `10-` para ser lido antes do `50-cloud-init.conf` da
   imagem: no sshd vale o primeiro valor lido de cada opção.

5. Valide e recarregue: `sshd -t && systemctl reload ssh`. Se o `systemctl`
   disser que o serviço não está ativo (o Ubuntu 24.04 sobe o sshd sob
   demanda), a configuração vale na próxima conexão.
6. Numa terceira sessão, entre de novo por chave. Confirme que a senha é
   recusada:
   `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password <usuário>@<IP_DA_VPS>`
   tem de responder `Permission denied (publickey)`.
7. Opcional: `apt install fail2ban` (a configuração padrão já protege o
   sshd).
8. Opcional: na regra `SSH` do firewall da Contabo
   ([seção 4.3](#43-firewall)), troque "qualquer IPv4" pelo IP do dono. Se o
   IP dele mudar, o VNC entra para corrigir. Nada do CI usa a 22 (as
   migrations vão pela API do Dokploy e o `ROLLOUT_VERIFY` é `http`); se um
   dia usar `ROLLOUT_VERIFY=ssh`, a 22 precisa voltar a aceitar o runner do
   GitHub, que não tem IP fixo.
9. Se algo der errado: pelo VNC, apague o arquivo do passo 4 e rode
   `systemctl reload ssh`.
10. Guarde uma cópia de segurança da chave privada, protegida pela
    frase-senha, no gerenciador de senhas (seção 1); atualize as seções 4.2,
    4.3 e 11.1 com o estado novo e registre na seção 12.

---

## 14. Pendências conhecidas

Todos os **A confirmar com o dono** deste arquivo estão aqui, uma linha por
item: o que fazer ou conferir, onde (a tela ou o comando) e a seção com o
detalhe. Ao resolver, troque `[ ]` por `[x]`, atualize a seção do provedor e
registre na [seção 12](#12-histórico-de-mudanças). A ordem é a de risco: o que
derruba o sistema, depois o que abre uma brecha, depois o resto.

### 14.1 Risco de queda

- [ ] **Validade do token classic do GHCR** (vencido, todo deploy falha no
      pull): na conta dona do token, GitHub → _Settings → Developer settings
      → Personal access tokens → Tokens (classic)_; anote o nome, a conta, a
      data de validade e onde ele está cadastrado no Dokploy, e ponha um
      lembrete. [Seção 5.7](#57-credencial-do-ghcr).
- [ ] **Validade da chave de API do Dokploy** (vencida, os deploys da API e
      da web falham): Dokploy → _Settings → Profile → API/CLI_; anote o nome
      e a data. [Seção 5.8](#58-chave-de-api-do-dokploy-usada-pelo-ci).
- [ ] **Renovação dos certificados da origem**: em **22/12/2026** (staging) e
      **30/12/2026** (produção), o comando de validade da
      [seção 13.7](#137-conferir-a-borda-depois-de-mexer-na-cloudflare); e o
      teste do desafio HTTP-01 da
      [seção 5.5](#55-domínios-e-certificados-lets-encrypt) depois de toda
      mudança na Cloudflare (passou em 29/10). Sem renovação, 526 a partir de
      19/01/2027.
- [ ] **Como saíram os certificados de produção**: o
      `docker logs dokploy-traefik ...` da
      [seção 5.5](#55-domínios-e-certificados-lets-encrypt).
- [ ] **`ALLOW_EMPTY_DATABASE_BOOTSTRAP=false`** salvo na API de staging e
      na de produção: Dokploy → o environment → `trajetto-api` → aba
      _Environment_. [Seção 5.6](#56-variáveis-por-application).
- [ ] **Backup de produção conferido**: Dokploy → environment `production` →
      `trajetto-postgres` → _Backups_ → rodar o backup manual → Cloudflare →
      _R2_ → o bucket → _Objects_ → prefixo `trajetto-production/` com um
      arquivo da data de hoje e tamanho plausível. Anote o _S3 Destination_
      usado e se o bucket `trajetto-backups-prod` foi criado.
      [Seções 10.2](#102-backups) e [6.10](#610-r2).
- [ ] **Canal de falha de backup**: Dokploy → _Settings → Notifications_,
      com o evento de backup de Database marcado e um teste enviado; anote o
      provedor. [Seção 5.9](#59-backups-do-banco).
- [ ] **Heartbeat de produção**: o check de produção no healthchecks.io e o
      `HEALTHCHECK_PING_URL` na API de produção.
      [Seção 10.1](#101-o-que-existe).
- [ ] **_Enhanced Security for Push Notifications_ desligado** no projeto
      Expo (ligado, todo push falha). [Seção 8.4](#84-push-e-firebase).
- [ ] **Cópia de segurança da keystore Android**: `eas credentials` →
      Android → baixar a keystore → gerenciador de senhas (se o EAS a
      perder, uma build assinada com outra chave não instala por cima do
      app). [Seção 8.2](#82-variáveis-e-credenciais-no-eas).
- [ ] **Application `trajetto-api-migrate`** (desde 31/10/2026 a imagem da
      API não migra no boot): criada em staging e em produção (imagem
      `:staging` / `:stable` com a credencial do GHCR, `DATABASE_URL` sem
      tetos de runtime, _Restart Policy_ `{"Condition":"none"}`), e o
      applicationId de cada uma no secret `DOKPLOY_MIGRATE_APPLICATION_ID`
      do environment ([`deploy.md` → 15](./deploy.md#15-migrations)).
      **`RUN_MIGRATIONS_ON_BOOT=false`** salvo no _Environment_ das duas
      Applications `trajetto-api` (**Save** basta: as imagens novas a
      ignoram) e mantido assim enquanto um build anterior a 31/10/2026
      (`main-<sha>`, ou `sha-<7>` de antes da separação) puder ser alvo de
      rollback: esses builds a leem com padrão `true` e voltariam a migrar no
      boot. Com ela em `false`, a `MIGRATION_DATABASE_URL` da API não é lida
      por build nenhum e pode sair; a variável `MIGRATIONS_VIA_JOB` e o secret
      `DEPLOY_SSH_KEY` do repositório saem, se existirem.
      [Seções 5.2](#52-environments-projetos-e-serviços) e
      [5.6](#56-variáveis-por-application).
- [ ] **`PLAY_SUBMIT_ENABLED`** vazio até o primeiro AAB manual (com `true`
      e sem a Play Console, o envio falha).
      [Seção 7.4](#74-secrets-e-variables).
- [ ] **Secrets da `trajetto-api`**: o `DOKPLOY_AI_APPLICATION_ID` de
      produção cadastrado (sem ele, a IA de produção não é atualizada), o
      `CLIENT_REPOS_READ_TOKEN` existe, e em que nível está o
      `ROLLOUT_VERIFY=http`. [Seção 7.4](#74-secrets-e-variables).
- [ ] **Validade do `API_REPO_READ_TOKEN` e do `CLIENT_REPOS_READ_TOKEN`** e
      as contas donas (vencidos, as suítes de navegador e o contrato de rotas
      param). [Seção 11.1](#111-credenciais-de-infraestrutura-e-de-ci).
- [ ] **Telas de SSL/TLS**: _SSL/TLS → Overview_ em _Full (strict)_;
      _SSL/TLS → Edge Certificates_ com _Minimum TLS Version_ 1.2 e _Always
      Use HTTPS_ ligado. [Seção 6.2](#62-ssltls-e-hsts).
- [ ] **Réplicas da API de produção**: confirmar 1 ou 2 e subir para 2, se
      for a intenção (o orçamento de memória e o rolling update dependem
      disso). [Seção 2.3](#23-staging-e-produção).
- [ ] **_Stop Grace Period_** existe no Dokploy v0.30.10 (sem ele, o
      desligamento da API é cortado em 10 s).
      [Seção 5.11](#511-lacunas-conhecidas).
- [ ] **`HTTP_REQUEST` da web** nos dois ambientes é a URL pública da API, e
      **`NODE_ENV`** não está no _Environment_ de nenhuma Application.
      [Seção 5.6](#56-variáveis-por-application).
- [ ] **Variáveis do ambiente EAS `production`** cadastradas, e a chave FCM
      V1 no campo _FCM V1 service account key_.
      [Seção 8.2](#82-variáveis-e-credenciais-no-eas).

### 14.2 Segurança

- [ ] **Endurecer o SSH** ([seção 13.8](#138-endurecer-o-ssh)) e restringir
      a origem da porta 22, ou registrar o motivo de não restringir. É a
      primeira pendência: o IP da VPS é público
      ([seção 4.3](#43-firewall)).
      [Seção 4.2](#42-ssh-e-console-de-emergência).
- [ ] **Conta dona do Dokploy**: credenciais próprias e fortes (ou
      transferir a propriedade para a conta admin), 2FA nela e na conta
      admin. [Seção 5.10](#510-usuários-e-conta-dona).
- [ ] **Fechar a quarta janela pública** (`trajetto-api` e `trajetto-ui`,
      abertas por volta das 22:45 UTC de 29/10) e registrar a hora; não abrir
      de novo com os dois itens acima pendentes.
      [Seções 7.2](#72-visibilidade-e-a-cota-do-actions) e
      [13.6](#136-abrir-e-fechar-um-repositório-para-usar-o-actions-grátis).
- [ ] **Painel do Dokploy atrás do Cloudflare Access**, com um _Bypass_ só
      das quatro rotas do CI (deploy e etapa de release) ou um _Service
      Token_. [Seção 5.1](#51-o-painel).
- [ ] **Restringir a regra de Skip do WAF** aos quatro caminhos do pipeline
      (deploy e etapa de release) e ao cabeçalho `x-api-key`; conferir em
      _Security → Events_.
      [Seção 6.5](#65-security-ddos-waf-e-bots).
- [ ] **Ruleset em `staging`** exigindo PR com revisão (só o dono na _Bypass
      list_), antes de dar Write a qualquer pessoa.
      [Seções 3.2](#32-dar-acesso-a-um-dev-novo-o-mínimo) e
      [7.5](#75-proteção-das-branches).
- [ ] **Chave do Dokploy por ambiente**, a de staging gerada por um membro
      restrito ao staging.
      [Seção 5.8](#58-chave-de-api-do-dokploy-usada-pelo-ci).
- [ ] **Avaliar mover o `EXPO_TOKEN`** do nível de repositório para os
      environments `staging` e `production` da `trajetto-mobile` (um secret
      de repositório é lido de qualquer branch por quem tem Write).
      [Seção 3.2](#32-dar-acesso-a-um-dev-novo-o-mínimo).
- [ ] **Defesa em profundidade na origem**: tirar a publicação da porta 3000
      do serviço do Dokploy e remover o roteador do Traefik do nome
      automático da Contabo. [Seção 4.3](#43-firewall).
- [ ] **Widget do Turnstile de produção**: o nome e os hostnames reais; só
      `www.intrajetto.com`. [Seção 6.9](#69-turnstile).
- [ ] **URL pública `r2.dev` desligada** nos buckets (R2 → o bucket →
      _Settings_). [Seção 6.10](#610-r2).
- [ ] **Nenhum token antigo da Cloudflare** em _My Profile → API Tokens_.
      [Seção 6.11](#611-tokens-da-api-da-cloudflare).
- [ ] **Segredos locais**: apagar a `ANTHROPIC_API_KEY` do `.env` e do
      `.env.development` locais; revogar o `EXPO_TOKEN` pessoal e o
      `GITHUB_ACCESS_TOKEN` antigo, se existirem; decidir o destino das
      cópias locais de segredos.
      [Seções 1](#regra-de-ouro-este-arquivo-não-guarda-valores) e
      [11.4](#114-temporárias-e-aposentadas).
- [ ] **2FA em todas as contas** da seção 3.1 (Contabo, Cloudflare, GitHub,
      Expo, Firebase, Resend, healthchecks.io, MapTiler, LocationIQ, Meta e a
      GoDaddy), a começar pela **conta Google da Trajetto**, que é a titular
      de quase todas; quem são os owners da organização no GitHub; quem é o
      titular do registro do domínio na GoDaddy.
      [Seção 3.1](#31-as-contas).
- [ ] **Membros da organização `trajetto` na Expo** e o papel de cada um
      (_Viewer_ por padrão).
      [Seção 3.2](#32-dar-acesso-a-um-dev-novo-o-mínimo).
- [ ] **Gerenciador de senhas oficial** e quem tem acesso a ele.
      [Seção 1](#regra-de-ouro-este-arquivo-não-guarda-valores).
- [ ] **Origem de produção na chave do MapTiler** (_Allowed HTTP Origins_)
      e, recomendado, um token do LocationIQ só para a produção.
      [Seção 11.2](#112-credenciais-de-provedores).
- [ ] **Credenciais das notas locais sem dono conhecido**: `R2_BACKUP_*`
      (do antigo `trajetto-backup`, então revogar, ou dos _S3 Destinations_
      atuais), `CLOUDFLARE_R2_API_TOKEN` e `RESEND_SECRET_KEY_DOKPLOY_LOGS`.
      [Seções 11.2](#112-credenciais-de-provedores) e
      [11.4](#114-temporárias-e-aposentadas).
- [ ] **No host**: se existe algum usuário criado por nós além dos da
      imagem, e o que o _Password reset_ do painel da Contabo faz.
      [Seção 4.2](#42-ssh-e-console-de-emergência).
- [ ] Opcional: `RATE_LIMIT_EDGE_SECRET` com a Transform Rule.
      [Seção 6.3](#63-rules).

### 14.3 Servidor e Dokploy

- [ ] **Reboot** pelo "System restart required", numa janela calma, com
      `CHECKPOINT` nos dois Postgres antes.
      [Seção 4.6](#46-manutenção-pendente).
- [ ] **Rotação de log do Docker e configuração do Traefik** aplicadas no
      host. [Seção 4.5](#45-outras-configurações-do-host).
- [ ] **Auto Backup da Contabo**: se continua ligado, a retenção e o custo.
      [Seção 4.1](#41-a-máquina).
- [ ] **Redis de staging**: decidir se recebe o comando personalizado e o
      limite de memória.
      [Seção 5.2](#52-environments-projetos-e-serviços).
- [ ] **Tela do domínio do painel** na v0.30.10.
      [Seção 5.1](#51-o-painel).

### 14.4 Cloudflare

- [ ] Rever o JSD quando o "Precursor" chegar.
      [Seção 6.5](#65-security-ddos-waf-e-bots).
- [ ] Cache de HTML das páginas públicas, com _purge_ a cada deploy.
      [Seção 6.7](#67-caching).
- [ ] Decidir se o domínio vai para a lista de preload do HSTS, e conferir
      o HSTS que chega ao navegador em `www`, no apex e em `api`.
      [Seção 6.2](#62-ssltls-e-hsts).
- [ ] Dispensar a recomendação _Overprovisioned Access Policies_.
      [Seção 6.4](#64-zero-trust-access-staging).
- [ ] Inventário completo do DNS (um _Export_, sem IPs no que vier para
      cá), inclusive os registros do Resend, um eventual DMARC e o MX, e o
      tipo e o destino de `uptime` (Uptime Kuma) e `monitor` (Beszel).
      [Seções 2.4](#24-os-hostnames) e
      [6.1](#61-dns).
- [ ] Quem criou a regra _Rate limit authentication requests_, o que ela
      cobre e se ocupa a regra gratuita de rate limiting.
      [Seção 6.5](#65-security-ddos-waf-e-bots).
- [ ] O arquivo `trajetto-ui-production-apex.yml` não existe no host.
      [Seção 6.3](#63-rules).

### 14.5 Backups e monitoramento

- [ ] Ensaio de restauração com uma cópia real do Dokploy.
      [Seção 10.3](#103-o-que-falta).
- [ ] Uma cópia do banco interno do Dokploy (`dokploy-postgres`) além do
      Auto Backup da Contabo. [Seção 10.2](#102-backups).
- [ ] Monitores de uptime externos (o que o Uptime Kuma já vigia e onde ele
      roda; o que o Beszel vigia e se alerta), alerta de validade dos
      certificados da origem e heartbeat de backup.
      [Seções 10.1](#101-o-que-existe) e [10.3](#103-o-que-falta).
- [ ] Proteção dos objetos do R2: Bucket Lock nos prefixos de prova e cópia
      periódica. [Seção 6.10](#610-r2).
- [ ] O nome real do token R2 de staging, e se a produção tem token e
      destino de backup próprios. [Seção 6.10](#610-r2).

### 14.6 GitHub

- [ ] Environments, Rulesets e o bypass do GitHub Actions nos três
      repositórios, e o _Prevent self-review_.
      [Seções 7.3](#73-environments) e [7.5](#75-proteção-das-branches).
- [ ] Dependabot do app sem `target-branch`: os PRs vão para `main`, o que
      contraria a regra de que `main` só recebe PR de `staging`. Pôr
      `target-branch: staging`, como na API e na web.
      [Seção 7.7](#77-dependabot-e-varredura-de-segredos).
- [ ] Apagar os secrets obsoletos. [Seção 7.4](#74-secrets-e-variables).
- [ ] O que está ligado fora dos arquivos: _Dependabot alerts_, _security
      updates_, _CodeQL default setup_ e a política de actions fixadas por
      SHA. Desde 30/10/2026 os _alerts_ e os _security updates_ são o vigia
      das dependências (o `audit-ci` só bloqueia push que muda dependência):
      confirme que estão ligados nos três.
      [Seção 7.7](#77-dependabot-e-varredura-de-segredos).
- [ ] O valor de `IMAGE_SCAN_ENFORCE` na `trajetto-api` (ligado em 27/10
      para as primeiras correções; ligado, só um achado do Trivy reprova).
      _Settings → Secrets and variables → Actions → Variables_.
      [Seção 7.4](#74-secrets-e-variables).
- [x] ~~A exceção `GHSA-23hp-3jrh-7fpw` do `audit-ci.jsonc` da API~~: saiu
      em 30/10/2026. O bcrypt 6 não tem `@mapbox/node-pre-gyp`, o `audit-ci`
      já avisava que ela não casava com nada, e a auditoria passa sem ela.
- [ ] **Até 31/12/2026**: as três linhas do `.trivyignore` da `trajetto-ui`
      (CVE-2026-75604, GHSA-2xp9-vwfh-vxw4 e GHSA-2464-fhr4-w9xw, todas do
      Next < 15.5.24, com `exp:2026-12-31`) vencem. Depois dessa data o Trivy
      deixa de honrá-las e, com `IMAGE_SCAN_ENFORCE=true` na web, o scan
      reprova o build nelas: suba o Next (migração planejada à parte) ou
      renove cada linha com motivo e data nova. As mesmas exceções estão no
      `audit-ci.jsonc` da web.

### 14.7 Expo e e-mail

- [ ] Assinatura de OTA (sem ela, a produção não recebe OTA pelo CI, e um
      _Developer_ publica OTA sem assinatura) e a Play Console.
      [Seção 8.3](#83-ota-e-build-manual).
- [ ] O projeto Expo duplicado apagado.
      [Seção 8.1](#81-projeto-perfis-e-canais).
- [ ] Resend: o nome da chave de produção, o webhook de produção e os
      eventos marcados em cada webhook; se o staging deve usar o domínio
      real; qual provedor recebe o e-mail do endereço de contato.
      [Seção 9](#9-e-mail-resend).

### 14.8 Documentação fora deste arquivo que ainda descreve o estado antigo

- `trajetto-ui/docs/deploy.md`: HSTS de 2 anos na Cloudflare (o real é 12
  meses), exceção no Bot Fight Mode (não existe no Free e ele está
  desligado), `TURNSTILE_REQUIRED` da API (removida em 25/10) e "Dokploy
  ainda não foi criado".
- `trajetto-api/infra/traefik/README.md`: diz que o apex e o HSTS dele ficam
  no Traefik da web; hoje o redirect é a Redirect Rule da Cloudflare.
- A seção "Os três repositórios juntos" dos três `deploy.md` ainda diz que o
  host da API de produção está "a definir" e que a API tem 2 réplicas (seção
  2.3); ela precisa mudar nos três ao mesmo tempo.
- `README.md` e `variaveis-de-ambiente.md` da API ainda tratam o host de
  produção como previsto.
