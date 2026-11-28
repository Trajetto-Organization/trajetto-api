# ADR 0008 — Escala horizontal com réplicas idênticas

- **Status:** aceito. ADR da fase final, com o adendo de 18/11/2026 (o
  orçamento de cada papel, [ADR 0012](./0012-papeis-de-processo.md)).
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

## Adendo de 18/11/2026: o orçamento de cada papel

Com os papéis de processo ([ADR 0012](./0012-papeis-de-processo.md)), as
réplicas continuam idênticas, mas **dentro de cada Application**: todas as
réplicas do `worker` são iguais entre si, e todas as da `api`. Entre
papéis, o que tem de ser igual é a imagem e a configuração que a impressão
do `process_heartbeat` confere. Escalar passa a ser escalar um papel, e
cada papel tem o seu orçamento:

- **Conexões.** Cada processo conta o pool principal (o `connection_limit`
  do login do papel), mais 1 da readiness, mais 3 do `databaseRead` na
  `api` e mais 3 do `databaseBatch` em quem roda o cron ou a fila `jobs`.
  Os logins e os limites por papel estão em
  [`deploy.md` → Valores por papel](../deploy.md#valores-por-papel). No
  papel `all` de hoje, 2 × (10 + 3 + 1) + migrate 2 + ferramentas 8 = 38;
  no 100k (ESTIMADO), `api` 3 × (6 + 3 + 1) + `worker` com o cron 1 × (8 +
  3 + 1) + 8 ≈ 50. A conta continua abaixo do `max_connections` com folga,
  e o PgBouncer entra quando ela deixa de caber (onda 17).
- **Memória.** O teto da Application tem de caber o heap principal, as
  threads da planilha e a reserva nativa; cada processo confere no boot
  (`MEMORY_BUDGET_MODE`, U-15). Os tetos por papel e por fase, e a soma da
  VPS, estão em
  [`deploy.md` → Tetos por Application e por fase](../deploy.md#tetos-por-application-e-por-fase)
  e na [seção 23](../deploy.md#23-recursos-da-vps-e-logs).
- **CPU.** A `api` continua sem limite de CPU (o throttling piora o p99);
  o `worker` e o `scheduler` têm limite, para um dreno de backlog não
  tomar a CPU do HTTP no mesmo host.
- **Filas.** A concorrência de cada fila é por variável e cabe no lease do
  claim (o boot recusa a que não cabe, F3-05); o fan-out entre processos
  usa o despertar do [ADR 0002](./0002-redis-descartavel.md) (adendo de
  18/11/2026).

Escalar um papel sem refazer a conta das conexões e a da memória continua
esgotando o Postgres ou o host, como antes.

## Fontes

- [`arquitetura.md` → Redis e tempo real](../arquitetura.md#redis-e-tempo-real)
  (Escala horizontal) e [Conexão com o Postgres](../arquitetura.md#conexão-com-o-postgres).
- [`deploy.md` → 19. Papéis da mesma imagem](../deploy.md#19-papéis-da-mesma-imagem).
- Adendo de 18/11/2026: [`deploy.md` → roles do banco](../deploy.md#roles-do-banco-logins-urls-e-conexões)
  e [23. Recursos da VPS e logs](../deploy.md#23-recursos-da-vps-e-logs).
