# restore-drill — Ensaio mensal de restauração

**Quando:** todo mês, no dia 1 às 05:45 UTC (o Schedule Job do servidor), e depois de mudar o backup.

## O que significa

Um backup só vale se restaura. O ensaio restaura a cópia mais recente num contêiner descartável, mede o tempo (RTO) e a perda, e confere o schema. Nunca no servidor da staging com os dados da produção: o ensaio restaura dados pessoais.

Com a imagem `trajetto-postgres` (plano de escala, F1-02), o `trajetto-restore-drill` vem dentro dela, na mesma versão do pgBackRest do banco. Ele roda num contêiner da mesma imagem do Database, sempre com teto (`--cpus 1 --memory 1g`, mais o peso de I/O onde o kernel aceita), e com o token só de leitura do R2 (`PITR_DRILL_REPO1_S3_KEY` e `PITR_DRILL_REPO1_S3_KEY_SECRET`): a chave de escrita, que apaga backups, nunca chega ao ensaio. Antes de escrever qualquer coisa, ele confere o disco e a RAM; restaura com `--archive-mode=off`; sobe a cópia só com o socket local e com o próprio `max_wal_size` de 1 GB; lê `_prisma_migrations`, as contagens das tabelas principais e o marcador (o `max(ts)` das linhas `cluster` do `ops_sample`); e pinga o healthchecks.io (`PITR_DRILL_PING_URL`) com um resumo em JSON, sem segredo.

**Onde rodar, por degrau** (decisão D27):

| Degrau                             | Onde                                             | Condição                                                                                                                                       |
| ---------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| VPS única (hoje)                   | no próprio servidor, no contêiner com teto       | na janela (dia 1, 05:45 UTC), com a staging api e web em 0 réplicas, e o backup restaurado, mais o WAL da recuperação, em ≤ 50% do disco livre |
| depois do G-03 (staging no 2º VPS) | na VPS 1, que fica só com a produção             | a mesma janela e o mesmo guarda de disco                                                                                                       |
| a partir do `prod-db-2`            | num volume do `prod-db-2` (`--volume=<volume>`)  | de madrugada; o primário não divide disco nem I/O com o ensaio                                                                                 |
| nunca                              | no servidor da staging, com os dados da produção | —                                                                                                                                              |

O ensaio da staging (F1a) restaura os dados da própria staging e roda no servidor dela.

O guarda de disco soma ao banco o WAL que a recuperação guarda no `pg_wal` até cada _restartpoint_: até 1 GB do próprio ensaio mais o `POSTGRES_MAX_WAL_SIZE` do Database (a distância entre dois checkpoints dele; 8 GB se faltar), ou menos, se o arquivo tem menos WAL desde o backup. Com o `archive_timeout` de 60 s, cada minuto é um segmento inteiro de 16 MiB: um backup de um dia deixa uns 22 GiB para reproduzir, e o teto é o que segura o disco. O ensaio mensal, 45 minutos depois do backup diário, conta pouco mais que o banco.

## Primeira ação

1. Sem a imagem nova (hoje, na produção): baixe a cópia e rode `infra/scripts/restore-postgres.sh`, como em [deploy.md, Ensaiar a restauração](../deploy.md#ensaiar-a-restauração).
2. Com a imagem nova, no servidor (o Schedule Job roda o mesmo), trocando `<App Name do Database>`:

   ```sh
   c=$(docker ps -q -f label=com.docker.swarm.service.name=<App Name do Database>)
   docker exec "$c" cat /usr/local/bin/trajetto-restore-drill | bash -s -- --from "$c"
   ```

   O script sai do próprio contêiner do banco, lê o _Environment_ dele, troca a chave de escrita pela de leitura e cria o contêiner do ensaio. Opções: `--target='2026-12-01 05:00:00+00'` (até um instante, em vez do fim do arquivo), `--repo=2` (o segundo repositório) e `--volume=<volume>` (o degrau do `prod-db-2`).

3. O ping `/fail` com `drill-disk` (o backup, mais o WAL da recuperação, passa de `PITR_DRILL_MAX_DISK_FRACTION`, padrão 0,5, do disco livre; a mensagem diz quanto de cada) ou `drill-ram` (o servidor tem menos RAM livre que o teto do ensaio) não restaurou nada: mova o ensaio para o próximo degrau da tabela, ou rode na janela com a staging em 0.
4. O `drill-config` diz qual variável falta no _Environment_ do Database (o token de leitura, normalmente). Os outros motivos (`drill-restore`, `drill-recovery`, `drill-migrations`, `drill-checks`) trazem as últimas linhas do pgBackRest ou do Postgres, sem segredo.

## Como confirmar

O resumo do ensaio (na saída e no corpo do ping) traz `"result":"ok"`, o backup restaurado, `rto_seconds`, `loss_seconds` (o início do ensaio, ou o `--target`, menos o marcador), as migrations aplicadas e as contagens. Sem a imagem nova, `prisma migrate status` diz "Database schema is up to date!". Anote data, RTO e perda em "Ensaios feitos" no [deploy.md](../deploy.md#ensaiar-a-restauração).

## Quando escalar

Ensaio que falha (cópia ilegível, migrations pela metade, recuperação que não termina): chame o dono no mesmo dia. Até corrigir, o backup não é backup.
