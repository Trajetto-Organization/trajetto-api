# ADR 0001 — Filas e mensageria: o Postgres é a fila, sem broker

- **Status:** aceito. Decisão de 09/2026, revista com evidência em 28/10/2026
  (§7 de `README_AJUSTES_FINAIS_TRAJETTO.md`).
- **Escopo:** `trajetto-api`. O app e a web só consomem o resultado.
- **Substitui:** o ADR 0001 da raiz do workspace (`C:/dev/trajetto/docs`), que
  não é versionada e está vazia. Este arquivo passa a ser a fonte da decisão.

## Contexto

O sócio de infraestrutura perguntou se o RabbitMQ deveria voltar, para tirar
pressão do banco e aguentar volume alto de eventos. A pergunta é legítima: a
`main` antiga usava RabbitMQ, e a escala-alvo do Comprovei (5 milhões de
entregas/mês, 3.600 transportadoras) é bem maior que a de hoje.

Esta revisão olhou o código e as medições, não a intuição. Ela responde às
nove perguntas da §7 com caminho de arquivo, constante e número medido. Quando
algo não foi medido, o texto diz isso.

## Decisão

1. **Nenhum broker.** Nem RabbitMQ, nem Kafka, nem Redis Streams. As filas
   continuam sendo tabelas do Postgres, todas no mesmo desenho:

   - `domain_outbox_event`, gravada na transação do dado;
   - `notification_delivery`, com as raias `internal` e `external`;
   - `webhook_delivery`;
   - `ai_analysis_request`.

   O claim é `FOR UPDATE SKIP LOCKED`, com lease, fencing por `attempts`, teto
   de reclaim, backoff com jitter, dead letter e idempotência por chave única.

2. **O Redis fica no papel descartável:** rate limit (falha aberta), cooldown
   do "esqueci minha senha", pub/sub do `@socket.io/redis-adapter`, tickets de
   socket de 30 s e fotos curtas das leituras de plataforma do MASTER
   (`src/shared/cache/snapshot-cache.ts`). Fila, lock e fonte de verdade ficam
   fora dele.
3. **O tempo real não passa por fila nenhuma** (pergunta 4).
4. **Broker só por gatilho medido** (seção _Quando reabrir_), depois da
   escada de respostas mais baratas, e com um ADR novo.

## O que a `main` antiga fazia

A `main` antiga (último commit de 13/08/2026) usava RabbitMQ para **três**
coisas, e não só para e-mail: `src/jobs/email-queue.ts`,
`src/jobs/whatsapp-queue.ts` e `src/jobs/ai-verification-queue.ts`, sobre
`infra/messaging/rabbitmq-connection.ts`.

- Fila durável, mensagem persistente e `prefetch(3)`.
- No erro, o consumidor fazia `nack` sem requeue e republicava a mensagem com
  `setTimeout(10000 * 2^n)`. Esse timer vive **na memória do processo**: um
  crash ou um deploy perdia a retentativa.
- Depois de 3 tentativas, a mensagem era descartada. Não havia DLX
  (`x-dead-letter` não aparece em nenhum arquivo).
- Não havia outbox. A publicação acontecia depois do commit, e um crash entre
  o commit e o `publish` perdia o efeito.
- O healthcheck dependia do broker, e uma instabilidade do Rabbit derrubava as
  réplicas da API. Esse foi o incidente que motivou a saída, em 09/2026.

O desenho atual é estritamente mais confiável. Nenhum efeito depende de memória
de processo, toda falha terminal fica consultável e reenviável, e o evento
nasce na transação do dado.

## Respostas às nove perguntas da §7

### 1. O que precisa ser assíncrono, e o que continua síncrono

| Trabalho                                                                                       | Como roda                                                                                            | Onde                                                                                      |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Notificações (in-app, atividade, push, e-mail, WhatsApp)                                       | assíncrono durável: outbox → expansão → entrega por raia                                             | `src/shared/notifications/outbox-service.ts`, `notification-pipeline-service.ts`          |
| Webhooks de clientes                                                                           | assíncrono durável: linha na transação, despacho com varredura de 5 s                                | `src/shared/integration/webhook-dispatch-service.ts`                                      |
| Leitura de IA (odômetro, checklist, canhoto)                                                   | assíncrono durável: `ai_analysis_request` + pipeline                                                 | `src/shared/ai/ai-analysis-pipeline-service.ts`                                           |
| Importação de planilha                                                                         | assíncrono **em processo**: 202, 1 rodando + 3 na espera por réplica                                 | `src/modules/import/services/import-queue.ts`                                             |
| Estorno de importação grande                                                                   | assíncrono em processo, em lotes de 500 com lease e retomada                                         | `reverse-import-usecase.ts`, `import-repository.ts`                                       |
| E-mails transacionais com segredo (login, 2FA, reset)                                          | depois da resposta, fora do outbox **de propósito** (o payload teria segredo)                        | `src/shared/services/transactional-mail-service.ts`                                       |
| Login, Turnstile, presign, confirmação do upload (HeadObject), posições, callbacks de provedor | **síncrono**: a resposta depende disso                                                               | rotas respectivas                                                                         |
| Exportações e PDF do comprovante                                                               | síncrono com teto: 3 por réplica e 1 por empresa (429); PDF com 8 pendentes e 20 s, em worker thread | `src/shared/services/export/export-slots.ts`, `src/shared/services/proof-pdf-renderer.ts` |

A importação e o estorno ficam em processo porque o arquivo não é persistido.
Uma fila durável exigiria guardar o arquivo no R2 e um cursor de linha. Isso
só se justifica se a perda em deploy for medida como problema. A perda
silenciosa de antes foi tratada nesta rodada (ver _O que esta rodada mudou_).

### 2. O banco tem gargalo causado por tarefas de fundo?

Não, segundo as medições existentes (`tests/load/README.md`):

