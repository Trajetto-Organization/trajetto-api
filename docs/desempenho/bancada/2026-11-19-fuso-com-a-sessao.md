# ABBA de CPU e statements: fuso-com-a-sessao

Gerado por `tests/load/cpu-abba.sh` (plano de escala LOAD-10), com o
método do ADR 0011: as duas imagens se alternam no mesmo harness, cada
corrida numa cópia nova do mesmo banco, com o `pg_stat_statements`
zerado e a CPU lida do cgroup de cada contêiner.

| Campo             | Valor                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| Data              | 2026-11-19                                                               |
| Resultado         | o corte fica                                                             |
| Commit do harness | 0ccd2b365a58 (com mudanças locais)                                       |
| A                 | wfl-w15-api:base (66203d9b4c64)                                          |
| B                 | wfl-w15-api:cuta (fbc6a0223bb1)                                          |
| Controle (A=B)    | não                                                                      |
| Ordem             | ABBAAB                                                                   |
| Carga             | load.js a 60 operações/s por 120 s, aquecimento de 20 s, repouso de 15 s |
| Réplicas da api   | 2 (PROCESS_ROLE=all, cpuset 0-5)                                         |
| Máquina           | DESKTOP-KKI817J, 16 núcleos, 16 no docker                                |
| Modelo do banco   | abba 2026-11-19T02:31Z                                                   |

## Veredito

- O corte fica: a CPU por requisição caiu −3,5% (o mínimo é 2%) e o p95 variou −7,5% (até +5%).
- Meta da onda 15 para B (≤ 6,0 ms e ≤ 7 statements por requisição): não, com 12,09 ms e 8,95 statements. Indicativo na bancada; o número que vale é o do portão do 1M no hardware-alvo.

## Média ± desvio

| Medida                                   | A                | B                | Δ     |
| ---------------------------------------- | ---------------- | ---------------- | ----- |
| CPU da api por requisição                | 12,53 ± 1,18 ms  | 12,09 ± 0,91 ms  | −3,5% |
| CPU da api por requisição, sem o repouso | 10,48 ± 0,79 ms  | 11,09 ± 1,18 ms  | +5,8% |
| Statements por requisição                | 8,83 ± 0,02      | 8,95 ± 1,29      | +1,3% |
| Statements por requisição, sem o repouso | 8,76 ± 0,03      | 8,93 ± 1,29      | +1,9% |
| CPU do Postgres por requisição           | 13,32 ± 1,11 ms  | 13,04 ± 1,24 ms  | −2,2% |
| Execução no Postgres por requisição      | 5,59 ± 0,46 ms   | 5,31 ± 0,23 ms   | −5,1% |
| p50                                      | 17,9 ± 1,7 ms    | 16,4 ± 0,2 ms    | −8,3% |
| p95                                      | 48,7 ± 5,1 ms    | 45,1 ± 0,7 ms    | −7,5% |
| p99                                      | 54,8 ± 8,4 ms    | 55,4 ± 12,2 ms   | +1,1% |
| Vazão                                    | 58,9 ± 0,0 req/s | 58,9 ± 0,1 req/s | +0,0% |
| Memória da 1ª réplica no fim             | 277 ± 22 MB      | 271 ± 29 MB      | −2,2% |

## Por corrida

| #   | Variante | Requisições | CPU/req  | Statements/req | Postgres/req | p95     | Falhas | k6  |
| --- | -------- | ----------- | -------- | -------------- | ------------ | ------- | ------ | --- |
| 1   | A        | 7.173       | 13,88 ms | 8,81           | 14,59 ms     | 54,6 ms | 0,0%   | 0   |
| 2   | B        | 7.173       | 13,14 ms | 10,44          | 14,47 ms     | 45,9 ms | 0,0%   | 0   |
| 3   | B        | 7.172       | 11,55 ms | 8,18           | 12,22 ms     | 44,6 ms | 0,0%   | 0   |
| 4   | A        | 7.172       | 12,03 ms | 8,85           | 12,85 ms     | 46,0 ms | 0,0%   | 0   |
| 5   | A        | 7.172       | 11,67 ms | 8,83           | 12,54 ms     | 45,6 ms | 0,0%   | 0   |
| 6   | B        | 7.172       | 11,58 ms | 8,23           | 12,42 ms     | 44,7 ms | 0,0%   | 0   |

## Statements mais chamados (última corrida de cada variante)

### A (corrida 5)

