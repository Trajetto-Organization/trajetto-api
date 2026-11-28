# ABBA de CPU e statements: catalogo-do-motorista

Gerado por `tests/load/cpu-abba.sh` (plano de escala LOAD-10), com o
método do ADR 0011: as duas imagens se alternam no mesmo harness, cada
corrida numa cópia nova do mesmo banco, com o `pg_stat_statements`
zerado e a CPU lida do cgroup de cada contêiner.

| Campo             | Valor                                                                    |
| ----------------- | ------------------------------------------------------------------------ |
| Data              | 2026-11-19                                                               |
| Resultado         | o corte sai                                                              |
| Commit do harness | 629028742e52 (com mudanças locais)                                       |
| A                 | wfl-w15-api:cuta (fbc6a0223bb1)                                          |
| B                 | wfl-w15-api:cutab (4e539681acdb)                                         |
| Controle (A=B)    | não                                                                      |
| Ordem             | ABBAAB                                                                   |
| Carga             | load.js a 60 operações/s por 120 s, aquecimento de 20 s, repouso de 15 s |
| Réplicas da api   | 2 (PROCESS_ROLE=all, cpuset 0-5)                                         |
| Máquina           | DESKTOP-KKI817J, 16 núcleos, 16 no docker                                |
| Modelo do banco   | abba 2026-11-19T02:31Z                                                   |

## Veredito

- O corte sai: a CPU por requisição variou −0,5% (precisa cair 2% ou mais) e o p95 +0,3% (até +5%).
- Meta da onda 15 para B (≤ 6,0 ms e ≤ 7 statements por requisição): não, com 11,66 ms e 7,76 statements. Indicativo na bancada; o número que vale é o do portão do 1M no hardware-alvo.

## Média ± desvio

| Medida                                   | A                | B                | Δ     |
| ---------------------------------------- | ---------------- | ---------------- | ----- |
| CPU da api por requisição                | 11,71 ± 0,11 ms  | 11,66 ± 0,11 ms  | −0,5% |
| CPU da api por requisição, sem o repouso | 10,24 ± 0,68 ms  | 10,03 ± 0,12 ms  | −2,0% |
| Statements por requisição                | 8,17 ± 0,02      | 7,76 ± 0,04      | −5,0% |
| Statements por requisição, sem o repouso | 8,12 ± 0,04      | 7,73 ± 0,04      | −4,8% |
| CPU do Postgres por requisição           | 12,32 ± 0,11 ms  | 12,26 ± 0,11 ms  | −0,5% |
| Execução no Postgres por requisição      | 5,16 ± 0,07 ms   | 5,17 ± 0,08 ms   | +0,3% |
| p50                                      | 16,4 ± 0,0 ms    | 15,3 ± 0,1 ms    | −6,6% |
| p95                                      | 44,9 ± 0,2 ms    | 45,0 ± 0,2 ms    | +0,3% |
| p99                                      | 49,0 ± 1,0 ms    | 49,7 ± 1,0 ms    | +1,5% |
| Vazão                                    | 58,9 ± 0,1 req/s | 58,9 ± 0,0 req/s | −0,0% |
| Memória da 1ª réplica no fim             | 255 ± 19 MB      | 263 ± 15 MB      | +3,0% |

## Por corrida

| #   | Variante | Requisições | CPU/req  | Statements/req | Postgres/req | p95     | Falhas | k6  |
| --- | -------- | ----------- | -------- | -------------- | ------------ | ------- | ------ | --- |
| 1   | A        | 7.171       | 11,84 ms | 8,15           | 12,28 ms     | 44,8 ms | 0,0%   | 0   |
| 2   | B        | 7.171       | 11,79 ms | 7,80           | 12,39 ms     | 45,2 ms | 0,0%   | 0   |
| 3   | B        | 7.172       | 11,59 ms | 7,77           | 12,17 ms     | 44,8 ms | 0,0%   | 0   |
| 4   | A        | 7.171       | 11,63 ms | 8,16           | 12,24 ms     | 45,1 ms | 0,0%   | 0   |
| 5   | A        | 7.172       | 11,67 ms | 8,19           | 12,44 ms     | 44,7 ms | 0,0%   | 0   |
| 6   | B        | 7.172       | 11,60 ms | 7,72           | 12,22 ms     | 45,0 ms | 0,0%   | 0   |

## Statements mais chamados (última corrida de cada variante)

### A (corrida 5)

