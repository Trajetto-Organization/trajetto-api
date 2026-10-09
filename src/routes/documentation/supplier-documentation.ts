import { z } from "zod";

import { createSupplierSchema } from "@/schemas/create-supplier-schema";
import { updateSupplierSchema } from "@/schemas/update-supplier-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { listSupplierSchema } from "@/schemas/list-supplier-schema";

import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";
import { searchMetaDoc } from "@/shared/pagination/list-meta";

/**
 * Every error body the API sends: `code` is what a client branches on, and a
 * schema listing only `message` would strip it on the way out.
 */
const codedError = (description: string) =>
  z
    .object({
      code: z.string().optional(),
      message: z.string(),
      issues: z.array(z.string()).optional(),
    })
    .describe(description);

const supplierSchemas = {
  createSupplier: createSupplierSchema,
  listSupplier: listSupplierSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  updateSupplier: updateSupplierSchema,
  supplierParams: z.object({
    supplierId: z.string().uuid(),
    businessId: z.string().uuid(),
  }),
  searchSupplierCursor: cursorPaginationByBusinessSchema,
};

const supplierRow = z.object({
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
});

/** The list's `meta.searchMeta`, as summarizeSupplierList builds it. */
const supplierListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Fornecedores da busca e dos filtros (o cartão de total)."),
    withTelephone: z
      .number()
      .int()
      .describe("Dos quais com telefone cadastrado."),
    withEmail: z.number().int().describe("Dos quais com e-mail cadastrado."),
    topStates: z
      .string()
      .describe(
        'Os três estados com mais fornecedores na busca, ex.: "SP (12), MG (4)"; "N/A" sem nenhum.',
      ),
  },
  ["uf"],
);

const supplierResponses = {
  supplierCreated: z.object({
    message: z.string().default("Fornecedor criado com sucesso!"),
    id: z.string().uuid().describe("O ID do fornecedor criado."),
  }),

  supplierRow,


  supplierListSearchMeta: supplierListSearchMetaDoc,

  supplierUpdated: z.object({
    message: z.string().default("Fornecedor atualizado com sucesso!"),
  }),

  supplierDeleted: z.object({
    message: z.string().default("Fornecedor excluído com sucesso!"),
  }),

  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  createSupplierErrors: codedError(
    "VALIDATION_ERROR (com `issues`) ou empresa/usuário não encontrado.",
  ),

  listSupplierErrors: codedError(
    "VALIDATION_ERROR: ordenação ou filtro inválido (`sort` fora da lista, UF desconhecida). BUSINESS_NOT_IDENTIFIED: o MASTER não informou `businessId`.",
  ),

  searchSupplierErrors: codedError(
    "VALIDATION_ERROR (limite, cursor ou busca inválidos) ou empresa não encontrada.",
  ),

  updateSupplierErrors: codedError(
    "VALIDATION_ERROR (com `issues`) ou empresa/usuário não encontrado.",
  ),

  deleteSupplierErrors: codedError("Empresa ou usuário não encontrado."),

  supplierForbidden: codedError(
    "SUPPLIER_TENANT_MISMATCH: só para o MASTER, quando o fornecedor não é da empresa do caminho (fornecedor não muda de empresa). Para o usuário da empresa, o fornecedor de outra empresa responde 404 SUPPLIER_NOT_FOUND, como um id que não existe.",
  ),

  supplierNotFound: codedError(
    "SUPPLIER_NOT_FOUND (o fornecedor não existe ou é de outra empresa — a mesma resposta) ou USER_NOT_FOUND (o usuário da sessão não existe mais).",
  ),

  // Create, list and search look the session user up first.
  sessionUserNotFound: codedError(
    "USER_NOT_FOUND: o usuário da sessão não existe mais.",
  ),

  supplierConflict: codedError(
    "SUPPLIER_NAME_TAKEN, SUPPLIER_CNPJ_TAKEN ou SUPPLIER_EMAIL_TAKEN: já existe um fornecedor com o mesmo nome (sem diferenciar maiúsculas), CNPJ ou e-mail NESTA empresa. Outras empresas não contam nem são citadas.",
  ),

  supplierInUse: codedError(
    "SUPPLIER_IN_USE: o fornecedor está vinculado a ordens de serviço, peças ou contas a pagar; a mensagem traz as contagens. Excluí-lo apagaria o fornecedor desse histórico.",
  ),
};

export { supplierSchemas, supplierResponses };
