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

| Código                                              | O que é                                                  | Dispara quando                                                                                |
| --------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [outbox-lag](./outbox-lag.md)                       | Outbox parado                                            | evento do outbox devido há mais de 5 min                                                      |
| [delivery-lag](./delivery-lag.md)                   | Entregas paradas na fila                                 | entrega devida há mais de 5 min (internas) ou 15 min (externas)                               |
| [webhook-lag](./webhook-lag.md)                     | Webhooks de integração parados                           | webhook devido há mais de 30 min                                                              |
| [ai-lag](./ai-lag.md)                               | Análises de IA paradas                                   | análise de IA devida há mais de 15 min                                                        |
| [channel-credential](./channel-credential.md)       | Credencial de um canal recusada                          | a primeira entrega que falhou por credencial nos últimos 10 min                               |
| [channel-failure-burst](./channel-failure-burst.md) | Rajada de falhas num canal                               | 50 entregas do mesmo canal falharam de vez em 10 min                                          |
| [ai-provider-paused](./ai-provider-paused.md)       | Análises de IA pausadas pelo provedor                    | pedidos devidos esperando porque o provedor recusou o serviço                                 |
| [ai-credential](./ai-credential.md)                 | Credencial da IA recusada                                | análise recusada pelo provedor por credencial (401/403)                                       |
| [cron-lease-expired](./cron-lease-expired.md)       | Cron interrompido no meio                                | execução RUNNING com o lease vencido                                                          |
| [cron-partial-stuck](./cron-partial-stuck.md)       | Expurgo só parcial há 26 h                               | 26 h só de execuções parciais                                                                 |
| [cron-overdue](./cron-overdue.md)                   | Cron sem sucesso                                         | job sem execução bem-sucedida há 26 h, ou que rodou e nunca teve sucesso                      |
| [partition-runway-low](./partition-runway-low.md)   | Partições de posição acabando                            | driver_position com menos de 3 dias de partições à frente                                     |
| [worker-stuck](./worker-stuck.md)                   | Worker travado numa réplica                              | worker sem sinal de progresso há 10 min numa réplica viva                                     |
| [connection-usage-high](./connection-usage-high.md) | Conexões do Postgres perto do teto                       | conexões em 80% de max_connections                                                            |
| [redis-down](./redis-down.md)                       | Redis sem resposta                                       | Redis não responde ao PING em 2 s                                                             |
| [pitr-archive-off](./pitr-archive-off.md)           | PITR esperado com o arquivamento desligado               | PITR_EXPECTED=true e archive_mode diferente de on                                             |
| [wal-archive-stalled](./wal-archive-stalled.md)     | Arquivamento do WAL parado ou falhando                   | com o arquivamento ligado, último segmento há mais de 300 s, ou a última tentativa falhou     |
| [xid-age-high](./xid-age-high.md)                   | Idade do xid alta                                        | age(datfrozenxid) do cluster acima de 1 bilhão                                                |
| [long-write-xact](./long-write-xact.md)             | Transação de escrita aberta há muito tempo               | escrita aberta há mais de LONG_WRITE_XACT_ALERT_SECONDS (120 s)                               |
| [pg-wal-high](./pg-wal-high.md)                     | pg_wal grande                                            | pg_wal acima de PG_WAL_ALERT_GIB (12 GiB; 8 na VPS única)                                     |
| [redis-evictions](./redis-evictions.md)             | Redis despejando chaves                                  | evicted_keys cresceu desde a linha cluster de 15 a 20 min atrás                               |
| [redis-memory-policy](./redis-memory-policy.md)     | Redis sem teto de memória ou com noeviction              | Redis respondendo sem maxmemory ou com maxmemory-policy noeviction                            |
| [proof-signing](./proof-signing.md)                 | Certificado do comprovante vencendo, vencido ou inválido | certificado A1 vence em 30 dias (aviso) ou 7 (crítico), venceu ou não abre                    |
| [volume-near-gate](./volume-near-gate.md)           | Volume de entregas perto do portão aprovado              | os 7 dias projetados para o mês acima de 70% do portão aprovado, ou o dia acima do teto suave |
| [collection-incomplete](./collection-incomplete.md) | Verificação incompleta                                   | uma parte do estado da operação não pôde ser lida                                             |

## Operação

Incidentes que nenhuma regra nomeia ainda e as mudanças de servidor planejadas (`OPERATION_RUNBOOKS`).

| Runbook                                                           | O que é                              | Quando                                                                      |
| ----------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| [provider-down](./provider-down.md)                               | Provedor externo fora                | Meta, Expo, Resend ou LocationIQ fora do ar ou lento                        |
| [reconnect-storm](./reconnect-storm.md)                           | Tempestade de reconexão              | depois de um deploy ou de uma queda de rede, todos os sockets voltam juntos |
| [migration-lock](./migration-lock.md)                             | Migration presa num lock             | a etapa de release espera por um lock e falha pelo lock_timeout             |
| [disk-full](./disk-full.md)                                       | Disco do servidor enchendo           | disco do host acima de 80% (e-mail) ou 85% (Telegram)                       |
| [pitr-restore](./pitr-restore.md)                                 | Restaurar o banco até um momento     | um apagamento acidental, uma migration ruim ou a perda do banco             |
| [restore-drill](./restore-drill.md)                               | Ensaio mensal de restauração         | todo mês, no dia 1 às 05:45 UTC, e depois de mudar o backup                 |
| [staging-remote-server](./staging-remote-server.md)               | A staging num Remote Server (2º VPS) | onda 16 (G-03), depois dos portões no 2º VPS vazio                          |
| [producao-servidores-proprios](./producao-servidores-proprios.md) | A produção no prod-1 e no prod-db-1  | onda 22, antes do primeiro cliente de escala                                |
