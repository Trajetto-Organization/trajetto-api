import { z } from "zod";

import { createBusinessSchema } from "@/schemas/create-business-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { updateBusinessSchema } from "@/schemas/update-business-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateAILimitSchema } from "@/schemas/update-ai-limit-schema";
import { updateVehicleLimitSchema } from "@/schemas/update-vehicle-limit-schema";

import { confirmDeletionCodeSchema } from "@/schemas/confirm-deletion-code-schema";

const businessSchemas = {
  createBusiness: createBusinessSchema,
  listBusiness: listPagesSchema,
  searchBusinessCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de empresas a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última empresa da página anterior para paginação"),
    search: z.string().trim().max(100).optional(),
  }),
  updateDeleteBusiness: updateDeleteBusinessSchema,
  // Wire format only: the controller re-parses and owns the real validation.
  moduleImpactParams: z.object({
    businessId: z.string().describe("ID da empresa"),
    module: z.string().describe("FLEET ou DELIVERIES"),
  }),
  updateBusiness: updateBusinessSchema,
  updateAILimit: updateAILimitSchema,
  updateVehicleLimit: updateVehicleLimitSchema,
  updateEntitlement: z.object({
    module: z.enum(["FLEET", "DELIVERIES"]).describe("Módulo vendável."),
    enabled: z.boolean().describe("Habilitar (true) ou desabilitar (false)."),
  }),
  confirmDeletionCode: confirmDeletionCodeSchema,
};

