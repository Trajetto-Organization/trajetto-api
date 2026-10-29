import { z } from "zod";

import { errorResponse, internalErrorResponse } from "./common-responses";
import { trendsPeriodSchema } from "@/schemas/trends-period-schema";

import { OPERATION_COUNTER_TEXT } from "./operation-day-texts";

/**
 * The series of a trend point. All optional: a series the viewer may not see,
 * or whose module the company did not hire, is absent (no line) rather than
 * zero (a flat line claiming the metric exists).
 */
const trendSeries = z.object({
  vehicles: z.number().optional().describe("Veículos cadastrados no período"),
  drivers: z.number().optional().describe("Motoristas cadastrados no período"),
  businesses: z
    .number()
    .optional()
    .describe("Empresas cadastradas (só MASTER)"),
  branches: z.number().optional().describe("Filiais cadastradas no período"),
  parts: z.number().optional().describe("Peças cadastradas (Frotas)"),
  suppliers: z
    .number()
    .optional()
    .describe("Fornecedores cadastrados (Frotas)"),
  serviceOrders: z
    .number()
    .optional()
    .describe("Ordens de serviço abertas (Frotas)"),
  users: z.number().optional().describe("Usuários cadastrados no período"),
  fines: z.number().optional().describe("Multas registradas (Frotas)"),
  deliveries: z.number().optional().describe("Entregas criadas (Entregas)"),
  routes: z.number().optional().describe("Rotas criadas (Entregas)"),
});

/**
 * The counts of one entity: created in the company's current civil month and
 * in the one before (Business.timezone), plus what the card shows (`value`)
 * and its comparison (`previous`), by `basis`. Zero, not absent, when the
 * profile may not see the entity or the company did not hire its module: the
 * web hides those cards by its route registry and reads every key.
 */
const monthCount = (what: string) =>
  z.object({
    currentMonth: z
      .number()
      .describe(`${what} no mês atual, no calendário da empresa`),
    lastMonth: z.number().describe(`${what} no mês anterior`),
    basis: z
      .enum(["total", "month_to_date"])
      .describe(
        "`total` num cadastro (veículos, motoristas, empresas, filiais, peças, fornecedores, usuários): o cartão mostra o total atual. `month_to_date` numa operação (ordens de serviço, multas, entregas, rotas): o cartão mostra o mês até agora.",
      ),
    value: z
      .number()
      .describe(
        "O número do cartão: o total atual (`total`) ou o criado no mês até agora (`month_to_date`).",
      ),
    previous: z
      .number()
      .describe(
        "A mesma medida um período antes: o total quando o mês da empresa começou (`total`) ou o mês anterior até o mesmo dia e hora (`month_to_date`).",
      ),
  });

const dashboardSchemas = {
  trendsQuery: trendsPeriodSchema,
};

