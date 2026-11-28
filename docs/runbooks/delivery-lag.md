# delivery-lag — Entregas paradas na fila

**Dispara quando:** entrega devida há mais de 5 min (internas) ou 15 min (externas).

## O que significa

Uma entrega de `notification_delivery` já devida espera para ser enviada além do limite da sua faixa: 5 minutos na faixa interna (sino, push, atividade) e 15 na externa (e-mail e WhatsApp, que esperam terceiros). O motivo diz a faixa. Entregas em espera de nova tentativa não contam: só o que já devia ter saído.

## Primeira ação

1. `/health/metrics` → `notifications` mostra o backlog por canal e `workers` mostra quem roda as faixas; um worker sem progresso é reiniciado com **Deploy** da `trajetto-api`.
2. Se a faixa externa é a única parada, confira o provedor em `/health/providers` (Resend, Meta): um provedor lento segura a faixa, e o runbook é o [provider-down](./provider-down.md).
3. Leia o log da réplica: `notification delivery` com erro repetido diz o canal.

## Como confirmar

O motivo some no minuto seguinte, e o backlog da faixa em `/health/metrics` volta a cair.

## Quando escalar

Uma faixa interna parada mais de 15 minutos depois do Deploy é o banco ou o próprio worker: chame o dono com o trecho do log. A externa parada por um provedor fora só escala se o provedor não voltar em uma hora.