- **O gargalo é a CPU do Node, não o banco.** A 400 req/s oferecidas, o
  processo usava 2,4 cores, e o Postgres tinha menos de 25 conexões, metade
  ociosa. Aumentar o pool para 60 piorou a vazão (159 contra 166 req/s).
- **Joelho de ~110–120 req/s por réplica** com histórico (300 mil entregas),
  medido em 07/10/2026.
- **Soak de 30 min sem falhas:** p95 geral de 36,6 ms e p95 de
  `route.positions` de 60,8 ms.
- **`POST /route/positions` custa 9 statements**, verificado em
  `tests/E2E/driver-positions-statement-budget.test.ts`.

O custo do polling ocioso por réplica vem das constantes:

| Fila                  | Intervalo                                                           | Custo aproximado         |
| --------------------- | ------------------------------------------------------------------- | ------------------------ |
| outbox                | 30 s (`PIPELINE_SWEEP_INTERVAL_MS`) + wake de 500 ms após o publish | 2 statements a cada 30 s |
| entregas (2 raias)    | 30 s                                                                | 4 statements a cada 30 s |
| webhooks              | 5 s                                                                 | 2 statements a cada 5 s  |
| IA                    | 30 s                                                                | 1–2 a cada 30 s          |
| heartbeat dos workers | 30 s                                                                | 1 a cada 30 s            |

O total fica em ~40 statements/min (~0,7/s). No joelho HTTP são ~1.000
statements/s (9 × ~115 req/s), então o fundo é menos de 0,1% da carga do banco.
Os índices de claim são parciais, só sobre PENDING e PROCESSING
(`prisma/migrations/20260908120000_harden_queue_tables`), e as tabelas de fila
têm autovacuum a 1% e fillfactor 70.

**O que não foi medido:** o tempo de dreno depois de um pico
(`tests/load/README.md`, cena `spike.js`). Ele precisa de série temporal
(`--out json`) amostrando `GET /health/metrics`. A ausência dessa medida está
registrada, e nenhum número foi inventado para ela.

### 3. O RabbitMQ traz benefício demonstrável? Qual o custo?

Não traz benefício demonstrável.

- **Não dispensa o outbox.** Para não anunciar o que não foi gravado, o
  produtor continuaria gravando na transação e precisaria de um relay
  outbox → broker. Isso acrescenta um componente e não remove nenhum.
- **Não dá exatamente-uma-vez.** A documentação do RabbitMQ (_Reliability
  Guide_) garante at-least-once com confirmações e diz que duplicatas são
  possíveis. Ela recomenda consumidor idempotente, ou seja, as mesmas
  proteções de hoje: `Resend-Idempotency-Key`, unique por entrega,
  `X-Trajetto-Event-Id` e fencing.
- **Não muda os tetos reais**, que são o consumidor e o provedor: WhatsApp e
  push ~25/s, e-mail ~14/s, IA local 0,1–0,5/s por réplica.

O custo operacional seria real:

- **HA exige um cluster de 3 nós com quorum queues.** O espelhamento clássico
  foi removido no RabbitMQ 4.0 (_Quorum Queues_, tamanho padrão do grupo: 3).
  No Dokploy, onde cada serviço é uma _Application_, isso significa 3 serviços
  com volume, credencial, TLS, alarmes de memória e disco, DLX, publisher
  confirms, monitoramento, backup e upgrade.
- Mais um domínio de falha no caminho de toda notificação. Ele já derrubou as
  réplicas uma vez.
- Mais um sistema para os testes de falha (`tests/E2E/resilience-*`)
  cobrirem.

### 4. O rastreamento em tempo real precisa de fila?

Não. Uma fila no caminho crítico só acrescentaria latência e um ponto de
falha. O caminho real é este:

1. **App** (`trajetto-mobile/features/tracking/position-rules.ts`): captura a
   cada 15 s (`PING_INTERVAL_MS`) e envia quando junta 20 pings
   (`FLUSH_AT_COUNT`) ou a cada 2 min (`FLUSH_INTERVAL_MS`). O buffer guarda
   até 900 pings, em lotes de até 200.
2. **API** (`POST /route/positions`): uma transação com `createMany
skipDuplicates` em `driver_position`, particionada por dia, com unique
   `(driverId, recorded_at)`, e o upsert de `driver_last_position`.
3. **Emit** só quando a posição avança, via `@socket.io/redis-adapter` para a
   sala `operations:<businessId>`.
4. **Web:** ordena por `recordedAt` e, ao reconectar, relê
   `driver_last_position` (p95 de 12,6 ms na torre).

A latência de servidor é de 60,8 ms no p95. O atraso que o usuário percebe no
mapa vem do flush do app (até 120 s), não do servidor, e uma fila não
encurtaria esses 120 s. Um mapa mais "vivo" se consegue reduzindo
`FLUSH_INTERVAL_MS`. Isso é uma decisão de bateria e de dados do motorista,
com nova conta de req/s contra o joelho, e não uma decisão de arquitetura.

### 5. Retentativa, DLQ, concorrência, timeout, backpressure, métricas, idempotência e recuperação

