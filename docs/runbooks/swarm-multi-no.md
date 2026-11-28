# swarm-multi-no — Labels, placement e um nó novo no Swarm

**Quando:** onda 17 (plano de escala F4-52): os labels e as constraints no nó único, primeiro na staging (já no 2º VPS) e depois na produção. Depois, a cada nó que entra: o prod-db-1 da onda 22 ([producao-servidores-proprios](./producao-servidores-proprios.md)) e os nós de aplicação da onda 23, com o PgBouncer em dois nós.

## O que significa

O Swarm escolhe em que nó roda cada task. Hoje cada ambiente tem um nó só, e tudo roda nele. Com um segundo nó, o Swarm passa a escolher, e três coisas dão errado sem aviso:

- **um serviço com volume sobe noutro nó, com o volume vazio**: o volume é local ao nó. O Dokploy põe `node.role==manager` em todo serviço com volume, o Database incluído, e isso só segura enquanto houver um manager só;
- **uma task cai num nó que não baixa a imagem do GHCR** e fica `Rejected`;
- **as réplicas da API se juntam num nó**, e a queda dele leva todas.

Os **labels** dizem para que serve cada nó, e a **constraint** de cada serviço diz em que nó ele pode rodar. Eles entram já no nó único (decisão D59 do plano de escala): nada muda hoje, e o segundo nó passa a ser só adicionar.

| Label                | O nó que o leva                                                                                                            | Quem exige                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trajetto.app=true`  | roda a aplicação                                                                                                           | a API e os papéis, a migração e a web                                                                                                                                                                                 |
| `trajetto.db=true`   | tem o disco do banco                                                                                                       | o Database PostgreSQL e o PgBouncer                                                                                                                                                                                   |
| `trajetto.ai=true`   | tem CPU para o OCR                                                                                                         | a `trajetto-ai`                                                                                                                                                                                                       |
| `trajetto.edge=true` | recebe o tráfego público: o Traefik do Dokploy, o IP para onde a Cloudflare aponta e as portas 80 e 443 só das faixas dela | nenhum serviço: o Traefik do Dokploy é um contêiner do manager, fora do Swarm. O label marca o nó que leva o registro da Cloudflare e o firewall de borda ([deploy.md, 6.1](../deploy.md#61-firewall-da-vps-contabo)) |

**As constraints**, em _Advanced → Swarm Settings → Placement_ de cada Application (no Database, o campo de mesmo nome). Os campos que não aparecem aqui ficam como estão:

| Serviço                               | Placement                                                                               | Por quê                                                                                                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trajetto-postgres` (Database)        | `{ "Constraints": ["node.labels.trajetto.db==true", "node.hostname==<nó do volume>"] }` | o volume é local. O label diz que é um nó de banco; o hostname prende o banco ao nó do volume, porque com dois nós `trajetto.db` (o 2º PgBouncer, o standby) o label sozinho o deixaria subir no outro, vazio |
| `trajetto-redis` (Database)           | `{ "Constraints": ["node.hostname==<nó do volume>"] }`                                  | um Redis só, num nó certo. Ele é descartável ([ADR 0002](../adr/0002-redis-descartavel.md)), mas mudar de nó zera as chaves, e os sockets reconectam todos                                                    |
| `trajetto-pgbouncer` ×1               | `{ "Constraints": ["node.labels.trajetto.db==true"] }`                                  | perto do banco. **Sem `MaxReplicas`** enquanto for uma task só: com start-first, a task nova não teria vaga (abaixo)                                                                                          |
| `trajetto-pgbouncer` ×2 (onda 23)     | `{ "Constraints": ["node.labels.trajetto.db==true"], "MaxReplicas": 1 }`                | uma task por nó, para a queda de um nó levar só uma. O _Update Config_ e o _Rollback Config_ passam a `"Order": "stop-first"` (abaixo)                                                                        |
| `trajetto-ai`                         | `{ "Constraints": ["node.labels.trajetto.ai==true"] }`                                  | o OCR toma a CPU do nó; num nó próprio, não disputa com a API                                                                                                                                                 |
| `trajetto-api`                        | `{ "Constraints": ["node.labels.trajetto.app==true"], "MaxReplicas": 4 }`               | até 4 réplicas por nó: a queda de um nó leva no máximo 4                                                                                                                                                      |
| `trajetto-worker`                     | `{ "Constraints": ["node.labels.trajetto.app==true"] }`                                 | aplicação                                                                                                                                                                                                     |
| `trajetto-scheduler`                  | `{ "Constraints": ["node.labels.trajetto.app==true"] }`                                 | aplicação                                                                                                                                                                                                     |
| `trajetto-worker-external`            | `{ "Constraints": ["node.labels.trajetto.app==true"] }`                                 | aplicação                                                                                                                                                                                                     |
| `trajetto-realtime`                   | `{ "Constraints": ["node.labels.trajetto.app==true"] }`                                 | aplicação                                                                                                                                                                                                     |
| `trajetto-ingest`                     | `{ "Constraints": ["node.labels.trajetto.app==true"] }`                                 | aplicação                                                                                                                                                                                                     |
| `trajetto-api-migrate`                | `{ "Constraints": ["node.labels.trajetto.app==true"] }`                                 | a mesma imagem da API; num nó de aplicação, nunca no do banco por acaso                                                                                                                                       |
| `trajetto-ui` (projeto `trajetto-ui`) | `{ "Constraints": ["node.labels.trajetto.app==true"] }`                                 | aplicação                                                                                                                                                                                                     |

