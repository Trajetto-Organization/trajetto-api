# ADR 0006 — Idempotência de efeitos externos; na dúvida, guardar

- **Status:** aceito. ADR da fase final.
- **Escopo:** `trajetto-api` (e o contrato que o app e a API pública seguem).
- **Origem deste arquivo:** o texto integral ficava na pasta `docs/` da raiz
  do workspace, que não é versionada e está vazia. Este arquivo foi
  reconstruído em 28/10/2026 a partir do que os documentos versionados já
  registravam (fontes no fim). Não acrescenta decisão nova.

## Decisão

1. **Reenviar nunca duplica.** Toda escrita que um cliente pode repetir
   (o outbox do app, a API pública) leva uma chave: `client_submission_id`
   no corpo ou `Idempotency-Key` no cabeçalho. A chave é **única por
   empresa** no banco; o reenvio de um registro que já existe é respondido
   com ele, e a chave de outro usuário da mesma empresa é recusada (409),
   nunca entregue.
2. **Todo efeito externo leva uma chave estável**: o id da entrega no e-mail
   (`Resend-Idempotency-Key`) e no push (`tag` em todo aparelho, `collapseId`
   só no iPhone), o
   `X-Trajetto-Event-Id` no webhook, a `idempotencyKey` da leitura de IA. O
   que cada canal ainda deixa passar está na pergunta 6 do
   [ADR 0001](./0001-filas-e-mensageria.md#6-como-evitamos-duplicação-em-redelivery-crash-restart-e-várias-réplicas).
3. **Na dúvida, guardar o objeto.** Um arquivo no R2 sem linha que o
   referencie pode ser o upload de um cliente que ainda vai reenviar o
   registro. O coletor noturno (`cleanup-orphan-uploads`) só olha objetos
   de 30 a 33 dias e, por padrão, só conta (`UPLOAD_ORPHAN_GC=dry-run`);
   apagar exige `delete`.

## Onde o código aplica

- Chaves únicas por empresa no `prisma/schema.prisma` (abastecimento,
  checklist, ordem de serviço, entrega, pausa) e as respostas de reenvio em
  `src/modules/driver-pause/usecases/pause-ownership.ts`.
- A importação de planilha identifica uma linha sem chave de NF-e pelo par
  (embarcador, código do pedido), que não tem índice único de propósito:
  a checagem é repetida sob um advisory lock dentro da transação do insert
  (`src/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase.ts`).
- O coletor de órfãos: `src/shared/services/orphan-uploads.ts`.

## Fontes

- [`arquitetura.md` → Regras transversais](../arquitetura.md#regras-transversais)
  (Idempotência) e [Arquivos](../arquitetura.md#arquivos).
- [`arquitetura.md` → Compatibilidade com o app do motorista](../arquitetura.md#compatibilidade-com-o-app-do-motorista).
- [ADR 0001](./0001-filas-e-mensageria.md), pergunta 6.
