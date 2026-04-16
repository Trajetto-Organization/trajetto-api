import { z } from "zod";

import { createBusinessSchema } from "@/schemas/create-business-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { updateBusinessSchema } from "@/schemas/update-business-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { updateAILimitSchema } from "@/schemas/update-ai-limit-schema";

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
  }),
  updateDeleteBusiness: updateDeleteBusinessSchema,
  updateBusiness: updateBusinessSchema,
  updateAILimit: updateAILimitSchema,
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
      ai_analysis_used: z.number(),
      ai_analysis_reset_at: z.coerce.string().nullable(),
    }),
  }),
  aiUsageData: z.object({
    data: z.object({
      id: z.string(),
      corporate_reason: z.string(),
      fantasy_name: z.string().nullable(),
      ai_analysis_limit: z.number(),
      ai_analysis_used: z.number(),
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
};

export { businessSchemas, businessResponses };
