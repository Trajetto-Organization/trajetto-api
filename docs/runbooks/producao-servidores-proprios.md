# producao-servidores-proprios — A produção nos servidores próprios (prod-1 e prod-db-1)

**Quando:** onda 22 (V-01 a V-06), condição do primeiro cliente de escala, com os portões B e do 100k aprovados no hardware-alvo ainda vazio (V-02).

## O que significa

A produção sai da VPS 1 para dois servidores próprios, na mesma região dela e com a rede privada ligada entre eles:

- **prod-1**: um VDS de 12 núcleos dedicados (48 GB, 360 GB), cadastrado como _Remote Server_ do mesmo Dokploy. Recebe as Applications: API e papéis, migrate, IA, web e PgBouncer.
- **prod-db-1**: um VDS de 8 núcleos (32 GB) com disco extra, que entra como **nó do Swarm do prod-1** (_Cluster → Add Node_), com o label `trajetto.db=true`. Recebe o Database PostgreSQL. Nós de aplicação extras entram do mesmo jeito, nunca como _Remote Servers_ independentes.

O painel do Dokploy e os monitores ficam na VPS 1, que deixa de rodar a produção.

As Applications vão por um de dois caminhos, os mesmos da staging ([staging-remote-server.md](./staging-remote-server.md)): **(a) transferência** pelo Dokploy v0.31.x, mantendo App Names e `applicationId`, se o ensaio da staging passou; ou **(b) recriação**, com a mesma lista fechada, na coluna da produção. O banco **nunca** vai por transferência nem por dump: vai por um standby restaurado do pgBackRest e um `promote`, que mantém o system-id, a stanza e o PITR. O `pg_dump` com restore fica como plano B.

Depois da virada: 24 h de go/no-go com um dump reverso pronto; passado o prazo, só correção para frente. A produção antiga fica parada 7 dias na VPS 1 e então é apagada.

Os nomes `trajetto-*-production` e `prod-1`/`prod-db-1` abaixo são marcadores; nenhum valor de segredo aparece aqui.

## Primeira ação

### Semanas antes (V-01 e V-02)

