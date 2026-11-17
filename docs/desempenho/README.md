# Desempenho: relatórios de portão

Esta pasta guarda os relatórios de capacidade da API, um arquivo por portão,
no formato do [`TEMPLATE.md`](./TEMPLATE.md). O nome do arquivo é
`<data>-<degrau>.md` (por exemplo `2027-02-10-100k.md`).

## A regra

- Nenhum portão carrega a produção em uso, e a staging não é régua de
  capacidade (plano de escala, seção 6).
- **Sem relatório, o degrau de infraestrutura não sobe.** Um degrau novo
  (servidor, réplicas, PgBouncer) só entra depois de um relatório aprovado
  aqui.
- O `APPROVED_GATE_MONTHLY_DELIVERIES` (o portão da régua de rampa,
  `docs/variaveis-de-ambiente.md`) só muda com um relatório aprovado. Hoje ele
  é `10000`, o degrau em que a plataforma já opera, sem relatório no formato
  do template. O alerta `volume-near-gate`
  ([runbook](../runbooks/volume-near-gate.md)) avisa quando as entregas dos
  últimos 7 dias, projetadas para o mês, passam de 70% dele.
- Um relatório aprovado não se edita: um portão refeito é um arquivo novo.

## Relatórios

| Data | Degrau | Resultado | Arquivo |
| ---- | ------ | --------- | ------- |
| —    | —      | —         | nenhum  |

## Medições de outubro de 2026, antes do template

Duas medições de 07/10/2026 orientaram correções que o código ainda cita. Os
relatórios originais (`carga-2026-10.md` e `banco-2026-10.md`) ficaram na
pasta `docs/` da raiz do workspace, que não é versionada, e não estão neste
repositório. O que eles mediram e o que mudou por causa disso fica registrado
aqui e nos testes que guardam cada correção. Os números são os que o código e
o [README do harness](../../tests/load/README.md) já registravam; nada aqui
foi medido de novo.

### Carga de 07/10/2026

O harness de `tests/load` com a imagem real da API: 1, 2 e 4 réplicas,
smoke, carga, estresse até a saturação e o `multi-replica.sh`, numa empresa
com 300 mil entregas.

- **Teto de uma réplica:** o joelho é ~110–120 req/s por réplica, com
  histórico. Com mais réplicas, o platô foi ~140 req/s com 1, ~205 com 2 e
  ~250–285 com 4, quando a CPU da máquina acabou. Numa máquina só, isso diz
  se a aplicação escala até a CPU da máquina, não quantos hosts a produção
  precisa.
- **Keep-alive:** 16 `POST /route/positions` responderam 502 numa corrida de
  estresse. O keep-alive do Fastify (72 s) era menor que o do Traefik (90 s).
  Correção: `src/config/http-server.ts` (95 s); teste
  `tests/unitaires/lifecycle/http-keep-alive.test.ts`.
- **Verificação do JWT:** a tentativa de ler o segredo como chave pública
  custava ~7% da CPU de uma réplica, duas vezes por requisição autenticada.
  Correção: `src/shared/security/jwt-verify-key.ts`; teste
  `tests/unitaires/security/jwt-verify-key.test.ts`. Desde a onda 9 do plano
  de escala, a assinatura é conferida uma vez só por requisição
  (`src/shared/auth/access-token-once.ts`; teste
  `tests/unitaires/security/access-token-once.test.ts`).
- **Dashboard:** rotular cada linha no SQL levava ~300 ms por visita (298 ms
  em média) e era um quarto da CPU do banco a 120 req/s. Correção:
  `src/modules/dashboard/repositories/period-buckets.ts`; teste
  `tests/E2E/dashboard-counts-index-ranges.test.ts`.
- **Contagens do quadro de entregas:** três leituras agrupadas do histórico
  inteiro, 64 + 64 + 28 ms por página, um terço da CPU do banco a 120 req/s.
  Correção: uma leitura com `GROUPING SETS`
  (`src/modules/delivery/repositories/delivery-repository.ts`); testes
  `tests/E2E/delivery-list-facets-single-scan.test.ts` e
  `tests/E2E/query-plans-scale.test.ts`.

### Banco de 07/10/2026

A rodada de planos de consulta num banco de rascunho com 50 empresas e 1
milhão de entregas. Cada correção é guardada por um teste que roda o
repositório de verdade e confere o plano do Postgres (caminho de acesso,
nunca milissegundos):

- os índices da migration `20261007120000_db_perf_indexes`:
  `tests/E2E/query-plans-scale.test.ts`;
- a busca das ocorrências e do atendimento pelo índice de trigramas das
  entregas (`src/modules/delivery/repositories/occurrence-search.ts` e
  `SupportTicketRepository.resolveSearchMatches`):
  `tests/E2E/query-plans-search-occurrences-tickets.test.ts`;
- a retenção de 400 dias das contagens de uso da API, que não tinham limite:
  `tests/E2E/query-plans-retention.test.ts`.
