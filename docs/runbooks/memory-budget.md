# memory-budget — Orçamento de memória de uma réplica não fecha

**Dispara quando:** a linha mais nova do `ops_sample` de um processo diz que o orçamento de memória dele não fecha (`memory_budget.ok = false`).

## O que significa

No boot, cada processo soma o que pode ocupar de memória: o heap principal (o `--max-old-space-size` do `NODE_OPTIONS`), as threads que leem planilhas (`SPREADSHEET_READS_PER_PROCESS` × `SPREADSHEET_WORKER_MAX_OLD_MB`), as threads do pool de CPU quando existirem e a reserva do que o V8 e as bibliotecas nativas seguram fora de todo heap (`NATIVE_RESERVE_MB`, 150). A soma tem de caber no teto do contêiner, o _Memory_ da Application (o `memory.max` do cgroup) — plano de escala, U-15.

A leitura da planilha numa thread (F3-23b) deu a ela um heap só dela, **somado** ao principal. Com o heap de 768 MiB de antes num contêiner de 1 GiB, a primeira planilha grande pode levar o processo além do teto, e o kernel mata o contêiner inteiro, com todas as requisições dele. Com `MEMORY_BUDGET_MODE=warn` (o padrão deste release) o processo subiu mesmo assim: o log tem `memory budget does not fit` com as partes, o `/health/metrics` traz `memory_budget_ok: false` e este alerta toca. Com `enforce`, o boot é recusado com a mesma frase.

## Primeira ação

1. Veja `memory_budget` em `/health/metrics` da réplica (ou o log do boot): `limit_mb`, `heap_mb`, `spreadsheet_reads`, `spreadsheet_max_old_mb` e `native_mb`.
2. Aplique os valores da seção 3 do plano de escala na Application certa, no _Environment_ dela no Dokploy, e faça o Deploy. Na `trajetto-api` de produção com 1 GiB: `NODE_OPTIONS=--max-old-space-size=576` e `SPREADSHEET_WORKER_MAX_OLD_MB=256` (576 + 256 + 150 = 982 de 1.024).
3. Se o heap não pode baixar, suba o _Memory_ da Application (_Advanced → Resources_) e refaça a conta do host antes.

```sql
SELECT DISTINCT ON (replica) replica, ts,
  metrics -> 'memory_budget' ->> 'total_mb' AS soma_mb,
  metrics -> 'memory_budget' ->> 'limit_mb' AS teto_mb,
  metrics -> 'memory_budget' ->> 'mode' AS modo
FROM ops_sample
WHERE ts > now() - interval '5 minutes' AND role <> 'cluster'
ORDER BY replica, ts DESC;
```

## Como confirmar

O boot do deploy novo loga `memory budget fits`, o `/health/metrics` traz `memory_budget_ok: true` e a linha do `ops_sample` de cada réplica tem `ok` igual a `true`.

## Quando escalar

Se a conta não fecha nem com os valores da seção 3 (o host não tem memória para o teto que ela pede), chame o dono: é a régua R1/R2 da seção 3.3 do plano, e a decisão de mover um papel para outro servidor. Não ligue `MEMORY_BUDGET_MODE=enforce` antes de os valores estarem nos dois ambientes.
