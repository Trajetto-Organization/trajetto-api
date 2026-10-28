# ADR 0005 — Retentativa, backoff e dead letter

- **Status:** aceito. ADR da fase final.
- **Escopo:** `trajetto-api`.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova.

## Decisão

Toda fila do Postgres tem a mesma política:

- **retentativa com backoff e jitter**, num número fixo de tentativas por
  fila;
- **dead letter** = a linha fica em `FAILED`, consultável e reenviável; nada
  é descartado em silêncio;
- **reenvio por id explícito**, nunca em massa: as rotas de dead letter são
  do MASTER; o reenvio de um webhook é de quem administra as integrações da
  empresa;
- todo `429` ou `503` de sobrecarga responde com `Retry-After`.

Os números de cada fila (lease, concorrência, intervalos, tentativas e
timeout da chamada) estão na tabela da pergunta 5 do
[ADR 0001](./0001-filas-e-mensageria.md#5-retentativa-dlq-concorrência-timeout-backpressure-métricas-idempotência-e-recuperação).
As constantes vivem em `src/shared/notifications/pipeline-rules.ts`,
`src/shared/integration/webhook-dispatch-rules.ts` e `src/shared/ai/ai-rules.ts`.

## Onde fica o dead letter

| O que falhou                | Consulta                               | Reenvio                                                                                                                                         |
| --------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| entrega de notificação      | `GET /health/dead-letter`              | `POST /health/dead-letter/replay`                                                                                                               |
| evento do outbox (expansão) | `GET /health/dead-letter/events`       | `POST /health/dead-letter/events/replay` (28/10/2026)                                                                                           |
| webhook                     | `GET /integrations/webhook-deliveries` | `POST /integrations/webhook-delivery/:id/business/:businessId/resend` (linha nova, mesmo `X-Trajetto-Event-Id`, permissão `integration_manage`) |
| leitura de IA               | o registro mostra a falha              | botão "Verificar com IA"                                                                                                                        |

As rotas de `/health/dead-letter*` são só do MASTER e têm rate limit
(`src/routes/health-routes.ts`). O
reenvio de eventos aceita até 100 ids por vez, move só linhas em `FAILED`,
zera as tentativas e a expansão idempotente cria só as entregas que
faltavam. Quem pediu e quando ficam na linha de log de aviso
`failed outbox events requeued by hand` (com os ids e quantos voltaram), que
é o registro durável; o `lastError` do evento mostra o mesmo só até a próxima
expansão, que o substitui numa falha e o limpa ao publicar.

## Consequências registradas

- Os alertas do `ops-heartbeat` (`src/shared/health/alert-rules.ts`) avisam
  quando um canal acumula falhas terminais ou quando a fila envelhece.
- Reenviar WhatsApp pode duplicar uma mensagem que falhou num timeout
  ambíguo: a Meta não tem chave de idempotência (ADR 0003).

## Fontes

- [`arquitetura.md` → Postgres é a fila](../arquitetura.md#postgres-é-a-fila)
  e [Saúde e observabilidade](../arquitetura.md#saúde-e-observabilidade).
- [`deploy.md` → 20. Alertas e monitoramento](../deploy.md#20-alertas-e-monitoramento).
- [ADR 0001](./0001-filas-e-mensageria.md), pergunta 5.
