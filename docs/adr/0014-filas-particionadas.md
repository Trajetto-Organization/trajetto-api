# ADR 0014 — As quatro filas particionadas por dia, pelo id

- **Status:** aceito em 18/11/2026 (plano de escala, onda 10, F5-09).
- **Escopo:** `trajetto-api`: `domain_outbox_event`, `notification_delivery`,
  `notification_provider_receipt` e `webhook_delivery`.
- **Depende de:** [ADR 0001](./0001-filas-e-mensageria.md) (o Postgres é a
  fila) e da contração do F5-06 (as filas sem chave estrangeira nem unique
  além da chave primária).

## Contexto

As filas são tabelas de trabalho: cada linha é reivindicada algumas vezes e
depois só espera o expurgo. No alvo de 5 M entregas por mês (1 a 1,7 M
eventos por dia), o expurgo noturno é de milhões de `DELETE` por noite: as
linhas mortas que as reivindicações pulam até o autovacuum passar, o WAL
que o standby repete e um job que, numa noite ruim, não termina dentro do
orçamento (`CRON_PURGE_RUN_BUDGET_MS`) e deixa a tabela crescer.

## Decisão

Cada fila vira uma tabela particionada por `RANGE ("id")`, uma partição por
dia UTC. Todo id das quatro é um uuid v7
(`tests/unitaires/database/queue-ids-v7-guard.test.ts`): os primeiros 48
bits são o milissegundo, e a linha cai no dia a que pertence. A entrega leva
o milissegundo do seu evento, e o recibo o da sua entrega, então um dia da
família (evento, entregas, recibos) sai junto. Um dia vencido e assentado
sai inteiro, por `DETACH … CONCURRENTLY` e `DROP` (F5-11, F5-12), sem linha
morta para varrer.

A troca é o passo `prisma/post-deploy/10-queue-partition-swap.sql`, que a
etapa de release roda em todo deploy e que não faz nada enquanto não pode:

1. **Espera a capability.** Só troca quando todo processo vivo anuncia
   `queue-partition-agnostic-v1` e nenhuma sessão sem nome está no banco
   (`trajetto_queue_swap_ready`, F5-07): a imagem de antes do plano grava por
   uniques e apaga por cascatas que uma tabela particionada não tem. E só
   depois de o `05-queue-contract.sql` (F5-06) ter tirado as FKs e os
   uniques. Até lá, `pending`, e o deploy seguinte (ou um _Run workflow_ com
   `force_release`) roda de novo.
2. **A tabela de hoje vira a partição legada.** Numa transação por fila, sob
   o `ACCESS EXCLUSIVE` dela: os índices da tabela comum ganham o sufixo
   `_legacy` e ela vira `<fila>_legacy`; nasce o pai particionado com as
   mesmas colunas, padrões e CHECKs, a chave primária e cada índice com o
   nome original; um `CHECK ("id" < corte)` validado prova que a legada cabe
   abaixo do corte (a única varredura da troca), e o `ATTACH` como a
   partição de `MINVALUE` até o corte anexa os índices dela aos do pai, sem
   reconstruir nenhum. O corte é a próxima meia-noite UTC.
3. **Os dias à frente.** Uma semana de partições a partir do corte, com os
   parâmetros de armazenamento que a tabela comum tinha (o pai particionado
   não os aceita), os alvos de estatística das colunas, os grants da tabela
   no pai (as partições não têm nenhum) e o `trajetto_partitions` como dono
   da árvore. Dali em diante o job `partition-maintenance` mantém
   `QUEUE_PARTITION_LOOKAHEAD_DAYS` dias à frente.

Fica de fora, com o motivo no estado do passo:

- **Um lock que não veio** em 3 s (três tentativas): `pending`; enquanto o
  passo espera o lock, toda consulta nova àquela fila espera atrás dele, e
  essa espera é a pausa que a fila sente.
- **Um id no corte ou depois** (um v4 escrito à mão, um relógio adiantado):
  a fila fica comum, `pending`, até o expurgo levá-lo ou o dia chegar.
- **Mais de 2 M linhas** (`pg_class.reltuples`): `skipped`. A validação do
  CHECK lê a tabela inteira sob o lock, e com milhões de linhas essa pausa
  passa do que um deploy pode impor. A troca dessa tabela pede uma janela
  própria (abaixo).
- **Um erro qualquer** numa fila desfaz só a troca dela e deixa o passo
  `pending` com a mensagem: a troca nunca reprova um deploy.

Num banco sem empresa (o molde do E2E, o `yarn dev` do zero) a troca roda na
hora: todas as suítes rodam sobre as filas particionadas.

## A volta

`prisma/post-deploy/rollback/unpartition-queue.sql`, à mão, nunca pela etapa
(a subpasta não é um passo):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "SET trajetto.unpartition_queue = 'webhook_delivery'" \
  -f prisma/post-deploy/rollback/unpartition-queue.sql
```

Para cada fila pedida (uma, várias separadas por vírgula, ou `all`), sob o
`ACCESS EXCLUSIVE` dela: uma tabela comum com as mesmas colunas, padrões,
CHECKs, parâmetros, índices (nomes originais), grants e alvos de
estatística, com **todas** as linhas copiadas; o pai particionado e as
partições saem. A trava dura a cópia inteira: com milhões de linhas, é uma
janela com os workers parados. A tabela fica com o comentário
`trajetto:swap-hold`, e a troca a deixa em paz (`skipped`) até alguém tirar
o comentário (`COMMENT ON TABLE <fila> IS NULL`).

## Medir a trava antes da produção

Na staging, com o seed `LOAD_TIER=prod-like` num Database descartável e as
filas ainda comuns (o passo `pending` à espera da capability), em duas
sessões do `psql`:

```sql
-- sessão 1: quem espera por uma fila, e há quanto tempo, a cada 200 ms
SELECT now() - a.query_start AS espera, l.relation::regclass, l.mode, a.application_name
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE NOT l.granted
  AND l.relation::regclass::text IN ('domain_outbox_event', 'notification_delivery',
                                     'notification_provider_receipt', 'webhook_delivery')
ORDER BY espera DESC;
\watch 0.2
```

Na sessão 2, o _Run workflow_ com `force_release` (ou a etapa da
`trajetto-api-migrate`). O aceite é nenhuma espera acima de 3 s; o log da
etapa diz quanto cada fila levou (`… em N s`).

## Consequências

- O piso de rollback do código é a release do F5-06 (já era): a imagem de
  antes do plano não roda sobre as filas sem uniques.
- Toda escrita nas filas precisa de id v7; a guarda unitária cobra o `src/`,
  e os testes semeiam com `tests/E2E/support/uuid7-sql.ts`.
- A retenção passa a ser por dia (F5-11, F5-12); enquanto a partição legada
  existir, o expurgo em lotes continua valendo para ela.
- Uma consulta sem o id no filtro lê todas as partições: os planos com as
  39 partições que a retenção guarda são conferidos por
  `tests/E2E/query-plans-partitioned-queues.test.ts` (F5-13). As
  reivindicações passam do portão de 2 ms de planejamento sem o intervalo
  de ids em voo (`QUEUE_CLAIM_ID_FLOOR_ENABLED`), o plano B, que poda os
  dias sem linha a reivindicar.
