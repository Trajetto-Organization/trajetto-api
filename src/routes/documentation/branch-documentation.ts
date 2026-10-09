import { z } from "zod";

import { internalErrorResponse } from "./common-responses";

import { createBranchSchema } from "@/schemas/create-branch-schema";
import { updateBranchSchema } from "@/schemas/update-branch-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteBranchSchema } from "@/schemas/update-delete-branch-schema";

import { listBranchSchema } from "@/schemas/list-branch-schema";
import { cursorPaginationByBusinessSchema } from "@/schemas/cursor-pagination-schema";

import { confirmDeletionCodeSchema } from "@/schemas/confirm-deletion-code-schema";
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

const branchSchemas = {
  createBranch: createBranchSchema,
  listBranch: listBranchSchema,
  updateDeleteBranch: updateDeleteBranchSchema,
  updateBranch: updateBranchSchema,
  businessIdParam: updateDeleteBusinessSchema,
  searchBranchCursor: cursorPaginationByBusinessSchema,
  confirmDeletionCode: confirmDeletionCodeSchema,
};

const branchRow = z.object({
  id: z.string(),
  corporate_reason: z.string(),
  fantasy_name: z.string().nullable(),
  cep: z.string(),
  city: z.string(),
  uf: z.string(),
  street: z.string(),
  address_number: z.string(),
  cnpj: z.string(),
  complement: z.string().nullable(),
  cnae: z.string(),
  erp_code: z.string().nullable(),
  responsible_name: z.string(),
  telephone: z.string(),
  email: z.string(),
  is_active: z.boolean(),
  businessId: z.string(),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
});

/** The list's `meta.searchMeta`, as summarizeBranchList builds it. */
const branchListSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe("Filiais da busca e dos filtros (o cartão de total)."),
    active: z
      .number()
      .int()
      .describe(
        "Ativas, com a busca e o filtro de UF aplicados e sem o de situação (o cartão não zera ao escolher \"Inativa\").",
      ),
    withErpCode: z
      .number()
      .int()
      .describe("Das quais com código ERP cadastrado."),
    withFantasyName: z
      .number()
      .int()
      .describe("Das quais com nome fantasia (não vazio)."),
  },
  ["status", "uf"],
);

const branchResponses = {
  branchCreated: z.object({
    message: z.string().default("Filial criada com sucesso!"),
    id: z.string().uuid().describe("O ID da filial criada."),
  }),

  branchRow,

  branchListSearchMeta: branchListSearchMetaDoc,

  branchUpdated: z.object({
    message: z.string().default("Filial atualizada com sucesso!"),
  }),
  branchDeleted: z.object({
    message: z.string().default("Filial deletada com sucesso!"),
  }),
  branchToggled: z.object({
    message: z.string().default("Filial ativada com sucesso!"),
    is_active: z.boolean(),
  }),
  branchDeletionCodeSent: z.object({
    message: z
      .string()
      .default(
        "Um código de confirmação foi enviado para o seu e-mail. O código expira em 5 minutos.",
      ),
  }),

  internalServerError: internalErrorResponse,

  createBranchErrors: codedError("VALIDATION_ERROR (com `issues`)."),
  listBranchErrors: codedError(
    "VALIDATION_ERROR: ordenação ou filtro inválido (`sort` fora da lista, status ou UF desconhecidos). BUSINESS_NOT_IDENTIFIED: o MASTER não informou `businessId`.",
  ),
  searchBranchErrors: codedError(
    "VALIDATION_ERROR: limite, cursor ou busca inválidos.",
  ),
  updateBranchErrors: codedError("VALIDATION_ERROR (com `issues`)."),
  toggleBranchErrors: codedError("VALIDATION_ERROR: parâmetro inválido."),
  requestBranchDeletionErrors: codedError("VALIDATION_ERROR: parâmetro inválido."),
  confirmBranchDeletionErrors: codedError(
    "VALIDATION_ERROR: código ausente ou fora do formato. BRANCH_DELETION_CODE_INVALID: o código não confere. BRANCH_DELETION_CODE_EXPIRED: passaram os 5 minutos; peça a exclusão de novo para receber outro código.",
  ),
  /** The confirmation refusals that are about state, not input (decision 11.3). */
  branchDeletionConflict: codedError(
    "BRANCH_IN_USE: a filial tem veículos, motoristas, ordens de serviço, contas a pagar, multas, abastecimentos ou checklists; a mensagem traz as contagens. BRANCH_DELETION_NOT_REQUESTED: não há pedido de exclusão desta filial por este usuário — peça a exclusão (POST) antes de confirmar.",
  ),
  /** Routes without the tenant gate: the MASTER can name a missing company. */
  branchOrBusinessNotFound: codedError(
    "BRANCH_NOT_FOUND: a filial não existe nesta empresa (a de outra empresa responde igual, para não confirmar que o ID existe). BUSINESS_NOT_FOUND: o MASTER informou uma empresa que não existe.",
  ),

  branchForbidden: codedError(
    "TENANT_ACCESS_DENIED: a empresa do caminho não é a do usuário; PERMISSION_DENIED: o perfil não tem `branch_manage`.",
  ),
  branchNotFound: codedError(
    "BRANCH_NOT_FOUND: a filial não existe nesta empresa. A filial de outra empresa responde igual, para não confirmar que o ID existe.",
  ),
  branchConflict: codedError(
    "BRANCH_NAME_TAKEN, BRANCH_EMAIL_TAKEN ou BRANCH_ERP_CODE_TAKEN: já existe uma filial com a mesma razão social (sem diferenciar maiúsculas), e-mail ou código ERP NESTA empresa. BRANCH_CNPJ_UNAVAILABLE: o CNPJ, identidade nacional, já está cadastrado; a mensagem não diz onde. TOGGLE_CONFLICT: o status mudou enquanto a tela estava aberta.",
  ),
  branchInUse: codedError(
    "BRANCH_IN_USE: a filial tem veículos, motoristas, ordens de serviço, contas a pagar, multas, abastecimentos ou checklists; a mensagem traz as contagens.",
  ),
};

export { branchSchemas, branchResponses };
