import { z } from "zod";

const dashboardSchemas = {
  countByDateRangeQuery: z.object({
    startDate: z.string().describe("Data de início no formato YYYY-MM-DD"),
    endDate: z.string().describe("Data de fim no formato YYYY-MM-DD"),
  }),
  countByDateRangeParams: z.object({
    entity: z
      .enum([
        "vehicle",
        "driver",
        "business",
        "branch",
        "part",
        "supplier",
        "service-order",
        "user-registration",
      ])
      .describe("Entidade a ser contabilizada"),
  }),
};

const dashboardResponses = {
  countByDateRange: z.object({
    count: z.number().describe("Total de registros no período"),
  }),
  vehicleStatusCount: z.object({
    ACTIVE: z.number().describe("Total de veículos ativos"),
    INACTIVE: z.number().describe("Total de veículos inativos"),
    BLOCKED: z.number().describe("Total de veículos bloqueados"),
    IN_ROUTE: z.number().describe("Total de veículos em rota"),
  }),
  maintenanceStats: z.object({
    pending: z.number().describe("Total de manutenções pendentes"),
    recent: z.number().describe("Total de manutenções recentes"),
    overdue: z.number().describe("Total de manutenções atrasadas"),
  }),
  monthlyCosts: z.object({
    preventive: z.number().describe("Custos com manutenção preventiva"),
    corrective: z.number().describe("Custos com manutenção corretiva"),
  }),
  vehicleTypeCount: z.object({
    data: z.array(
      z.object({
        name: z.string().describe("Nome do tipo de veículo"),
        count: z.number().describe("Quantidade de veículos"),
      }),
    ),
  }),
  internalServerError: z.object({
    message: z.string().default("Erro interno do servidor"),
  }),
};

export { dashboardSchemas, dashboardResponses };