| Fila               | Lease                     | Concorrência                                                                                                                                                      | Retentativas (backoff, jitter ±20%)                                  | Tentativas | Timeout da chamada                                            |
| ------------------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------- | ------------------------------------------------------------- |
| outbox (expansão)  | 60 s, renovado por evento | 1 por vez (`OUTBOX_EXPANSION_CONCURRENCY`), claim de até 10, 1 por agregado                                                                                       | 30 s, 2 min, 10 min, 30 min                                          | 5          | —                                                             |
| entregas (2 raias) | 180 s                     | 5 por raia (`NOTIFICATION_INTERNAL_CONCURRENCY`, `NOTIFICATION_EXTERNAL_CONCURRENCY`), vaga a vaga                                                                | 30 s, 2 min, 10 min, 30 min, 1 h, 3 h (~4h40); `Retry-After` até 1 h | 7          | backstop de 15 s por entrega; SMTP, Meta e Expo com 10 s cada |
| webhooks           | 120 s                     | 5 (`WEBHOOK_CONCURRENCY`); por endpoint 2 em paralelo por processo (`WEBHOOK_PER_ENDPOINT_CONCURRENCY`) e 4 somando todos (`WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY`) | 30 s, 2 min, 10 min, 1 h, 6 h                                        | 6          | 10 s; resposta lida até 8 kB                                  |
| IA                 | 300 s                     | 4 (`AI_CONCURRENCY`, limitada por `AI_LOCAL_MAX_CONCURRENCY`)                                                                                                     | 30 s, 2 min, 10 min; leitor ocupado: 5–15 s                          | 4          | leitor 15 s; foto do R2 com prazo de 15 s                     |

Constantes em `src/shared/notifications/pipeline-rules.ts`,
`src/shared/integration/webhook-dispatch-rules.ts`,
`src/shared/ai/ai-rules.ts` e `ai-analysis-pipeline-service.ts`. Os
invariantes de lease (`ceil(lote/concorrência) × timeout < lease`) são
verificados no import do módulo e no boot. A concorrência de cada fila vem
do _Environment_ desde a onda 12 do plano de escala (F3-05; padrões iguais
às constantes de antes, de 1 a 32): o invariante é conferido com o valor
dado, e um valor que não cabe no lease para o boot.

Desde a onda 13 (F3-06), cada fila é um **pool contínuo**
(`src/shared/queue/continuous-pool.ts`), no lugar da barreira por lote: a
vaga que libera é a hora de olhar a fila de novo, então uma entrega lenta
segura só a própria vaga, e não as quatro que já tinham terminado. As raias
reivindicam só para as vagas livres (o lease corre desde o claim); o outbox
reivindica um lote de até 10 quando nada do claim anterior espera (cada
evento renova o lease antes de expandir) e expande um evento por agregado
por vez. Na parada, o que foi reivindicado e não começou volta na hora, por
um UPDATE cercado (`PENDING`, `attempts − 1`, `availableAt = now()`), em vez
de esperar o lease vencer; o que está em voo termina. O invariante das
raias segue o da barreira, que o pool só melhora, porque a imagem anterior
lê o mesmo _Environment_ no rolling e num rollback.

Os webhooks entraram no mesmo pool (F3-07): até 20 linhas por claim quando
nada do claim anterior espera vaga, no máximo
`WEBHOOK_PER_ENDPOINT_CONCURRENCY` chamadas (2) a um mesmo endpoint por
processo, e cada claim seguinte deixa de fora os endpoints que já estão no
teto. Assim um endpoint lento segura as próprias chamadas e as próprias
linhas, e as dos outros clientes seguem. Um ciclo reivindica por até 20 s
(`WEBHOOK_DRAIN_BUDGET_MS`) e termina; a varredura ou o despertar
seguinte começa outro. O invariante dos webhooks ganhou uma rodada: um
claim sai enquanto as chamadas do anterior ainda estão em voo, e as linhas
dele podem esperar por elas.

A linha cuja última tentativa permitida morreu com o processo (`PROCESSING`,
lease vencido, tentativas no teto) não é reivindicada de novo e vira
`FAILED` com o motivo "O processo foi interrompido durante a última
tentativa permitida.". Até a onda 13 isso rodava antes de cada claim, por
um UPDATE que achava as linhas pelo índice do próprio claim: toda linha
vencida, as `PENDING` também, lida para achar as poucas em voo, e uma
enchente de e-mails vencidos fazia cada claim ler a enchente inteira.
Desde a F3-08 é um timer de cada processo que consome a fila, uma vez por
minuto e uma no boot (`src/shared/queue/exhausted-close.ts`), por um índice
parcial só das linhas em voo (`<fila>_processing_lease_idx`), até 500 por
UPDATE com `SKIP LOCKED`. A linha leva até um minuto a mais para aparecer
como `FAILED`; nada sai nesse meio-tempo, porque nenhum claim a pega.

**Justiça por empresa (F3-10).** As raias pegavam as linhas vencidas mais
velhas, de quem fossem: uma transportadora que dispara 20 mil avisos punha
a mensagem de todas as outras empresas atrás deles. Com
`QUEUE_FAIR_CLAIM_ENABLED=true` (desligado por padrão, até a medida na
staging), o claim de cada raia anda pelas empresas que têm linhas na
fila, na ordem dos ids, a partir de um cursor que gira em cada processo,
e pega até `QUEUE_FAIR_ROWS_PER_TENANT` (2) linhas vencidas de cada uma,
visitando até `QUEUE_FAIR_MAX_TENANTS` (64); depois da última empresa
vêm as linhas sem empresa (o balde nulo) e a volta ao começo, até o
cursor. O que a volta não encheu, as mais velhas da raia enchem, então
uma empresa sozinha ainda recebe claims cheios. A volta é um skip scan
recursivo no índice `(business_id, availableAt)` da raia (F3-09): duas
sondagens curtas por empresa visitada, nunca a leitura das linhas de uma
empresa grande (`src/shared/queue/fair-claim.ts`).

**Outbox pelo vencimento e por empresa (F3-11).** O claim do outbox
ordenava por `created_at`, sob um OR das `PENDING` vencidas e das
`PROCESSING` com o lease vencido, e os eventos em espera de nova
tentativa ficavam na frente do índice, lidos por todo claim. Agora ele
grava o fim do lease em `availableAt` (como as raias e os webhooks, e a
renovação antes de cada expansão também) e reivindica um intervalo de
`domain_outbox_event_due_idx`, que para em `now()`. Com
`QUEUE_FAIR_CLAIM_ENABLED`, o outbox anda pelas empresas como as raias,
por `domain_outbox_event_fair_idx` (`businessId`, `availableAt`): a
expansão é o primeiro passo de toda notificação, então uma enchente de
eventos de uma transportadora deixa de segurar o sino das outras. O
índice antigo, `domain_outbox_event_claim_idx` (`created_at`), que a
imagem anterior ainda lê no rolling e num rollback, sai na contração da
onda 20.

