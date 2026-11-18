# partition-detach-pending — Detach de partição pendente

**Quando:** `partitions.<tabela>.detach_pending` acima de 0 no `/health/metrics`, ou o job `partition-maintenance` dizendo que não destacou uma partição vencida porque outra da mesma tabela está pendente.

## O que significa

O job `partition-maintenance` tira uma partição que passou da retenção com `ALTER TABLE … DETACH PARTITION … CONCURRENTLY`, que não segura as escritas, e depois a apaga (plano de escala F2-08). Esse comando roda em dois tempos, fora de transação: se a conexão cai ou o comando é cancelado no meio (um deploy, um `lock_timeout` de 10 s esperando uma transação que tinha a tabela aberta, um `pg_dump` em andamento), a partição fica marcada como **detach pendente** (`pg_inherits.inhdetachpending`). Enquanto houver uma pendente, o Postgres não aceita outro `DETACH … CONCURRENTLY` na mesma tabela, e as partições vencidas seguintes também ficam.

O próprio job, na noite seguinte, acha a pendente e roda `DETACH … FINALIZE`. Só é incidente quando isso não acontece.

## Primeira ação

1. Veja quais estão pendentes:

   ```sql
   SELECT i.inhparent::regclass AS tabela, c.relname AS particao
   FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
   WHERE i.inhdetachpending;
   ```

2. Espere a próxima noite: o job termina sozinho.
3. Se precisar antes (o disco apertado, a retenção atrasada), termine à mão, fora de transação, longe das 03:00 UTC do backup:

   ```sql
   SET lock_timeout = '10s';
   ALTER TABLE <tabela> DETACH PARTITION <particao> FINALIZE;
   DROP TABLE <particao>;
   ```

   O `FINALIZE` espera as transações que já tinham a tabela aberta; um `lock_timeout` quer dizer que alguma ainda está lá ([feed-frozen](./feed-frozen.md) mostra como achá-la). Na trilha de posições com `TRAIL_ARCHIVE_ENABLED`, só apague o dia que o arquivo conferiu ([trail-archive](./trail-archive.md)).

## Como confirmar

A primeira consulta volta vazia e `partitions.<tabela>.detach_pending` volta a 0. Na noite seguinte o job destaca as partições vencidas que tinham ficado.

## Quando escalar

A pendente continua depois de duas noites, ou o `FINALIZE` falha por outro motivo que não o lock: chame o dono.
