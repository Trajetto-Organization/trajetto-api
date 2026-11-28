# redis-evictions — Redis despejando chaves

**Dispara quando:** evicted_keys cresceu desde a linha cluster de 15 a 20 min atrás.

## O que significa

O Redis chegou ao teto de memória e jogou chaves fora (`allkeys-lru`). Nada de negócio se perde, mas contadores do rate limit e estado do Socket.IO somem antes da hora: um limite pode deixar passar mais do que devia.

## Primeira ação

1. `redis` em `/health/metrics`: `used_memory_mb` contra `maxmemory_mb`, `pubsub_channels` e `client_recent_max_output_buffer_bytes`.
2. Um buffer de saída enorme é um cliente de Socket.IO lento; a memória crescendo devagar é volume: o teto sobe por degrau (256 MB hoje).

## Como confirmar

Nenhum despejo novo na comparação seguinte (o motivo some 15 minutos depois de parar).

## Quando escalar

Subir o `--maxmemory` do Database Redis é decisão do dono (memória do host).
