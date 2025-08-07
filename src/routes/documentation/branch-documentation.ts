import { z } from "zod";

import { createBranchSchema } from "@/schemas/create-branch-schema";
import { updateBranchSchema } from "@/schemas/update-branch-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

const branchSchemas = {
  createBranch: createBranchSchema,
  listBranch: listPagesSchema,
  listBranchBusiness: listPagesByBusinessSchema,
  updateDeleteBranch: updateDeleteBranchSchema,
  updateBranch: updateBranchSchema,
  businessIdParam: updateDeleteBusinessSchema,
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
    message: z
      .string()
      .default("Filial não encontrada! Por favor, tente novamente."),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  cnpjAlreadyExists: z.object({
    message: z.string().default("Já existe uma filial com este CNPJ."),
  }),

  corporateReasonAlreadyExists: z.object({
    message: z.string().default("Filial já cadastrada."),
  }),

  erpCodeAlreadyExists: z.object({
    message: z.string().default("Já existe uma filial com este código ERP."),
  }),

  emailAlreadyExists: z.object({
    message: z.string().default("Este e-mail já foi cadastrado em uma filial!"),
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
      message: z.string().default("Já existe uma filial com este CNPJ."),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe uma filial cadastrada com esta razão social."),
    }),
    z.object({
      message: z.string().default("Já existe uma filial com este código ERP."),
    }),
    z.object({
      message: z
        .string()
        .default("Este e-mail já foi cadastrado em uma filial!"),
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

  updateBranchErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Filial não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Já existe uma filial com este CNPJ."),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe uma filial cadastrada com esta razão social."),
    }),
    z.object({
      message: z.string().default("Já existe uma filial com este código ERP."),
    }),
    z.object({
      message: z
        .string()
        .default("Este e-mail já foi cadastrado em uma filial!"),
    }),
  ]),

  deleteBranchErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
    z.object({
      message: z.string().default("Filial já cadastrada."),
    }),
  ]),
};

export { branchSchemas, branchResponses };