1. Os dois servidores contratados, na região da VPS 1, com a rede privada ligada, e o repo2 do pgBackRest (Backblaze B2 com Object Lock, `PGBACKREST_REPO2_*` no Database da produção atual) com `pgbackrest --stanza=trajetto --repo=2 check` verde.
2. O prod-1: _Remote Servers → Add_ → _Setup Server_. O firewall da Contabo como o da VPS 1 ([deploy.md, seção 6.1](../deploy.md#61-firewall-da-vps-contabo)): 80 e 443 só das faixas da Cloudflare, SSH, e o resto fechado.
3. **As portas do Swarm só na rede privada**, entre o prod-1 e cada nó, e em nenhum outro lugar: 2377/tcp (gestão do cluster), 7946/tcp e 7946/udp (descoberta dos nós) e 4789/udp (a overlay). Se a overlay for cifrada (`--opt encrypted`, o plano B da rede entre os nós), também o **protocolo IP 50 (ESP)**, sem o qual os pacotes cifrados somem sem erro. No firewall da Contabo, a fonte é a faixa da rede privada; se ele não cobrir a interface privada, no host:

   ```sh
   ufw allow in on <interface privada> proto tcp from <faixa privada> to any port 2377
   ufw allow in on <interface privada> from <faixa privada> to any port 7946
   ufw allow in on <interface privada> proto udp from <faixa privada> to any port 4789
   ufw allow in on <interface privada> proto esp from <faixa privada>
   ```

4. O prod-db-1 no Swarm do prod-1: _Remote Servers_ → prod-1 → _Cluster → Add Node_, como **worker** (um manager só, ou três: dois quebram o quórum). Os labels, no manager:

   ```sh
   docker node ls
   docker node update --label-add trajetto.app=true <nó do prod-1>
   docker node update --label-add trajetto.db=true <nó do prod-db-1>
   ```

5. **O placement por label** (F4-52, onda 17): o Dokploy põe `node.role==manager` em todo serviço com volume, e o banco precisa de `node.labels.trajetto.db==true` no lugar disso. Confirme, primeiro na staging, que a versão instalada aceita o placement no Database e que ele sobrevive a um **Deploy**:

   ```sh
   docker service inspect trajetto-postgres-production --format '{{json .Spec.TaskTemplate.Placement}}'
   ```

   Sem isso, a virada não começa.

6. Um teste de pull do GHCR numa task no nó worker (primeiro na staging): a credencial do GHCR vale para o serviço inteiro, e um nó que não baixa a imagem deixa a task em `Pending`.
7. Os portões B e do 100k no hardware vazio (V-02), com os relatórios aprovados.

### As Applications, pelo caminho (a) ou (b)

- **(a) Transferência**: cada Application da produção para o prod-1, uma por vez, com a ação de transferir da v0.31.x, mas **só na janela**, depois do banco (abaixo), porque a Application transferida passa a procurar o banco na rede do prod-1.
- **(b) Recriação**: antes da janela, todas criadas no prod-1 com **0 réplicas**, pelo guia de [deploy.md, seção 7](../deploy.md#7-montar-o-dokploy-do-zero-staging-e-produção) e pela seção 3.4 do plano de escala, com o Environment copiado da produção e a lista fechada de [staging-remote-server.md](./staging-remote-server.md#caminho-b-recriação) aplicada na coluna da produção: os secrets `DOKPLOY_*_APPLICATION_ID` e as vars `SWARM_*_SERVICE` e `ROLLOUT_*` do environment `production` do GitHub, o `DOKPLOY_UI_APPLICATION_ID` da web, as `DEPLOY_SSH_*` com o host do prod-1 (a produção confere por SSH por padrão) e o forced command do verify-rollout instalado nele, o `HTTP_REQUEST` interno da web, o `PGBOUNCER_PRIMARY_HOST` e as URLs do banco e do Redis.

### O banco: standby restaurado e promote

Os comandos `docker service` rodam no manager (o prod-1); `docker ps`, `docker exec` e `docker run` rodam no servidor onde o contêiner está: o banco antigo na VPS 1, o novo no prod-db-1.

1. No Swarm do prod-1, um Database PostgreSQL novo com a **mesma imagem** `trajetto-postgres` por digest e o mesmo _Environment_ do Database da produção ([deploy.md, seção 27](../deploy.md#27-pitr-com-pgbackrest)), com o placement por label (ele roda no prod-db-1) e o teto do hardware novo. O primeiro **Deploy** cria um cluster vazio: pare o Database e restaure como standby no volume dele, com o token só de leitura no lugar do de escrita:

   ```sh
   # no prod-1: o volume do Database novo
   docker service inspect trajetto-postgres-production --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{.Source}}{{end}}'
   # no prod-db-1, com esse nome em v
   docker run --rm -u postgres -v "$v":/var/lib/postgresql/data --env-file <arquivo com o Environment, apagado depois> \
     ghcr.io/trajetto-organization/trajetto-postgres@sha256:<digest> \
     pgbackrest --stanza=trajetto --pg1-path=/var/lib/postgresql/data --type=standby --delta restore
   ```

   Suba o Database de novo: ele entra em recuperação e segue o arquivo (o WAL no R2), com atraso de até o `archive_timeout` (60 s). Com o `PITR_ARCHIVE=on` no Environment, ele só passa a arquivar depois do `promote`.

2. **A janela** (de madrugada, com aviso): todas as Applications da produção antiga em 0 réplicas (nenhuma escrita); no banco antigo, o último segmento para o arquivo, e só depois a parada:

   ```sh
   c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-production)
   docker exec "$c" psql -U trajetto -d trajetto -Atc 'CHECKPOINT' -c 'SELECT pg_walfile_name(pg_switch_wal())'
   docker exec "$c" psql -U trajetto -d trajetto -Atc 'SELECT last_archived_wal FROM pg_stat_archiver'
   ```

   Quando o `last_archived_wal` chegar ao segmento do `pg_switch_wal`, **Stop** no Database antigo. **Nunca dois primários na mesma stanza**: o antigo para antes do `promote`.

3. No standby, confirme que ele aplicou esse segmento (`SELECT pg_last_wal_replay_lsn()` e o log "restored log file") e promova:

   ```sh
   c=$(docker ps -q -f label=com.docker.swarm.service.name=trajetto-postgres-production)
   docker exec "$c" psql -U trajetto -d trajetto -Atc 'SELECT pg_promote()'
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto check
   docker exec -u postgres "$c" pgbackrest --stanza=trajetto --repo=2 check
   ```

4. A etapa de release: **Deploy** na `trajetto-api-migrate-production` do prod-1 (roles, grants e a época do cluster, que sobe depois de um promote). Depois o PgBouncer, a API e os papéis, na ordem da seção 3.8 do plano (V-04), e a web.
5. Cloudflare: os registros de `api` e `www` para o IPv4 do prod-1, com o proxy ligado.
6. Um full logo depois: `docker exec -u postgres "$c" trajetto-backup full`.

**Plano B do banco** (o standby não sobe ou não alcança o último segmento): `pg_dump` do banco antigo e restore no Database novo. O cluster novo tem outro system-id: `stanza-create` num caminho novo do repositório (`PGBACKREST_REPO1_PATH`, como na staging) antes de ligar o arquivamento, e um full logo depois da virada.

### Depois da janela

1. **Go/no-go de 24 h**: um dump reverso do banco novo pronto para restaurar na VPS 1, e a decisão no fim do prazo. Passadas as 24 h, só correção para frente.
2. A produção antiga parada 7 dias na VPS 1; depois, **Delete** de cada Application e Database dela. A VPS 1 fica com o painel do Dokploy e os monitores.

## Como confirmar

- `docker service ls` no prod-1 lista a produção, e `docker node ls` mostra o prod-db-1 como worker com o banco nele (`docker service ps trajetto-postgres-production`).
- `pgbackrest check` verde nos dois repositórios logo depois do promote, e o próximo `trajetto-backup` sem `archive-gap`.
- `/health/rollout` com os papéis no commit promovido, e o feed de integração sem pulo (a época subiu).
- Reiniciar a VPS 1 dá 0 checks falhos da produção no healthchecks.io.

## Quando escalar

Antes do `promote`, qualquer dúvida volta atrás sem perda: suba de novo as réplicas da produção antiga e religue o Database antigo. Depois do `promote`, um segundo primário arquivando na mesma stanza, um `pgbackrest check` vermelho ou uma réplica que não acha o banco: chame o dono na hora; até o fim do go/no-go, a volta é pelo dump reverso.
