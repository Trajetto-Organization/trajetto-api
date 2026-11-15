# disk-full — Disco do servidor enchendo

**Quando:** disco do host acima de 80% (e-mail) ou 85% (Telegram).

## O que significa

O disco do servidor é um só para as duas produções e a staging. Com ele cheio o Postgres para (não consegue gravar WAL) e as imagens novas não descem. O que mais cresce: `pg_wal` com o arquivamento parado, a fila do pgBackRest, logs dos contêineres e imagens antigas.

## Primeira ação

1. Veja o que cresce: `df -h`, `docker system df` e o `pg_wal` de cada banco ([pg-wal-high](./pg-wal-high.md)).
2. Na staging, desligue o arquivamento para salvar o disco: Database PostgreSQL de staging → _Environment_ → tire o `PITR_ARCHIVE` (ou `PITR_ARCHIVE=off`) → **Save** → **Deploy**. O wrapper grava `archive_mode=off` e o WAL da staging para de se acumular; religue depois, pelo passo a passo do F1a.
3. Imagens antigas saem pela limpeza diária do Dokploy. Nunca rode `docker volume prune` (apagaria volumes de bancos parados).

## Como confirmar

O disco volta abaixo de 80% no Beszel e para de crescer.

## Quando escalar

Acima de 90%, ou crescendo depressa: chame o dono na hora. Nunca apague arquivos do volume do Postgres à mão.