**IA por empresa, o canhoto primeiro (F3-12).** O claim da IA já tirava a
primeira leitura de cada empresa antes da segunda de qualquer uma, mas por
uma janela (`row_number()` por empresa) sobre todo o backlog vencido: uma
enchente de canhotos de uma transportadora era lida por cada claim. Com
`QUEUE_FAIR_CLAIM_ENABLED`, a IA anda pelas empresas como as raias e o
outbox, e dentro de cada empresa lê primeiro os canhotos
(`ai_analysis_request_proof_fair_idx`) e só depois, se eles não encheram a
parte da empresa, o abastecimento e o checklist
(`ai_analysis_request_other_fair_idx`), cada classe por um índice parcial
próprio (`businessId`, `availableAt`). O canhoto é lido com o motorista
ainda na porta do cliente, e o veredito é o que o manda refazer a foto;
um abastecimento lido minutos depois não custa viagem a ninguém. O que a
volta não encheu, as mais velhas vencidas enchem
(`ai_analysis_request_due_idx`). Desligado, o claim é a janela de antes.

**Webhooks com teto global por endpoint (F3-13).** O teto de chamadas a um
mesmo endpoint era por processo (`WEBHOOK_PER_ENDPOINT_CONCURRENCY`, 2):
com três despachantes, o ERP do cliente recebia seis de uma vez. Com
`WEBHOOK_ENDPOINT_GLOBAL_CONCURRENCY` (4, o que as duas réplicas da
produção já mandam; `0` desliga), o claim é em dois níveis: anda pelos
endpoints com linha vencida, a partir de um cursor que gira em cada
processo, por um skip scan de `webhook_delivery_endpoint_due_idx`
(`endpointId`, `availableAt`, `id`), e de cada um pega as linhas vencidas
em ordem, no máximo o teto por processo e nunca além do que o teto global
deixa depois das linhas em voo do endpoint (`PROCESSING` com lease vivo,
de qualquer processo), contadas uma vez por claim. As linhas são travadas
enquanto a volta as lê, pulando as que outra transação segura, então a
parte de um endpoint nunca se gasta numa linha que o claim não pode
pegar. Sem as mais velhas enchendo o que a volta não encheu (as partes são
o teto), uma volta que visitou 64 endpoints sem nada para pegar (linhas
guardadas de um endpoint pausado por até 30 dias, em espera de nova
tentativa ou em voo, um endpoint ou um host no teto) não encerra a busca:
o cursor anda com ela mesmo quando nada foi reivindicado, e o claim segue
dali, cada volta numa transação curta, até pegar alguma linha ou voltar ao
cursor de onde partiu (no máximo 64 voltas, 4.096 endpoints; o resto fica
para o claim seguinte). A contagem só vale com um claim por vez: cada um toma um
`pg_advisory_xact_lock` na mesma transação, antes do comando, e o solta no
commit; nenhuma chamada HTTP acontece com ele. A imagem anterior, no
rolling, reivindica sem o lock e sem o teto global, até sair.

**Teto por host de destino (F3-14).** O ERP de um agregador
(Comprovei/Fusion) recebe um endpoint por empresa, todos no mesmo host: só
o teto por endpoint deixaria ele receber 4 vezes o número de empresas de
uma vez. `webhook_endpoint.destination_host` guarda o host da URL, em
minúsculas, gravado com ela, e `WEBHOOK_HOST_GLOBAL_CONCURRENCY` (16; `0`
desliga) limita as chamadas em voo a um host somando todos os endpoints
dele: no mesmo claim, um endpoint de host já no teto não recebe parte, e
as linhas achadas para endpoints do mesmo host são cortadas, na ordem do
claim, no que o host ainda tem. Host nulo (um endpoint salvo pela imagem
anterior, até o minuto do despachante preenchê-lo) conta como sem teto. Um
host que ficou para trás porque a imagem anterior trocou a URL (no rolling
ou num rollback, que não conhecem a coluna) é corrigido antes do envio
seguinte do endpoint, que confere o host com a URL a cada chamada.

**Tetos globais dos provedores (F3-15a).** A concorrência das raias é por
processo, então cada processo a mais multiplica o que a Meta, a Resend e o
Expo recebem de uma vez, e o contrato com eles é da plataforma.
`WHATSAPP_GLOBAL_CONCURRENCY`, `EMAIL_GLOBAL_CONCURRENCY` e
`PUSH_GLOBAL_CONCURRENCY` (`0`, o padrão, é sem teto global) valem para
todos os processos juntos, e cada um fica com o teto dividido pelos
processos vivos da raia (`process_heartbeat.queues`), nunca abaixo de 1
(`src/shared/notifications/provider-caps.ts`). O divisor é o maior entre os
vivos agora, o maior número visto nos últimos 10 minutos e
`ROLE_EXPECTED_CONSUMERS`, e uma leitura que falha mantém o último: um
soluço do banco não pode fazer cada processo achar que está sozinho e
passar do contrato. Com algum teto ligado, o pool da raia separa as linhas
por provedor: o claim deixa de fora o canal do provedor que está na sua
parte e devolve na hora, sem gastar tentativa, o que pegou a mais, então
nenhuma linha espera o provedor com o lease correndo. A parte conta as
chamadas abertas no provedor, não as vagas do pool: um envio que passou do
tempo de espera da entrega (`PER_DELIVERY_TIMEOUT_MS`) libera a vaga mas
continua aberto, e segue contando na parte do provedor até ele responder,
ou até o fim do lease da entrega; sem isso, um provedor lento recebia uma
chamada nova para cada uma que ainda não tinha respondido. Concorrência
não limita taxa; o balde de taxa por provedor é o F3-15c.

