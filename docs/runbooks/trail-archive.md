# trail-archive — Arquivamento da trilha de posições

**Quando:** o alerta [partition-stuck](./partition-stuck.md) numa tabela da trilha (`driver_position`, `driver_position_v2`), um aviso do job `partition-maintenance` sobre o arquivo, ou alguém pedindo a trilha de um dia que já saiu do banco.

## O que significa

A trilha de posições guarda `DRIVER_POSITION_RETENTION_DAYS` (90) dias no banco, um dia por partição. Com `TRAIL_ARCHIVE_ENABLED=true` (plano de escala F2-11), o job `partition-maintenance` (04:10 UTC), antes de apagar o dia vencido, copia-o para o bucket de **arquivo** (`TRAIL_ARCHIVE_BUCKET`, nunca o de fotos): um CSV em gzip por empresa, `trail/<aaaammdd>/<businessId>.csv.gz`, anotado em `archive_manifest` com a contagem e o sha256. Só apaga a partição quando a soma do manifesto confere com a contagem do dia (`archive_partition`). Um dia que não conferiu, ou que o tempo da noite não alcançou, fica no banco para a noite seguinte; depois de 3 noites, o `partition-stuck` avisa. O objeto fica no bucket `TRAIL_ARCHIVE_RETENTION_DAYS` (180) dias, pela regra de ciclo de vida do próprio bucket.

Ligado sem o bucket ou o token, o boot só avisa, e o job guarda todo dia vencido: o disco cresce até alguém notar.

## Primeira ação

1. Leia no log do `partition-maintenance` da última noite o motivo do dia guardado (bucket, token, contagem que não bateu, tempo).
2. Veja o que o manifesto tem do dia:

   ```sql
   SELECT status, count(*), sum(row_count) AS linhas
   FROM archive_manifest
   WHERE partition_name = '<partição, por exemplo driver_position_v2_20261101>'
   GROUP BY status;

   SELECT * FROM archive_partition WHERE partition_name = '<partição>';
   ```

3. Bucket ou token errado: corrija no _Environment_ da `trajetto-api` (os nomes em `docs/variaveis-de-ambiente.md`) e espere a próxima noite; o job refaz o que ficou `PENDING`.
4. Para alguém que pede um dia que já saiu do banco: baixe o objeto do bucket de arquivo (`trail/<aaaammdd>/<businessId>.csv.gz`), confira o sha256 com o do manifesto e entregue só o arquivo da empresa que pediu.

## Como confirmar

O dia aparece em `archive_partition` com a contagem certa, a partição sai do banco na noite seguinte e o `partition-stuck` some. No bucket, um objeto por empresa daquele dia.

## Quando escalar

A contagem do manifesto não bate com a do dia por duas noites seguidas (uma linha gravada num dia já arquivado, ou um objeto corrompido), ou o disco do banco perto do limite com dias guardados: chame o dono. Nunca apague à mão um dia da trilha que o arquivo não conferiu.
