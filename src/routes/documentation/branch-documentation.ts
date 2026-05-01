import { z } from "zod";

import { createBranchSchema } from "@/schemas/create-branch-schema";
import { updateBranchSchema } from "@/schemas/update-branch-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { confirmDeletionCodeSchema } from "@/schemas/confirm-deletion-code-schema";

const branchSchemas = {
  createBranch: createBranchSchema,
  listBranch: listPagesSchema,
  listBranchBusiness: listPagesByBusinessSchema,
  updateDeleteBranch: updateDeleteBranchSchema,
  updateBranch: updateBranchSchema,
  businessIdParam: updateDeleteBusinessSchema,
  searchBranchCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de empresas a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID da última empresa da página anterior para paginação"),
    businessId: z.string().describe("ID da empresa"),
  }),
  confirmDeletionCode: confirmDeletionCodeSchema,
};

const branchResponses = {
  branchCreated: z.object({
    message: z.string().default("Filial criada com sucesso!"),
  }),
  branchList: z.object({
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
        businessId: z.string(),
        business_name: z.string().optional(),
      }),
    ),
    total: z.number(),
  }),
  branchBusinessList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        cnpj: z.string(),
        cep: z.string(),
        city: z.string(),
        uf: z.string(),
        street: z.string(),
        address_number: z.string(),
        complement: z.string(),
        telephone: z.string(),
        email: z.string(),
        businessId: z.string(),
        business_name: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    total: z.number(),
  }),
  branchUpdated: z.object({
    message: z.string().default("Filial atualizada com sucesso!"),
  }),
  branchDeleted: z.object({
    message: z.string().default("Filial deletada com sucesso!"),
  }),
  branchToggled: z.object({
    message: z.string().default("Status da filial atualizado com sucesso!"),
    is_active: z.boolean(),
  }),

  searchBranchStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {nextCursor, hasMore}. Subsequent lines are branch objects.",
      ),
  }),

  // Common Error Responses
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
  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada."),
  }),
  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  // Branch-specific errors (400)
  branchCnpjAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Este CNPJ não está disponível para cadastro. Os CNPJs de filiais devem ser únicos em todo o sistema.",
      ),
  }),
  branchCorporateReasonAlreadyExists: z.object({
    message: z
      .string()
      .default(
        "Esta razão social não está disponível para cadastro. As razões sociais de filiais devem ser únicas em todo o sistema.",
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

  // Business-specific errors (400) - thrown by branch controllers
  businessCnpjAlreadyExists: z.object({
    message: z.string().default("Este cnpj já foi cadastrado em uma empresa!"),
  }),
  businessCorporateReasonAlreadyExists: z.object({
    message: z
      .string()
      .default("Esta razão social já foi cadastrada em uma empresa!"),
  }),
  businessErpCodeAlreadyExists: z.object({
    message: z
      .string()
      .default("Este código erp já foi cadastrado em uma empresa!"),
  }),
  businessEmailAlreadyExists: z.object({
    message: z
      .string()
      .default("Este e-mail já foi cadastrado em uma empresa!"),
  }),

  // Forbidden errors (403)
  branchNotBelongBusiness: z.object({
    message: z.string().default("Esta filial não pertence a esta empresa!"),
  }),

  // Grouping errors by route
  createBranchErrors: z.union([
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
        .default("Empresa não encontrada! Por favor, tente novamente."),
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
          "Esta razão social não está disponível para cadastro. As razões sociais de filiais devem ser únicas em todo o sistema.",
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
  ]),
  listBranchErrors: z.union([
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
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),
  listBranchBusinessErrors: z.union([
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
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  // Update branch errors (400 only - 403 and 404 are separate)
  updateBranchErrors: z.union([
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
        .default(
          "Este CNPJ não está disponível para cadastro. Os CNPJs de filiais devem ser únicos em todo o sistema.",
        ),
    }),
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
  ]),

  // Update branch forbidden error (403)
  updateBranchForbidden: z.object({
    message: z.string().default("Esta filial não pertence a esta empresa!"),
  }),

  // Update branch not found error (404)
  updateBranchNotFound: z.object({
    message: z.string().default("Filial não encontrada."),
  }),

  // Delete branch errors (400 only - 403 and 404 are separate)
  deleteBranchErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),

  // Delete branch forbidden error (403)
  deleteBranchForbidden: z.object({
    message: z.string().default("Esta filial não pertence a esta empresa!"),
  }),

  // Delete branch not found error (404)
  deleteBranchNotFound: z.object({
    message: z.string().default("Filial não encontrada."),
  }),

  // Two-step deletion flow
  branchDeletionCodeSent: z.object({
    message: z
      .string()
      .default(
        "Um código de confirmação foi enviado para o seu e-mail. O código expira em 5 minutos.",
      ),
  }),
  branchHasChildrenConflict: z.object({
    message: z.string().default("Existem 3 veículo(s), 2 motorista(s)."),
  }),
  requestBranchDeletionErrors: z.union([
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
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar enviar o código de confirmação! Por favor, tente novamente.",
        ),
    }),
  ]),
  confirmBranchDeletionErrors: z.union([
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
        .default("Empresa não encontrada! Por favor, tente novamente."),
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

export { branchSchemas, branchResponses };
