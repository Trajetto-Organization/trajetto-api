# history-window — Janela do histórico: `delivery_event` e `activity` particionadas por mês

**Quando:** o ensaio na staging antes, a janela de madrugada que você aprovou (onda 11 do plano de escala) e, se preciso, a volta nos 14 dias seguintes.

## O que significa

A linha do tempo das entregas (`delivery_event`) cresce para sempre e é lida por empresa e por entrega. Particionada por mês pelo id (um uuid v7, que ordena no tempo), cada leitura quente lê um ou dois meses, não o histórico inteiro (plano de escala F2-17, decisões D39 e D68). A casca vazia, `delivery_event_part`, já está no banco desde a release do plano, com as colunas, os índices, as chaves estrangeiras e o gatilho do U-16.

A cópia é o passo `prisma/post-deploy/30-delivery-event-window.sql` da etapa de release e **só roda dentro do intervalo** `HISTORY_WINDOW_APPROVED` do _Environment_ da `trajetto-api-migrate`: dois instantes ISO com fuso, separados por `/`, no máximo 24 h, por exemplo `2026-12-06T06:00:00Z/2026-12-06T07:30:00Z`. Fora dele, ou sem ele, o passo termina `skipped: aguardando janela`; um hotfix promovido depois nunca dispara a janela sem aviso. Dentro dele, o passo espera (`pending`) todo processo vivo anunciar `history-partition-agnostic-v1` e então, numa transação:

1. trava as escritas da `delivery_event` (as leituras seguem): esse é o tempo de pausa, medido (o que ele faz com quem grava está logo abaixo);
2. recupera em `delivery_event_submission` as chaves de envio que a imagem anterior gravou só na coluna;
3. copia toda linha para a casca com o `txid` como está (NULL continua NULL): um integrador com cursor v2 não recebe nada repetido nem perde nada;
4. confere as contagens;
5. troca os nomes: a tabela de antes vira `delivery_event_legacy` (fica 14 dias, sai na onda 20), a casca vira `delivery_event`, os meses viram `delivery_event_AAAAMM` e a partição de tudo que veio antes do primeiro mês vira `delivery_event_older`. O instante da janela fica no comentário da tabela de antes (`trajetto:window-legacy at=<instante UTC>`): é por ele que a contração da onda 20 (F2-20) conta os 14 dias, porque a linha do passo em `release_step_state` é regravada pela release seguinte.

O registro de atividades (`activity`, F2-18) vai na mesma janela, pelo passo seguinte, `prisma/post-deploy/31-activity-window.sql`, com a mesma aprovação e a mesma capability: as escritas da `activity` param enquanto toda linha é copiada para a casca `activity_part`, e todo id de antes da troca para uuid v7 (09/2025, um uuid v4 aleatório) ganha um v7 do próprio `created_at`, o mesmo em toda rodada (a função `trajetto_activity_rekey`). A tabela de antes vira `activity_legacy`, com os ids antigos, por 14 dias; a partição de antes do primeiro mês vira `activity_older`. A linha do tempo aberta numa aba antes da janela recomeça do topo sozinha (o cabeçalho `x-trajetto-data-version` passa de `1` a `2`).

O `applied:` diz quantas linhas foram copiadas (e, na `activity`, quantos ids foram re-chaveados) e a pausa de escrita (`pausa de escrita de N s`). Um lock que não veio, um erro ou contagens diferentes deixam tudo como estava e o passo diz `pending:` com o motivo: dá para rodar de novo dentro do intervalo.

**O que a pausa faz com quem grava.** Uma gravação não espera a pausa inteira: espera o lock no máximo o `lock_timeout` da API (5 s, nas `options` da `DATABASE_URL` e nos logins por papel) e então falha sem gravar nada (a transação volta), com **503 `SERVICE_BUSY`** e `Retry-After` de 2 s. Vale para toda gravação que passa pela linha do tempo (criar entrega, mudar status, comprovante, ocorrência) e pela `activity`, que entra na transação de quase toda ação do painel, do app e da API pública: durante cada pausa, quase nada se grava. O app repete sozinho (respeita o `Retry-After`), a web mostra "O sistema está ocupado; tente de novo em instantes." e o usuário tenta de novo, e o integrador precisa repetir o pedido com a mesma `Idempotency-Key`. As leituras seguem, mas cada gravação que espera ocupa uma conexão do pool por até 5 s, e uma leitura pode receber 503 se o pool encher. Por isso o portão é a pausa do ensaio abaixo de 60 s, e o aviso de 48 h fala em erros, não em lentidão.

