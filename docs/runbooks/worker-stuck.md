# worker-stuck — Worker travado numa réplica

**Dispara quando:** worker sem sinal de progresso há 10 min numa réplica viva.

## O que significa

Um worker (outbox, uma faixa de entregas, IA, webhooks) de uma réplica que ainda responde não dá sinal de progresso há 10 minutos. O que ele processa fica com as outras réplicas, se houver.

## Primeira ação

1. O motivo diz a réplica e o worker. Leia o log daquela task.
2. Dê **Deploy** na `trajetto-api` para substituir as tasks.

## Como confirmar

O motivo some e `workers` em `/health/metrics` mostra o worker com batida recente.

## Quando escalar

Se volta a travar depois do Deploy, há um laço preso no código: chame o dono com o log.
