# webhook-lag — Webhooks de integração parados

**Dispara quando:** webhook devido há mais de 30 min.

## O que significa

Uma linha de `webhook_delivery` já devida (fora do backoff) espera mais de 30 minutos para ser enviada ao endpoint do cliente. Um cliente fora do ar não dispara isto (as linhas dele estão em backoff); dispara o despachante parado ou sobrecarregado.

## Primeira ação

1. `/health/metrics` → `webhooks`: o backlog e os endpoints desligados; `workers` diz se o despachante está vivo.
2. Um despachante sem progresso é reiniciado com **Deploy** da `trajetto-api`.
3. Uma rajada de um só cliente (milhares de eventos) se resolve sozinha; confira se o atraso está caindo.

## Como confirmar

O motivo some e `webhooks.oldest_due_seconds` em `/health/metrics` cai.

## Quando escalar

Se o atraso só cresce por uma hora com o despachante vivo, o volume passou da vazão: chame o dono (é um gatilho de capacidade do plano de escala).
