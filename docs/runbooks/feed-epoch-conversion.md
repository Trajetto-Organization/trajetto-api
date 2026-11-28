# feed-epoch-conversion — Cursor do feed de outra época do cluster

**Dispara quando:** nos últimos 15 minutos, o feed `/integration/v1/events` converteu pelo menos um cursor emitido noutra época do cluster, até 7 dias depois de a época mudar.

## O que significa

Com `INTEGRATION_FEED_ORDER=commit` (plano de escala F2-05), o feed anda pela ordem de commit, e o cursor que cada integrador guarda leva a época do cluster (`cluster_epoch`, [cluster-epoch-stale](./cluster-epoch-stale.md)). Depois de um PITR, de um promote ou de um restore lógico, a etapa de release sobe a época e os ids de transação voltam a ser usados: um cursor da época anterior não diz mais onde o integrador parou. Por isso o feed não o lê como está nem o recusa: ele o **converte** pelo piso do próprio cursor (o `created_at` do último evento servido menos `FEED_FLOOR_MARGIN_MS`) e devolve de novo tudo o que foi gravado desde então, sem pular nada. A integração recebe eventos repetidos e, pelo contrato público, deduplica pelo `id` do evento.

Cada processo conta as conversões no minuto (`metrics.feed.epoch_conversions` da `ops_sample`), e o `ops-heartbeat` soma as dos últimos 15 minutos. O alerta é esperado logo depois de um PITR, promote ou restore, e some sozinho quando todo integrador consultou uma vez com o cursor novo.

O cursor não é assinado: a época dentro dele é só o que o integrador manda. Por isso só conta para o alerta a conversão que a história do cluster sustenta: a época passou da primeira, mudou há no máximo 7 dias (`cluster_epoch.changed_at`) e o último evento do cursor é anterior à mudança. Qualquer outra (um cursor editado à mão, um trazido de outro ambiente, como o de um ERP apontado para a staging e depois para a produção, ou o de um integrador que voltou mais de 7 dias depois) é convertida do mesmo jeito, sem pular nada, mas conta em `metrics.feed.stray_epoch_conversions` e não alerta: uma chave de API sozinha não abre incidente. O log a registra em `info`, na linha `integration feed: cursor of another epoch with no recent epoch change behind it`, com o `businessId`.

## Primeira ação

1. Confirme que houve um PITR, um promote ou um restore (o runbook [pitr-restore](./pitr-restore.md), o log da etapa com `applied: época N para N+1`).
2. Avise os clientes com integração por polling: um trecho de eventos desde o instante da restauração foi enviado de novo e deve ser deduplicado pelo `id`. As empresas que consultaram estão no log, na linha `integration feed: cursor of another cluster epoch converted`, com o `businessId`.

## Como confirmar

```sql
SELECT ts, replica, metrics -> 'feed' AS feed
FROM ops_sample
WHERE ts > now() - interval '30 minutes'
  AND (metrics -> 'feed' ->> 'epoch_conversions')::int > 0
ORDER BY ts DESC;
```

As linhas param de aparecer quando cada integrador já guardou o cursor da época nova, e o motivo some do `ops-heartbeat`.

## Quando escalar

Se ninguém fez PITR, promote nem restore e o alerta disparou, chame o dono na hora, junto com o [cluster-epoch-stale](./cluster-epoch-stale.md): a época subiu sem motivo conhecido. Se as conversões não param depois de horas, um integrador está mandando sempre o mesmo cursor velho (ele não guarda o `resume_cursor`): fale com o cliente.
