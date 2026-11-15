# ai-provider-paused — Análises de IA pausadas pelo provedor

**Dispara quando:** pedidos devidos esperando porque o provedor recusou o serviço.

## O que significa

O provedor de IA recusou o serviço para todo mundo (limite de gasto ou de uso da conta) e o pipeline parou de pedir, para não queimar as tentativas: os pedidos esperam, sem falhar.

## Primeira ação

1. `/health/providers` → `trajetto-ai` e o log do serviço de IA: qual limite foi atingido.
2. Resolvido o limite, o pipeline volta sozinho; não é preciso reenviar nada.

## Como confirmar

O número de pausados cai a zero e as leituras pendentes andam.

## Quando escalar

Limite de conta que só o dono muda: chame o dono.