| Chamadas | Execução (ms) | Statement                                                                                                                                                          |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6601     | 884.9         | `SELECT u."id", u."name", u."email", u."email_verified", u."password", u."avatar", u."role"::text AS "role", u."businessId", u."profileAccessId", u."driverId", u` |
| 3096     | 111.7         | `SELECT "public"."shipper"."id", "public"."shipper"."name" FROM "public"."shipper" WHERE "public"."shipper"."id" IN ($1) OFFSET $2`                                |
| 1549     | 168.5         | `SELECT "public"."driver"."id", "public"."driver"."name" FROM "public"."driver" WHERE ("public"."driver"."businessId" = $1 AND "public"."driver"."id" IN ($2,$3,$` |
| 1467     | 89.0          | `SELECT "public"."route"."id", "public"."route"."started_at" FROM "public"."route" WHERE ("public"."route"."businessId" = $1 AND "public"."route"."status" = CAST` |
| 1396     | 55.9          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."description", "public"."occurrence_type"."requires_photo"` |
| 1396     | 47.0          | `SELECT "public"."route"."id", "public"."route"."status"::text, "public"."route"."started_at", "public"."route"."completed_at", "public"."route"."updated_at" FRO` |
| 1396     | 847.4         | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1396     | 55.8          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."pause_kind"::text, "public"."occurrence_type"."system_key` |
| 1396     | 32.0          | `SELECT "public"."business_settings"."id", "public"."business_settings"."businessId", "public"."business_settings"."checklist_requirement"::text, "public"."busin` |
| 1396     | 57.2          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."description", "public"."occurrence_type"."requires_photo"` |
| 1332     | 66.9          | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1167     | 869.4         | `WITH "day_route" AS ( SELECT r."id", r."driverId", (r."scheduled_date" = $1::date) AS "of_day" FROM "route" r WHERE r."businessId" = $2 AND r."status" <> $23 AN` |
| 1080     | 19.9          | `SELECT "public"."route_stop"."id", "public"."route_stop"."sequence", "public"."route_stop"."status"::text, "public"."route_stop"."arrived_at", "public"."route_s` |
| 1080     | 4.9           | `SELECT "public"."delivery_item"."id", "public"."delivery_item"."description", "public"."delivery_item"."quantity", "public"."delivery_item"."unit", "public"."de` |
| 1080     | 52.8          | `SELECT "public"."delivery_occurrence"."id", "public"."delivery_occurrence"."occurrenceTypeId", "public"."delivery_occurrence"."authorization_status"::text, "pub` |

### B (corrida 6)

| Chamadas | Execução (ms) | Statement                                                                                                                                                          |
| -------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6542     | 897.7         | `SELECT u."id", u."name", u."email", u."email_verified", u."password", u."avatar", u."role"::text AS "role", u."businessId", u."profileAccessId", u."driverId", u` |
| 3046     | 111.0         | `SELECT "public"."shipper"."id", "public"."shipper"."name" FROM "public"."shipper" WHERE "public"."shipper"."id" IN ($1) OFFSET $2`                                |
| 1551     | 173.6         | `SELECT "public"."driver"."id", "public"."driver"."name" FROM "public"."driver" WHERE ("public"."driver"."businessId" = $1 AND "public"."driver"."id" IN ($2,$3,$` |
| 1480     | 90.0          | `SELECT "public"."route"."id", "public"."route"."started_at" FROM "public"."route" WHERE ("public"."route"."businessId" = $1 AND "public"."route"."status" = CAST` |
| 1366     | 67.5          | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1328     | 97.3          | `SELECT "public"."occurrence_type"."id", "public"."occurrence_type"."name", "public"."occurrence_type"."description", "public"."occurrence_type"."requires_photo"` |
| 1328     | 817.2         | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1328     | 43.1          | `SELECT "public"."route"."id", "public"."route"."status"::text, "public"."route"."started_at", "public"."route"."completed_at", "public"."route"."updated_at" FRO` |
| 1328     | 30.3          | `SELECT "public"."business_settings"."id", "public"."business_settings"."businessId", "public"."business_settings"."checklist_requirement"::text, "public"."busin` |
| 1140     | 862.6         | `WITH "day_route" AS ( SELECT r."id", r."driverId", (r."scheduled_date" = $1::date) AS "of_day" FROM "route" r WHERE r."businessId" = $2 AND r."status" <> $23 AN` |
| 1035     | 83.0          | `SELECT "public"."driver"."id", "public"."driver"."name", "public"."driver"."cnh" FROM "public"."driver" WHERE "public"."driver"."id" IN ($1,$2,$3,$4,$5,$6,$7,$8` |
| 1035     | 23590.5       | `SELECT "status"::text AS "status", "shipperId", "driverId", GROUPING("status", "shipperId", "driverId")::int AS "set", count(*)::int AS "count" FROM "public"."d` |
| 1035     | 32.8          | `SELECT "public"."shipper"."id", "public"."shipper"."name" FROM "public"."shipper" WHERE ("public"."shipper"."businessId" = $1 AND "public"."shipper"."id" IN ($2` |
| 1035     | 794.2         | `SELECT "public"."delivery"."id", "public"."delivery"."code", "public"."delivery"."invoice_key", "public"."delivery"."invoice_number", "public"."delivery"."recip` |
| 1035     | 190.6         | `SELECT COUNT(*) AS "_count$_all", "public"."route_stop"."routeId" FROM "public"."route_stop" LEFT JOIN "public"."delivery" AS "j0" ON ("j0"."id") = ("public"."r` |