## Primeira ação

**Antes (uma semana antes da janela):**

1. Ensaio na staging, num Database descartável (decisão D70: 1 GiB, 0,5 CPU, folga de disco de 2× o banco mais 20 GB, a API e a web da staging em 0 réplicas), pelo túnel e com o repositório na sua máquina, como o seed `prod-like` pede (`tests/load/README.md`). **Nunca pelo _Run workflow_ nem pela `trajetto-api-migrate`**: a etapa de release roda no Database da staging, não no descartável, e o `HISTORY_WINDOW_APPROVED` da staging fica vazio.

   Migre o descartável só com `yarn prisma:migrate:deploy` pelo túnel (as cascas `delivery_event_part` e `activity_part` vêm das migrations), semeie com `LOAD_TIER=prod-like` (só as contagens da produção) e rode os dois passos à mão no `psql`, na raiz do repositório. Com empresas no banco, cada passo espera todo processo vivo anunciar `history-partition-agnostic-v1`, e ali não há processo nenhum: sem o anúncio, fica `pending` para sempre. O anúncio vai à mão, só neste banco, numa linha de `ops_sample` antes de cada passo (a prontidão lê os últimos 5 minutos). A aprovação é a configuração `trajetto.history_window_approved` da sessão, a mesma que a etapa de release monta do `HISTORY_WINDOW_APPROVED`, aqui das próximas 6 horas:

   ```sql
   -- psql "$DATABASE_URL" (o túnel para o Database descartável), na raiz do repositório
   \i prisma/post-deploy/00-queue-swap-ready.sql

   SELECT set_config(
     'trajetto.history_window_approved',
     to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') || '/'
       || to_char(now() AT TIME ZONE 'UTC' + interval '6 hours', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     false
   );

   INSERT INTO ops_sample (id, ts, role, replica, metrics)
   VALUES (gen_random_uuid()::text, now() AT TIME ZONE 'UTC', 'all', 'ensaio-da-janela',
           '{"v": 1, "capabilities": ["history-partition-agnostic-v1"]}');

   \i prisma/post-deploy/30-delivery-event-window.sql

   INSERT INTO ops_sample (id, ts, role, replica, metrics)
   VALUES (gen_random_uuid()::text, now() AT TIME ZONE 'UTC', 'all', 'ensaio-da-janela',
           '{"v": 1, "capabilities": ["history-partition-agnostic-v1"]}');

   \i prisma/post-deploy/31-activity-window.sql
   ```

2. Anote a pausa do `NOTICE:  applied:` de cada passo (`pausa de escrita de N s`; à mão não há linha em `release_step_state`) num arquivo `docs/desempenho/<data>-janela-delivery-event.md`. O portão é **pausa de escrita abaixo de 60 s** em cada passo; acima disso, não faça a janela na produção e chame quem cuida do plano. Apague o Database descartável no fim.
3. Escolha a janela (padrão: domingo, 03:00 BRT, 06:00 UTC) e avise clientes e integradores 48 h antes: durante a pausa de cada passo (até 1 minuto, pelo ensaio), as gravações que passam pela linha do tempo ou pelo registro de atividades, quase todas, falham com 503 `SERVICE_BUSY` e `Retry-After`; o integrador repete o pedido com a mesma `Idempotency-Key`, o app repete sozinho e, no painel, o usuário tenta de novo. As leituras seguem, e o feed `/integration/v1/events` atrasa (não pula evento).
4. Confira que o full semanal do pgBackRest rodou no sábado.

**Na janela:**

