# foreign-environment — Processo de outro ambiente gravando neste banco

**Dispara quando:** uma linha viva do `process_heartbeat` deste banco tem um `APP_ENV` diferente do processo que roda o heartbeat (um processo da staging no banco da produção, ou o contrário).

## O que significa

Cada processo grava o seu `APP_ENV` na linha dele. Staging e produção dividem a VPS e a rede `dokploy-network`, então uma Application de um ambiente com a `DATABASE_URL` copiada do outro conecta sem erro nenhum. Esse processo consome as filas deste banco com a configuração do ambiente dele: notificações e webhooks de clientes reais saindo com as chaves, as URLs e o bucket da staging, ou a staging mexendo em dados da produção.

É sempre um erro de configuração, nunca um estado normal. A impressão da configuração dele também é diferente, então a conferência dos papéis do deploy (`ROLLOUT_ROLES_EXPECTED`) não fica verde enquanto ele estiver lá.

## Primeira ação

1. Ache o processo (o motivo do alerta já traz o papel e a réplica):

   ```sql
   SELECT replica, role, app_env, build_commit, node_hostname, started_at, updated_at
   FROM process_heartbeat
   WHERE updated_at > now() - interval '90 seconds'
   ORDER BY app_env, role;
   ```

2. No Dokploy, no environment do `APP_ENV` que aparece na linha, abra a Application daquele papel e confira a `DATABASE_URL` (e a `DATABASE_READ_URL`, a `BATCH_DATABASE_URL` e a `REDIS_URL`) no _Environment_: o host tem de ser o Database do próprio ambiente (`trajetto-postgres-staging` na staging, `trajetto-postgres-production` na produção).
3. Pare o processo errado primeiro (_Stop_, ou _Replicas 0_) e só então corrija a URL e faça o Deploy.
4. Se o processo da staging consumiu filas da produção, levante o que ele mandou: as `notification_delivery` e os `webhook_delivery` processados no intervalo em que a linha esteve viva.

## Como confirmar

A consulta não mostra mais linhas de outro `APP_ENV`, e o motivo some do heartbeat (uma linha sem batida sai da janela de 90 s sozinha).

## Quando escalar

Sempre avise o dono: um processo de outro ambiente no banco da produção é um incidente de dados. Se ele mandou mensagens a clientes ou mexeu em dados, o dono decide o comunicado e a correção.
