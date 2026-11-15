# provider-down — Provedor externo fora

**Quando:** Meta, Expo, Resend ou LocationIQ fora do ar ou lento.

## O que significa

Um provedor de que a API depende parou de responder ou responde com erro: WhatsApp (Meta), push (Expo), e-mail (Resend) ou geocodificação (LocationIQ). As entregas entram em backoff e tentam de novo sozinhas, com até 3 h entre tentativas; nada se perde até esgotar as tentativas. A geocodificação pausa em todas as réplicas pelo Redis.

## Primeira ação

1. `/health/providers` (MASTER) diz qual provedor, o `failure_kind` e se é `transient`.
2. Confira a página de status do provedor. Não há o que reiniciar do nosso lado.
3. Se a recusa é da nossa conta (chave, limite), não é queda: é o [channel-credential](./channel-credential.md).

## Como confirmar

`/health/providers` volta a `ok` e o backlog da faixa cai. O que esgotou as tentativas durante a queda está em `/health/dead-letter` e volta pelo replay.

## Quando escalar

Queda de mais de uma hora, ou um provedor recusando a conta: chame o dono.