| Chamadas | Execução (ms) | Statement                                                                                                                                                          |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6595     | 875.1         | `SELECT u."id", u."name", u."email", u."email_verified", u."password", u."avatar", u."role"::text AS "role", u."businessId", u."profileAccessId", u."driverId", u` |
| 3171     | 114.6         | `SELECT "public"."shipper"."id", "public"."shipper"."name" FROM "public"."shipper" WHERE "public"."shipper"."id" IN ($1) OFFSET $2`                                |
| 2512     | 84.4          | `SELECT "public"."business"."id", "public"."business"."corporate_reason", "public"."business"."fantasy_name", "public"."business"."cep", "public"."business"."cit` |
| 2247     | 71.7          | `SELECT "public"."business"."id", "public"."business"."timezone" FROM "public"."business" WHERE ("public"."business"."id" = $1 AND $4=$5) LIMIT $2 OFFSET $3`      |
| 1607     | 183.0         | `SELECT "public"."driver"."id", "public"."driver"."name" FROM "public"."driver" WHERE ("public"."driver"."businessId" = $1 AND "public"."driver"."id" IN ($2,$3,$` |
| 1481     | 87.1          | `SELECT "public"."route"."id", "public"."route"."started_at" FROM "public"."route" WHERE ("public"."route"."businessId" = $1 AND "public"."route"."status" = CAST` |
| 1447     | 58.6          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."description", "public"."occurrence_type"."requires_photo"` |
| 1447     | 55.4          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."pause_kind"::text, "public"."occurrence_type"."system_key` |
| 1447     | 32.5          | `SELECT "public"."business_settings"."id", "public"."business_settings"."businessId", "public"."business_settings"."checklist_requirement"::text, "public"."busin` |
| 1447     | 870.1         | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1447     | 48.3          | `SELECT "public"."route"."id", "public"."route"."status"::text, "public"."route"."started_at", "public"."route"."completed_at", "public"."route"."updated_at" FRO` |
| 1447     | 58.0          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."description", "public"."occurrence_type"."requires_photo"` |
| 1288     | 61.4          | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1130     | 19.9          | `SELECT "public"."route_stop"."id", "public"."route_stop"."sequence", "public"."route_stop"."status"::text, "public"."route_stop"."arrived_at", "public"."route_s` |
| 1130     | 5.0           | `SELECT "public"."delivery_item"."id", "public"."delivery_item"."description", "public"."delivery_item"."quantity", "public"."delivery_item"."unit", "public"."de` |

### B (corrida 6)

| Chamadas | Execução (ms) | Statement                                                                                                                                                          |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6600     | 888.0         | `SELECT u."id", u."name", u."email", u."email_verified", u."password", u."avatar", u."role"::text AS "role", u."businessId", u."profileAccessId", u."driverId", u` |
| 3193     | 113.9         | `SELECT "public"."shipper"."id", "public"."shipper"."name" FROM "public"."shipper" WHERE "public"."shipper"."id" IN ($1) OFFSET $2`                                |
| 1564     | 172.5         | `SELECT "public"."driver"."id", "public"."driver"."name" FROM "public"."driver" WHERE ("public"."driver"."businessId" = $1 AND "public"."driver"."id" IN ($2,$3,$` |
| 1498     | 90.5          | `SELECT "public"."route"."id", "public"."route"."started_at" FROM "public"."route" WHERE ("public"."route"."businessId" = $1 AND "public"."route"."status" = CAST` |
| 1450     | 56.2          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."pause_kind"::text, "public"."occurrence_type"."system_key` |
| 1450     | 57.8          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."description", "public"."occurrence_type"."requires_photo"` |
| 1450     | 33.1          | `SELECT "public"."business_settings"."id", "public"."business_settings"."businessId", "public"."business_settings"."checklist_requirement"::text, "public"."busin` |
| 1450     | 58.7          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."description", "public"."occurrence_type"."requires_photo"` |
| 1450     | 876.2         | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1450     | 48.4          | `SELECT "public"."route"."id", "public"."route"."status"::text, "public"."route"."started_at", "public"."route"."completed_at", "public"."route"."updated_at" FRO` |
| 1376     | 68.5          | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1155     | 20.6          | `SELECT "public"."route_stop"."id", "public"."route_stop"."sequence", "public"."route_stop"."status"::text, "public"."route_stop"."arrived_at", "public"."route_s` |
| 1155     | 5.2           | `SELECT "public"."delivery_item"."id", "public"."delivery_item"."description", "public"."delivery_item"."quantity", "public"."delivery_item"."unit", "public"."de` |
| 1155     | 54.4          | `SELECT "public"."delivery_occurrence"."id", "public"."delivery_occurrence"."occurrenceTypeId", "public"."delivery_occurrence"."authorization_status"::text, "pub` |
| 1139     | 842.4         | `WITH "day_route" AS ( SELECT r."id", r."driverId", (r."scheduled_date" = $1::date) AS "of_day" FROM "route" r WHERE r."businessId" = $2 AND r."status" <> $23 AN` |
