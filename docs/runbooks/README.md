# Runbooks

Um arquivo por motivo de alerta do `ops-heartbeat`
(`src/shared/health/alert-rules.ts`): todo motivo termina com
`(runbook: docs/runbooks/<código>.md)`, e o código é estável. Cada runbook
tem quatro seções: o que significa, a primeira ação, como confirmar e quando
escalar. Um código novo vem com o runbook no mesmo commit:
`tests/unitaires/lifecycle/runbooks.test.ts` recusa um sem o outro.

Regras, limiares e como ligar o monitor externo:
[deploy.md, Alertas e monitoramento](../deploy.md#20-alertas-e-monitoramento).

## Motivos de alerta

| Código                                                  | O que é                                                  | Dispara quando                                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [outbox-lag](./outbox-lag.md)                           | Outbox parado                                            | evento do outbox devido há mais de 5 min                                                                                               |
| [delivery-lag](./delivery-lag.md)                       | Entregas paradas na fila                                 | entrega devida há mais de 5 min (internas) ou 15 min (externas)                                                                        |
| [webhook-lag](./webhook-lag.md)                         | Webhooks de integração parados                           | webhook devido há mais de 30 min                                                                                                       |
| [ai-lag](./ai-lag.md)                                   | Análises de IA paradas                                   | análise de IA devida há mais de 15 min                                                                                                 |
| [job-overdue](./job-overdue.md)                         | Job durável sem ninguém para rodar                       | job durável (`background_job`) PENDING e devido há mais de 10 min                                                                      |
| [job-failing](./job-failing.md)                         | Job que precisa terminar está falhando                   | exclusão de empresa ou anonimização de pessoa que gastou as tentativas normais e segue falhando, ou que falhou de vez nas últimas 24 h |
| [channel-credential](./channel-credential.md)           | Credencial de um canal recusada                          | a primeira entrega que falhou por credencial nos últimos 10 min                                                                        |
| [channel-failure-burst](./channel-failure-burst.md)     | Rajada de falhas num canal                               | 50 entregas do mesmo canal falharam de vez em 10 min                                                                                   |
| [ai-provider-paused](./ai-provider-paused.md)           | Análises de IA pausadas pelo provedor                    | pedidos devidos esperando porque o provedor recusou o serviço                                                                          |
| [ai-credential](./ai-credential.md)                     | Credencial da IA recusada                                | análise recusada pelo provedor por credencial (401/403)                                                                                |
| [cron-lease-expired](./cron-lease-expired.md)           | Cron interrompido no meio                                | execução RUNNING com o lease vencido                                                                                                   |
| [cron-partial-stuck](./cron-partial-stuck.md)           | Expurgo só parcial há 26 h                               | 26 h só de execuções parciais                                                                                                          |
| [cron-overdue](./cron-overdue.md)                       | Cron sem sucesso                                         | job sem execução bem-sucedida há 26 h, ou que rodou e nunca teve sucesso                                                               |
| [partition-runway-low](./partition-runway-low.md)       | Partições acabando                                       | uma tabela particionada do registro com menos de 3 dias de partições à frente                                                          |
| [partition-lookahead-low](./partition-lookahead-low.md) | Folga de partições baixa                                 | uma tabela particionada do registro com menos de 5 dias de partições à frente                                                          |
| [partition-stuck](./partition-stuck.md)                 | Partição velha presa                                     | partição que passou da retenção há mais de 3 dias e continua no banco                                                                  |
| [worker-stuck](./worker-stuck.md)                       | Worker travado numa réplica                              | worker sem sinal de progresso há 10 min numa réplica viva                                                                              |
| [connection-usage-high](./connection-usage-high.md)     | Conexões do Postgres perto do teto                       | conexões em 80% de max_connections                                                                                                     |
| [socket-cap-high](./socket-cap-high.md)                 | Sockets de uma réplica perto do teto                     | os sockets de uma réplica em 80% do `socket_cap` dela                                                                                  |
| [memory-budget](./memory-budget.md)                     | Orçamento de memória de uma réplica não fecha            | a soma do heap, das threads da planilha e da reserva nativa de um processo passa do teto do contêiner (`memory_budget.ok = false`)     |
| [queue-no-consumer](./queue-no-consumer.md)             | Fila sem processo que a consuma                          | uma fila com item devido há mais de 2 min e nenhum processo vivo deste ambiente no `process_heartbeat` que a consuma                   |
| [mixed-versions](./mixed-versions.md)                   | Processos em commits diferentes                          | os processos vivos deste ambiente em dois ou mais commits há mais de 30 min                                                            |
| [foreign-environment](./foreign-environment.md)         | Processo de outro ambiente neste banco                   | uma linha viva do `process_heartbeat` com outro `APP_ENV` (um processo da staging no banco da produção, ou o contrário)                |
| [redis-down](./redis-down.md)                           | Redis sem resposta                                       | Redis não responde ao PING em 2 s                                                                                                      |
| [pitr-archive-off](./pitr-archive-off.md)               | PITR esperado com o arquivamento desligado               | PITR_EXPECTED=true e archive_mode diferente de on                                                                                      |
| [wal-archive-stalled](./wal-archive-stalled.md)         | Arquivamento do WAL parado ou falhando                   | com o arquivamento ligado, último segmento há mais de 300 s, ou a última tentativa falhou                                              |
| [xid-age-high](./xid-age-high.md)                       | Idade do xid alta                                        | age(datfrozenxid) do cluster acima de 1 bilhão                                                                                         |
| [long-write-xact](./long-write-xact.md)                 | Transação de escrita aberta há muito tempo               | escrita aberta há mais de LONG_WRITE_XACT_ALERT_SECONDS (120 s)                                                                        |
| [pg-wal-high](./pg-wal-high.md)                         | pg_wal grande                                            | pg_wal acima de PG_WAL_ALERT_GIB (12 GiB; 8 na VPS única)                                                                              |
| [redis-evictions](./redis-evictions.md)                 | Redis despejando chaves                                  | evicted_keys cresceu desde a linha cluster de 15 a 20 min atrás                                                                        |
| [redis-memory-policy](./redis-memory-policy.md)         | Redis sem teto de memória ou com noeviction              | Redis respondendo sem maxmemory ou com maxmemory-policy noeviction                                                                     |
| [proof-signing](./proof-signing.md)                     | Certificado do comprovante vencendo, vencido ou inválido | certificado A1 vence em 30 dias (aviso) ou 7 (crítico), venceu ou não abre                                                             |
| [volume-near-gate](./volume-near-gate.md)               | Volume de entregas perto do portão aprovado              | os 7 dias projetados para o mês acima de 70% do portão aprovado, ou o dia acima do teto suave                                          |
| [geocoding-quota-high](./geocoding-quota-high.md)       | Consumo do dia da geocodificação perto da cota           | as consultas do dia da conta do geocodificador acima de 70% de LOCATIONIQ_DAILY_QUOTA                                                  |
| [provider-throttled](./provider-throttled.md)           | Provedor recusando por taxa                              | a Meta (130429 ou 429), a Resend ou o Expo (429) recusaram um envio por taxa nas últimas 24 h                                          |
| [feed-txid-regressed](./feed-txid-regressed.md)         | Txid do feed à frente do cluster                         | o maior delivery_event.txid gravado não está abaixo do próximo xid do cluster (restore lógico sem o pg_resetwal -e)                    |
| [cluster-epoch-stale](./cluster-epoch-stale.md)         | Época do cluster velha                                   | o system_identifier ou a timeline do Postgres mudaram (PITR, promote, cluster novo) e a etapa de release não rodou depois              |
| [feed-epoch-conversion](./feed-epoch-conversion.md)     | Cursor do feed de outra época do cluster                 | o feed converteu, nos últimos 15 min, um cursor emitido antes de um PITR, promote ou restore                                           |
| [collection-incomplete](./collection-incomplete.md)     | Verificação incompleta                                   | uma parte do estado da operação não pôde ser lida                                                                                      |

## Operação

Incidentes que nenhuma regra nomeia ainda e as mudanças de servidor planejadas (`OPERATION_RUNBOOKS`).

| Runbook                                                           | O que é                              | Quando                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| [provider-down](./provider-down.md)                               | Provedor externo fora                | Meta, Expo, Resend ou LocationIQ fora do ar ou lento                                                                              |
| [reconnect-storm](./reconnect-storm.md)                           | Tempestade de reconexão              | depois de um deploy ou de uma queda de rede, todos os sockets voltam juntos                                                       |
| [migration-lock](./migration-lock.md)                             | Migration presa num lock             | a etapa de release espera por um lock e falha pelo lock_timeout                                                                   |
| [disk-full](./disk-full.md)                                       | Disco do servidor enchendo           | disco do host acima de 80% (e-mail) ou 85% (Telegram)                                                                             |
| [pitr-restore](./pitr-restore.md)                                 | Restaurar o banco até um momento     | um apagamento acidental, uma migration ruim ou a perda do banco                                                                   |
| [restore-drill](./restore-drill.md)                               | Ensaio mensal de restauração         | todo mês, no dia 1 às 05:45 UTC, e depois de mudar o backup                                                                       |
| [staging-remote-server](./staging-remote-server.md)               | A staging num Remote Server (2º VPS) | onda 16 (G-03), depois dos portões no 2º VPS vazio                                                                                |
| [producao-servidores-proprios](./producao-servidores-proprios.md) | A produção no prod-1 e no prod-db-1  | onda 22, antes do primeiro cliente de escala                                                                                      |
| [delivery-event-writer-bound](./delivery-event-writer-bound.md)   | Escrita no histórico recusada        | um erro `TJ001`: INSERT em `delivery_event` numa transação aberta há mais de 240 s                                                |
| [history-window](./history-window.md)                             | Janela do histórico                  | a janela de madrugada aprovada da onda 11, o ensaio antes dela e a volta nos 14 dias                                              |
| [feed-frozen](./feed-frozen.md)                                   | Feed de eventos parado               | o `/integration/v1/events` sem eventos novos enquanto as entregas acontecem: uma transação de escrita aberta no cluster           |
| [partition-missing](./partition-missing.md)                       | Partição faltando                    | um INSERT recusado com `23514` (`no partition of relation`), ou o `partition-maintenance` sem a partição de ontem, hoje ou amanhã |
| [partition-detach-pending](./partition-detach-pending.md)         | Detach de partição pendente          | `detach_pending` acima de 0 em `partitions.<tabela>`: um `DETACH … CONCURRENTLY` interrompido                                     |
| [load-shedding](./load-shedding.md)                               | Descarte de carga                    | 503 `SERVICE_BUSY`, ou recusas contadas em `shedding`, ou a decisão de ligar o `enforce`                                          |
| [noisy-tenant](./noisy-tenant.md)                                 | Empresa barulhenta                   | 429 `TENANT_BUSY`, ou uma empresa estourando o orçamento em `panel_budget`                                                        |
| [trail-archive](./trail-archive.md)                               | Arquivamento da trilha               | `partition-stuck` na trilha de posições, ou um pedido de um dia que já saiu do banco                                              |
