import { FastifyInstance } from "fastify";

import { ImportDeliverySpreadsheetController } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-controller";
import { DownloadTemplateController } from "@/modules/import/usecases/download-template/download-template-controller";

import { ListImportsController } from "@/modules/import/usecases/list-imports/list-imports-controller";
import { GetImportController } from "@/modules/import/usecases/get-import/get-import-controller";
import { ReverseImportController } from "@/modules/import/usecases/reverse-import/reverse-import-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import {
  importSchemas,
  importResponses,
} from "./documentation/import-documentation";
import { ndjsonList, offsetMetaWith } from "./documentation/ndjson";
import { importListSearchMetaDoc } from "@/modules/import/usecases/list-imports/list-imports-documentation";
import { XLSX, fileResponse } from "./documentation/doc-only-responses";
import { TEMPLATE_FILENAME } from "@/shared/delivery/spreadsheet-template-file";

const importDeliverySpreadsheetController =
  new ImportDeliverySpreadsheetController();
const downloadTemplateController = new DownloadTemplateController();

const listImportsController = new ListImportsController();
const getImportController = new GetImportController();
const reverseImportController = new ReverseImportController();

// 8 MB of base64 (the schema's own cap) plus the JSON around it.
const SPREADSHEET_BODY_LIMIT = 9 * 1024 * 1024;

/**
 * Loading a day's work from a spreadsheet, and taking it back.
 *
 * Behind `delivery_manage` and the DELIVERIES module: an upload creates
 * deliveries and routes, so whoever may not create a delivery by hand may not
 * create two hundred of them from a file either.
 */
const deliveriesModule = verifyModuleEnabled("DELIVERIES");

