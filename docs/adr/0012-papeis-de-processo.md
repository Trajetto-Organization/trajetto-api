# ADR 0012 — Papéis de processo: uma imagem, uma Application por papel

- **Status:** aceito em 18/11/2026 (plano de escala, onda 12, F3-33).
  Substitui o [ADR 0004](./0004-workers-no-mesmo-processo.md).
- **Escopo:** `trajetto-api`: o processo da imagem `trajetto-api`, as
  Applications do Dokploy que a rodam e a ação de deploy.
- **Depende de:** [ADR 0001](./0001-filas-e-mensageria.md) (o Postgres é a
  fila), [ADR 0002](./0002-redis-descartavel.md) (o Redis só leva dicas que
  podem sumir) e [ADR 0008](./0008-escala-horizontal.md) (réplicas sem
  cookie sticky).

## Contexto

O ADR 0004 punha o HTTP, o Socket.IO, os workers e o cron no mesmo
processo, e deixava a separação para um gatilho medido: espera no pool,
o Postgres puxado por um dreno de backlog, ou publicar o HTTP sem
reiniciar os workers. Em 15/11/2026 o dono decidiu implementar todo o
código de escala de uma vez, porque os primeiros clientes já são de escala
(milhões de entregas por mês, milhares de empresas). A **infra** continua
crescendo por medição; o **código** fica pronto, com cada mudança atrás de
uma variável de padrão seguro.

Separar com uma flag só (`WORKERS_ENABLED`) não bastava: um worker dedicado
que ninguém acorda varria a cada 30 s, uma réplica sem workers não tinha
como avisar o worker, o cron e as filas não se separavam, e nada dizia ao
deploy que o worker tinha subido no build novo.

## Decisão

1. **Uma imagem, vários papéis.** A imagem `trajetto-api` roda em uma
   Application por papel: `api`, `worker`, `scheduler`, `worker-external`,
   `realtime` e `ingest`, mais o `all` (tudo num processo, a produção de
   hoje). Nenhum papel tem código, Dockerfile ou build próprio; a migração
   continua na imagem irmã `trajetto-api-migrate`.
2. **`PROCESS_ROLE` é preset e rótulo** (decisão D15). O papel preenche
   `WORKERS_ENABLED`, `CRON_ENABLED`, `WORKER_QUEUES`, `SOCKETS_ENABLED` e
   as varreduras (2 s nos papéis que consomem filas sem ser acordados
   localmente), e toda variável dada explicitamente ganha dele, com aviso
   no boot. Sem `PROCESS_ROLE`, o processo é exatamente o de antes (`all`,
   ou `api` com `WORKERS_ENABLED=false`).
3. **A superfície HTTP é do papel, sem variável.** Os papéis sem tráfego
   público (`worker`, `scheduler`, `worker-external`) respondem só
   `/health*`; o `realtime` atende o `/socket.io` e o `/health*`; o
   `ingest`, o `/health*` e o `POST /route/positions`. Um contêiner de outro
   environment na rede `dokploy-network` não alcança as rotas de um worker,
   e copiar um _Environment_ nunca alarga a superfície.
4. **Todo processo diz quem é** na tabela `process_heartbeat`: papel,
   ambiente, commit, filas, cron, sockets e a impressão da configuração
   (o hash das chaves que não podem divergir, da identidade do banco e do
   Redis). O deploy espera cada papel no commit novo pelo
   `/health/rollout` (`ROLLOUT_ROLES_EXPECTED`, onde `all` vale por `api`,
   `worker` e `scheduler`, D22), e os alertas acusam fila sem consumidor,
   versões misturadas e processo de outro ambiente no banco.
5. **O despertar entre processos vai pelo pub/sub do Redis**, como dica
   descartável (adendo de 18/11/2026 do ADR 0002): quem grava trabalho numa
   fila que não consome avisa no canal `<SOCKET_ADAPTER_KEY>:wake:<fila>`;
   uma dica perdida custa a varredura de 2 s. A verdade continua nas
   tabelas.
6. **Cada papel tem a própria tag** (`<tag>-<papel>`, D16), que anda logo
   antes do deploy dele, na ordem migrate → ia → worker → scheduler →
   worker-external → api → ingest → realtime (D17). O Swarm puxa a tag de
   novo a cada reinício de task; uma tag só para todos subiria um worker no
   build novo fora de ordem.
7. **Cada papel tem o seu orçamento**: login do banco e `connection_limit`,
   teto de memória com o heap conferido no boot (`MEMORY_BUDGET_MODE`) e
   concorrência das filas por variável, com o lease conferido no boot
   (adendo de 18/11/2026 do ADR 0008).

Os valores de cada papel, o passo a passo de cada Application, a ordem do
corte e da reversão e os tetos por fase estão em
[`deploy.md` → 19. Papéis da mesma imagem](../deploy.md#19-papéis-da-mesma-imagem).

## Por quê

- **Uma imagem** mantém um build, uma varredura de vulnerabilidades e um
  digest por release: o rollback de um papel é o rollback da API.
- **Preset com a variável vencendo**: o preset evita o esquecimento que
  custava 30 s por notificação (a varredura de um worker sem despertar), e
  a variável explícita deixa uma medição ou um incidente mexer num botão
  só. Nascer uma vez, na onda 12, evita um rótulo que muda de efeito.
- **Separar não é microsserviço**: os papéis falam pelo Postgres (as
  filas, os leases) e por dicas no Redis, nunca por chamadas entre si. Um
  papel fora do ar atrasa o trabalho dele; não perde nada.

## Consequências

- O código de todos os papéis já roda na staging e na produção, inerte:
  sem a Application de um papel, nada muda. O dono cria cada Application
  quando a régua de RAM da VPS deixa
  ([`deploy.md` → 23](../deploy.md#23-recursos-da-vps-e-logs)): o
  `trajetto-worker` nasce na staging na onda 12 e na produção na onda 14;
  os outros, na staging do 2º VPS e na virada para os servidores próprios.
- A reversão de cada corte é na ordem inversa, mudando primeiro a
  Application que fica (`PROCESS_ROLE=all` na api antes de zerar o
  worker): uma fila nunca fica sem processo.
- O deploy passa a falhar quando um papel não sobe no commit novo, quando
  uma fila fica sem consumidor ou quando dois processos do mesmo ambiente
  têm configurações diferentes; sem `ROLLOUT_ROLES_EXPECTED`, ele faz o que
  fazia.
- Provas: `tests/unitaires/lifecycle/process-role.test.ts`,
  `tests/E2E/process-roles-replicas.test.ts`,
  `tests/E2E/process-heartbeat.test.ts`,
  `tests/unitaires/lifecycle/deploy-roles.test.ts`,
  `tests/unitaires/lifecycle/wait-for-roles.test.ts` e
  `tests/unitaires/lifecycle/role-guide.test.ts`; na bancada, o
  `tests/load/multi-replica.sh` com o perfil `roles`.

## Fontes

- [`deploy.md` → 19. Papéis da mesma imagem](../deploy.md#19-papéis-da-mesma-imagem)
  e [14. Conferir a convergência](../deploy.md#14-conferir-a-convergência).
- [`arquitetura.md` → Um processo, vários papéis](../arquitetura.md#um-processo-vários-papéis).
- `src/shared/lifecycle/process-role.ts`, `src/shared/wake/` e
  `src/shared/health/process-heartbeat.ts`.
