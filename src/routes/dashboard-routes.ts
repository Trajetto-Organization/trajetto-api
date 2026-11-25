import { FastifyInstance } from "fastify";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

import { GetDashboardOverviewController } from "@/modules/dashboard/usecases/get-dashboard-overview/get-dashboard-overview-controller";
import { GetDashboardTrendsController } from "@/modules/dashboard/usecases/get-dashboard-trends/get-dashboard-trends-controller";

import {
  dashboardSchemas,
  dashboardResponses,
} from "./documentation/dashboard-documentation";
import { errorResponse } from "./documentation/common-responses";

const getDashboardOverviewController = new GetDashboardOverviewController();
const getDashboardTrendsController = new GetDashboardTrendsController();

async function dashboardRoutes(app: FastifyInstance) {
  app.get(
    "/overview",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [
        verifyUserRole(["MASTER", "BUSINESS_ADMIN", "BUSINESS_USER"]),
      ],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["dashboard"],
        summary: "Visão geral do painel",
        description:
          "Contagens do mês, tendência de seis meses, situação da frota, custos de manutenção, operação de hoje e atividades recentes. Meses e 'hoje' seguem o fuso da empresa (Business.timezone); o MASTER vê o total da plataforma no fuso padrão. Séries e custos só aparecem para o perfil que pode lê-los e para a empresa que contratou o módulo. Os números (tudo menos as atividades recentes, lidas a cada visita) podem ter até 60 s: saem de uma foto da empresa por aquilo que o perfil pode ver (DASHBOARD_SNAPSHOT_TTL_MS), e dois perfis só dividem a mesma cópia quando veriam os mesmos números. O cabeçalho `x-trajetto-refresh: 1` (o Atualizar do painel) pede uma leitura nova, feita só se a cópia tiver 2 s ou mais.",
        response: {
          200: dashboardResponses.dashboardOverview,
          401: errorResponse,
          403: errorResponse,
          404: dashboardResponses.resourceNotFound,
          429: errorResponse,
          500: dashboardResponses.internalServerError,
        },
      },
    },
    getDashboardOverviewController.handle,
  );

  app.get(
    "/trends",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["dashboard"],
        summary: "Tendências do painel por período",
        description:
          "Série de cadastros e custos de manutenção nos últimos 7 ou 30 dias (por dia) ou 3, 6 ou 12 meses (por mês), no calendário da empresa (Business.timezone). Mesmas regras de visibilidade da visão geral. A série pode ter até 60 s: sai da foto da empresa por período e por aquilo que o perfil pode ver (DASHBOARD_SNAPSHOT_TTL_MS). O cabeçalho `x-trajetto-refresh: 1` pede uma leitura nova, feita só se a cópia tiver 2 s ou mais.",
        querystring: dashboardSchemas.trendsQuery,
        response: {
          200: dashboardResponses.dashboardTrends,
          400: errorResponse,
          401: errorResponse,
          403: errorResponse,
          404: dashboardResponses.resourceNotFound,
          429: errorResponse,
          500: dashboardResponses.internalServerError,
        },
      },
    },
    getDashboardTrendsController.handle,
  );
}

export { dashboardRoutes };