const dashboardResponses = {
  dashboardOverview: z.object({
    counts: z
      .object({
        vehicles: monthCount("Veículos cadastrados"),
        drivers: monthCount("Motoristas cadastrados"),
        businesses: monthCount("Empresas cadastradas (só MASTER)"),
        branches: monthCount("Filiais cadastradas"),
        parts: monthCount("Peças cadastradas (Frotas)"),
        suppliers: monthCount("Fornecedores cadastrados (Frotas)"),
        serviceOrders: monthCount("Ordens de serviço abertas (Frotas)"),
        users: monthCount("Usuários cadastrados"),
        fines: monthCount("Multas registradas (Frotas)"),
        deliveries: monthCount("Entregas criadas (Entregas)"),
        routes: monthCount("Rotas criadas (Entregas)"),
      })
      .describe(
        "Zero quando o perfil não pode ver a entidade ou a empresa não contratou o módulo dela.",
      ),
    vehicleStatus: z
      .object({
        ACTIVE: z.number().describe("Veículos ativos"),
        INACTIVE: z.number().describe("Veículos inativos"),
        BLOCKED: z.number().describe("Veículos bloqueados"),
        IN_ROUTE: z.number().describe("Veículos em rota"),
      })
      .describe("Zero quando o perfil não lê veículos."),
    activityTrends: z
      .array(
        trendSeries.extend({ month: z.string().describe("Mês (ex.: Set)") }),
      )
      .describe(
        "Seis meses do calendário da empresa (Business.timezone), o atual por último. Cada série só vem quando o perfil pode vê-la e a empresa contratou o módulo dela.",
      ),
    maintenanceStats: z
      .object({
        pending: z
          .number()
          .describe(
            "A vencer: próxima revisão entre hoje e hoje + 30 dias, ou nenhuma revisão registrada (sem a data da última revisão, qualquer que seja a quilometragem)",
          ),
        recent: z
          .number()
          .describe(
            "Em dia: próxima revisão depois de hoje + 30 dias e quilometragem ainda não atingida",
          ),
        overdue: z
          .number()
          .describe(
            "Atrasada: o dia da próxima revisão já passou (vencer hoje ainda não é atraso) ou a quilometragem foi atingida",
          ),
        // Optional only for the shared MASTER snapshot (60 s in Redis): one
        // written by the previous version has no key, and a required field
        // would fail its serialisation during a rolling deploy.
        unrecorded: z
          .number()
          .optional()
          .describe(
            "Já contados em `pending`: veículos sem a data da última revisão registrada. Ausente só em respostas de uma versão anterior da API.",
          ),
      })
      .describe(
        "Próxima revisão = dia da última revisão + intervalo em meses (fim de mês ajustado), comparado com o hoje da empresa (Business.timezone), ou quilometragem da última revisão + intervalo em km (sem quilometragem registrada, a conta parte de zero). Conta todos os veículos cadastrados, inclusive os inativos. Zero quando a empresa não contratou Frotas ou o perfil não lê veículos.",
      ),
    deliveryOperation: z
      .object({
        unassigned: z
          .number()
          .describe(
            "Pendentes sem motorista, de qualquer data (o que ainda deve rota)",
          ),
        designated: z.number().describe(OPERATION_COUNTER_TEXT.designated),
        inRoute: z.number().describe(OPERATION_COUNTER_TEXT.inRoute),
        deliveredToday: z
          .number()
          .describe(OPERATION_COUNTER_TEXT.deliveredToday),
        failedToday: z.number().describe(OPERATION_COUNTER_TEXT.failedToday),
        occurrencesToday: z
          .number()
          .describe(
            "Ocorrências relatadas por motoristas no dia de negócio da empresa, pela hora em que aconteceram; não conta anotações do painel nem tipos de sistema",
          ),
      })
      .nullable()
      .describe(
        "Nulo para o MASTER (sem empresa única), para empresa sem o módulo Entregas e para perfil sem leitura em delivery_manage (linha só com escrita não conta). 'Hoje' é o dia civil no fuso da empresa; designadas, em rota, entregues e insucessos são os documentos do dia da torre de controle (decisão 7.1).",
      ),
    recentActivity: z.array(
      z.object({
        id: z.string().describe("ID da atividade"),
        type: z.string().describe("Tipo da atividade"),
        action: z.string().describe("Ação registrada"),
        entityId: z
          .string()
          .describe("ID do registro a que a atividade se refere"),
        description: z.string().describe("Descrição da atividade"),
        status: z.string().describe("Situação exibida na atividade"),
        performedBy: z.string().nullable().describe("Quem realizou a ação"),
        businessId: z.string().nullable().describe("ID da empresa"),
        tenantName: z
          .string()
          .nullable()
          .optional()
          .describe(
            "Nome da empresa no momento da atividade, preservado após a exclusão",
          ),
        visibilityLevel: z
          .string()
          .nullable()
          .optional()
          .describe("Nível de visibilidade"),
        performingUserRole: z
          .string()
          .nullable()
          .optional()
          .describe("Papel de quem realizou a ação"),
        user: z
          .object({
            // Nullable because a MASTER action shown to a company user is
            // presented as the platform, with the operator's personal address
            // stripped — see shared/activity/actor-presentation.
            email: z.string().nullable().describe("E-mail do usuário"),
            role: z.string().describe("Papel do usuário"),
            name: z.string().describe("Nome do usuário"),
          })
          .nullish()
          .describe("Quem realizou a ação"),
        business: z
          .object({
            corporate_reason: z.string().describe("Razão social da empresa"),
          })
          .nullish()
          .describe("Empresa da atividade"),
        created_at: z
          .union([z.string(), z.date()])
          .describe("Quando a atividade foi registrada"),
        updated_at: z
          .union([z.string(), z.date()])
          .describe("Última atualização da atividade"),
      }),
    ),
    vehiclesByType: z.array(
      z.object({
        name: z.string().describe("Tipo de veículo ('Outros' sem tipo)"),
        count: z.number().describe("Quantidade de veículos desse tipo"),
      }),
    ),
    maintenanceCosts: z
      .array(
        z.object({
          month: z.string().describe("Mês (ex.: Set)"),
          internal: z.number().describe("Custo de manutenção interna"),
          external: z.number().describe("Custo de manutenção externa"),
        }),
      )
      .describe(
        "Vazio quando a empresa não contratou Frotas ou o perfil não lê ordens de serviço.",
      ),
  }),
  dashboardTrends: z.object({
    activityTrends: z
      .array(
        trendSeries.extend({
          date: z.string().describe("Dia (ex.: 27 de set.) ou mês (ex.: Set)"),
        }),
      )
      .describe(
        "Dias ou meses do calendário da empresa (Business.timezone), o atual por último. Cada série só vem quando o perfil pode vê-la e a empresa contratou o módulo dela.",
      ),
    maintenanceCosts: z
      .array(
        z.object({
          date: z.string().describe("Dia ou mês"),
          internal: z.number().describe("Custo de manutenção interna"),
          external: z.number().describe("Custo de manutenção externa"),
        }),
      )
      .describe(
        "Vazio quando a empresa não contratou Frotas ou o perfil não lê ordens de serviço.",
      ),
  }),
  resourceNotFound: errorResponse,
  internalServerError: internalErrorResponse,
};

export { dashboardSchemas, dashboardResponses };
