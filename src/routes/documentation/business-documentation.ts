import { z } from "zod";

import { createBusinessSchema } from "@/schemas/create-business-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { updateBusinessSchema } from "@/schemas/update-business-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const businessSchemas = {
  createBusiness: createBusinessSchema,
  listBusiness: listPagesSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  updateBusiness: updateBusinessSchema,
};

const businessResponses = {
  businessCreated: z.object({
    message: z.string().default("Empresa criada com sucesso!"),
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

  // Respostas de erro comum
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
  ]),

  deleteBusinessErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Empresa não encontrada!"),
    }),
  ]),
};

export { businessSchemas, businessResponses };