const businessResponses = {
  businessCreated: z.object({
    message: z.string().default("Empresa e filial matriz criadas com sucesso!"),
  }),
  businessList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        corporate_reason: z.string(),
        fantasy_name: z.string(),
        cep: z.string(),
        city: z.string(),
        uf: z.string(),
        street: z.string(),
        address_number: z.string(),
        complement: z.string(),
        cnae: z.string(),
        erp_code: z.string(),
        responsible_name: z.string(),
        email: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
        telephone: z.string(),
        cnpj: z.string(),
        vehicle_limit: z
          .number()
          .describe(
            "Nº de veículos contratados (base de cobrança; 0 = não configurado).",
          ),
        vehicle_count: z
          .number()
          .describe("Veículos ativos (ocupando vaga do plano)."),
      }),
    ),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
  businessUpdated: z.object({
    message: z.string().default("Empresa atualizada com sucesso!"),
  }),
  businessDeleted: z.object({
    message: z.string().default("Empresa deletada com sucesso!"),
  }),
  businessToggled: z.object({
    message: z.string().default("Status da empresa atualizado com sucesso!"),
    is_active: z.boolean(),
  }),

  searchBusinessStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {nextCursor, hasMore}. Subsequent lines are business objects.",
      ),
  }),

  // Common error responses
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  validationError: z.object({
    message: z.string().default("Validation Error"),
    issues: z.array(z.string()),
  }),
  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),
  cnpjAlreadyExists: z.object({
    message: z.string().default("Este cnpj já foi cadastrado em uma empresa!"),
  }),
  corporateReasonAlreadyExists: z.object({
    message: z
      .string()
      .default("Esta razão social já foi cadastrada em uma empresa!"),
  }),
  erpCodeAlreadyExists: z.object({
    message: z
      .string()
      .default("Este código erp já foi cadastrado em uma empresa!"),
  }),
  emailAlreadyExists: z.object({
    message: z
      .string()
      .default("Este e-mail já foi cadastrado em uma empresa!"),
  }),

  // Branch errors (used in create/update business)
  branchNameAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Esta razão social não está disponível para cadastro. As razões sociais de filiais devem ser únicas em todo o sistema.",
      ),
  }),
  branchCnpjAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este CNPJ não está disponível para cadastro. Os CNPJs de filiais devem ser únicos em todo o sistema.",
      ),
  }),
  branchErpCodeAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este código ERP não está disponível para cadastro. Os códigos ERP de filiais devem ser únicos em todo o sistema.",
      ),
  }),
  branchEmailAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este e-mail não está disponível para cadastro. Os e-mails de filiais devem ser únicos em todo o sistema.",
      ),
  }),

  // Grouping errors by route
  createBusinessErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este cnpj já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta razão social já foi cadastrada em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este código erp já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este e-mail já foi cadastrado em uma empresa!"),
    }),
    // Branch errors
    z.object({
      message: z
        .string()
        .default(
          "Esta razão social não está disponível para cadastro. As razões sociais de filiais devem ser únicas em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este CNPJ não está disponível para cadastro. Os CNPJs de filiais devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este código ERP não está disponível para cadastro. Os códigos ERP de filiais devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este e-mail não está disponível para cadastro. Os e-mails de filiais devem ser únicos em todo o sistema.",
        ),
    }),
  ]),
  listBusinessErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),
  updateBusinessErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Este cnpj já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta razão social já foi cadastrada em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este código erp já foi cadastrado em uma empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Este e-mail já foi cadastrado em uma empresa!"),
    }),
    // Branch errors
    z.object({
      message: z
        .string()
        .default(
          "Esta razão social não está disponível para cadastro. As razões sociais de filiais devem ser únicas em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este CNPJ não está disponível para cadastro. Os CNPJs de filiais devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este código ERP não está disponível para cadastro. Os códigos ERP de filiais devem ser únicos em todo o sistema.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Este e-mail não está disponível para cadastro. Os e-mails de filiais devem ser únicos em todo o sistema.",
        ),
    }),
  ]),
  deleteBusinessErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  // AI Limit responses
  aiLimitUpdated: z.object({
    message: z.string().default("Limite de análise IA atualizado com sucesso!"),
    data: z.object({
      id: z.string(),
      corporate_reason: z.string(),
      fantasy_name: z.string().nullable(),
      ai_analysis_limit: z.number(),
    }),
  }),
  vehicleLimitUpdated: z.object({
    message: z.string().default("Limite de veículos atualizado com sucesso!"),
    data: z.object({
      id: z.string(),
      corporate_reason: z.string(),
      fantasy_name: z.string().nullable(),
      vehicle_limit: z.number(),
    }),
  }),
  moduleImpactData: z.object({
    data: z.object({
      module: z.string(),
      records: z.array(z.object({ label: z.string(), count: z.number() })),
      affectedUsers: z.number(),
      inFlight: z.array(z.object({ label: z.string(), count: z.number() })),
    }),
  }),
  entitlementsData: z.object({
    data: z.object({
      modules: z.array(
        z.object({
          module: z.string().describe("FLEET | DELIVERIES"),
          enabled: z.boolean(),
        }),
      ),
      vehicle_limit: z
        .number()
        .describe("Nº de veículos contratados (0 = não configurado)."),
      vehicle_count: z
        .number()
        .describe("Veículos ativos (ocupando vaga do plano)."),
      vehicle_inactive_count: z
        .number()
        .describe("Veículos inativos (histórico preservado, sem ocupar vaga)."),
      vehicle_limit_enabled: z.boolean(),
    }),
  }),
  entitlementUpdated: z.object({
    message: z.string().default("Módulo da empresa atualizado com sucesso!"),
  }),
  aiUsageData: z.object({
    data: z.object({
      id: z.string(),
      corporate_reason: z.string(),
      fantasy_name: z.string().nullable(),
      ai_analysis_limit: z.number(),
      ai_analysis_used: z
        .number()
        .describe("Verificações concluídas no período (unidades consumidas)."),
      ai_analysis_in_progress: z
        .number()
        .describe(
          "Unidades reservadas por análises em andamento — voltam ao saldo se a análise falhar.",
        ),
      ai_analysis_reset_at: z.coerce.string().nullable(),
      ai_analysis_remaining: z.number(),
      ai_analysis_enabled: z.boolean(),
    }),
  }),
  aiLimitErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  // Two-step deletion flow
  businessDeletionCodeSent: z.object({
    message: z
      .string()
      .default(
        "Um código de confirmação foi enviado para o seu e-mail. O código expira em 5 minutos.",
      ),
  }),
  businessHasChildrenConflict: z.object({
    message: z
      .string()
      .default("Existem 2 filial(is) vinculada(s), 5 usuário(s) vinculado(s)."),
  }),
  requestBusinessDeletionErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar enviar o código de confirmação! Por favor, tente novamente.",
        ),
    }),
  ]),
  confirmBusinessDeletionErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Nenhuma solicitação de exclusão pendente. Solicite a exclusão novamente.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Código de confirmação expirado. Solicite a exclusão novamente para receber um novo código.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Código de confirmação inválido. Verifique e tente novamente.",
        ),
    }),
  ]),
};

export { businessSchemas, businessResponses };