**Balde de taxa por provedor (F3-15c).** Os contratos são taxas (80
mensagens por segundo na Meta, 10 requisições na Resend, 600 notificações
no Expo), e quatro vagas com envios de 100 ms já dão ~40 requisições por
segundo. `WHATSAPP_SENDS_PER_SECOND`, `EMAIL_REQUESTS_PER_SECOND` e
`PUSH_NOTIFICATIONS_PER_SECOND` (`0`, o padrão, é desligado: nenhuma
conexão, nenhuma espera, o 429 tratado como antes) ligam um balde GCRA sem
rajada no Redis, por provedor, que todos os processos dividem
(`src/shared/notifications/provider-rate-bucket.ts`): a chave guarda o
instante em que o próximo envio pode começar, no relógio do próprio Redis,
e cada envio reserva a sua vez (um push a três celulares são três). Uma vez
a até 1 s é esperada na vaga; uma mais longe devolve a linha para a fila,
com `availableAt` nela, sem gastar tentativa. Um 429 do provedor (o 130429
da Meta, a recusa por taxa da Resend, o 429 do Expo) empurra a chave para
depois da pausa pedida (1 s sem Retry-After, até 1 min com ele), e a linha
espera o mesmo, sem gastar tentativa. A chave é um contador de ritmo, não
estado de negócio: perdê-la num despejo custa no máximo um segundo de taxa.
Com o Redis fora, vale a divisão do F3-15a: cada processo fica com a taxa
dividida pelo divisor estável da raia, localmente. O alerta
`provider-throttled` soma as recusas por taxa das últimas 24 h (seção
`provider_rate` das linhas `ops_sample`) e é o gatilho para ligar o balde
(decisão D45).

**Cota diária de WhatsApp por empresa (F3-15b).** Todas as empresas mandam
WhatsApp pela mesma conta da plataforma na Meta: a rajada de uma
transportadora gasta o nível de mensagens e a nota de qualidade de que
todas dependem. Com `WHATSAPP_DAILY_QUOTA_PER_TENANT` acima de 0 (`0`, o
padrão, é sem cota, até a conversa com a Meta), cada chamada à Meta toma
uma unidade da `provider_quota_day` (provedor `whatsapp`, escopo
`whatsapp:<businessId>`, o dia de negócio da empresa no fuso dela), no
Postgres, porque o que é contrato não pode sumir num despejo do Redis
(`src/shared/notifications/whatsapp-daily-quota.ts`). Passou da cota, a
linha volta para a fila sem gastar tentativa, com `availableAt` no começo
do próximo dia de negócio da empresa, um milissegundo depois da última já
guardada para aquele dia: todas no mesmo instante saíam em qualquer ordem,
e uma mais velha podia ficar para o dia seguinte atrás de mais novas. A
guardada se reconhece pelo começo do `lastError`, então uma nova tentativa
de outra mensagem marcada para depois da meia-noite não empurra as
guardadas. Nunca cai para o e-mail. Os
administradores recebem o aviso `whatsapp-quota.reached` no sino, uma vez
por dia: a chave do evento no outbox (`whatsapp-quota.reached:<empresa>:<dia>`)
é a deduplicação.

- **DLQ:** o status `FAILED`.
  - `GET /health/dead-letter` com `POST /health/dead-letter/replay` cobre
    as entregas.
  - `GET /health/dead-letter/events` com
    **`POST /health/dead-letter/events/replay`** (novo nesta rodada) cobre os
    eventos do outbox.
  - Webhook: reenvio com o mesmo event id.
  - IA: botão "Verificar com IA".
  - Tudo é MASTER e por id explícito.
- **Backpressure:** sempre com `Retry-After`.
  - Importação: `IMPORT_BUSY` 429, 1 rodando + 3 na espera por réplica.
  - Exportação: `EXPORT_BUSY`, 3 por réplica e 1 por empresa.
  - PDF: 8 pendentes, depois 503.
  - Rate limit global: 300/min por IP.
  - Posições: 120/min por motorista.
- **Disjuntores:**
  - IA (`src/shared/ai/provider-circuit.ts`): 5 falhas abrem por 60 s, até
    10 min; quota 10 → 60 min; credencial 5 → 60 min.
  - Endpoint de webhook: 20 falhas seguidas desligam o endpoint, e as
    linhas ficam retidas por 30 dias.
  - Template do WhatsApp pausado: não chama a Meta.
  - Raia `external` isolada da `internal`: funciona como bulkhead.
- **Métricas:** `GET /health/metrics` (MASTER, foto de 10 s). Mostra backlog
  e `oldest_pending_seconds`/`oldest_eligible_seconds` por canal, tuplas
  mortas por tabela de fila, uso de conexões, `runtime.prisma_pool`
  (`busy`, `idle`, `waiting`) e batimentos dos workers.
- **Alertas** (`src/shared/health/alert-rules.ts`, cron `ops-heartbeat`):
  - atraso do outbox > 5 min;
  - raia internal > 5 min;
  - raia external > 15 min;
  - webhooks > 30 min;
  - IA > 15 min;
  - 50 falhas terminais por canal;
  - conexões em 80%;
  - worker travado há 10 min.
- **Recuperação:**
  - o lease vencido devolve a linha;
  - o fencing por `attempts` impede o dono antigo de escrever;
  - o teto de reclaim evita que uma linha que derruba o worker derrube
    todas as réplicas;
  - no shutdown, os pipelines esperam até 10 s, dentro do teto de 35 s
    (stop grace de 40 s no Dokploy, com `STOP_GRACE_PERIOD_MS=40000`); com
    um grace menor, o plano de desligamento encurta essa espera
    (`src/shared/lifecycle/shutdown-plan.ts`).

