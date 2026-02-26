import { z } from "zod";
import { trendsPeriodSchema } from "@/schemas/trends-period-schema";

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
  trendsQuery: trendsPeriodSchema,
};

const dashboardResponses = {
  countByDateRange: z.object({
    count: z.number().describe("Total de registros no período"),
  }),
  dashboardOverview: z.object({
    counts: z.object({
      vehicles: z.object({
        currentMonth: z
          .number()
          .describe("Number of vehicles created in current month"),
        lastMonth: z
          .number()
          .describe("Number of vehicles created in last month"),
      }),
      drivers: z.object({
        currentMonth: z
          .number()
          .describe("Number of drivers created in current month"),
        lastMonth: z
          .number()
          .describe("Number of drivers created in last month"),
      }),
      businesses: z.object({
        currentMonth: z
          .number()
          .describe("Number of businesses created in current month"),
        lastMonth: z
          .number()
          .describe("Number of businesses created in last month"),
      }),
      branches: z.object({
        currentMonth: z
          .number()
          .describe("Number of branches created in current month"),
        lastMonth: z
          .number()
          .describe("Number of branches created in last month"),
      }),
      parts: z.object({
        currentMonth: z
          .number()
          .describe("Number of parts created in current month"),
        lastMonth: z.number().describe("Number of parts created in last month"),
      }),
      suppliers: z.object({
        currentMonth: z
          .number()
          .describe("Number of suppliers created in current month"),
        lastMonth: z
          .number()
          .describe("Number of suppliers created in last month"),
      }),
      serviceOrders: z.object({
        currentMonth: z
          .number()
          .describe("Number of service orders created in current month"),
        lastMonth: z
          .number()
          .describe("Number of service orders created in last month"),
      }),
      users: z.object({
        currentMonth: z
          .number()
          .describe("Number of users created in current month"),
        lastMonth: z.number().describe("Number of users created in last month"),
      }),
      fines: z.object({
        currentMonth: z
          .number()
          .describe("Number of fines created in current month"),
        lastMonth: z.number().describe("Number of fines created in last month"),
      }),
    }),
    vehicleStatus: z.object({
      ACTIVE: z.number().describe("Number of active vehicles"),
      INACTIVE: z.number().describe("Number of inactive vehicles"),
      BLOCKED: z.number().describe("Number of blocked vehicles"),
      IN_ROUTE: z.number().describe("Number of vehicles in route"),
    }),
    activityTrends: z.array(
      z.object({
        month: z.string().describe("Month name"),
        vehicles: z.number().describe("Number of vehicles"),
        drivers: z.number().describe("Number of drivers"),
        businesses: z.number().describe("Number of businesses"),
        branches: z.number().describe("Number of branches"),
        parts: z.number().describe("Number of parts"),
        suppliers: z.number().describe("Number of suppliers"),
        serviceOrders: z.number().describe("Number of service orders"),
        users: z.number().describe("Number of users"),
        fines: z.number().describe("Number of fines"),
      }),
    ),
    maintenanceStats: z.object({
      pending: z.number().describe("Number of pending maintenances"),
      recent: z.number().describe("Number of recent maintenances"),
      overdue: z.number().describe("Number of overdue maintenances"),
    }),
    recentActivity: z.array(
      z.object({
        id: z.string().describe("Activity ID"),
        type: z.string().describe("Activity type"),
        action: z.string().describe("Activity action"),
        entityId: z.string().describe("Entity ID related to activity"),
        description: z.string().describe("Activity description"),
        status: z.string().describe("Activity status"),
        performedBy: z.string().describe("User who performed the activity"),
        businessId: z.string().nullable().describe("Business ID"),
        visibilityLevel: z
          .string()
          .nullable()
          .optional()
          .describe("Visibility level"),
        performingUserRole: z
          .string()
          .nullable()
          .optional()
          .describe("Performing user role"),
        user: z
          .object({
            email: z.string().describe("User email"),
            role: z.string().describe("User role"),
            name: z.string().describe("User name"),
          })
          .optional()
          .describe("User information"),
        business: z
          .object({
            corporate_reason: z.string().describe("Business corporate reason"),
          })
          .optional()
          .describe("Business information"),
        created_at: z
          .union([z.string(), z.date()])
          .describe("Activity creation date"),
        updated_at: z
          .union([z.string(), z.date()])
          .describe("Activity last update date"),
      }),
    ),
    vehiclesByType: z.array(
      z.object({
        name: z.string().describe("Vehicle type name"),
        count: z.number().describe("Number of vehicles of this type"),
      }),
    ),
    maintenanceCosts: z.array(
      z.object({
        month: z.string().describe("Month name"),
        preventive: z.number().describe("Preventive maintenance costs"),
        corrective: z.number().describe("Corrective maintenance costs"),
      }),
    ),
  }),
  dashboardTrends: z.object({
    activityTrends: z.array(
      z.object({
        date: z.string().describe("Date or month"),
        vehicles: z.number().describe("Number of vehicles"),
        drivers: z.number().describe("Number of drivers"),
        businesses: z.number().describe("Number of businesses"),
        branches: z.number().describe("Number of branches"),
        parts: z.number().describe("Number of parts"),
        suppliers: z.number().describe("Number of suppliers"),
        serviceOrders: z.number().describe("Number of service orders"),
        users: z.number().describe("Number of users"),
        fines: z.number().describe("Number of fines"),
      }),
    ),
    maintenanceCosts: z.array(
      z.object({
        date: z.string().describe("Date or month"),
        preventive: z.number().describe("Preventive maintenance costs"),
        corrective: z.number().describe("Corrective maintenance costs"),
      }),
    ),
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
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { dashboardSchemas, dashboardResponses };
