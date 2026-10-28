# ADR 0008 — Escala horizontal com réplicas idênticas

- **Status:** aceito. ADR da fase final.
- **Escopo:** `trajetto-api`.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova.

## Decisão

A API escala com **N réplicas idênticas** da mesma imagem atrás do Traefik do
Dokploy, **sem cookie sticky**:

- o estado está no Postgres (dados, filas, leases dos crons);
- as filas (`SKIP LOCKED` + lease) e os crons (lease por horário) não
  duplicam trabalho entre réplicas;
- o adapter Redis leva os eventos de tempo real entre elas (ADR 0007);
- o WebSocket fica na réplica que o aceitou, por natureza.

Staging e produção começam com 2 réplicas da Application `trajetto-api`.

## Consequências registradas

- **Orçamento de conexões**: cada réplica soma o próprio pool mais a conexão
  da readiness (`réplicas × 11 + migrations + ferramentas < max_connections`).
  Escalar sem refazer a conta esgota o Postgres.
- O Postgres continua o ponto único de coordenação; os gatilhos para mudar
  isso estão em [ADR 0001 → Quando reabrir a decisão](./0001-filas-e-mensageria.md#quando-reabrir-a-decisão).
- Provas: `tests/E2E/multi-replica-events.test.ts` e o harness de carga com
  Traefik e várias réplicas em `tests/load/`.

## Fontes

- [`arquitetura.md` → Redis e tempo real](../arquitetura.md#redis-e-tempo-real)
  (Escala horizontal) e [Conexão com o Postgres](../arquitetura.md#conexão-com-o-postgres).
- [`deploy.md` → 19. Réplicas, workers e tempo real](../deploy.md#19-réplicas-workers-e-tempo-real).
