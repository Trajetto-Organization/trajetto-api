# pitr-archive-off — PITR esperado com o arquivamento desligado

**Dispara quando:** PITR_EXPECTED=true e archive_mode diferente de on.

## O que significa

O ambiente diz que o PITR está ligado (`PITR_EXPECTED=true`), mas o Postgres está com `archive_mode` desligado: o WAL não vai para o R2 e não há restauração até o minuto; só o dump diário do Dokploy (perda de até 24 h).

## Primeira ação

1. No Database PostgreSQL do ambiente, confira o _Environment_: o `PITR_ARCHIVE=on` e as `PGBACKREST_REPO1_*` sumiram?
2. Confira se alguém pôs um _Command_ ou _Args_ no Database: um campo preenchido apaga o `CMD` da imagem e desliga o arquivamento sem erro. Esvazie e dê **Deploy**.
3. Se o PITR foi desligado de propósito, tire o `PITR_EXPECTED` da `trajetto-api` (**Save** → **Deploy**).

## Como confirmar

No banco, `SHOW archive_mode;` responde `on`, e o motivo some.

## Quando escalar

Sem saber por que o arquivamento caiu, chame o dono: até voltar, o RPO é o do dump.
