import { z } from "zod";

import { internalErrorResponse } from "./common-responses";

import { createAccountPayableSchema } from "@/schemas/create-account-payable-schema";
import { updateAccountPayableSchema } from "@/schemas/update-account-payable-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { cursorPaginationSchema } from "@/schemas/cursor-pagination-schema";

import {
  exportAccountPayableSchema,
  listAccountPayableSchema,
} from "@/schemas/list-account-payable-schema";
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

const accountPayableBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  accountPayableId: z.string().uuid("O ID da conta a pagar é obrigatório!"),
});

const accountPayableSchemas = {
  createAccountPayable: createAccountPayableSchema,
  listAccountPayable: listAccountPayableSchema,
  exportAccountPayable: exportAccountPayableSchema,
  updateAccountPayable: updateAccountPayableSchema,
  businessIdParam: updateDeleteBusinessSchema,
  accountPayableBusinessParams: accountPayableBusinessParams,
  searchAccountPayableCursor: cursorPaginationSchema,
};

const namedRef = (fields: z.ZodRawShape) =>
  z.object(fields).nullable().optional();

/** A bill as every read returns it: its columns, the names, the situation. */
const accountPayableRow = z.object({
  id: z.string(),
  issue_date: z.union([z.string(), z.date()]),
  due_date: z
    .union([z.string(), z.date()])
    .describe(
      "Instante em que começa o dia do vencimento, no fuso da empresa.",
    ),
  payment_date: z.union([z.string(), z.date()]).nullable(),
  amount: z.number(),
  amount_paid: z.number().nullable(),
  category: z
    .string()
    .nullable()
    .describe("Categoria da conta (enum AccountPayableCategory)."),
  category_description: z
    .string()
    .nullable()
    .describe("Descrição livre quando category = OTHER."),
  businessId: z.string(),
  branchId: z.string(),
  serviceOrderId: z.string().nullable(),
  registrationUserId: z
    .string()
    .describe("O responsável pela conta (pode ser um motorista)."),
  supplierId: z.string().nullable().describe("Favorecido cadastrado."),
  payee_name: z.string().nullable().describe("Favorecido sem cadastro."),
  vehicleId: z.string().nullable().describe("Veículo (centro de custo)."),
  description: z.string().nullable(),
  document_number: z.string().nullable(),
  createdById: z
    .string()
    .nullable()
    .describe("Quem registrou; nulo em contas antigas."),
  created_at: z.union([z.string(), z.date()]),
  updated_at: z.union([z.string(), z.date()]),
  branch: namedRef({
    id: z.string(),
    corporate_reason: z.string(),
    fantasy_name: z.string().nullable(),
  }),
  serviceOrder: namedRef({
    id: z.string(),
    date: z.union([z.string(), z.date()]),
    maintenance_type: z.string(),
    vehicle: z.object({
      license_plate: z.string(),
      description: z.string(),
    }),
  }),
  registrationUser: namedRef({ id: z.string(), name: z.string() }),
  createdBy: namedRef({ id: z.string(), name: z.string() }),
  supplier: namedRef({ id: z.string(), name: z.string() }),
  vehicle: namedRef({
    id: z.string(),
    license_plate: z.string(),
    description: z.string(),
  }),
  status: z
    .enum(["PENDING", "PARTIAL", "OVERDUE", "PARTIAL_LATE", "PAID", "LATE"])
    .describe(
      "Calculado pelo dia de negócio da empresa: vence só DEPOIS do dia do vencimento. LATE = quitada depois do dia do vencimento.",
    ),
  status_group: z
    .enum(["OPEN", "OVERDUE", "PAID"])
    .describe("A situação dos cartões e do filtro `status`."),
  due_day: z
    .string()
    .describe(
      "AAAA-MM-DD do vencimento no fuso da empresa: mostre como dia, sem hora.",
    ),
  payment_day: z.string().nullable().describe("AAAA-MM-DD do pagamento."),
  remaining_amount: z.number().describe("Valor − valor pago, nunca negativo."),
});