async function importRoutes(app: FastifyInstance) {
  app.get(
    "/download-template",
    {
      onRequest: [ensureAuthenticated],
      // Uploads are the dispatcher's, never the driver's (decision 4.4).
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["import"],
        summary: "Baixa a planilha modelo",
        description:
          "Responde com o arquivo .xlsx, NÃO com JSON. O modelo é gerado a partir das mesmas colunas que o importador lê, então ele não pode divergir do parser: uma coluna nova aparece no próximo download. Traz uma linha de exemplo em cinza e uma nota em cada cabeçalho que tem explicação — as perguntas que isso evita são feitas às 6h por quem não vai ler documentação.",
        response: {
          200: fileResponse({
            contentTypes: [XLSX],
            filename: TEMPLATE_FILENAME,
            description:
              "A planilha modelo (.xlsx), gerada das mesmas colunas que o importador lê. NÃO é JSON.",
          }),
          400: importResponses.codedError,
          500: importResponses.internalServerError,
        },
      },
    },
    downloadTemplateController.handle,
  );

  app.post(
    "/import-spreadsheet/:businessId",
    {
      // The schema accepts 8 MB of base64 and says so; without this the
      // framework's 1 MiB default refused any spreadsheet past ~750 KB with a
      // 413 the schema never mentioned. What keeps a large body from costing
      // the process is the reader's inflate and row ceilings, not this.
      bodyLimit: SPREADSHEET_BODY_LIMIT,

      // Each import is seconds of parsing and one query per row. A day's
      // spreadsheet is imported a handful of times; a loop of them froze the
      // replica for every tenant on it. The processing itself runs after the
      // 202, one upload at a time per replica (import-queue.ts).
      config: { rateLimit: { max: 6, timeWindow: "1 minute" } },
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["import"],
        summary: "Importa entregas de uma planilha (em segundo plano)",
        description:
          "Uma linha, uma entrega. ASSÍNCRONA: valida o pedido e o arquivo, abre a importação e responde 202 com `data.id` e `status` IN_PROGRESS; as linhas são processadas depois da resposta, uma importação por vez em cada servidor. Acompanhe por GET /import/get-import/:importId/business/:businessId até `status` virar COMPLETED — é lá que fica o relatório. Uma planilha de 20 mil linhas levava mais que os 100 s que a borda espera, e o operador via erro enquanto as entregas continuavam sendo criadas. O que se recusa sem processar as linhas é recusado na hora: embarcador inexistente ou de outra empresa → 404 SHIPPER_NOT_FOUND; arquivo que não é planilha → 400 SPREADSHEET_UNREADABLE; arquivo grande demais (inflado, células ou linhas) → 413 SPREADSHEET_TOO_LARGE / SPREADSHEET_TOO_MANY_ROWS; servidor com a fila cheia → 429 IMPORT_BUSY com `retry-after`. Um arquivo que passa na conferência e mesmo assim não abre fecha a importação com o motivo na linha 1 do relatório. No relatório, `report.rows` diz o que aconteceu com cada linha pelo número que ela tem na planilha do operador (cabeçalho é a linha 1), e `report.unknownHeaders` lista as colunas que não reconhecemos — nunca fatais, sempre relatadas. Preencher as colunas de rota cria a rota e põe as linhas nela, na ordem da planilha. A duplicata é detectada pela chave da NF-e ou, sem ela, pelo par embarcador + pedido: reenviar o mesmo arquivo é seguro e sai como duplicada.",
        params: importSchemas.businessIdParam,
        body: importSchemas.importSpreadsheet,
        response: {
          202: importResponses.spreadsheetAccepted,
          400: importResponses.codedError,
          403: importResponses.codedError,
          404: importResponses.spreadsheetNotFound,
          413: importResponses.codedError,
          429: importResponses.codedError,
          500: importResponses.internalServerError,
        },
      },
    },
    importDeliverySpreadsheetController.handle,
  );

  app.get(
    "/list-imports",
    {
      onRequest: [ensureAuthenticated],
      // Uploads are the dispatcher's, never the driver's (decision 4.4).
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["import"],
        summary: "Lista as importações da empresa",
        description:
          'Planilhas (`source` SPREADSHEET) e XMLs de NF-e (`source` NFE_XML): toda importação grava uma linha aqui. Token de motorista recebe 403 PERMISSION_DENIED. Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope `{meta:{total,page,pageSize,searchMeta}}` (total do filtro e, em `searchMeta.facets`, as opções dos filtros de status e origem com as contagens, cada uma com o outro filtro aplicado) e cada linha seguinte é uma importação. Tabela paginada no servidor: ordena por `sort`/`order` (created_at, filename, imported, duplicated, invalid; padrão a mais recente primeiro) e filtra por `status` (IN_PROGRESS, COMPLETED, REVERSED) e `source` (SPREADSHEET, NFE_XML). Chamar response.json() nisso dá erro de parse — leia linha a linha. Existe para o relatório sobreviver à requisição que o produziu: "qual das duzentas falhou?" é perguntado horas depois, por quem não fez o upload e não pode refazê-lo para descobrir.',
        querystring: importSchemas.listImports,
        response: {
          200: ndjsonList(
            importResponses.importListRow,
            offsetMetaWith(importListSearchMetaDoc),
          ),
          400: importResponses.codedError,
          403: importResponses.codedError,
          404: importResponses.lookupNotFound,
          500: importResponses.internalServerError,
        },
      },
    },
    listImportsController.handle,
  );

  app.get(
    "/get-import/:importId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      // Uploads are the dispatcher's, never the driver's (decision 4.4).
      preHandler: [
        deliveriesModule,
        verifyPermission("delivery_manage", "read", { allowDriver: false }),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["import"],
        summary: "Lê uma importação com o relatório por linha",
        description:
          'Uma importação com o relatório linha a linha (`report.rows`, `report.unknownHeaders`, `report.routes`). É daqui que a tela lê o relatório ao abrir uma importação: a listagem traz só os contadores (salvo includeReport=true), porque o relatório tem uma entrada por linha da planilha. Traz também `reversal`, o estorno pedido para ela (nulo se ninguém pediu): `state` RUNNING enquanto as entregas são removidas em segundo plano, INTERRUPTED se parou no meio (pedir o estorno de novo continua de onde parou) e DONE quando terminou e `status` virou REVERSED, com o que foi removido e o que foi mantido. A leitura é filtrada pela empresa: a importação de outra transportadora responde 404 IMPORT_NOT_FOUND, nunca "existe mas não é sua".',
        params: importSchemas.importBusinessParams,
        response: {
          200: importResponses.importDetail,
          400: importResponses.codedError,
          403: importResponses.codedError,
          404: importResponses.importNotFound,
          500: importResponses.internalServerError,
        },
      },
    },
    getImportController.handle,
  );

  app.post(
    "/reverse-import/:importId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyBusinessActive,
        deliveriesModule,
        verifyPermission("delivery_manage", "write"),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["import"],
        summary: "Estorna uma importação (planilha ou XML)",
        description:
          "Cada entrega removida é anunciada aos webhooks como `delivery.cancelled`, na mesma transação da remoção (o ERP que recebeu o `delivery.created` fica sabendo). Desfaz o que o upload criou e nada além disso. Remove só o que ninguém tocou — entrega ainda PENDENTE, sem eventos e sem ocorrências, rota ainda PLANEJADA — e devolve em `keptDeliveries`/`keptRoutes` o que ficou, com o motivo. O estorno é parcial de propósito: recusar o desfazer inteiro porque três de duzentas já saíram deixaria o operador apagando as outras cento e noventa e sete na mão, e as que ele esquecer sobem no caminhão. Uma entrega já comprovada é um fato sobre o mundo; nenhum botão de desfazer apaga um. " +
          "Roda em lotes de 500 entregas, cada lote numa transação (uma transação só estourava o tempo: desfazer 2.000 entregas levava 29 s e falhava). Com até 500 entregas a desfazer, o estorno acontece na hora e responde 200 com o resultado. Com mais, responde 202 com `data.id`, `status` e `data.reversal` (`state` RUNNING) e continua em segundo plano, um trabalho por vez em cada servidor, na mesma fila das importações: acompanhe por GET /import/get-import/:importId/business/:businessId até `status` virar REVERSED — o resultado fica em `reversal`. A importação só vira REVERSED quando a última entrega foi desfeita. Se o estorno parar no meio (falha ou servidor reiniciado), `reversal.state` fica INTERRUPTED, a importação continua COMPLETED com o que já foi removido contado, e pedir o estorno de novo continua de onde parou. Pedir de novo enquanto ele roda responde 202 com o andamento, sem começar outro. " +
          "Um estorno já terminado responde 409 IMPORT_ALREADY_REVERSED em vez de dizer que removeu zero; uma importação ainda em andamento, 409 IMPORT_IN_PROGRESS; servidor com a fila cheia, 429 IMPORT_BUSY com `retry-after`. Importação inexistente ou de outra empresa → 404 IMPORT_NOT_FOUND.",
        params: importSchemas.importBusinessParams,
        response: {
          200: importResponses.importReversed,
          202: importResponses.importReversalAccepted,
          400: importResponses.codedError,
          403: importResponses.codedError,
          404: importResponses.importNotFound,
          409: importResponses.codedError,
          429: importResponses.codedError,
          500: importResponses.internalServerError,
        },
      },
    },
    reverseImportController.handle,
  );
}

export { importRoutes };
