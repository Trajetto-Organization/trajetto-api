import { FastifyInstance } from "fastify";

import { ListTrafficViolationCodeController } from "@/modules/fine/usecases/list-traffic-violation-code/list-traffic-violation-code-controller";
import { SearchTrafficViolationCodeCursorController } from "@/modules/fine/usecases/search-traffic-violation-code-cursor/search-traffic-violation-code-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { requireModuleForPlugin } from "@/modules/middlewares/verify-module-enabled";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  trafficViolationCodeSchemas,
  trafficViolationCodeResponses,
} from "./documentation/traffic-violation-code-documentation";
import { ndjsonCursor, ndjsonList } from "./documentation/ndjson";

const listTrafficViolationCodeController =
  new ListTrafficViolationCodeController();
const searchTrafficViolationCodeCursorController =
  new SearchTrafficViolationCodeCursorController();

async function trafficViolationCodeRoutes(app: FastifyInstance) {
  // The codes exist for the fine form: the same FLEET gate as the fines
  // (decision 4.3). The table itself is national and the same for everyone.
  requireModuleForPlugin(app, "FLEET");

  app.get(
    "/list-traffic-violation-codes",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["traffic-violation-code"],
        summary: "Lista os códigos de infração",
        description:
          "A tabela nacional de códigos de infração de trânsito, paginada, com busca livre e filtros por gravidade e tipo de infrator.",
        querystring: trafficViolationCodeSchemas.listTrafficViolationCode,
        response: {
          200: ndjsonList(trafficViolationCodeResponses.trafficViolationCodeRow),
          400: trafficViolationCodeResponses.error,
          500: trafficViolationCodeResponses.error,
        },
      },
    },
    listTrafficViolationCodeController.handle,
  );

  app.get(
    "/search-traffic-violation-codes",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["traffic-violation-code"],
        summary: "Busca códigos de infração (por cursor)",
        description:
          "Os códigos de infração para o seletor do formulário de multa, em ordem de código e desdobramento, filtrados no servidor pelo termo digitado (`search`): o código como impresso (`745` ou `745-50`) ou palavras da descrição. A primeira linha traz `meta.searchMeta.{nextCursor, hasMore}`; passe `nextCursor` como `cursor` para a próxima página.",
        querystring:
          trafficViolationCodeSchemas.searchTrafficViolationCodeCursor,
        response: {
          200: ndjsonCursor(trafficViolationCodeResponses.trafficViolationCodeRow),
          400: trafficViolationCodeResponses.error,
          500: trafficViolationCodeResponses.error,
        },
      },
    },
    searchTrafficViolationCodeCursorController.handle,
  );
}

export { trafficViolationCodeRoutes };