Os papéis entram na tabela antes de existirem: quem cria a Application de um papel ([deploy.md, seção 19](../deploy.md#criar-a-application-de-um-papel)) já põe a constraint dele.

**O que foi medido** num Swarm descartável de um nó (Docker 27.5.1, em 19/11/2026), com serviços que imitam os do Dokploy (a API com 2 réplicas start-first, o banco stop-first com volume, o PgBouncer start-first):

- labels e constraints que o nó já atende **não trocam nenhuma task**: o `docker service update --constraint-add` deixou as mesmas tasks no mesmo nó, e um deploy forçado, como o _Deploy_ do Dokploy, recriou cada uma no mesmo nó, como um deploy comum;
- **um serviço stop-first cuja constraint pede um label que o nó não tem** (o Database) parou a task velha e deixou a nova `Pending` com "no suitable node": o banco cai até o label existir. Por isso os labels vêm antes das constraints, conferidos no `docker node inspect`;
- **tirar um label que um serviço no ar exige** derruba a task na hora, sem deploy nenhum: o Swarm a recusa com "assigned node no longer meets constraints", e a nova fica `Pending` até o label voltar (aí ela sobe sozinha);
- **`MaxReplicas: 1` com start-first**, num nó que já tem a task, deixou a task nova `Pending` para sempre com "max replicas per node limit exceed": a velha seguiu servindo, e o update nunca terminou. Trocar para stop-first no meio disso deixou o serviço em 0/1 até o deploy seguinte, que destravou. Com stop-first desde o começo, o mesmo `MaxReplicas: 1` convergiu;
- a API com `MaxReplicas: 4` e 2 réplicas fez o rolling start-first normal: a task nova coube ao lado das velhas;
- o `docker node update self` é recusado: use o HOSTNAME do `docker node ls`.

**Regras que valem a partir do segundo nó:**

- **Nunca tire um label** de um nó enquanto um serviço que o exige roda nele: a task cai na hora (medido acima). Para tirar um nó de uso, `docker node update --availability drain <nó>`, que move as tasks com o grace de cada serviço.
- **A API com vaga para o rolling.** Com `MaxReplicas: 4` e start-first, cada rolling precisa de uma vaga livre num nó: as réplicas ficam em no máximo 4 × (nós `trajetto.app`) − 1 (11 em 3 nós, 15 em 4). Com um nó perdido, as réplicas dele só voltam onde houver vaga.
- **O PgBouncer ×2 rola stop-first**, com `MaxReplicas: 1`: a task de um nó drena os clientes nos 90 s do grace enquanto a do outro recebe as conexões novas, e a substituta sobe depois. Cada task tem o seu teto de conexões ao Postgres: com duas, o `PGBOUNCER_MAX_DB_CONNECTIONS` de cada uma cai à metade (30), para o Postgres seguir vendo no máximo 60 pelo PgBouncer, mais os 2 do alias de cada task ([pgbouncer](./pgbouncer.md)).
- **Nenhum _Volume_ nem _File Mount_ nas Applications de aplicação**: o arquivo de um _File Mount_ só existe no nó onde o Dokploy o gravou (o manager), e a task noutro nó não sobe. O certificado do comprovante vai por `PROOF_SIGNING_PFX_BASE64`, nunca por `PROOF_SIGNING_PFX_PATH` ([deploy.md, 7.11](../deploy.md#711-certificado-do-comprovante-a1-icp-brasil)).
- **`docker exec`, `docker ps` e o _Terminal_ do Dokploy só alcançam o nó em que rodam.** O console do PgBouncer, os comandos dos runbooks e os _Schedule Jobs_ do servidor (o backup e o ensaio do PITR acham o Database com um `docker ps` local: [deploy.md, seção 27](../deploy.md#os-schedule-jobs-do-servidor)) rodam no nó da task, que o `docker service ps` do serviço mostra no manager. Antes de o Database sair do manager (onda 22), os _Schedule Jobs_ do PITR precisam rodar no nó dele.
- **A conferência por SSH só lê o digest das tasks do nó em que roda**: com uma task noutro nó, o `verify-rollout.sh` reprova o deploy com "sem container legível neste nó". Antes de uma Application ter task fora do manager, o environment do GitHub passa a `ROLLOUT_VERIFY=http` (a liveness e os papéis do `/health/rollout` veem todos os nós; o rollout do PgBouncer fica só com o aviso, [deploy.md, seção 14](../deploy.md#14-conferir-a-convergência)), ou a conferência por SSH aprende a ler os outros nós. O `infra/pgbouncer/retarget.sh` do failover confere a task saudável só no nó em que roda: rode-o no nó que tem uma task do PgBouncer ([failover-standby](./failover-standby.md)).
- **Quem é cada réplica**: `SWARM_NODE_HOSTNAME={{.Node.Hostname}}`, `SWARM_TASK_SLOT={{.Task.Slot}}` e `SWARM_SERVICE_NAME={{.Service.Name}}`, digitados assim no _Environment_ de cada Application da imagem `trajetto-api` (F4-50), põem o nó no log e no `ops_sample` ([deploy.md, séries de operação](../deploy.md#séries-de-operação-ops_sample)).

O código já não depende de nó: as réplicas não têm afinidade (o tempo real passa pelo Redis, [ADR 0008](../adr/0008-escala-horizontal.md); a prova com 3 réplicas é o F4-51), e o dreno do rolling fecha as conexões HTTP mantidas abertas (F1-15).

## Primeira ação

### No nó único (onda 17)

Primeiro a staging, inteira; uma semana depois, a produção. Os comandos `docker` rodam no host, por SSH; na produção, troque `-staging` por `-production`.

1. **O antes**, num arquivo:

   ```sh
   docker node ls
   docker service ls --format '{{.Name}}' | grep '^trajetto-' | while read -r s; do
     docker service ps "$s" --filter desired-state=running --format "$s {{.Name}} {{.Node}}"
   done | sort > ~/placement-antes.txt
   docker service ls --format '{{.Name}} {{.Replicas}}' | grep '^trajetto-'
   ```

   Cada serviço em N/N (`2/2`, `1/1`). O `<nó>` dos passos seguintes é o HOSTNAME do `docker node ls`.

2. **Os labels**, num comando só, e a conferência:

   ```sh
   docker node update --label-add trajetto.app=true --label-add trajetto.db=true --label-add trajetto.ai=true --label-add trajetto.edge=true <nó>
   docker node inspect <nó> --format '{{json .Spec.Labels}}'
   ```

   Os quatro aparecem com `"true"`. Sem isso, nenhuma constraint.

3. **As Applications**, uma por vez, pela tabela acima: _Advanced → Swarm Settings → Placement_ → **Save** → **Deploy**, e depois a constraint no serviço:

   ```sh
   docker service inspect trajetto-api-staging --format '{{json .Spec.TaskTemplate.Placement}}'
   ```

   A `trajetto-ai`, os papéis que existirem, a `trajetto-api` e a web (no projeto `trajetto-ui`): todas start-first, então o _Deploy_ é um rolling comum. Na `trajetto-api-migrate` e na `trajetto-pgbouncer`, só **Save**: valem no próximo deploy do pipeline (o _Deploy_ da migrate roda a etapa de release, e o do PgBouncer é o rolling de 90 s que se ensaia sob carga, em [pgbouncer](./pgbouncer.md)).

4. **Os Databases, na janela do Postgres e nunca fora dela**: cada _Deploy_ de um Database o para e sobe de novo. O Placement do PostgreSQL (o label e o hostname) e o do Redis (o hostname) entram no mesmo _Deploy_ da janela da troca do digest do Postgres ([deploy.md, Standby](../deploy.md#standby-o-pg_hba-da-imagem-e-o-ramo-standby-onda-17)): `PAUSE trajetto;` no console de administração do PgBouncer (antes de ele existir, sem este passo), `CHECKPOINT;` no banco, o Placement e o digest no Database e **Deploy**, `RESUME trajetto;`. O Redis, logo depois, na mesma janela. Antes, confirme que o painel da sua versão tem o Placement no Database e que o `<nó do volume>` é o HOSTNAME do `docker node ls`. Sem o campo no Database, nada muda no nó único, e o nó novo não entra (Quando escalar).

5. **O depois**: o laço do passo 1, agora em `~/placement-depois.txt`:

   ```sh
   docker service ls --format '{{.Name}}' | grep '^trajetto-' | while read -r s; do
     docker service ps "$s" --filter desired-state=running --format "$s {{.Name}} {{.Node}}"
   done | sort > ~/placement-depois.txt
   ```

### Um nó novo (ondas 22 e 23)

Primeiro na staging. Antes de tudo, as constraints da tabela em **todos** os serviços dos dois projetos (o nó único acima): um serviço sem constraint pode ir para o nó novo no próximo deploy dele.

1. **As portas do Swarm só na rede privada**, entre os nós e em nenhum outro lugar: 2377/tcp (gestão do cluster), 7946/tcp e 7946/udp (descoberta dos nós) e 4789/udp (a overlay). Se a overlay for cifrada (`--opt encrypted`, o plano B da rede entre os nós), também o **protocolo IP 50 (ESP)**, sem o qual os pacotes cifrados somem sem erro. Os comandos do `ufw` estão em [producao-servidores-proprios](./producao-servidores-proprios.md), passo 3. Abertas à internet, a 2377 recebe pedidos de entrada no cluster e a 4789 aceita pacotes da overlay, que sem cifra é texto puro.
2. Dokploy → _Remote Servers_ → o servidor do ambiente → _Cluster → Add Node_, como **worker**. Managers são um ou três, nunca dois: com dois, a queda de um tira o quórum do outro.
3. No manager, `docker node ls`: o nó novo `Ready` e `Active`, **sem label nenhum**. Nenhuma constraint o aceita, e nada vai para ele.
4. **O teste de pull do GHCR**, na staging: o label de aplicação no nó novo, `docker node update --label-add trajetto.app=true <nó novo>`, e **Deploy** da `trajetto-api` da staging com 2 réplicas. O Swarm põe a réplica no nó com menos tasks do serviço, e `docker service ps trajetto-api-staging` mostra uma task `Running` no nó novo. Uma task `Rejected` por "No such image" ou "unauthorized" quer dizer que o nó não recebeu a credencial do GHCR ([deploy.md, 7.3](../deploy.md#73-credencial-do-ghcr)): Quando escalar.
5. Os labels do papel do nó, e só eles. Um nó de aplicação fica com o `trajetto.app` do teste. Um nó de banco ou de IA sai do teste primeiro por `docker node update --availability drain <nó novo>` (as tasks dele voltam ao nó antigo, cada uma com o seu grace; tirar o label com elas no ar as derrubaria na hora), e só então `docker node update --label-rm trajetto.app --label-add trajetto.db=true <nó novo>` (ou `trajetto.ai=true`) e `docker node update --availability active <nó novo>`. O `trajetto.edge` fica só no nó do Traefik. Confira com `docker node inspect <nó novo> --format '{{json .Spec.Labels}}'`.
6. O Swarm não move sozinho o que já roda: um **Deploy** de cada Application espalha as tasks pelos nós que a constraint dela aceita. Um Database novo no nó de banco segue o runbook da virada ([producao-servidores-proprios](./producao-servidores-proprios.md)), com o hostname do nó novo no Placement.

## Como confirmar

- No nó único, o aceite: `diff ~/placement-antes.txt ~/placement-depois.txt` vazio. O mesmo número de tasks, no mesmo nó, e cada serviço em N/N no `docker service ls`, sem task `Pending`.
- O Placement no serviço, depois do _Deploy_: `docker service inspect trajetto-api-staging --format '{{json .Spec.TaskTemplate.Placement}}'` mostra `"Constraints":["node.labels.trajetto.app==true"]` e `"MaxReplicas":4`; o do Database (`docker service inspect trajetto-postgres-staging --format '{{json .Spec.TaskTemplate.Placement}}'`) mostra as duas constraints, e não mais `node.role==manager`.
- Com um nó novo: `docker service ps trajetto-api-staging` com tasks `Running` nos dois nós e, com as variáveis do F4-50, o `metrics.swarm.node` das linhas do `ops_sample` diferente entre as réplicas.

## Quando escalar

- **Uma task `Pending` com "no suitable node"** logo depois de uma constraint: o label falta, ou está escrito de outro jeito. Numa Application (start-first), a task velha segue servindo: corrija o label (`docker node update --label-add …`) e a nova sobe sozinha. No Database (stop-first), o banco está parado: o label primeiro, na hora; se não resolver, apague o Placement do Database e **Deploy** (volta ao padrão do Dokploy), e chame o dono.
- **"max replicas per node limit exceed"**: um `MaxReplicas` sem vaga para o rolling. Tire o `MaxReplicas` (ou, no PgBouncer ×2, passe o _Update Config_ e o _Rollback Config_ a stop-first) e **Deploy** de novo: o deploy seguinte destrava.
- **Uma task `Rejected` no nó novo por "No such image" ou "unauthorized"**: o nó não baixa do GHCR. Drene o nó (`docker node update --availability drain <nó novo>`), confira que as tasks voltaram ao nó antigo e chame o dono antes de qualquer outro nó: sem pull no nó worker, ele não recebe nenhuma Application.
- **O painel do Database sem Placement**, ou um Placement que some depois de um _Deploy_: o banco fica preso a `node.role==manager`, e com mais de um manager ele poderia subir longe do volume. Nenhum nó novo entra até isso estar resolvido.