### 6. Como evitamos duplicação em redelivery, crash, restart e várias réplicas

| Canal              | Proteção                                                                                                                                                                                   | Resíduo inevitável                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Expansão do outbox | id da entrega decidido por evento, destinatário e canal (F5-03); unique parcial por destinatário até a onda 10; `createMany skipDuplicates`; PUBLISHED com fencing; `eventKey` único       | nenhum                                                                                                    |
| In-app / atividade | unique `notification.deliveryId` / `activity_deliveryId_key`                                                                                                                               | nenhum                                                                                                    |
| E-mail             | `Resend-Idempotency-Key` = id da entrega (retenção de 24 h; o cronograma de ~4h40 cabe nela)                                                                                               | reenvio manual depois de 24 h                                                                             |
| Push               | invariante de lease e fencing; **novo:** id da entrega como `tag` (todo aparelho) e `collapseId` (só iPhone) em `push-provider.ts`; o aparelho troca a cópia pela anterior                 | a Expo não deduplica no servidor: um crash entre o aceite e o UPDATE envia de novo, mas a bandeja colapsa |
| WhatsApp           | invariante de lease, fencing, backstop sem reenvio, registro do aceite com retentativa, ledger de recibos por `referenceId`                                                                | a Meta não tem chave: um crash entre o aceite e o UPDATE gera 1 reenvio                                   |
| Webhook            | at-least-once com `X-Trajetto-Event-Id` estável (também no reenvio), `X-Trajetto-Delivery`, `sequence`                                                                                     | o receptor deduplica (contrato documentado)                                                               |
| IA                 | `idempotencyKey` (tipo, registro, hash da entrada) + ledger de quota com `FOR UPDATE`                                                                                                      | nenhum na cobrança                                                                                        |
| Crons              | lease `(jobName, scheduledFor)` único                                                                                                                                                      | nenhum                                                                                                    |
| Posições           | unique `(driverId, recorded_at)`                                                                                                                                                           | nenhum                                                                                                    |
| Várias réplicas    | `SKIP LOCKED` provado nas quatro filas em `tests/E2E/queue-claim-concurrency.test.ts`, inclusive com dreno paralelo exatamente-uma-vez (a `ai_analysis_request` ganhou o seu nesta rodada) | —                                                                                                         |

