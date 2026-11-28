# ai-lag — Análises de IA paradas

**Dispara quando:** análise de IA devida há mais de 15 min.

## O que significa

Um pedido de `ai_analysis_request` já devido espera mais de 15 minutos. As leituras de comprovante, abastecimento e checklist ficam pendentes na tela até a IA responder.

## Primeira ação

1. `/health/providers` → `trajetto-ai`: o serviço responde ao `/health` e ao `POST /v1/read`?
2. Se não responde, veja a Application `trajetto-ai` do ambiente no Dokploy (aba _Logs_, memória) e dê **Deploy** nela.
3. Se responde, o worker de IA da API pode estar travado: `workers` em `/health/metrics` e **Deploy** da `trajetto-api`.

## Como confirmar

O motivo some e o backlog de IA em `/health/metrics` cai.

## Quando escalar

IA fora por mais de uma hora, ou falta de memória repetida no contêiner da IA: chame o dono.
