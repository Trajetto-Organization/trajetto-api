# restore-drill — Ensaio mensal de restauração

**Quando:** todo mês, no dia 1 às 05:45 UTC, e depois de mudar o backup.

## O que significa

Um backup só vale se restaura. O ensaio restaura a cópia mais recente num contêiner descartável, mede o tempo (RTO) e a perda, e confere o schema. Nunca no servidor da staging: o ensaio leva dados pessoais da produção.

## Primeira ação

1. Hoje: baixe a cópia e rode `infra/scripts/restore-postgres.sh`, como em [deploy.md, Ensaiar a restauração](../deploy.md#ensaiar-a-restauração).
2. Com a imagem nova do Postgres: `trajetto-restore-drill`, sempre com teto (`--cpus 1 --memory 1g`) e na janela.
3. Confira o disco livre antes: o ensaio não pode passar de metade do que sobra.

## Como confirmar

`prisma migrate status` diz "Database schema is up to date!", as contagens batem, e o `max(ts)` do `ops_sample` mostra a perda. Anote data, RTO e perda em "Ensaios feitos" no [deploy.md](../deploy.md#ensaiar-a-restauração).

## Quando escalar

Ensaio que falha (cópia ilegível, migrations pendentes que não aplicam): chame o dono no mesmo dia. Até corrigir, o backup não é backup.
