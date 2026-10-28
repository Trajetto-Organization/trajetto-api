# ADR 0007 — Tempo real distribuído, no máximo uma vez

- **Status:** aceito. ADR da fase final.
- **Escopo:** `trajetto-api` (servidor Socket.IO) e os clientes web e app.
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova.

## Decisão

- O tempo real é **Socket.IO só com WebSocket**, no mesmo processo da API
  (`src/websocket.ts`), com o `@socket.io/redis-adapter` levando os eventos
  entre réplicas (`src/shared/socket/adapter-redis.ts`).
- A entrega é **_at-most-once_**: um evento pode se perder (réplica que cai,
  Redis fora, cliente desconectado). **A verdade está no banco**: toda tela
  refaz a consulta ao reconectar, e um evento só avisa que algo mudou.
- Nenhuma fila no caminho do tempo real: uma fila acrescentaria latência e um
  ponto de falha sem encurtar o atraso que o usuário vê, que vem do intervalo
  de envio do app
  ([ADR 0001, pergunta 4](./0001-filas-e-mensageria.md#4-o-rastreamento-em-tempo-real-precisa-de-fila)).
- O evento é emitido **depois do commit**, nunca dentro da transação
  (`sendCatalogChangedEvent` e afins).

## Como o código cumpre

- Salas por usuário, sessão, empresa (`business:<id>`) e operação
  (`operations:<id>`). A autorização é relida do banco a cada inscrição e
  revalidada a cada `SOCKET_REVALIDATE_MS` (3 min, com jitter).
- O app conecta com o token; a web, com um ticket de uso único de 30 s
  (`POST /user/socket-ticket`, `src/shared/socket/socket-ticket.ts`), para o
  token nunca chegar ao JavaScript da página.
- `catalogChanged` `{ businessId, entity }` faz a web invalidar a lista daquela
  entidade. Uma rajada de eventos vira um refresh só na Torre.
- Sem Redis, cada réplica ainda alcança os próprios sockets; só o
  espalhamento entre réplicas degrada (ADR 0002).

## Fontes

- [`arquitetura.md` → Redis e tempo real](../arquitetura.md#redis-e-tempo-real)
  e o fluxo "Tempo real entre réplicas" em
  [Fluxos em detalhe](../arquitetura.md#fluxos-em-detalhe).
- [`deploy.md` → 19. Réplicas, workers e tempo real](../deploy.md#19-réplicas-workers-e-tempo-real).
- Prova entre réplicas: `tests/E2E/multi-replica-events.test.ts`.
