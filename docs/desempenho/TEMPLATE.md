# Portão `<degrau>` — `<data>`

> Copie este arquivo para `docs/desempenho/<data>-<degrau>.md` e preencha
> todos os campos. Campo sem valor fica com o motivo ("não medido: …"), nunca
> em branco. Nenhum IP, token ou e-mail real além do que a seção "Gerador"
> pede; o host do alvo, só pelo nome.

## Resumo

| Campo                                       | Valor                                        |
| ------------------------------------------- | -------------------------------------------- |
| Degrau                                      | 1k, 10k, 100k, 1M ou 5M                      |
| Portão                                      | B, 100k, 1M ou 5M (plano de escala, seção 6) |
| Resultado                                   | aprovado, reprovado ou no limite             |
| `APPROVED_GATE_MONTHLY_DELIVERIES` proposto | `<entregas por mês>` (hoje: `<valor atual>`) |
| Aprovado por                                | `<nome>` em `<data>`                         |

## O que rodou

| Campo     | Valor                                                                   |
| --------- | ----------------------------------------------------------------------- |
| Commit    | `<sha>` (API), `<sha>` (web), `<sha>` (app), quando entram              |
| Digests   | `trajetto-api@sha256:<…>`, `trajetto-api-migrate@sha256:<…>`, os outros |
| Seed      | `LOAD_TIER=<…>`, empresas, entregas, motoristas; tempo do seed          |
| Réplicas  | por papel (api, worker, realtime, ingest…) e o limite de cada uma       |
| Variáveis | as que diferem do padrão (pool, concorrência, `commit_delay`…)          |

## A máquina do alvo

| Campo           | Valor                                          |
| --------------- | ---------------------------------------------- |
| Máquina         | provedor, plano, região                        |
| `nproc`         | `<n>`                                          |
| Memória e disco | `<GiB>`, tipo de disco                         |
| Steal           | média e máximo de `vmstat 5` durante a corrida |
| Hostname        | `<nome>`                                       |

## O gerador

| Campo    | Valor                                            |
| -------- | ------------------------------------------------ |
| Hostname | `<nome>`                                         |
| IP       | `<ip>` (nunca o mesmo do alvo)                   |
| `nproc`  | `<n>`                                            |
| Caminho  | rede privada, ou pela Cloudflare (15 min no fim) |

## Critérios e números

Uma linha por critério do portão, com o limite e o medido:

| Critério                 | Limite     | Medido | Passou |
| ------------------------ | ---------- | ------ | ------ |
| `<ex.: p95 do load>`     | `< 250 ms` |        |        |
| `<ex.: falhas>`          | `0`        |        |        |
| `<ex.: rolling sem 5xx>` | `0`        |        |        |

## Anexos

- **Resumo do k6** de cada cenário (o `--summary-export`, colado ou como
  arquivo ao lado).
- **`docker stats`** do pico (CPU e memória por contêiner).
- **Top 20 do `pg_stat_statements`** da corrida, por tempo total
  (`pgss_snapshot` da hora, ou a leitura direta).
- **`ops_sample`** do intervalo: ELU, `prisma_pool.waiting`, CPU por
  requisição e a linha `cluster`.

## O que mudou por causa disto

O que a corrida achou, o que foi corrigido (com o commit e o teste que
guarda) e o que ficou para o próximo portão.
