import { FastifyInstance } from "fastify";

import { ImportDeliverySpreadsheetController } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-controller";
import { DownloadTemplateController } from "@/modules/import/usecases/download-template/download-template-controller";

import { ListImportsController } from "@/modules/import/usecases/list-imports/list-imports-controller";
import { ReverseImportController } from "@/modules/import/usecases/reverse-import/reverse-import-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";

import { importSchemas, importResponses } from "./documentation/import-documentation";

const importDeliverySpreadsheetController =
  new ImportDeliverySpreadsheetController();
const downloadTemplateController = new DownloadTemplateController();

const listImportsController = new ListImportsController();
const reverseImportController = new ReverseImportController();

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
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["import"],
        summary: "Download the spreadsheet model",
        description:
          "Responde com o arquivo .xlsx, NÃO com JSON. O modelo é gerado a partir das mesmas colunas que o importador lê, então ele não pode divergir do parser: uma coluna nova aparece no próximo download. Traz uma linha de exemplo em cinza e uma nota em cada cabeçalho que tem explicação — as perguntas que isso evita são feitas às 6h por quem não vai ler documentação.",
        response: {
          400: importResponses.genericError,
          500: importResponses.internalServerError,
        },
      },
    },
    downloadTemplateController.handle,
  );

  app.post(
    "/import-spreadsheet/:businessId",
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
        summary: "Load a day's deliveries from a spreadsheet",
        description:
          "Uma linha, uma entrega. Responde 200 mesmo quando nada foi criado: uma planilha em que todas as linhas eram duplicatas não criou nada e o operador continua precisando do relatório. `report.rows` diz o que aconteceu com cada linha pelo número que ela tem na planilha do operador (cabeçalho é a linha 1), e `report.unknownHeaders` lista as colunas que não reconhecemos — nunca fatais, sempre relatadas, porque é assim que alguém descobre que digitou o cabeçalho errado. Preencher as colunas de rota cria a rota e põe as linhas nela, na ordem da planilha. A duplicata é detectada pela chave da NF-e ou, sem ela, pelo par embarcador + pedido.",
        params: importSchemas.businessIdParam,
        body: importSchemas.importSpreadsheet,
        response: {
          200: importResponses.spreadsheetImported,
          400: importResponses.genericError,
          403: importResponses.genericError,
          404: importResponses.genericError,
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
      preHandler: [deliveriesModule, verifyPermission("delivery_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["import"],
        summary: "List the uploads a company has made",
        description:
          "Responde em application/x-ndjson, NÃO em JSON: a primeira linha é o envelope `{meta:{total,page,pageSize}}` e cada linha seguinte é uma importação, da mais recente para a mais antiga. Chamar response.json() nisso dá erro de parse — leia linha a linha. Existe para o relatório sobreviver à requisição que o produziu: \"qual das duzentas falhou?\" é perguntado horas depois, por quem não fez o upload e não pode refazê-lo para descobrir.",
        querystring: importSchemas.listImports,
        response: {
          200: importResponses.importListEnvelope,
          400: importResponses.genericError,
          403: importResponses.genericError,
          500: importResponses.internalServerError,
        },
      },
    },
    listImportsController.handle,
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
        summary: "Undo an upload, as far as it still can be undone",
        description:
          "Desfaz o que o upload criou e nada além disso. Remove só o que ninguém tocou — entrega ainda PENDENTE, sem eventos e sem ocorrências, rota ainda PLANEJADA — e devolve em `keptDeliveries`/`keptRoutes` o que ficou, com o motivo. O estorno é parcial de propósito: recusar o desfazer inteiro porque três de duzentas já saíram deixaria o operador apagando as outras cento e noventa e sete na mão, e as que ele esquecer sobem no caminhão. Uma entrega já comprovada é um fato sobre o mundo; nenhum botão de desfazer apaga um. Um segundo estorno responde 409 em vez de dizer que removeu zero.",
        params: importSchemas.importBusinessParams,
        response: {
          200: importResponses.importReversed,
          400: importResponses.genericError,
          403: importResponses.genericError,
          404: importResponses.genericError,
          409: importResponses.genericError,
          500: importResponses.internalServerError,
        },
      },
    },
    reverseImportController.handle,
  );
}

export { importRoutes };
