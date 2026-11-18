# history-window — Janela do histórico: `delivery_event` particionada por mês

**Quando:** o ensaio na staging antes, a janela de madrugada que você aprovou (onda 11 do plano de escala) e, se preciso, a volta nos 14 dias seguintes.

## O que significa

A linha do tempo das entregas (`delivery_event`) cresce para sempre e é lida por empresa e por entrega. Particionada por mês pelo id (um uuid v7, que ordena no tempo), cada leitura quente lê um ou dois meses, não o histórico inteiro (plano de escala F2-17, decisões D39 e D68). A casca vazia, `delivery_event_part`, já está no banco desde a release do plano, com as colunas, os índices, as chaves estrangeiras e o gatilho do U-16.

A cópia é o passo `prisma/post-deploy/30-delivery-event-window.sql` da etapa de release e **só roda dentro do intervalo** `HISTORY_WINDOW_APPROVED` do _Environment_ da `trajetto-api-migrate`: dois instantes ISO com fuso, separados por `/`, no máximo 24 h, por exemplo `2026-12-06T06:00:00Z/2026-12-06T07:30:00Z`. Fora dele, ou sem ele, o passo termina `skipped: aguardando janela`; um hotfix promovido depois nunca dispara a janela sem aviso. Dentro dele, o passo espera (`pending`) todo processo vivo anunciar `history-partition-agnostic-v1` e então, numa transação:

1. trava as escritas da `delivery_event` (as leituras seguem): esse é o tempo de pausa, medido;
2. recupera em `delivery_event_submission` as chaves de envio que a imagem anterior gravou só na coluna;
3. copia toda linha para a casca com o `txid` como está (NULL continua NULL): um integrador com cursor v2 não recebe nada repetido nem perde nada;
4. confere as contagens;
5. troca os nomes: a tabela de antes vira `delivery_event_legacy` (fica 14 dias, sai na onda 20), a casca vira `delivery_event`, os meses viram `delivery_event_AAAAMM` e a partição de tudo que veio antes do primeiro mês vira `delivery_event_older`.

O `applied:` diz quantas linhas foram copiadas e a pausa de escrita (`pausa de escrita de N s`). Um lock que não veio, um erro ou contagens diferentes deixam tudo como estava e o passo diz `pending:` com o motivo: dá para rodar de novo dentro do intervalo.

## Primeira ação

**Antes (uma semana antes da janela):**

1. Ensaio na staging, num Database descartável (decisão D70: 1 GiB, 0,5 CPU, folga de disco de 2× o banco mais 20 GB, a API e a web da staging em 0 réplicas): migre o banco (a etapa de release roda e o passo fica `skipped: aguardando janela`), semeie com `LOAD_TIER=prod-like` (só as contagens da produção) e rode a etapa de novo com `HISTORY_WINDOW_APPROVED` cobrindo o agora.
2. Anote a pausa do `applied:` (no log da etapa, ou na consulta de `release_step_state` abaixo) num arquivo `docs/desempenho/<data>-janela-delivery-event.md`. O portão é **pausa de escrita abaixo de 60 s**; acima disso, não faça a janela na produção e chame quem cuida do plano.
3. Escolha a janela (padrão: domingo, 03:00 BRT, 06:00 UTC) e avise clientes e integradores 48 h antes: durante a pausa, as gravações da linha do tempo esperam, e o feed `/integration/v1/events` atrasa (não pula evento).
4. Confira que o full semanal do pgBackRest rodou no sábado.

**Na janela:**

1. Dokploy → `trajetto-api-migrate` da produção → _Environment_ → `HISTORY_WINDOW_APPROVED=<início ISO>/<fim ISO>` → _Save_.
2. GitHub → _Actions_ → `production` → _Run workflow_ com `force-release` = true, e aprove o environment `production`.
3. Acompanhe a task da `trajetto-api-migrate` até terminar e leia o `applied:` do `30-delivery-event-window.sql`. Um `pending:` dentro do intervalo: leia o motivo; se for o lock ou a capability, rode o _Run workflow_ de novo enquanto o intervalo durar.
4. Confira o `/health/metrics` (as partições de `delivery_event` sem alerta) e o feed de um integrador.
5. Rode um full do pgBackRest logo depois (_Schedules_ → backup full → _Run now_).
6. Apague o `HISTORY_WINDOW_APPROVED` do _Environment_.

**A volta, só nos 14 dias e só se a tabela particionada der problema:** pare a API (`trajetto-api` em 0 réplicas) e rode no Database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "SET trajetto.unpartition_history = 'delivery_event'" \
  -f prisma/post-deploy/rollback/unpartition-delivery-event.sql
```

Ela traz de volta as linhas gravadas depois da janela e o endereço do GPS preenchido depois, devolve os nomes e deixa a casca vazia de novo, com o comentário `trajetto:window-hold` na tabela: a janela não roda mais sozinha. Para uma janela nova, `COMMENT ON TABLE "delivery_event" IS NULL`.

## Como confirmar

A linha do tempo particionada, a tabela de antes guardada e as contagens iguais:

```sql
SELECT relname, relkind FROM pg_class
WHERE relname IN ('delivery_event', 'delivery_event_legacy', 'delivery_event_part');

SELECT (SELECT count(*) FROM delivery_event_legacy) AS antes,
       (SELECT count(*) FROM delivery_event WHERE id <= (SELECT max(id) FROM delivery_event_legacy)) AS copiadas;

SELECT status, detail, updated_at FROM release_step_state
WHERE step = 'prisma/post-deploy/30-delivery-event-window.sql';
```

`delivery_event` com `relkind` `p`, `delivery_event_legacy` com `r`, nenhuma `delivery_event_part`; as duas contagens iguais (a segunda pode passar da primeira só pelas linhas gravadas depois, com id menor que o último copiado, o que é raro); o `detail` com a pausa. As partições:

```sql
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid)
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = 'delivery_event'::regclass ORDER BY 1;
```

## Quando escalar

A pausa do ensaio acima de 60 s, um `pending:` com erro de cópia ou de contagem, um `failed` na etapa, ou um integrador que diga ter recebido eventos repetidos ou perdido algum depois da janela: chame o dono antes de qualquer outra janela. Não apague a `delivery_event_legacy` à mão: ela é a volta, e sai pela contração da onda 20 depois dos 14 dias.
