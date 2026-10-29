import { FastifyInstance } from "fastify";
import { ListAllActivitiesController } from "@/modules/activity/usecases/list-all-activities/list-all-activities-controller";
import { GetActivitySummaryController } from "@/modules/activity/usecases/get-activity-summary/get-activity-summary-controller";
import { ListActivitiesCursorController } from "@/modules/activity/usecases/list-activities-cursor/list-activities-cursor-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import {
  activitySchemas,
  activityResponses,
} from "./documentation/activity-documentation";
import { ndjsonCursor, ndjsonList } from "./documentation/ndjson";

const listAllActivitiesController = new ListAllActivitiesController();
const getActivitySummaryController = new GetActivitySummaryController();
const listActivitiesCursorController = new ListActivitiesCursorController();

async function activityRoutes(app: FastifyInstance) {
  app.get(
    "/list",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["activity"],
        summary: "Lista o registro de atividades (tabela)",
        description:
          "O registro de atividades em páginas, mais recentes primeiro (`order=asc` inverte). Filtra no servidor, sobre o registro inteiro e não sobre a página: `status`, `type`, `action` e `role` (um ou mais valores do catálogo, separados por vírgula). O status filtrado também encontra as grafias antigas do mesmo status. `role=DRIVER` são as ações do motorista pelo aplicativo; `PLATFORM`/`MASTER`, as da equipe Trajetto. O MASTER vê todas as empresas ou uma (`businessId`); o administrador vê a própria empresa, sem as ações do MASTER exceto as mudanças do plano dela.",
        querystring: activitySchemas.listAllActivitiesQuery,
        response: {
          200: ndjsonList(activityResponses.activityRow),
          400: activityResponses.listActivitiesErrors,
          403: activityResponses.activityForbidden,
          500: activityResponses.internalServerError,
        },
      },
    },
    listAllActivitiesController.handle,
  );

  app.get(
    "/list-cursor",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["activity"],
        summary: "Linha do tempo de atividades (cursor, NDJSON)",
        description:
          "Feed da linha do tempo, mais recentes primeiro, paginado por cursor (o registro é escrito o tempo todo: com páginas por posição, a segunda repetiria linhas da primeira). A janela `period` (7d ou 30d) conta dias civis no fuso da empresa, hoje incluído, e faz parte do contrato do cursor: ao trocá-la, descarte o cursor e recomece. O escopo é o da tabela — o MASTER vê tudo ou uma empresa (`businessId`); o administrador, a própria empresa sem as ações do MASTER, exceto as mudanças do plano dela.",
        querystring: activitySchemas.listActivitiesCursorQuery,
        response: {
          200: ndjsonCursor(
            activityResponses.activityRow,
            activityResponses.activityCursorMeta,
          ),
          400: activityResponses.resourceNotFound,
          403: activityResponses.activityForbidden,
          500: activityResponses.internalServerError,
        },
      },
    },
    listActivitiesCursorController.handle,
  );

  app.get(
    "/summary",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["activity"],
        summary: "Resumo das atividades do período",
        description:
          "Totais da janela inteira (nunca de uma página): ações por tipo, exclusões, pessoas que agiram (ações de sistema, sem autor, não contam) e o módulo mais movimentado. A janela conta dias civis no fuso da empresa, hoje incluído. O escopo é o da tabela — o MASTER vê tudo ou uma empresa (`businessId`); o administrador, a própria empresa sem as ações do MASTER.",
        querystring: activitySchemas.activitySummaryQuery,
        response: {
          200: activityResponses.activitySummary,
          400: activityResponses.resourceNotFound,
          403: activityResponses.activityForbidden,
          500: activityResponses.internalServerError,
        },
      },
    },
    getActivitySummaryController.handle,
  );
}

export { activityRoutes };
