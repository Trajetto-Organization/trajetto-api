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
2. **A tabela de hoje vira a partição legada, sem ser lida sob a trava.**
   Toda gravação numa fila acontece dentro de uma transação de negócio (o
   `publish(tx)` da mudança de status, do comprovante), que segura as
   próprias linhas enquanto espera: uma trava `ACCESS EXCLUSIVE` mantida
   durante a leitura da tabela inteira seguraria toda escrita que publica
   um evento. Por isso a troca de cada fila são três transações:
   - **A, a guarda.** Sob o `ACCESS EXCLUSIVE`, por um instante: o maior id
     (pelo índice da chave primária, sem ler a tabela) precisa estar abaixo
     do corte, e entra o `CHECK ("id" < corte) NOT VALID`
     (`<fila>_swap_cutoff`). Dali em diante toda linha nova é conferida
     contra ele.
   - **B, a validação.** O `VALIDATE CONSTRAINT` da guarda, a única leitura
     da tabela inteira, sob `SHARE UPDATE EXCLUSIVE`: leituras e escritas
     seguem; só um `VACUUM` ou outra DDL da mesma tabela espera.
   - **C, a troca.** Sob o `ACCESS EXCLUSIVE` de novo, só catálogo: os
     índices da tabela comum ganham o sufixo `_legacy` e ela vira
     `<fila>_legacy`; nasce o pai particionado com as mesmas colunas,
     padrões e CHECKs (menos a guarda, que o `LIKE` copia e o pai tira na
     hora), a chave primária e cada índice com o nome original; o `ATTACH`
     como a partição de `MINVALUE` até o corte não lê nada (a guarda
     validada prova o limite) e anexa os índices dela aos do pai, sem
     reconstruir nenhum; depois a guarda sai.

   O corte é a primeira meia-noite UTC a pelo menos um dia de distância (a
   que começa depois de amanhã): o que for gravado até lá cai na partição
   legada. O dia é a folga da guarda: entre A e C toda gravação é conferida
   contra ela, e um corte que chegasse antes recusaria as linhas do dia
   novo. Uma troca que não termina (o lock que não veio, um id no corte,
   um erro) tira a sua guarda antes de o passo acabar, e o passo tira
   também a de uma fila que deixa em paz. A guarda que o passo não
   conseguiu tirar (o lock dela também não veio), ou a de uma execução que
   morreu entre A e C, tem pelo menos aquele dia: a próxima execução a
   tira, ou continua dela se o corte ainda é o que escolheria. Até lá o
   passo fica `pending` e diz a fila e o corte a partir do qual ela
   recusaria toda gravação (o que fazer está em
   [deploy.md](../deploy.md#contrações-que-esperam-a-capability-onda-10)).

3. **Os dias à frente.** Uma semana de partições a partir do corte, com os
   parâmetros de armazenamento que a tabela comum tinha (o pai particionado
   não os aceita), os alvos de estatística das colunas, os grants da tabela
   no pai (as partições não têm nenhum) e o `trajetto_partitions` como dono
   da árvore. Dali em diante o job `partition-maintenance` mantém
   `QUEUE_PARTITION_LOOKAHEAD_DAYS` dias à frente.

Fica de fora, com o motivo no estado do passo:

- **Um lock que não veio** em 3 s (três tentativas): `pending`; enquanto o
  passo espera um `ACCESS EXCLUSIVE` (A e C), toda consulta nova àquela
  fila espera atrás dele, e essa espera é a pausa que a fila sente; a
  espera da validação (B) não segura ninguém.
- **Um id no corte ou depois** (um v4 escrito à mão, um relógio adiantado):
  a fila fica comum, `pending`, até o expurgo levá-lo ou o dia chegar.
- **Mais de 2 M linhas** (`pg_class.reltuples`): `skipped`. A validação da
  guarda lê a tabela inteira; sem trava sobre as escritas, mas com o disco
  do servidor compartilhado e o tempo da etapa de release, e com milhões de
  linhas isso passa do que um deploy deve impor. A troca dessa tabela pede
  uma janela própria (abaixo).
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

Num Database descartável da staging (1 GiB, 0,5 CPU, folga de disco de 2×
o banco da produção mais 20 GB, a API e a web da staging em 0), pelo túnel
e com o repositório na sua máquina, como o seed `prod-like` pede
(`tests/load/README.md`). Nunca pelo _Run workflow_: a etapa de release
roda no Database da staging, não no descartável.

1. Migre só com `yarn prisma:migrate:deploy`, sem a etapa de release: num
   banco sem empresa a troca roda na hora, e as filas já estariam
   particionadas antes do seed.
2. Semeie com `LOAD_TIER=prod-like`. Com empresas no banco, a troca espera
   todo processo vivo anunciar a capability, e ali não há processo nenhum:
   sem o anúncio, o passo fica `pending` para sempre. Faça o anúncio à mão,
   só neste banco, na mesma sessão que roda a troca (a prontidão lê os
   últimos 5 minutos de `ops_sample`):

   ```sql
   -- psql "$DATABASE_URL", na raiz do repositório
   \i prisma/post-deploy/00-queue-swap-ready.sql

   INSERT INTO ops_sample (id, ts, role, replica, metrics)
   VALUES (
     gen_random_uuid()::text,
     now() AT TIME ZONE 'UTC',
     'all',
     'ensaio-da-troca',
     '{"v": 1, "capabilities": ["queue-partition-agnostic-v1", "notification-partition-agnostic-v1"]}'
   );

   \i prisma/post-deploy/10-queue-partition-swap.sql
   \i prisma/post-deploy/20-notification-partition-swap.sql
   ```

3. Leia o `NOTICE` de cada passo:
   `tempos: <fila> em N s (espera E s, trava T s, validação V s)`. A trava
   é o tempo sob `ACCESS EXCLUSIVE` (só catálogo, perto de zero), a espera
   é o que cada consulta à fila esperaria atrás do pedido dela, e a
   validação é a leitura da tabela inteira, que não segura ninguém. O
   aceite é espera mais trava abaixo de 3 s em cada fila; a validação diz
   quanto a troca vai somar à etapa de release da produção.
   Uma fila com mais de 2 M linhas estimadas fica `skipped` (grande
   demais para a etapa); para medir também a dela, rode
   `SET trajetto.swap_window = 'on';` na sessão antes dos `\i`.

Com outra carga no banco, uma segunda sessão do `psql` mostra quem espera
por uma fila, e há quanto tempo, a cada 200 ms:

```sql
SELECT now() - a.query_start AS espera, l.relation::regclass, l.mode, a.application_name
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE NOT l.granted
  AND l.relation::regclass::text IN ('domain_outbox_event', 'notification_delivery',
                                     'notification_provider_receipt', 'webhook_delivery')
ORDER BY espera DESC;
\watch 0.2
```

Apague o Database no fim.

## Consequências

- O piso de rollback do código é a release do F5-06 (já era): a imagem de
  antes do plano não roda sobre as filas sem uniques.
- Toda escrita nas filas precisa de id v7; a guarda unitária cobra o `src/`,
  e os testes semeiam com `tests/E2E/support/uuid7-sql.ts`.
- A retenção passa a ser por dia (F5-11, F5-12); enquanto a partição legada
  existir, o expurgo em lotes continua valendo para ela.
- O sino (`notification`) segue o mesmo caminho, por mês (F5-15):
  `07-notification-contract.sql` e `20-notification-partition-swap.sql`,
  com a mesma volta (`trajetto.unpartition_queue = 'notification'`).
- Uma consulta sem o id no filtro lê todas as partições: os planos com as
  39 partições que a retenção guarda são conferidos por
  `tests/E2E/query-plans-partitioned-queues.test.ts` (F5-13). As
  reivindicações passam do portão de 2 ms de planejamento sem o intervalo
  de ids em voo (`QUEUE_CLAIM_ID_FLOOR_ENABLED`), o plano B, que poda os
  dias sem linha a reivindicar.