1. Dokploy → `trajetto-api-migrate` da produção → _Environment_ → `HISTORY_WINDOW_APPROVED=<início ISO>/<fim ISO>` → _Save_.
2. Rode a etapa de release da produção **sem trocar de build**: Dokploy → `trajetto-api-migrate` da produção → **Deploy** (ela roda a imagem `:stable`, a que está no ar), ou GitHub → _Actions_ → `production` → _Run workflow_ com `image_tag` = a tag que a produção roda agora (o `sha-<7>` da última promoção verde, no resumo do _Staging evidence_ dela) e `force_release` marcado, e aprove o environment `production`. Nunca uma tag mais nova: o `image_tag` é obrigatório, e um build novo seria promovido para a produção na mesma noite, junto com a cópia, o que esta aprovação existe para evitar.
3. Acompanhe a task da `trajetto-api-migrate` até terminar e leia o `applied:` do `30-delivery-event-window.sql` e do `31-activity-window.sql`. Um `pending:` dentro do intervalo: leia o motivo; se for o lock ou a capability, rode a etapa de novo pelo passo 2, do mesmo jeito, enquanto o intervalo durar (o passo que já rodou diz `skipped`).
4. Confira o `/health/metrics` (as partições de `delivery_event` e de `activity` sem alerta), o feed de um integrador e o Registro de Atividades no painel.
5. Rode um full do pgBackRest logo depois (_Schedules_ → backup full → _Run now_).
6. Apague o `HISTORY_WINDOW_APPROVED` do _Environment_.

**A volta, só nos 14 dias e só se a tabela particionada der problema:** pare a API (`trajetto-api` em 0 réplicas) e rode no Database:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "SET trajetto.unpartition_history = 'delivery_event'" \
  -f prisma/post-deploy/rollback/unpartition-delivery-event.sql
```

Ela traz de volta as linhas gravadas depois da janela e o endereço do GPS preenchido depois, devolve os nomes e deixa a casca vazia de novo, com o comentário `trajetto:window-hold` na tabela: a janela não roda mais sozinha. Para uma janela nova, `COMMENT ON TABLE "delivery_event" IS NULL`. A da `activity` é igual, com os ids de antes de volta:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -c "SET trajetto.unpartition_history = 'activity'" \
  -f prisma/post-deploy/rollback/unpartition-activity.sql
```

**O id antigo de uma atividade (suporte, nos 14 dias):** quem guardou um id de antes da janela (um print, uma planilha exportada) acha a atividade pelo id novo:

```sql
SELECT id AS id_antigo, trajetto_activity_rekey(id, created_at) AS id_novo
FROM activity_legacy WHERE id = '<id antigo>';
```

## Como confirmar

A linha do tempo particionada, a tabela de antes guardada e as contagens iguais:

```sql
SELECT relname, relkind FROM pg_class
WHERE relname IN ('delivery_event', 'delivery_event_legacy', 'delivery_event_part');

SELECT (SELECT count(*) FROM delivery_event_legacy) AS antes,
       (SELECT count(*) FROM delivery_event WHERE id <= (SELECT max(id) FROM delivery_event_legacy)) AS copiadas;

SELECT step, status, detail, updated_at FROM release_step_state
WHERE step IN ('prisma/post-deploy/30-delivery-event-window.sql', 'prisma/post-deploy/31-activity-window.sql');

SELECT (SELECT count(*) FROM activity_legacy) AS antes,
       (SELECT count(*) FROM activity WHERE id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-7') AS fora_do_v7;
```

O instante de cada janela, de onde a contração conta os 14 dias:

```sql
SELECT relname, obj_description(oid, 'pg_class') FROM pg_class
WHERE relname IN ('delivery_event_legacy', 'activity_legacy');
```

`delivery_event` com `relkind` `p`, `delivery_event_legacy` com `r`, nenhuma `delivery_event_part`; as duas contagens iguais (a segunda pode passar da primeira só pelas linhas gravadas depois, com id menor que o último copiado, o que é raro); o `detail` de cada passo com a pausa; na `activity`, nenhum id fora do v7. As partições:

```sql
SELECT c.relname, pg_get_expr(c.relpartbound, c.oid)
FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
WHERE i.inhparent = 'delivery_event'::regclass ORDER BY 1;
```

## Quando escalar

A pausa do ensaio acima de 60 s, um `pending:` com erro de cópia ou de contagem, um `failed` na etapa, ou um integrador que diga ter recebido eventos repetidos ou perdido algum depois da janela: chame o dono antes de qualquer outra janela. Não apague a `delivery_event_legacy` nem a `activity_legacy` à mão: elas são a volta (e a `activity_legacy`, o id antigo), e saem pela contração da onda 20 depois dos 14 dias.
