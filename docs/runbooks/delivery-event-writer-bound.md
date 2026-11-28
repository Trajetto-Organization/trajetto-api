# delivery-event-writer-bound — Escrita no histórico recusada pelo limite de 240 s

**Quando:** um erro com SQLSTATE `TJ001` no log, "INSERT numa transação aberta há N s; o limite é 240 s".

## O que significa

O feed `/integration/v1/events` anda pela ordem de commit e começa cada página num piso: o `created_at` do último evento servido menos `FEED_FLOOR_MARGIN_MS` (10 min). Esse piso só é seguro se ninguém gravar um evento muito depois do início da própria transação (plano de escala U-16, decisão D66). Por isso um gatilho em `delivery_event` (e na casca `delivery_event_part`) recusa, uma vez por comando, o INSERT de uma transação aberta há mais de 240 s, e a transação inteira volta atrás. Sem o gatilho, um evento gravado 20 minutos depois do início cairia abaixo do piso de um integrador que já passou dali, e sumiria para ele sem erro.

Nenhum caminho da API chega perto: as transações do Prisma terminam em 15 s e a mais longa, a reversão de importação, em 60 s. O alerta [long-write-xact](./long-write-xact.md) (120 s) avisa antes. Um `TJ001` quer dizer que um caminho novo grava o histórico numa transação longa, ou que alguém rodou uma carga à mão numa transação só.

## Primeira ação

1. Ache quem gravou: o log da requisição ou do job que falhou traz a consulta; numa carga à mão, é a sessão de quem a rodou.
2. Carga à mão (um backfill, uma correção): divida em transações curtas, de no máximo uns milhares de linhas cada. Uma carga de massa num banco descartável pode desligar os gatilhos da própria sessão com `SET session_replication_role = replica` (só superusuário), como o seed de carga faz.
3. Caminho da API: é um bug. A transação que falhou voltou atrás inteira, sem gravar nada pela metade; o cliente recebe 500 e pode tentar de novo. Abra o caso com a consulta e o tempo que a transação ficou aberta.

Nunca apague nem desligue o gatilho na produção para destravar uma escrita: o feed passaria a poder pular eventos para sempre.

## Como confirmar

Os dois gatilhos estão no lugar, com o limite de 240 s:

```sql
SELECT tgrelid::regclass AS tabela, tgname, tgenabled,
       encode(tgargs, 'escape') AS argumento
FROM pg_trigger
WHERE tgname IN ('delivery_event_writer_bound', 'delivery_event_part_writer_bound');
```

Duas linhas, `tgenabled` = `O` e o argumento `240\000`. Depois da janela do histórico ([history-window](./history-window.md)) a casca virou a `delivery_event` e só a primeira linha aparece, na tabela particionada; o gatilho da tabela de antes se chama `delivery_event_legacy_writer_bound`. Depois da correção, a escrita que falhava passa.

## Quando escalar

Um `TJ001` vindo da própria API, ou o gatilho ausente ou desligado nessa consulta: chame o dono. O gatilho ausente é o caso grave, porque o feed perde a garantia de não pular evento: recrie-o rodando de novo a migration `20261118100000_delivery_event_writer_bound` (o SQL dela é idempotente) pelo `psql`, com a escrita da API parada se o lock não vier.
