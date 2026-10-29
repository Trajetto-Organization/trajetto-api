# ADR 0003 — Outbox transacional

- **Status:** aceito. ADR da fase final.
- **Escopo:** `trajetto-api`.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova.

## Decisão

**O evento nasce na mesma transação do dado.** Quem grava publica no outbox
com a transação do Prisma (`OutboxService.publish(tx, …)`, em
`src/shared/notifications/outbox-service.ts`), e a linha de
`domain_outbox_event` só existe se o dado foi gravado. Os webhooks dos
clientes seguem a mesma regra: `webhook_delivery` é criada na transação do
evento (`announce(..., tx)`). Nada é anunciado sem ter sido gravado.

O efeito externo (e-mail, WhatsApp, push, webhook) sai depois, por um
pipeline que lê a fila com `FOR UPDATE SKIP LOCKED` e lease
(`src/shared/notifications/notification-pipeline-service.ts`,
`src/shared/integration/webhook-dispatch-service.ts`).

## Garantias, sem exagero

- **Efeitos externos: pelo menos uma vez.** Um worker que perde o lease no
  meio de um envio pode ter enviado; o fencing por `attempts` só anula as
  escritas atrasadas dele. A deduplicação de cada canal (chave de
  idempotência do Resend, `tag` do push e `collapseId` no iPhone,
  `X-Trajetto-Event-Id` do
  webhook) e o resíduo que sobra estão na tabela da pergunta 6 do
  [ADR 0001](./0001-filas-e-mensageria.md#6-como-evitamos-duplicação-em-redelivery-crash-restart-e-várias-réplicas).
  O WhatsApp não tem chave: um crash entre o aceite da Meta e o registro
  gera um reenvio, contado em `/health/metrics`.
- **Emit de tempo real: no máximo uma vez.** O toast de uma notificação pode
  se perder num crash; a notificação não, porque o sino lê o banco
  (`src/shared/lifecycle/startup.ts`).
- `tests/unitaires/docs/guarantee-claims.test.ts` impede que os comentários
  do código prometam mais do que isso (por exemplo, "exactly-once").

## Exceções registradas

As exceções conhecidas (pedido de IA depois do commit, `route.plan_changed`,
trilha de auditoria) e o que cobre cada uma estão na pergunta 7 do
[ADR 0001](./0001-filas-e-mensageria.md#7-há-risco-de-inconsistência-entre-gravar-e-publicar).

## Fontes

- [`arquitetura.md` → Postgres é a fila](../arquitetura.md#postgres-é-a-fila)
  e o fluxo "Outbox, filas e efeitos externos" em
  [Fluxos em detalhe](../arquitetura.md#fluxos-em-detalhe).
- [ADR 0001](./0001-filas-e-mensageria.md), perguntas 6 e 7.
- Comentários que citam este ADR: `src/shared/notifications/notification-pipeline-service.ts`,
  `src/shared/lifecycle/startup.ts`, `src/shared/health/metrics-queries.ts`.
