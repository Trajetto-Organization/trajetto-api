# partition-stuck — Partição velha presa

**Dispara quando:** uma partição de uma tabela do registro passou da
retenção há mais de 3 dias e continua anexada (ou com um `DETACH` pendente).

## O que significa

O job `partition-maintenance` destaca com `DETACH … CONCURRENTLY` e apaga
toda noite a partição que passou da retenção (para a trilha,
`DRIVER_POSITION_RETENTION_DAYS`). Uma partição presa há três noites quer
dizer que esse passo falha: um lock que nunca vem, um `DETACH` que não
termina ou falta de permissão. Nada é recusado, mas o disco não libera, e a
retenção prometida não é cumprida.

## Primeira ação

1. Veja no log o `partition maintenance step postponed` do job: o campo
   `step` (`finalize`, `detach` ou `drop`) e o `code` (SQLSTATE) dizem onde
   parou. `55P03` é lock; `42501` é permissão.
2. Lock: o `DETACH … CONCURRENTLY` espera as transações que já tinham a
   tabela aberta. Procure uma transação longa em `pg_stat_activity` e rode o
   job de novo depois que ela terminar.
3. Permissão: confira `partitions.<tabela>.owner_ok` em `/health/metrics`;
   falso quer dizer que o `infra/sql/10-partitions.sql` não convergiu. Rode a
   etapa de release de novo.
4. Logo depois de baixar a retenção, o alerta aparece até a primeira noite:
   rode o job à mão para destacar o que passou a ser antigo.
5. Trilha com o arquivo ligado (`TRAIL_ARCHIVE_ENABLED=true`): o dia só sai
   depois de ir para o R2 com a soma conferida. Procure no log do job:
   - `trail archive enabled but not configured`: falta o bucket ou o token
     (o campo `missing` diz qual); preencha no _Environment_ da
     `trajetto-api` e faça o deploy;
   - `trail archive failed`: o R2 não respondeu ou o token não tem acesso
     ao bucket de arquivo; a noite seguinte tenta de novo;
   - `trail archive out of time`: o orçamento da execução
     (`CRON_PURGE_RUN_BUDGET_MS`) acabou antes; o dia continua na noite
     seguinte, do ponto em que parou;
   - `trail archive does not add up`: a soma do manifesto não bate com o
     `count` da partição. Compare as duas:

     ```sql
     SELECT "businessId", status, row_count
       FROM archive_manifest WHERE partition_name = '<partição>';
     ```

     Uma linha de empresa que não tem mais linhas na partição (apagadas
     depois de arquivadas) é a causa comum: apague essa linha do manifesto
     e o objeto dela no bucket de arquivo, e rode o job;

   - `detached trail day without a verified archive is kept`: um dia
     destacado numa noite antiga sem o arquivo conferido. Para arquivá-lo,
     anexe de volta e rode o job:

     ```sql
     ALTER TABLE <pai> ATTACH PARTITION <tabela>
       FOR VALUES FROM ('<início>') TO ('<fim>');
     ```

     Para descartá-lo sem arquivo, `DROP TABLE` à mão.

## Como confirmar

`partitions.<tabela>.stuck` fica vazio e `detach_pending` volta a 0 em
`/health/metrics`.

## Quando escalar

Uma semana de partição presa, ou um `detach_pending` que não sai depois de
duas noites: chame o dono.