/** The list's `meta.searchMeta`, as summarizeAccountPayableList builds it. */
const accountPayableSearchMetaDoc = searchMetaDoc(
  {
    total: z
      .number()
      .int()
      .describe(
        "Contas da busca e dos demais filtros, sem o de situação (a soma dos três cartões).",
      ),
    open: z
      .number()
      .int()
      .describe("Em aberto: não quitadas, vencimento hoje ou depois."),
    overdue: z
      .number()
      .int()
      .describe("Vencidas: não quitadas, dia do vencimento já passou."),
    paid: z.number().int().describe("Quitadas (inclui as pagas com atraso)."),
    openAmount: z.number().describe("Quanto falta pagar nas contas em aberto."),
    overdueAmount: z
      .number()
      .describe("Quanto falta pagar nas contas vencidas."),
    paidAmount: z.number().describe("Quanto foi pago nas contas quitadas."),
  },
  ["status"],
);

const accountPayableResponses = {
  accountPayableRow,
  accountPayableSearchMeta: accountPayableSearchMetaDoc,

  accountPayableCreated: z.object({
    message: z.string().default("Conta a pagar criada com sucesso!"),
    id: z.string().uuid().describe("O ID da conta criada."),
    warnings: z
      .array(z.string())
      .describe(
        "Avisos que não impedem a gravação, como a soma das contas de uma ordem de serviço acima do total dela.",
      ),
  }),
  accountPayableUpdated: z.object({
    message: z.string().default("Conta a pagar atualizada com sucesso!"),
    warnings: z
      .array(z.string())
      .describe("Avisos que não impedem a gravação."),
  }),
  accountPayableDeleted: z.object({
    message: z.string().default("Conta a pagar deletada com sucesso!"),
  }),

  internalServerError: internalErrorResponse,

  writeErrors: codedError(
    "VALIDATION_ERROR (com `issues`: favorecido ausente ou duplo, datas, valores, textos). ACCOUNT_PAYABLE_INVALID_REFERENCE: filial, ordem de serviço, fornecedor, veículo ou responsável não encontrado NESTA empresa (a resposta é a mesma quando o registro é de outra empresa). ACCOUNT_PAYABLE_INVALID_AMOUNT, ACCOUNT_PAYABLE_PAYMENT_REQUIRED: valor pago acima do total, ou data de pagamento sem valor pago. ACCOUNT_PAYABLE_PAYEE_REQUIRED (edição): a conta já tem favorecido e a alteração o deixaria vazio.",
  ),
  listErrors: codedError(
    "VALIDATION_ERROR: ordenação ou filtro inválido. BUSINESS_NOT_IDENTIFIED: o MASTER não informou `businessId`.",
  ),
  exportErrors: codedError(
    "VALIDATION_ERROR, BUSINESS_NOT_IDENTIFIED, ou ACCOUNT_PAYABLE_NOTHING_TO_EXPORT: nenhuma conta com a busca e os filtros.",
  ),
  searchErrors: codedError(
    "VALIDATION_ERROR: limite, cursor ou busca inválidos.",
  ),
  deleteErrors: codedError("Empresa ou usuário não encontrado."),
  forbidden: codedError(
    "ACCOUNT_PAYABLE_TENANT_MISMATCH: só para o MASTER, quando a conta não é da empresa do caminho (conta não muda de empresa). Para o usuário da empresa, a conta de outra empresa responde 404 ACCOUNT_PAYABLE_NOT_FOUND, como um id que não existe.",
  ),
  notFound: codedError(
    "ACCOUNT_PAYABLE_NOT_FOUND: a conta não existe ou é de outra empresa — a mesma resposta. TENANT_NOT_FOUND: a empresa não existe.",
  ),
  alreadyPaid: codedError(
    "ACCOUNT_PAYABLE_ALREADY_PAID: conta com pagamento registrado não é excluída (inclusive quando o pagamento chegou durante a exclusão).",
  ),
};

export { accountPayableSchemas, accountPayableResponses };
