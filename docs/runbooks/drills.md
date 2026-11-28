# drills — Calendário dos ensaios: PITR, failover e game day

**Quando:** o PITR todo mês, o failover a cada trimestre e o game day a cada semestre; e antes de um portão de escala (o 1M pede o failover com RTO < 15 min e RPO < 10 s).

## O que significa

Um backup só vale se restaura, e um failover só vale se alguém já o fez com o relógio correndo. O failover é manual (decisão D6 do plano de escala): depende de uma pessoa, e o ensaio é o que garante que ela sabe os passos e que eles ainda funcionam. Cada ensaio tem o seu runbook e a sua meta, e o resultado fica na tabela do fim deste arquivo.

| Ensaio                  | Frequência                                                   | Onde                                                                                                                                   | Runbook                                   | Meta                                                                           |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------ |
| Restauração (PITR)      | todo mês, no dia 1 às 05:45 UTC (o Schedule Job do servidor) | no contêiner com teto, pelo degrau do [restore-drill](./restore-drill.md); nunca no servidor da staging com os dados da produção       | [restore-drill](./restore-drill.md)       | RTO < 1 h e perda ≤ 2 min; em tamanho real, RTO < 4 h                          |
| Failover para o standby | a cada trimestre (janeiro, abril, julho, outubro)            | na staging do 2º VPS, com um standby temporário de 1 GiB, até o prod-db-2; depois dele, o standby real da produção (E-01), numa janela | [failover-standby](./failover-standby.md) | RTO < 15 min, RPO < 10 s, a época do cluster +1 e nenhum evento do feed pulado |
| Game day                | a cada semestre (março e setembro)                           | na staging, sob o burn-in limitado (`tests/load/staging-burn-in.sh`)                                                                   | este arquivo, abaixo                      | nenhuma perda de dado confirmado; o que cada falha deve causar, e só isso      |

Nenhum ensaio roda contra a produção sem uma janela combinada, e nenhum com os dados da produção no servidor da staging: o ensaio de restauração restaura dados pessoais.

## Primeira ação

**Restauração (PITR), todo mês.** O Schedule Job roda sozinho; confira o ping do healthchecks.io (`PITR_DRILL_PING_URL`) e o resumo em JSON, e anote o RTO e a perda abaixo. Falhou, siga o [restore-drill](./restore-drill.md).

**Failover, a cada trimestre.** Siga o [failover-standby](./failover-standby.md), parte "No ensaio da staging": o standby temporário, o failover sob o burn-in, as medidas e a volta planejada ao Database de sempre. A época do cluster sobe na etapa de release (o **Deploy** da `trajetto-api-migrate`, direto no promovido), e só depois o PgBouncer passa ao promovido pelo `infra/pgbouncer/retarget.sh`.

**Game day, a cada semestre**, na staging, com o burn-in limitado rodando do começo ao fim (`tests/load/staging-burn-in.sh`, o mesmo do portão do rolling) e uma pessoa olhando o `/health/metrics` e os alertas. Uma falha de cada vez, esperando a volta completa antes da próxima, com o horário de cada uma anotado:

1. **Uma réplica da API morta.** No host, `docker kill` do contêiner de uma tarefa da `trajetto-api-staging` (`docker ps -f label=com.docker.swarm.service.name=trajetto-api-staging`). Esperado: o Swarm sobe outra; as requisições em voo naquela réplica falham e o resto segue pela outra; o burn-in fica abaixo do limite de erro dele e nenhuma escrita confirmada some.
2. **O Redis morto.** `docker kill` da tarefa do Database Redis da staging. Esperado: o que o [redis-down](./redis-down.md) descreve, e só isso: os sockets reconectam quando ele volta, nada de estado de negócio se perde (ele não guarda nenhum), e a varredura das filas cobre as dicas de despertar perdidas.
3. **O primário da staging morto**, com o standby temporário em streaming (o mesmo do ensaio trimestral): `docker kill` da tarefa do Database da staging, e daí o [failover-standby](./failover-standby.md) inteiro, contra o relógio. Esperado: durante a troca, 503 com `Retry-After` (nunca 500), o app guardando as escritas na fila dele, e tudo de volta depois do retarget; a época do cluster sobe e o feed não pula evento. Termine com a volta planejada do mesmo runbook.

## Como confirmar

Cada ensaio deixa uma linha na tabela abaixo, no mesmo dia, com o que foi medido e o que deu errado. Um ensaio que passou da meta tem um problema aberto antes do próximo.

| Data (UTC) | Ensaio | Ambiente | RTO | RPO / perda | Época | Observações |
| ---------- | ------ | -------- | --- | ----------- | ----- | ----------- |
| —          | —      | —        | —   | —           | —     | —           |

O que conferir em cada um:

- **PITR**: o resumo do `trajetto-restore-drill` (`rto_seconds`, `loss_seconds`, as migrations e as contagens).
- **Failover**: t1 − t0 do runbook, o `max(ts)` da linha `cluster` do `ops_sample` no promovido contra o instante da queda, `epoch` +1 em `cluster_epoch` e o `feed.epoch_conversions` do `ops_sample` subindo com um cursor de antes.
- **Game day**: o relatório do burn-in (taxa de erro e p95 de cada janela), os alertas que dispararam e os que deviam ter disparado.

## Quando escalar

- Uma meta não atingida (RTO, RPO, perda, um 500 onde o plano diz 503): é um problema do produto, não do ensaio. Abra-o com o número medido e chame o dono antes do próximo portão.
- Um ensaio que não pôde rodar no mês ou no trimestre dele: avise o dono; dois seguidos sem rodar valem como um ensaio que falhou.
- Qualquer dado da produção aparecendo fora dela durante um ensaio: pare tudo e chame o dono na hora.
