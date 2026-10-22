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
      // replica for every tenant on it.
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
        summary: "Importa entregas de uma planilha",
        description:
          "Uma linha, uma entrega. Responde 200 mesmo quando nada foi criado: uma planilha em que todas as linhas eram duplicatas não criou nada e o operador continua precisando do relatório. `report.rows` diz o que aconteceu com cada linha pelo número que ela tem na planilha do operador (cabeçalho é a linha 1), e `report.unknownHeaders` lista as colunas que não reconhecemos — nunca fatais, sempre relatadas, porque é assim que alguém descobre que digitou o cabeçalho errado. Preencher as colunas de rota cria a rota e põe as linhas nela, na ordem da planilha. A duplicata é detectada pela chave da NF-e ou, sem ela, pelo par embarcador + pedido. Embarcador escolhido inexistente ou de outra empresa → 404 SHIPPER_NOT_FOUND.",
        params: importSchemas.businessIdParam,
        body: importSchemas.importSpreadsheet,
        response: {
          200: importResponses.spreadsheetImported,
          400: importResponses.codedError,
          403: importResponses.codedError,
          404: importResponses.spreadsheetNotFound,
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
          'Uma importação com o relatório linha a linha (`report.rows`, `report.unknownHeaders`, `report.routes`). É daqui que a tela lê o relatório ao abrir uma importação: a listagem pedida com includeReport=false traz só os contadores, porque o relatório tem uma entrada por linha da planilha. A leitura é filtrada pela empresa: a importação de outra transportadora responde 404 IMPORT_NOT_FOUND, nunca "existe mas não é sua".',
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
          "Cada entrega removida é anunciada aos webhooks como `delivery.cancelled`, na mesma transação da remoção (o ERP que recebeu o `delivery.created` fica sabendo). Desfaz o que o upload criou e nada além disso. Remove só o que ninguém tocou — entrega ainda PENDENTE, sem eventos e sem ocorrências, rota ainda PLANEJADA — e devolve em `keptDeliveries`/`keptRoutes` o que ficou, com o motivo. O estorno é parcial de propósito: recusar o desfazer inteiro porque três de duzentas já saíram deixaria o operador apagando as outras cento e noventa e sete na mão, e as que ele esquecer sobem no caminhão. Uma entrega já comprovada é um fato sobre o mundo; nenhum botão de desfazer apaga um. Um segundo estorno responde 409 IMPORT_ALREADY_REVERSED em vez de dizer que removeu zero; uma importação ainda em andamento, 409 IMPORT_IN_PROGRESS. Importação inexistente ou de outra empresa → 404 IMPORT_NOT_FOUND.",
        params: importSchemas.importBusinessParams,
        response: {
          200: importResponses.importReversed,
          400: importResponses.codedError,
          403: importResponses.codedError,
          404: importResponses.importNotFound,
          409: importResponses.codedError,
          500: importResponses.internalServerError,
        },
      },
    },
    reverseImportController.handle,
  );
}

export { importRoutes };
