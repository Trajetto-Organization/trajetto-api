# SLOs da API

**Estado: PROPOSTO.** Os alvos abaixo vêm do plano de escala (seção 6.3) e
ainda não foram medidos contra a produção. Valem como régua quando o dono
aprovar; até lá, nenhuma regra de alerta muda por causa deste arquivo, e
nada no código o lê.

**Aprovação do dono:** pendente (nome e data entram aqui; mudar um alvo
depois é um commit neste arquivo, com o porquê).

Um SLO é um alvo de serviço que a gente se compromete a medir: um
indicador, o número que ele precisa bater e de onde o número sai. Sem fonte
não há SLO, só uma intenção. Por isso cada linha diz onde o número é lido
e se essa fonte já existe hoje.

## Os SLOs

| Indicador                            | Alvo                                                                                   | Fonte                                                                                                                                                       | Medível hoje                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Disponibilidade da API em 30 dias    | 99,9%                                                                                  | sonda externa em `/health/readiness` a cada 30 s (Uptime Kuma), mais a parte de 5xx nas linhas dos processos do `ops_sample` (`metrics.http.classes`)       | sim (a sonda está em 1 min, [deploy.md §20](./deploy.md#20-alertas-e-monitoramento); passar a 30 s é ajuste do dono) |
| Leituras do painel                   | p95 < 300 ms, p99 < 1 s                                                                | histograma dos grupos `lists` e `details` no `ops_sample` (`metrics.http.groups`)                                                                           | sim, pela borda de 250 ms (abaixo)                                                                                   |
| POST `/route/positions`              | p95 < 250 ms                                                                           | histograma do grupo `positions` no `ops_sample`                                                                                                             | sim                                                                                                                  |
| Envios do motorista                  | p95 < 500 ms                                                                           | histograma do grupo `driver_writes` no `ops_sample`                                                                                                         | sim                                                                                                                  |
| Outbox elegível                      | p95 < 30 s                                                                             | `metrics.queues.outbox_eligible_lag_seconds` da linha `cluster` do `ops_sample`, minuto a minuto (o gatilho do ADR 0001)                                    | sim                                                                                                                  |
| Sino e push depois do fato           | p95 < 10 s (≤ 3 s depois da F3)                                                        | SQL sobre `notification_delivery`, canais `IN_APP` e `PUSH`: o `deliveredAt` menos o `created_at` do evento do outbox                                       | sim                                                                                                                  |
| E-mail e WhatsApp                    | p95 < 2 min                                                                            | o mesmo SQL, canais `EMAIL` e `WHATSAPP`                                                                                                                    | sim                                                                                                                  |
| Webhook para endpoint saudável       | p95 < 60 s                                                                             | `webhook_delivery`: o `deliveredAt` menos o `created_at` das linhas entregues na primeira tentativa                                                         | sim                                                                                                                  |
| Sockets de volta depois de um deploy | 99% em ≤ 60 s                                                                          | a cena de socket dos portões (`socket-fleet`, que mede a volta depois de um restart), no relatório de portão de [`docs/desempenho`](./desempenho/README.md) | não na produção: é prova de portão, com a cena do LOAD-05 (`tests/load/socket-fleet.mjs`)                            |
| Feed de integração                   | 0 eventos pulados                                                                      | o E2E de ordem de commit (10 mil intercalações) mais uma reconciliação diária                                                                               | não: o E2E chega com o F2-05; a reconciliação diária ainda sem item no plano                                         |
| RPO e RTO                            | até 100k: RPO ≤ 2 min e RTO ≤ 1 h; de 1M em diante, com o standby: segundos e ≤ 15 min | o ensaio mensal de restauração ([runbook](./runbooks/restore-drill.md)), que mede o tempo e a perda pela linha-marcador `max(ts)` do `ops_sample`           | não na produção: o PITR da produção chega com o F1-25; até lá o RPO é o do dump diário do Dokploy, 24 h              |

O que fica de fora de propósito: a Torre (grupo `tower`) é medida, mas não
tem alvo proposto; o plano chama de "leituras do painel" as listas e os
detalhes, e é assim que `src/shared/health/route-groups.ts` agrupa as rotas.

## Como cada um é medido

As linhas do `ops_sample` são uma por processo por minuto, mais uma linha
`cluster` por minuto do ambiente inteiro
([deploy.md, Séries de operação](./deploy.md#séries-de-operação-ops_sample)),
guardadas por `OPS_SAMPLE_RETENTION_DAYS` (30) dias. A leitura é pelo `psql`.
Os exemplos usam a janela de 24 h; a do SLO é a de 30 dias.

### Disponibilidade

- **Erro** é uma resposta 5xx, os 503 do banco recusando inclusos. Um 429 não
  conta: é o limite de taxa fazendo o trabalho dele. As rotas de `/health`
  entram, no grupo `other`.
- O alvo vale quando as **duas** fontes passam. A sonda fica fora do servidor e
  pega a VPS inteira caída, que o `ops_sample` não vê (ninguém grava). A conta
  dos 5xx pega a falha parcial, que uma sonda de 30 s deixa passar.
- **Orçamento de erro:** 0,1% de 30 dias são 43 min 12 s de indisponibilidade,
  ou 1 requisição em mil com 5xx.

```sql
-- parte das respostas com 5xx nas últimas 24 h, somando as réplicas
SELECT sum((metrics->'http'->'classes'->>'5xx')::bigint)::numeric
       / NULLIF(sum((metrics->'http'->>'requests')::bigint), 0) AS parte_5xx
FROM ops_sample
WHERE ts > now() - interval '24 hours' AND role <> 'cluster';
```

### Latência por grupo de rota

O histograma de cada grupo (`src/shared/health/http-metrics.ts`) conta por
faixa, não acumulado, com as bordas de 25, 50, 100, 250, 500, 1000, 2500,
5000 e 10000 ms e uma faixa a mais para o que passa de 10 s. Na faixa de
índice `i` (a partir de 0) estão as requisições de até `borda[i]`. Um
"p95 < X ms" vale como "no máximo 5% das requisições do grupo acima de X".
Não há borda de 300 ms: as leituras do painel contam como lenta a requisição
acima de 250 ms, que é mais rigoroso. Uma borda nova muda a versão da amostra
(`v` do `ops_sample`), e então este arquivo muda junto.

| SLO                      | Grupos             | Lenta acima de     |
| ------------------------ | ------------------ | ------------------ |
| Leituras do painel, p95  | `lists`, `details` | 250 ms (índice 4)  |
| Leituras do painel, p99  | `lists`, `details` | 1000 ms (índice 6) |
| POST `/route/positions`  | `positions`        | 250 ms (índice 4)  |
| Envios do motorista, p95 | `driver_writes`    | 500 ms (índice 5)  |

O índice é o primeiro acima da borda: no máximo 5% (ou 1%, no p99) das
requisições podem cair dele em diante.

```sql
-- leituras do painel nas últimas 24 h: a parte acima de 250 ms (alvo ≤ 5%)
-- e a parte acima de 1 s (alvo ≤ 1%)
WITH faixas AS (
  SELECT i, (grupo.value->'latency_ms'->'counts'->>i)::bigint AS n
  FROM ops_sample,
       jsonb_each(metrics->'http'->'groups') AS grupo,
       generate_series(0, 9) AS i
  WHERE ts > now() - interval '24 hours'
    AND role <> 'cluster'
    AND grupo.key IN ('lists', 'details')
)
SELECT sum(n) FILTER (WHERE i >= 4)::numeric / NULLIF(sum(n), 0) AS acima_250ms,
       sum(n) FILTER (WHERE i >= 6)::numeric / NULLIF(sum(n), 0) AS acima_1s
FROM faixas;
```

Para as posições, troque os grupos por `'positions'`; para o motorista, por
`'driver_writes'` com `i >= 5`.

### Outbox elegível

A linha `cluster` de cada minuto traz a idade do evento devido mais antigo
ainda não expandido (`NULL` quando não há nenhum, que conta como zero). O
p95 é sobre os minutos da janela: no máximo 5% dos minutos com mais de 30 s.
O atraso é elegível, não idade: um evento esperando nova tentativa não conta
([runbook do outbox](./runbooks/outbox-lag.md)).

```sql
SELECT percentile_cont(0.95) WITHIN GROUP (
         ORDER BY coalesce((metrics->'queues'->>'outbox_eligible_lag_seconds')::float8, 0)
       ) AS p95_s
FROM ops_sample
WHERE role = 'cluster' AND ts > now() - interval '24 hours';
```

### Notificações e webhooks

- **Depois do fato** é do commit que gravou o fato até a entrega: o evento do
  outbox nasce na mesma transação do dado (ADR 0003), então o `created_at`
  dele é o momento do fato.
- **Entregue** é o `deliveredAt`, quando o provedor aceitou a mensagem (a Expo
  no push, o Resend no e-mail, a Meta no WhatsApp), não quando o telefone a
  mostrou. O que o provedor disse depois fica em `providerStatus`.
- A janela lê um intervalo da chave primária (uuid v7), não o `created_at`,
  que não tem índice nessa tabela (`deliveryIdFloor`, em
  `src/shared/health/metrics-queries.ts`). O id de cada entrega começa pelo
  milissegundo do evento (F5-03), então a janela pega as entregas dos
  eventos das últimas 24 h. As linhas entregues ficam 30 dias.

```sql
-- p95 depois do fato por canal, nas últimas 24 h
WITH piso AS (
  SELECT substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-0000-0000-000000000000' AS id
  FROM (SELECT lpad(to_hex((extract(epoch FROM now() - interval '24 hours') * 1000)::bigint), 12, '0') AS h) AS t
)
SELECT d."channel", count(*) AS entregas,
       percentile_cont(0.95) WITHIN GROUP (
         ORDER BY extract(epoch FROM d."deliveredAt" - e."created_at")
       ) AS p95_s
FROM "notification_delivery" d
JOIN "domain_outbox_event" e ON e."id" = d."outboxEventId"
WHERE d."id" >= (SELECT id FROM piso)
  AND d."status" = 'DELIVERED'
GROUP BY 1
ORDER BY 1;
```

O sino é o canal `IN_APP`. O alvo de ≤ 3 s depois da F3 conta com o
despertar entre processos (plano de escala, F3-04).

Os webhooks nascem na mesma transação do fato. **Endpoint saudável** é o que
recebeu na primeira tentativa (`attempts = 1`): uma retentativa diz que o
endpoint do cliente falhou ou demorou, e esse tempo não é nosso. O tempo de
resposta do endpoint (`latency_ms`) fica dentro da conta. Uma linha guardada
enquanto o endpoint estava pausado também sai com `attempts = 1` e conta como
lenta: com um endpoint pausado na janela, confira o `disabled_at` dele antes
de ler o p95 como atraso nosso.

```sql
SELECT count(*) AS entregas,
       percentile_cont(0.95) WITHIN GROUP (
         ORDER BY extract(epoch FROM "deliveredAt" - "created_at")
       ) AS p95_s
FROM "webhook_delivery"
WHERE "created_at" > now() - interval '24 hours'
  AND "status" = 'DELIVERED'
  AND "attempts" = 1
  AND "topic" <> 'ping';
```

### Sockets, feed, RPO e RTO

Esses três não são séries contínuas: são provas de portão e de ensaio.

- **Sockets:** a cena `socket-fleet` (LOAD-05, `tests/load/socket-fleet.mjs`)
  reinicia a API com os sockets abertos e mede quantos voltam em até 60 s; o
  resumo dela reprova abaixo de 99%. O número entra no relatório do portão.
- **Feed de integração:** o E2E de ordem de commit (F2-05) prova 0 pulados em
  10 mil intercalações. A reconciliação diária que o plano cita (comparar o que
  o feed serviu com o que foi gravado) não tem item ainda: o dono decide se
  ela vira um.
- **RPO e RTO:** o ensaio mensal restaura num contêiner descartável e anota o
  tempo e a perda (`max(ts)` da linha `cluster` do `ops_sample` restaurado),
  em [deploy.md, Ensaiar a restauração](./deploy.md#ensaiar-a-restauração).

## A regra dos alertas

**Até haver 30 dias de `ops_sample`, só limiares fixos.** O relógio começa
quando a série chega à produção (a promoção da onda 1). São as regras que já
existem no `ops-heartbeat` (`src/shared/health/alert-rules.ts`), com a tabela
em [deploy.md §20](./deploy.md#20-alertas-e-monitoramento) e um runbook por
motivo ([índice](./runbooks/README.md)).

**Depois, burn rate em duas janelas,** calculado em SQL sobre o `ops_sample`
dentro do `ops-heartbeat`. O burn rate é a velocidade com que o orçamento de
erro está sendo gasto: a parte de eventos ruins na janela dividida pelo que o
alvo permite (0,1% na disponibilidade, 5% num p95, 1% num p99). Em 1, o
orçamento acaba exatamente nos 30 dias. Duas regras, e cada uma exige as duas
janelas acima do limite, para não acordar ninguém por um pico que já passou:

- rápida: 1 h e 5 min, as duas acima de 14,4× (2% do orçamento do mês numa hora);
- lenta: 6 h e 30 min, as duas acima de 6× (5% do orçamento em seis horas).

Valem para os SLOs que o `ops_sample` mede: disponibilidade, as latências por
grupo e o outbox (minuto ruim = mais de 30 s). As notificações e os webhooks
seguem com os limiares de atraso das filas (`delivery-lag`, `webhook-lag`);
sockets, feed e RPO/RTO são de portão e de ensaio, sem alerta contínuo.
Nenhum item do plano constrói o burn rate ainda: quando houver 30 dias de
série, ele vira um item, com um código de alerta e um runbook por regra (o
`runbooks.test.ts` recusa um sem o outro).

### Os limiares fixos do plano, e onde estão hoje

| Limiar do plano                                                                     | Onde está                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ELU > 0,8 por 5 min, lag p99 > 200 ms, canário > 250 ms, pool waiting > 0 por 1 min | sem alerta até a pilha de métricas (onda 23): o ELU, o lag p99 e o pool waiting estão nas regras do vmalert (`infra/monitoring/vmalert/process.yml`, F5-30, em observação, sem paginar); o canário não sai no `/metrics`. Até lá, os números estão em cada linha de processo do `ops_sample` (`event_loop`, `threadpool`, `prisma_pool`) e na linha de log `runtime metrics`, e os limites estão no comentário de `src/shared/health/runtime-metrics.ts` |
| Disco > 80%                                                                         | no Beszel, que vê o disco do host ([runbook](./runbooks/disk-full.md))                                                                                                                                                                                                                                                                                                                                                                                   |
| WAL parado                                                                          | [`wal-archive-stalled`](./runbooks/wal-archive-stalled.md), com o arquivamento ligado                                                                                                                                                                                                                                                                                                                                                                    |
| `archive_mode` diferente de `on`                                                    | [`pitr-archive-off`](./runbooks/pitr-archive-off.md), só com `PITR_EXPECTED=true`                                                                                                                                                                                                                                                                                                                                                                        |
| `evicted_keys` > 0                                                                  | [`redis-evictions`](./runbooks/redis-evictions.md), contra a linha `cluster` de 15 min atrás                                                                                                                                                                                                                                                                                                                                                             |

```sql
-- os quatro limiares do processo, por réplica, na última hora
SELECT replica, ts,
       (metrics->'event_loop'->>'utilization')::float8 AS elu,
       (metrics->'event_loop'->>'lag_p99_ms')::float8 AS lag_p99_ms,
       (metrics->'threadpool'->>'canary_max_ms')::float8 AS canario_ms,
       (metrics->'prisma_pool'->>'waiting')::int AS pool_waiting
FROM ops_sample
WHERE ts > now() - interval '1 hour' AND role <> 'cluster'
ORDER BY replica, ts;
```
