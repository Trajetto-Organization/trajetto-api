# Jobs e horários

Tudo o que roda por horário no ambiente da API, num mapa só, em **UTC**. O
contêiner não tem `TZ`, e o scheduler lê toda agenda em UTC, qualquer que seja
o fuso do host (`CRON_TIMEZONE` em `src/shared/services/cron-scheduler-service.ts`).
Brasília é UTC−3: 03:00 UTC são 00:00 BRT. Um job que trata do dia de uma
empresa usa `src/shared/time/business-day.ts` dentro do handler.

O mapa junta três origens: os crons do código (registrados em
`src/jobs/cron/index.ts`), o que o Dokploy agenda (o backup do Database e, a
partir das ondas do plano de escala, os _Schedule Jobs_) e as janelas que o dono
reserva (carga na staging, histórico). O teste
`tests/unitaires/lifecycle/cron-registry.test.ts` confere duas coisas: que a
agenda de cada cron do código é a desta tabela, e que duas entradas pesadas
nunca se sobrepõem em dia nenhum. Mudou um horário no código ou no painel?
Mude aqui no mesmo commit.

## Mapa de horários

Colunas:

- **Agenda (UTC):** a expressão cron, como o código ou o painel a tem.
- **Dias:** `todo dia`, dias da semana (`dom`, `seg`, `ter`, `qua`, `qui`,
  `sex`, `sáb`, com `–` para um intervalo), `dia 1` (do mês) e `exceto dia 1`.
- **Janela reservada (UTC):** o intervalo que a entrada pode ocupar, do
  início ao fim (o fim não está incluído). Num expurgo, é o orçamento
  `CRON_PURGE_RUN_BUDGET_MS` (5 min): com sobra, a execução para e fica
  parcial. Nas outras, é a reserva do plano de escala (decisões D27 e D28).
- **Pesada:** disputa disco ou CPU do banco. Duas pesadas não se cruzam.

| Entrada                              | Onde                                            | Agenda (UTC)               | Dias                  | Janela reservada (UTC) | Pesada | Desde                          |
| ------------------------------------ | ----------------------------------------------- | -------------------------- | --------------------- | ---------------------- | ------ | ------------------------------ |
| `backup-database`                    | Dokploy (Database → Backups)                    | `0 3 * * *`                | todo dia              | 03:00–03:15            | sim    | hoje                           |
| `cleanup-expired-refresh-tokens`     | `src/jobs/cron`                                 | `17 3 * * *`               | todo dia              | 03:17–03:22            | sim    | hoje                           |
| `cleanup-notification-pipeline`      | `src/jobs/cron`                                 | `30 3 * * *`               | todo dia              | 03:30–03:35            | sim    | hoje                           |
| `cleanup-ai-pipeline`                | `src/jobs/cron`                                 | `45 3 * * *`               | todo dia              | 03:45–03:50            | sim    | hoje                           |
| `cleanup-background-jobs`            | `src/jobs/cron`                                 | `52 3 * * *`               | todo dia              | 03:52–03:57            | sim    | onda 14                        |
| `cleanup-user-history`               | `src/jobs/cron`                                 | `0 4 * * *`                | todo dia              | 04:00–04:05            | sim    | hoje                           |
| `partition-maintenance`              | `src/jobs/cron`                                 | `10 4 * * *`               | todo dia              | 04:10–04:15            | sim    | onda 6                         |
| `cleanup-webhook-deliveries`         | `src/jobs/cron`                                 | `20 4 * * *`               | todo dia              | 04:20–04:25            | sim    | hoje                           |
| `purge-chat-messages`                | `src/jobs/cron`                                 | `25 4 * * *`               | todo dia              | 04:25–04:30            | sim    | onda 14                        |
| `cleanup-api-usage`                  | `src/jobs/cron`                                 | `35 4 * * *`               | todo dia              | 04:35–04:40            | sim    | hoje                           |
| `purge-ops-series`                   | `src/jobs/cron`                                 | `40 4 * * *`               | todo dia              | 04:40–04:45            | sim    | hoje                           |
| `cleanup-delivery-event-submissions` | `src/jobs/cron`                                 | `45 4 * * *`               | todo dia              | 04:45–04:50            | sim    | onda 8                         |
| `cleanup-orphan-uploads`             | `src/jobs/cron`                                 | `50 4 * * *`               | todo dia              | 04:50–04:55            | sim    | hoje                           |
| `pgbackrest-diff`                    | Dokploy (Schedule Job)                          | `0 5 * * 0-5`              | dom–sex               | 05:00–05:45            | sim    | onda 3 (staging), 6 (produção) |
| `pgbackrest-full`                    | Dokploy (Schedule Job)                          | `0 5 * * 6`                | sáb                   | 05:00–05:45            | sim    | onda 3 (staging), 6 (produção) |
| `restore-drill`                      | dono, à mão (Schedule Job na onda 3)            | `45 5 1 * *`               | dia 1                 | 05:45–08:00            | sim    | hoje                           |
| `load-window`                        | dono, na staging                                | —                          | seg–sáb, exceto dia 1 | 06:00–08:00            | sim    | hoje                           |
| `history-window`                     | plano de escala, onda 11                        | —                          | dom, exceto dia 1     | 06:00–09:00            | sim    | onda 11                        |
| `partial-retry`                      | `src/shared/services/cron-limits.ts`            | —                          | todo dia              | 06:00–09:00            | não    | hoje                           |
| `catch-up`                           | `src/shared/services/cron-scheduler-service.ts` | `7 * * * *`                | todo dia              | —                      | não    | hoje                           |
| `ops-heartbeat`                      | `src/jobs/cron`                                 | `* * * * *`                | todo dia              | —                      | não    | hoje                           |
| `escalate-occurrence-authorizations` | `src/jobs/cron`                                 | `* * * * *`                | todo dia              | —                      | não    | hoje                           |
| `repair-unticketed-messages`         | `src/jobs/cron`                                 | `* * * * *`                | todo dia              | —                      | não    | hoje                           |
| `geocode-deliveries`                 | `src/jobs/cron`                                 | `* * * * *`                | todo dia              | —                      | não    | hoje                           |
| `close-abandoned-imports`            | `src/jobs/cron`                                 | `*/5 * * * *`              | todo dia              | —                      | não    | hoje                           |
| `reconcile-proof-analysis`           | `src/jobs/cron`                                 | `*/10 * * * *`             | todo dia              | —                      | não    | hoje                           |
| `reconcile-record-analysis`          | `src/jobs/cron`                                 | `5,15,25,35,45,55 * * * *` | todo dia              | —                      | não    | hoje                           |
| `check-push-receipts`                | `src/jobs/cron`                                 | `*/15 * * * *`             | todo dia              | —                      | não    | hoje                           |
| `alert-routes-left-open`             | `src/jobs/cron`                                 | `7 * * * *`                | todo dia              | —                      | não    | hoje                           |
| `snapshot-query-stats`               | `src/jobs/cron`                                 | `13 * * * *`               | todo dia              | —                      | não    | hoje                           |
| `remind-business-purge`              | `src/jobs/cron`                                 | `0 12 * * *`               | todo dia              | —                      | não    | onda 14                        |
| `cloudflare-ranges`                  | GitHub Actions                                  | `0 9 * * 1`                | seg                   | —                      | não    | hoje                           |

