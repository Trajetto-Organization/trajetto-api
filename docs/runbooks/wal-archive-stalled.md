# wal-archive-stalled — Arquivamento do WAL parado ou falhando

**Dispara quando:** com o arquivamento ligado, último segmento há mais de 300 s, ou a última tentativa falhou.

## O que significa

O Postgres não está conseguindo mandar os segmentos de WAL para o R2. Enquanto isso o `pg_wal` cresce no disco que as duas produções dividem, e a janela do PITR para de andar. Com `archive_timeout` de 60 s, cinco minutos sem segmento é arquivamento parado.

## Primeira ação

1. Veja o estado do arquivador, com a consulta abaixo.
2. Leia a aba _Logs_ do Database: o `archive-push` do pgBackRest diz por que falhou (R2 fora, chave revogada, bucket errado).
3. Acompanhe o `pg_wal` ([pg-wal-high](./pg-wal-high.md)): com a fila do pgBackRest cheia, ele descarta WAL para salvar o disco e a janela do PITR se perde até o próximo full.

```sql
SELECT archived_count, last_archived_time, failed_count,
       last_failed_wal, last_failed_time
FROM pg_stat_archiver;
```

## Como confirmar

`last_archived_time` volta a andar a cada minuto e o motivo some.

## Quando escalar

Mais de uma hora sem arquivar, ou o disco acima de 80%: chame o dono; na staging, o [disk-full](./disk-full.md) manda desligar o arquivamento.
