# failover-standby — Promover o standby e apontar o PgBouncer para ele

**Quando:** o primário se perdeu (o servidor caiu, o volume quebrou, o Postgres não volta) e existe um standby em streaming; ou o ensaio trimestral ([drills](./drills.md)), na staging do 2º VPS, com um standby temporário.

## O que significa

O failover é manual e ensaiado (decisão D6 do plano de escala): uma pessoa decide, promove o standby e troca o primário para onde o PgBouncer aponta. As Applications do runtime conectam ao `trajetto-pgbouncer`, então do lado delas nada muda além do `PGBOUNCER_PRIMARY_HOST` dele ([pgbouncer](./pgbouncer.md)); as URLs diretas (a `BATCH_DATABASE_URL` e a da `trajetto-api-migrate`) mudam à mão. A meta do ensaio é **RTO < 15 min e RPO < 10 s**.

Três coisas não podem acontecer:

- **Dois primários.** O primário antigo fica parado de vez antes do promote e nunca volta como está: ele e o promovido escreveriam histórias diferentes, e com o PITR ligado os dois arquivariam na mesma stanza. A imagem nunca rebaixa um primário sozinha ([deploy.md, Standby](../deploy.md#standby-o-pg_hba-da-imagem-e-o-ramo-standby-onda-17)).
- **A época do cluster parada.** Depois do promote os ids de transação seguem de onde o standby estava, e um integrador pode ter um cursor com um xid que o primário antigo deu e que esta história vai dar de novo. A etapa de release sobe a época (`infra/sql/50-cluster-epoch.sql`, pela timeline do WAL atual, que muda já no promote), e o feed converte o cursor velho a partir do piso dele: eventos se repetem, nenhum é pulado. Por isso a etapa roda **antes** de o tráfego voltar: ela vai direto ao promovido (passos 5 e 6), e só depois o PgBouncer passa a apontar para ele (passo 7). Se a ordem falhar, o feed se defende: enquanto a linha de `cluster_epoch` não descreve o cluster, o `/integration/v1/events` responde 503 com `Retry-After`, em vez de ler um cursor velho como posição da história nova.
- **Um evento pulado.** O cursor de outra época nunca é confiado; o alerta [feed-epoch-conversion](./feed-epoch-conversion.md) avisa para falar com os integradores.

Quanto se perde (RPO): o que o primário confirmou e ainda não tinha mandado ao standby. A linha-marcador é a `cluster` do `ops_sample`, gravada a cada minuto; o `pg_last_xact_replay_timestamp()` do standby diz até onde ele chegou.

## Primeira ação

Anote cada horário em UTC: o RTO é do passo 1 ao passo 8. Do passo 2 ao 7, o runtime responde 503 com `Retry-After` (o PgBouncer ainda aponta para o primário parado), e o app guarda as escritas na fila dele.

1. **t0.** Confirme que o primário se perdeu de verdade: o Swarm reinicia uma tarefa caída sozinho, e um Postgres em _crash recovery_ volta em minutos. Um failover por um soluço custa uma época nova e a conversão de todos os cursores.
2. **Pare o primário antigo de vez.** Dokploy → Database do primário → **Stop**. Se o servidor dele sumiu, garanta que ele não volte ligado (o servidor desligado no painel da Contabo). Até o fim deste runbook, nada o liga.
3. **Veja até onde o standby chegou**, no `psql` dele (como em [deploy.md, roles do banco](../deploy.md#roles-do-banco-logins-urls-e-conexões), com o App Name do standby):

   ```sql
   SELECT pg_is_in_recovery(), pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(), pg_last_xact_replay_timestamp();
   ```

   Espere o `replay` alcançar o `receive` (segundos). É o ponto em que o promovido começa.

4. **Promova**, no mesmo `psql`:

   ```sql
   SELECT pg_promote();
   CHECKPOINT;
   SELECT pg_is_in_recovery();
   ```

   `pg_promote()` responde `t` e o último `f`. O `CHECKPOINT` não é o que sobe a época (a etapa lê a timeline do WAL), mas encurta a recuperação se o promovido cair logo depois.

5. **As URLs diretas**: na `DATABASE_URL` da `trajetto-api-migrate` e em cada Application com `BATCH_DATABASE_URL` (a `trajetto-api`, ou o worker e o scheduler depois da separação), troque só o host pelo App Name do promovido, **Save**, sem Deploy ainda.
6. **A etapa de release**, antes de o tráfego voltar: Dokploy → `trajetto-api-migrate` → **Deploy**, esperando `Running`. Ela conecta direto ao promovido pela URL do passo 5, sem passar pelo PgBouncer. No log, a linha do `infra/sql/50-cluster-epoch.sql` diz `applied: época N para N+1`; ela também devolve os roles e os grants. Não use o _Run workflow_ com `force_release` aqui: ele valida e reconstrói antes da etapa e implanta o runtime depois dela, minutos além da meta.
7. **O PgBouncer para o promovido**, só com a época já subida, no host do Dokploy, com a chave de API do dono (Dokploy → Settings → Profile → API/CLI) e o `applicationId` da `trajetto-pgbouncer` do ambiente (o mesmo do secret `DOKPLOY_PGBOUNCER_APPLICATION_ID`). O script está no repositório, em `infra/pgbouncer/retarget.sh`; copie-o para o host como o `verify-rollout.sh` ([deploy.md, seção 14](../deploy.md#14-conferir-a-convergência)):

   ```sh
   DOKPLOY_API_KEY=<chave> ./retarget.sh <applicationId> trajetto-postgres-standby-staging \
     --expect-current trajetto-postgres-staging
   ```

   Ele recusa uma Application que não seja o PgBouncer e um host atual diferente do esperado, troca só a linha `PGBOUNCER_PRIMARY_HOST` do _Environment_, faz o **Deploy** (start-first: a tarefa antiga drena os clientes em até 90 s) e só termina quando uma tarefa nova, saudável, responde por dentro (`SHOW DATABASES`) que aponta para o promovido. Se o Dokploy recusar a troca (código 4), faça-a no painel (_Environment_ → a linha → **Save** → **Deploy**) e rode o mesmo comando com `--wait-only`. Daqui em diante o runtime que passa pelo PgBouncer está no promovido.

8. **t1.** **Deploy** das Applications com `BATCH_DATABASE_URL`, uma por vez.
9. **Depois, com calma**:
   - no _Environment_ do promovido, tire `POSTGRES_STANDBY_PRIMARY_HOST`, `POSTGRES_STANDBY_SLOT` e `POSTGRES_REPLICATION_PASSWORD` (a imagem já o sobe como primário, com um aviso no log enquanto elas estiverem lá);
   - com o PITR ligado, um backup completo (`trajetto-backup full`, [restore-drill](./restore-drill.md)): o promovido arquiva numa timeline nova da mesma stanza;
   - um standby novo, do promovido: um Database novo, de volume vazio, da mesma imagem ([deploy.md, Standby](../deploy.md#standby-o-pg_hba-da-imagem-e-o-ramo-standby-onda-17)). O volume do primário antigo nunca vira standby como está: guarde-o até o standby novo estar em streaming e depois apague o Database antigo.

### No ensaio da staging (o standby temporário)

Antes, uma vez: no `psql` do primário da staging, `ALTER ROLE trajetto_replication LOGIN;` e `\password trajetto_replication` (senha de `openssl rand -hex 32`); no _Environment_ dele, `POSTGRES_REPLICATION_CIDR` com a sub-rede da `dokploy-network` (`docker network inspect dokploy-network -f '{{(index .IPAM.Config 0).Subnet}}'`), no próximo **Deploy** planejado do Database (`PAUSE`, `CHECKPOINT`, **Deploy**, `RESUME`: [pgbouncer](./pgbouncer.md)).

1. Crie o Database `trajetto-postgres-standby` (App Name `trajetto-postgres-standby-staging`) com a mesma imagem e o mesmo digest do primário, _Memory Limit_ `1073741824`, sem porta, e no _Environment_: `POSTGRES_MEMORY_LIMIT_MB=1024`, o mesmo `POSTGRES_MAX_CONNECTIONS` do primário, `POSTGRES_STANDBY_PRIMARY_HOST=trajetto-postgres-staging`, `POSTGRES_STANDBY_SLOT=trajetto_standby`, `POSTGRES_REPLICATION_PASSWORD` e o mesmo `POSTGRES_REPLICATION_CIDR` do primário (promovido, ele já aceita o standby da volta). **Nenhuma** `PITR_ARCHIVE` nem `PGBACKREST_*`: promovido, ele arquivaria na stanza da staging. **Deploy**: o log diz "standby clonado" e o primário mostra `SELECT usename, state FROM pg_stat_replication` com `trajetto_replication | streaming`.
2. Com o burn-in limitado rodando (`tests/load/staging-burn-in.sh`), siga os passos 1 a 8 acima com o standby temporário. Anote o RTO e o RPO.
3. **A volta**, planejada e sem perda:
   1. No host, com o Database antigo parado, apague o volume dele (`docker volume ls`, o volume de `trajetto-postgres-staging`; `docker volume rm <volume>`), e no _Environment_ dele ponha `POSTGRES_STANDBY_PRIMARY_HOST=trajetto-postgres-standby-staging`, a mesma senha e `POSTGRES_STANDBY_SLOT=trajetto_back`. **Deploy** do antigo: ele clona o temporário pelo slot, criado no clone, e o segue.
   2. `PAUSE trajetto;` no console do PgBouncer, **Stop** do temporário (ele manda todo o WAL ao standby antes de parar), `SELECT pg_promote();` e `CHECKPOINT;` no antigo, as URLs diretas de volta, a etapa de release no antigo (**Deploy** da `trajetto-api-migrate`: `applied: época N+1 para N+2`), só então `retarget.sh <applicationId> trajetto-postgres-staging --expect-current trajetto-postgres-standby-staging` e `RESUME trajetto;`. Com a pausa longa, o `query_wait_timeout` (5 s) responde 503 aos clientes que esperam: é o esperado na volta.
   3. Tire as variáveis de standby do antigo, apague o Database temporário e, no primário, `SELECT pg_drop_replication_slot('trajetto_standby');` se o slot ainda existir.

## Como confirmar

No promovido, a época subiu e o par bate com o cluster:

```sql
SELECT e.epoch, e.timeline, e.changed_at,
       ('x' || substr(pg_walfile_name(pg_current_wal_lsn()), 1, 8))::bit(32)::integer AS cluster_timeline
FROM cluster_epoch e;
SELECT max(ts) FROM ops_sample WHERE role = 'cluster';
```

- `epoch` é o de antes mais um, `timeline` igual a `cluster_timeline`, e o alerta [cluster-epoch-stale](./cluster-epoch-stale.md) não aparece no `ops-heartbeat`.
- `/health/readiness` responde 200 nas réplicas, e o `/health/metrics` mostra o `pgbouncer` com `host` do promovido nos pools.
- Uma página do `/integration/v1/events` com o cursor guardado antes do failover volta com eventos (repetidos, nunca faltando) e o `feed.epoch_conversions` do `ops_sample` sobe: o poller antigo foi convertido. O alerta [feed-epoch-conversion](./feed-epoch-conversion.md) é esperado: avise os integradores que deduplicam pelo `id`.
- **RPO**: o último `max(ts)` da linha `cluster` no promovido contra o instante em que o primário se perdeu. **RTO**: t1 − t0. Anote os dois na tabela de resultados de [drills](./drills.md).

A fase infra do E2E faz o mesmo caminho a cada CI, num standby descartável: o promote, o feed recusando a página até a etapa, a etapa subindo a época logo depois dele e um cursor da época velha convertido sem pular (`tests/E2E/infra/failover-promote.test.ts`).

## Quando escalar

- O standby está muito atrás (o `replay` longe do `receive`, ou o `pg_last_xact_replay_timestamp()` de minutos antes da queda): o RPO passa da meta. Decida com o dono entre o failover com essa perda e esperar o primário, ou um PITR ([pitr-restore](./pitr-restore.md)).
- O primário antigo voltou ligado depois do promote: pare-o na hora e chame o dono. Escritas nos dois são duas histórias, e só uma fica.
- A etapa de release não subiu a época, ou falhou: não faça o retarget (passo 7) nem o Deploy do runtime (passo 8) até ela passar. Se o retarget já foi feito, o `/integration/v1/events` responde 503 até a etapa passar; o resto do runtime segue.
