import { z } from "zod";

import { createSupplierSchema } from "@/schemas/create-supplier-schema";
import { updateSupplierSchema } from "@/schemas/update-supplier-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

const supplierSchemas = {
  createSupplier: createSupplierSchema,
  listSupplier: listPagesSchema,
  listSupplierBusiness: listPagesByBusinessSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  updateSupplier: updateSupplierSchema,
  supplierParams: z.object({
    supplierId: z.string().uuid(),
    businessId: z.string().uuid(),
  }),
  searchSupplierCursor: z.object({
    limit: z
      .string()
      .optional()
      .describe("Número máximo de fornecedores a retornar (padrão: 10)"),
    cursor: z
      .string()
      .optional()
      .describe("ID do último fornecedor da página anterior para paginação"),
    businessId: z.string().describe("ID da empresa"),
  }),
};

const supplierResponses = {
  supplierCreated: z.object({
    message: z.string().default("Fornecedor criado com sucesso!"),
  }),

  supplierList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        cnpj: z.string(),
        cep: z.string().nullable(),
        city: z.string().nullable(),
        uf: z.string().nullable(),
        street: z.string().nullable(),
        address_number: z.string().nullable(),
        complement: z.string().nullable(),
        telephone: z.string().nullable(),
        email: z.string().nullable(),
        businessId: z.string(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(),
      }),
    ),
    total: z.number(),
  }),

  supplierBusinessList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        cnpj: z.string(),
        cep: z.string().nullable(),
        city: z.string().nullable(),
        uf: z.string().nullable(),
        street: z.string().nullable(),
        address_number: z.string().nullable(),
        complement: z.string().nullable(),
        telephone: z.string().nullable(),
        email: z.string().nullable(),
        businessId: z.string(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
      }),
    ),
    total: z.number(),
  }),

  supplierUpdated: z.object({
    message: z.string().default("Fornecedor atualizado com sucesso!"),
  }),

  supplierDeleted: z.object({
    message: z.string().default("Fornecedor excluído com sucesso!"),
  }),

  searchSupplierStreamDescription: z.object({
    description: z
      .string()
      .default(
        "NDJSON stream. First line contains meta object with {nextCursor, hasMore}. Subsequent lines are supplier objects.",
      ),
  }),

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

  supplierNotFound: z.object({
    message: z
      .string()
      .default("Fornecedor não encontrado! Por favor, tente novamente."),
  }),

  nameAlreadyExists: z.object({
    message: z
      .string()
      .default("Já existe um fornecedor com este nome para esta empresa."),
  }),

  cnpjAlreadyExists: z.object({
    message: z.string().default("Já existe um fornecedor com este CNPJ."),
  }),

  emailAlreadyExists: z.object({
    message: z.string().default("Já existe um fornecedor com este e-mail."),
  }),

  createSupplierErrors: z.union([
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
        .default("Já existe um fornecedor com este nome para esta empresa."),
    }),
    z.object({
      message: z.string().default("Já existe um fornecedor com este CNPJ."),
    }),
    z.object({
      message: z.string().default("Já existe um fornecedor com este e-mail."),
    }),
  ]),

  listSupplierErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  listSupplierBusinessErrors: z.union([
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

  updateSupplierErrors: z.union([
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
        .default("Fornecedor não encontrado! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default("Já existe um fornecedor com este nome para esta empresa."),
    }),
    z.object({
      message: z.string().default("Já existe um fornecedor com este CNPJ."),
    }),
    z.object({
      message: z.string().default("Já existe um fornecedor com este e-mail."),
    }),
  ]),

  updateSupplierForbiddenErrors: z.object({
    message: z.string().default("Este fornecedor não pertence a esta empresa!"),
  }),

  deleteSupplierErrors: z.union([
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
        .default("Fornecedor não encontrado! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Não é possível excluir este fornecedor pois ele está sendo utilizado em outros registros.",
        ),
    }),
  ]),

  deleteSupplierForbiddenErrors: z.object({
    message: z.string().default("Este fornecedor não pertence a esta empresa!"),
  }),
};

export { supplierSchemas, supplierResponses };