O crash depois do aceite está provado com SIGKILL real em
`tests/E2E/resilience-crash-after-accept.test.ts`. Nesta rodada, o teste passou
a afirmar também que as duas cópias do push levam o mesmo `tag` e nenhum
`collapseId`, porque o aparelho do teste é Android. O `collapseId` do iPhone
está coberto em `tests/unitaires/notifications/push-collapse-key.test.ts`. No
Android ele não vai de propósito: a Expo o converte em `collapse_key` do FCM,
que guarda no máximo 4 chaves por aparelho offline e descarta o resto, e uma
chave por entrega faria um motorista sem sinal perder tudo além de 4
notificações (sem chave, o FCM guarda até 100). Fonte: docs da Expo ("Message
request format") e do Firebase ("Collapsible and non-collapsible messages").

### 7. Há risco de inconsistência entre gravar e publicar?

O outbox transacional já cobre isso:

- **Notificações:** todas as chamadas a `OutboxService.publish` passam a
  transação (`tx`).
- **Webhooks:** todas as chamadas a `announce(..., tx)` são transacionais.

Exceções conhecidas:

- **Pedido de IA de abastecimento e checklist** (`create-fuel-usecase.ts`,
  `create-vehicle-checklist-usecase.ts`, e as atualizações): é feito depois do
  commit, em fire-and-forget. Um crash entre o commit e o pedido deixava o
  registro `pending` para sempre. **Fechado nesta rodada** pela varredura
  `reconcile-record-analysis` (abaixo), no mesmo padrão que o comprovante já
  tinha (`reconcile-proof-analysis`). Levar o pedido para dentro da transação
  exigiria mover a reserva de quota com `FOR UPDATE` para a transação do
  registro. A corrida de idempotência viraria P2002 dentro dela e abortaria o
  registro do motorista, por isso essa opção ficou de fora.
- **`route.plan_changed`:** `publishAfterCommit`, porque o repositório de rota
  não conhece o outbox. Um crash perde 1 push, e o app vê `plan_version` no
  próximo sync. É um trade-off aceito.
- **`publishAfterCommit` da IA:** usa `eventKey` determinístico, então o
  reenvio depois de um crash cai na chave única.
- **Trilha de auditoria** (`createActivityIfEnabled` sem `tx`): escrita
  interna com 1 retentativa e log `audit_trail_write_failed`. Não é efeito
  externo, e a dívida está registrada.

### 8. Estratégia de testes de carga, falha, reprocessamento e observabilidade

- **Carga:** harness k6 com Traefik e N réplicas (`tests/load/`: smoke, load,
  spike, stress, soak). `failure-injection.sh` derruba Redis e Postgres de
  verdade.
- **Filas (E2E):**
  - `queue-claim-concurrency`, `queue-claim-by-due`;
  - `notification-pipeline` (inclui o replay de entregas e, agora, o de
    eventos);
  - `notification-pipeline-lease` e `-timeout`, `outbox-expansion-lease`;
  - `webhook-dispatch*`;
  - `ai-pipeline-*`;
  - `import-abandoned`, `record-analysis-reconcile` (novo).
- **Resiliência:** `resilience-crash-after-accept`, `-database-loss`,
  `-redis-loss`, `-provider-outage`, `-replica-drain`, `-repeat-five`.
- **Observabilidade:** `health-metrics*`, `health-operational-metrics`,
  `health-under-failure`.
- **Lacuna:** o tempo de dreno depois de um pico não está medido (pergunta 2).

Nenhum teste de broker foi criado, porque não há broker.

### 9. Circuit breaker ou Saga resolvem um problema real?

- **Circuit breaker:** já existe onde o problema existe. São eles a IA, o
  endpoint de webhook, o template do WhatsApp e o bulkhead das raias. Um
  disjuntor genérico novo não cobriria nada que já não esteja coberto.
- **Saga:** não se aplica. O estado vive num Postgres só, e os efeitos
  externos são avisos idempotentes, não passos de negócio a compensar. Não
  existe transação distribuída de vários passos.
- **Timeout:** todo provedor tinha timeout, exceto o cliente S3 do
  `UploadService`, que não tinha nenhum. Corrigido nesta rodada (abaixo).

## Quando reabrir a decisão

Os gatilhos abaixo são lidos de `GET /health/metrics`
(`src/shared/health/operational-metrics.ts`) e valem por réplica ou por canal,
sustentados, não em um pico isolado:

| Gatilho                     | Métrica                                                                                                   | Limiar                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Atraso por consumidor       | `notifications.channels[].oldest_eligible_seconds` (raia external)                                        | p95 > 60 s por 2 semanas (o alerta dispara em 15 min)                 |
|                             | `outbox.oldest_pending_seconds`                                                                           | p95 > 30 s por 2 semanas (alerta em 5 min)                            |
|                             | `webhooks.oldest_due_seconds`                                                                             | p95 > 5 min por 2 semanas (alerta em 30 min)                          |
| Backlog crescendo           | `notifications.channels[].pending_total`, `outbox.pending`, `webhooks.pending_due`, `ai_pipeline.pending` | crescimento monotônico por 5 min seguidos, fora de um pico conhecido  |
| Espera no pool              | `runtime.prisma_pool.waiting`                                                                             | > 0 em amostras consecutivas nos horários de dreno, com HTTP saudável |
| Inchaço das tabelas de fila | `queue_tables[].dead_tuple_percent`                                                                       | > 20% persistente, mesmo com autovacuum                               |
| Uso de conexões             | `database.connection_usage_percent`                                                                       | > 80% (alerta existente) por causa dos workers, não do HTTP           |

Disparado um gatilho, a resposta segue esta ordem. Cada degrau só vem se o
anterior não bastar:

1. **Tuning:** lote, concorrência e intervalo de varredura, índices de claim e
   autovacuum.
2. **Separar os workers do HTTP** com a mesma imagem
   (`WORKERS_ENABLED=false` nas réplicas HTTP; `docs/deploy.md`, _Separar os
   workers do HTTP_), refazendo o orçamento de conexões.
3. **Uma dica de despertar pelo pub/sub do Redis** para acordar os outros
   processos sem esperar a varredura (plano de escala, F3-04): um canal por
   fila, com debounce e só o nome da réplica no corpo. É uma dica
   descartável, como o resto do Redis ([ADR 0002](./0002-redis-descartavel.md)):
   perdida, custa só a varredura de 2 s, e a fila continua no Postgres.
4. **Filas particionadas e tetos por fila no Postgres** (plano de escala,
   ondas 10 e 13), antes de qualquer componente novo.

**Correção de 15/11/2026.** Esta escada tinha mais dois degraus, e os dois
saíram:

- o `LISTEN/NOTIFY` do Postgres deu lugar à dica pelo pub/sub. O `LISTEN`
  não passa pelo PgBouncer em modo transaction (onda 17) e pediria uma
  conexão direta por processo, e o `NOTIFY` pega um lock global no commit.
  A dica pelo Redis dá a mesma garantia sem conexão especial. O `NOTIFY`
  fora da transação fica só como plano B, se a medição reprovar a dica;
- o Redis Streams com relay do outbox saiu. Ele contradizia o
  [ADR 0002](./0002-redis-descartavel.md): o Redis de hoje despeja chaves
  (`allkeys-lru`) e não persiste, e uma fila ali seria uma segunda
  dependência com estado, backup e alerta próprios, para a mesma escrita no
  Postgres feita depois. Um broker não está na escada: reabrir isso pede um
  ADR novo, com o gatilho medido e o motivo de o Postgres não bastar.

## O que esta rodada mudou (28/10/2026)

As lacunas eram pequenas e reais, e nenhuma pedia broker:

1. **Timeouts do R2** (`src/shared/services/upload-service.ts`). O cliente S3
   não tinha timeout nenhum, e no `@smithy/node-http-handler` 4.9.13 todo
   timeout é 0 por padrão. Além disso, `requestTimeout` sozinho só gera um
   aviso: só lança erro com `throwOnRequestTimeout`. A configuração nova é:

   - conexão de 5 s;
   - requisição de 15 s, com `throwOnRequestTimeout`;
   - socket ocioso de 15 s;
   - `maxAttempts` 3;
   - prazo total por operação (todas as tentativas) via `AbortSignal`:
     HeadObject no caminho HTTP, 10 s; PutObject e GetObject, 30 s; delete e
     list, 30 s.

   Medido contra um servidor local que aceita a conexão e nunca responde:

   | Configuração                        | Resultado                                          |
   | ----------------------------------- | -------------------------------------------------- |
   | antes, sem nenhum timeout           | ainda pendente depois de 20 s, sem limite          |
   | só `requestTimeout`                 | ainda pendente depois de 20 s, só com um WARN      |
   | cliente novo, sem prazo de operação | TimeoutError em 45,2 s (3 tentativas de 15 s)      |
   | HeadObject com o prazo de 10 s      | erro em 10,2 s, que vira 503 `STORAGE_UNAVAILABLE` |

   O `readObject` passou a distinguir "o objeto sumiu" (null) de "o storage
   não respondeu" (503). Antes, um R2 lento imprimia "foto ausente" no PDF do
   comprovante, que é guardado para sempre, e fazia `/verificar` responder
   `intact: false`, sem hash guardado, para um documento íntegro: a página
   mostrava "Arquivo indisponível" (sem acusar adulteração), quando o arquivo
   estava lá. Agora o 503 aparece como "Não foi possível verificar agora". O
   presign continua local e não foi afetado.

2. **Fila de importação no shutdown** (`import-queue.ts`,
   `src/shared/lifecycle/shutdown.ts`, `src/server.ts`). Antes, num deploy, a
   importação em andamento e até 3 na espera, que já tinham recebido 202, só
   eram fechadas como "interrompida" 15 a 20 min depois, pela varredura
   `close-abandoned-imports` (staleness de 15 min, roda a cada 5 min). Agora,
   no SIGTERM:

   - novas importações recebem 429 `IMPORT_BUSY` com `Retry-After`;
   - as que esperavam são fechadas **na hora**, com "Importação não iniciada:
     … Envie o arquivo de novo." e zero entregas;
   - a que está rodando continua por até 15 s contados do SIGTERM (os 12 s
     em que a réplica ainda atende ficam dentro desse prazo) e depois para
     entre duas linhas, fechando o próprio registro com a linha em que parou;
   - se não parar em 5 s, a fila a fecha contando as entregas pelas linhas;
   - a fila espera no máximo 2 s pela gravação desses fechamentos; o que não
     for gravado a tempo fica para a varredura;
   - um estorno na espera tem o lease liberado, então pedir de novo retoma
     na hora.

   Quando nenhuma entrega foi criada, o relatório diz "nenhuma entrega foi
   criada. Envie o arquivo de novo." em vez de mandar estornar: na espera, na
   que ainda lia o arquivo quando os 5 s acabaram, na que parou entre duas
   linhas sem ter criado nenhuma e, na varredura, na que morreu sem criar
   nada. A que já estava nas linhas e é fechada pela fila continua mandando
   estornar mesmo com zero contadas, porque a linha em que ela travou ainda
   pode gravar depois da contagem.

   Tudo isso cabe no teto de 35 s: importações até 22 s (15 + 5 + 2), o
   HTTP também (12 s de dreno e até 10 s para os pedidos em andamento,
   cujas conexões são fechadas depois disso), e então os workers, com até
   10 s (12 s no despachante de webhooks: o timeout de 10 s da chamada
   mais 2 s). São os prazos com o grace de 40 s;
   todos saem de `STOP_GRACE_PERIOD_MS` (`src/shared/lifecycle/shutdown-plan.ts`),
   e sem a variável cabem nos 10 s do Docker. A varredura continua como piso para
   SIGKILL, OOM e perda de nó, e escreve o mesmo tipo de relatório (o
   fechamento foi unificado em `import-repository.ts`).

3. **Push colapsável:** o id da entrega vai como `tag` para todo aparelho e
   como `collapseId` só para o iPhone (pergunta 6).
4. **Replay de eventos do outbox em FAILED:**
   `POST /health/dead-letter/events/replay`. É MASTER, aceita até 100 ids por
   vez e tem rate limit de 10/min por usuário. Só move linhas que estão em
   FAILED, zera as tentativas e grava o autor e o momento em `lastError`. Esse
   registro na linha dura só até a próxima expansão, que o substitui numa
   falha e o limpa ao publicar; o registro durável é a linha de log de aviso
   `failed outbox events requeued by hand`, com o usuário, os ids e quantos
   voltaram. A expansão idempotente garante que só nascem as entregas que
   faltavam.
5. **Varredura de IA de abastecimento e checklist:** o cron
   `reconcile-record-analysis` roda a cada 10 min, defasado 5 min do cron do
   comprovante. Ele pega registros `pending`:

   - com idade entre 10 min e 2 dias;
   - com foto que o serviço possa ler (um checklist só com listas de fotos
     vazias fica de fora: o serviço responde "unavailable" sem marcá-lo, e ele
     voltava a cada rodada ocupando as vagas da empresa);
   - sem nenhum pedido de IA;
   - de empresa com a leitura ligada que **já lia** quando o registro nasceu
     (tinha período de quota aberto antes dele), para não gastar quota nova
     com o histórico;
   - feitos depois da última vez que a empresa religou a leitura: um período
     de meses atrás não diz nada sobre quem a desligou e religou. O sinal é o
     evento `business-limit.changed` de `ai` saindo de 0, guardado 30 dias,
     que cobre os 2 dias olhados;
   - de motorista com login.

   Cada rodada pega no máximo 50 por empresa e 200 no total, dos mais antigos
   para os mais novos entre todas as empresas, para que as mesmas empresas
   não ocupem todas as rodadas.

   O pedido é refeito com a entrada que o botão manual montaria, e a
   idempotência e a quota ficam com o `AIAnalysisService`. Uma atualização
   cujo pedido se perdeu não é encontrada, porque a atualização não volta o
   status para `pending`. Para esse caso existe o botão.

6. **Dreno paralelo exatamente-uma-vez da `ai_analysis_request`.** Três
   instâncias drenam 24 pedidos. Cada foto é lida uma vez, cada unidade é
   consumida uma vez, e a quota termina com reservado 0 e consumido 24.

## Consequências

- **Uma peça a menos para operar.** A durabilidade, o reprocessamento e a
  observabilidade ficam no banco que já tem backup, métricas e alertas.
- **A escala depende de réplicas (CPU)**, com o Postgres como ponto único de
  coordenação. Os gatilhos acima dizem quando isso deixa de bastar.
- **Riscos conhecidos, fora desta decisão:**
  - a exclusão de empresa grande é um DELETE em cascata numa transação HTTP
    de 15 s, e não foi medida;
  - o tempo de dreno depois de um pico não foi medido.
