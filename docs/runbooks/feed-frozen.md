# feed-frozen — Feed de eventos parado

**Quando:** um integrador diz que o `/integration/v1/events` parou de trazer eventos novos (as páginas voltam vazias e o `resume_cursor` não anda), enquanto as entregas continuam acontecendo; ou o alerta [long-write-xact](./long-write-xact.md) dispara junto.

## O que significa

Com `INTEGRATION_FEED_ORDER=commit` (plano de escala F2-05), o feed anda pela ordem de commit e só entrega o evento cujo `txid` está abaixo do xmin do snapshot: o menor id de transação de escrita **ainda aberta em qualquer banco do cluster Postgres**, não só no da API. Enquanto uma transação de escrita fica aberta, nada gravado depois dela é servido. É de propósito: servir o que veio depois e pular o evento que ainda vai confirmar seria perdê-lo para sempre. O feed **atrasa, não pula** evento; quando a transação termina, tudo o que ficou para trás sai na ordem.

Quem segura: uma transação esquecida aberta (`idle in transaction`) num `psql`, um backfill ou uma carga à mão, um `CREATE INDEX CONCURRENTLY` longo, a janela do histórico durante a cópia ([history-window](./history-window.md)), uma transação preparada (`PREPARE TRANSACTION`) esquecida. Leitura não segura: um `pg_dump` ou um relatório longo sem escrita não ganha id de transação. Os escritores da `delivery_event` são cortados em 240 s ([delivery-event-writer-bound](./delivery-event-writer-bound.md)), então o problema quase sempre vem de fora da API.

## Primeira ação

1. Ache a transação de escrita mais antiga do cluster, no `psql` do Database:

   ```sql
   SELECT datname, pid, usename, application_name, state, xact_start,
          now() - xact_start AS aberta_ha, backend_xid, left(query, 120) AS consulta
   FROM pg_stat_activity
   WHERE backend_xid IS NOT NULL
   ORDER BY xact_start
   LIMIT 10;

   SELECT gid, prepared, owner, database FROM pg_prepared_xacts;
   ```

2. Se for uma operação planejada (a janela do histórico, um índice da etapa de release), espere ela terminar: o feed volta sozinho.
3. Se for uma sessão esquecida (`idle in transaction`, um `psql` de alguém), confirme com quem abriu e encerre: `SELECT pg_terminate_backend(<pid>);`. A transação volta atrás inteira.
4. Uma transação preparada esquecida: `ROLLBACK PREPARED '<gid>';`, depois de confirmar que ninguém a espera.

## Como confirmar

A primeira consulta não mostra mais nada aberto há minutos, e a página do feed de um integrador volta a trazer eventos (o `resume_cursor` muda). O alerta `long-write-xact` some no minuto seguinte.

## Quando escalar

Uma transação da própria API aberta há mais de 4 minutos (não devia existir: o limite do U-16 corta o escritor do histórico, e as transações do Prisma terminam em 15 s), ou o feed parado sem nenhuma transação de escrita aberta: chame o dono. Nunca troque `INTEGRATION_FEED_ORDER` para `id` para destravar: o caminho por id pula de vez o evento que confirma tarde.