## O que cada entrada é

- **`backup-database`:** o backup do próprio Database PostgreSQL no Dokploy,
  para o R2 ([deploy.md, seção 18](../deploy.md#18-backup-e-restauração)).
  Antes do primeiro job que apaga dados.
- **Os expurgos e as partições (03:17–04:55):** os crons noturnos
  ([arquitetura.md, Crons](../arquitetura.md#crons)). Cada um para no
  orçamento; com sobra, a execução fica parcial e o catch-up a repete na
  janela das parciais ([deploy.md, Expurgos parciais](../deploy.md#expurgos-parciais)).
  O `partition-maintenance` (onda 6, no lugar do `driver-position-partitions`)
  roda depois do backup das 03:00 de propósito: o `DETACH … CONCURRENTLY`
  espera as transações que já tinham a tabela aberta, e o `pg_dump` segura
  uma até o fim. Aos domingos ele também faz o `ANALYZE` do pai e o
  `VACUUM (FREEZE)` das partições assentadas. Com o arquivo da trilha
  ligado (`TRAIL_ARCHIVE_ENABLED`, onda 8), ele envia o dia vencido ao R2
  antes de apagá-lo e para de começar empresa nova no
  `CRON_PURGE_RUN_BUDGET_MS`; o que sobrar fica para a noite seguinte. Na
  escala do 5M o arquivo vira um job próprio (F3-28).
- **`pgbackrest-diff` e `pgbackrest-full`:** o backup físico do PITR, que
  ainda não existe: chega com a imagem `trajetto-postgres` (onda 3 na
  staging, onda 6 na produção). Diferencial de domingo a sexta, completo no
  sábado, para o completo não cair na janela do histórico.
- **`restore-drill`:** o ensaio mensal de restauração
  ([runbook](../runbooks/restore-drill.md)), com teto de CPU e memória, nunca
  no servidor da staging. Hoje é à mão, no mesmo horário.
- **`load-window`:** as cargas e os seeds na staging (plano de escala, seção
  6): das 03:00 às 05:00 BRT, nunca no dia 1 (o ensaio) nem no domingo (o
  histórico).
- **`history-window`:** a janela semanal do histórico (onda 11). Num domingo
  que cai no dia 1, ela espera o domingo seguinte, para não cruzar o ensaio.
- **`partial-retry`:** a janela em que o catch-up repete um expurgo parcial
  (`CRON_PARTIAL_RETRY_WINDOW_UTC`, no máximo `CRON_PARTIAL_RETRIES_PER_DAY`
  vezes por dia). Leve: cada repetição tem o mesmo orçamento de 5 min, e só
  há o que repetir quando uma noite deixou sobra.
- **`catch-up`:** a varredura de hora em hora (:07) que roda um job diário
  sem sucesso há 26 h, e as parciais dentro da janela.
- **`cloudflare-ranges`:** o workflow que compara as faixas da Cloudflare
  com as do código, toda segunda às 06:00 BRT. Roda no GitHub, fora do
  servidor.

Os crons de minuto e de hora (heartbeat, escalonamento das ocorrências,
geocodificação, recibos do push, reconciliações, rotas abertas e o
`pg_stat_statements`) são leves e rodam o dia todo; o que cada um faz está em
[arquitetura.md, Crons](../arquitetura.md#crons).
