# ADR 0004 — Workers no mesmo processo da API

- **Status:** aceito. ADR da fase final.
- **Escopo:** `trajetto-api`.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova.

## Decisão

Cada réplica da API roda, no mesmo processo Node (`src/server.ts`), o HTTP,
o Socket.IO e, com `WORKERS_ENABLED=true` (o padrão), os workers: o
pipeline de notificações, o pipeline de IA, o dispatcher de webhooks e o
agendador de crons (`src/workers/index.ts`). A mesma imagem pode separar os
papéis, mas **só por gatilho medido**.

## Por quê

- As filas são tabelas do Postgres reivindicadas com `SKIP LOCKED` e lease,
  e os crons têm um lease por horário: N réplicas não duplicam trabalho, e
  não há um processo especial a manter vivo.
- Uma peça a menos para implantar e monitorar: os workers sobem e descem
  junto com as réplicas da Application `trajetto-api`.

## Quando separar

Os gatilhos estão em
[`deploy.md` → Separar os workers do HTTP](../deploy.md#separar-os-workers-do-http-só-por-gatilho-medido):

- espera no pool visível em `/health/metrics` (`runtime.prisma_pool`) nos
  horários de dreno;
- CPU, IO ou WAL do Postgres puxados por um dreno de backlog enquanto o HTTP
  sofre;
- necessidade de publicar o HTTP sem reiniciar os workers.

Separar é isolamento, não correção de falha. O passo a passo (Application
`trajetto-worker` com a mesma imagem e `WORKERS_ENABLED=false` nas réplicas
HTTP) está na mesma seção. Testes: `tests/unitaires/lifecycle/workers-role-flag.test.ts`.

## Consequências registradas

- O desligamento ordenado (`src/shared/lifecycle/shutdown.ts`) para os
  workers depois do HTTP e da fila de importações, com teto de 35 s, abaixo
  do _Stop Grace Period_ de 40 s da Application.
- O pool de conexões é dividido entre HTTP e workers da mesma réplica; o
  orçamento de conexões está em
  [`arquitetura.md` → Conexão com o Postgres](../arquitetura.md#conexão-com-o-postgres).

## Fontes

- [`arquitetura.md` → Um processo, vários papéis](../arquitetura.md#um-processo-vários-papéis).
- [`deploy.md` → 19. Réplicas, workers e tempo real](../deploy.md#19-réplicas-workers-e-tempo-real).
- [ADR 0001 → Quando reabrir a decisão](./0001-filas-e-mensageria.md#quando-reabrir-a-decisão).
