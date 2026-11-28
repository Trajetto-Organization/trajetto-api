# ai-credential — Credencial da IA recusada

**Dispara quando:** análise recusada pelo provedor por credencial (401/403).

## O que significa

O serviço de IA recusou o token da API: `AI_LOCAL_TOKEN` da `trajetto-api` não bate com o da `trajetto-ai`. Toda leitura nova falha igual.

## Primeira ação

1. Compare `AI_LOCAL_TOKEN` no _Environment_ da `trajetto-api` e da `trajetto-ai` do mesmo ambiente (sem copiar o valor para fora do Dokploy).
2. Corrija o que mudou (**Save** → **Deploy**) e depois reenvie as análises que falharam, se a tela pedir.

## Como confirmar

`/health/providers` → `trajetto-ai` responde `ok` à conferência do token, e o motivo some.

## Quando escalar

Se os dois tokens são iguais e o 401 continua, chame o dono com o log da `trajetto-ai`.
