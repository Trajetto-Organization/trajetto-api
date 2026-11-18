# queue-no-consumer — Fila com item devido e nenhum processo que a consuma

**Dispara quando:** uma fila (outbox, entregas internas, entregas externas, webhooks ou IA) tem um item devido há mais de 2 min e nenhum processo vivo deste ambiente no `process_heartbeat` declara consumi-la.

## O que significa

Desde a onda 12 do plano de escala, a mesma imagem roda em papéis (`PROCESS_ROLE`): a `trajetto-api` em `api` só recebe as requisições e publica nas filas, e a `trajetto-worker` (papel `worker`) as consome. Cada processo grava a cada 30 s a sua linha no `process_heartbeat`, com as filas que consome (`WORKER_QUEUES`). Este alerta diz que existe trabalho devido numa fila e que nenhum processo vivo deste ambiente a consome: o worker caiu, não foi criado, ficou com `Replicas 0`, ou o `PROCESS_ROLE`/`WORKER_QUEUES` das Applications deixou a fila sem dono (por exemplo, `WORKER_QUEUES` sem `external` e sem a `trajetto-worker-external`).

Nada se perde: o item fica no Postgres e é processado assim que um consumidor voltar. Mas as notificações, os webhooks ou as leituras de IA daquela fila estão parados. Se o processo que caiu é o único com o cron (o worker), o heartbeat inteiro para e quem avisa é o silêncio do monitor externo, não este alerta.

## Primeira ação

1. Veja quem está vivo e o que cada um consome:

   ```sql
   SELECT role, app_env, build_commit, queues, cron, updated_at
   FROM process_heartbeat
   WHERE updated_at > now() - interval '90 seconds'
   ORDER BY role;
   ```

2. Dokploy → projeto `trajetto-api` → environment → `trajetto-worker`: a Application está com réplicas, sem erro no deploy e com o log mostrando `workers started`? Se caiu, _Deploy_ de novo; se não sobe, leia o log do boot.
3. Se a fila não está no `WORKER_QUEUES` de ninguém, corrija o _Environment_ da Application certa (o padrão do papel `worker` é todas as filas) e faça o Deploy.
4. Para voltar ao jeito de antes enquanto investiga: `PROCESS_ROLE=all` na `trajetto-api` (ela volta a consumir tudo) e Deploy. Só depois ponha o worker em `Replicas 0`, se for o caso.

## Como confirmar

A consulta acima mostra um processo vivo com a fila em `queues`, o lag da fila em `/health/metrics` volta a cair e o motivo some do próximo minuto do heartbeat.

## Quando escalar

Se o worker não sobe nem com o Deploy de novo, ou o `PROCESS_ROLE=all` na API também não consome a fila, chame o dono: pode ser o banco recusando as conexões do papel (`trajetto_worker`), uma migration pendente ou o build com defeito, e o rollback (`production.yml` com `image_tag`) é a saída.
