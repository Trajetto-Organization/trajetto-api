import { z } from "zod";

import { createAccountPayableSchema } from "@/schemas/create-account-payable-schema";
import { listPagesSchema } from "@/schemas/list-pages-schema";

import { updateAccountPayableSchema } from "@/schemas/update-account-payable-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const accountPayableBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  accountPayableId: z.string().uuid("O ID da conta a pagar é obrigatório!"),
});

const accountPayableSchemas = {
  createAccountPayable: createAccountPayableSchema,
  listAccountPayable: listPagesSchema,
  updateAccountPayable: updateAccountPayableSchema,
  businessIdParam: updateDeleteBusinessSchema,
  accountPayableBusinessParams: accountPayableBusinessParams,
};

const accountPayableResponses = {
  accountPayableCreated: z.object({
    message: z.string().default("Conta a pagar criada com sucesso!"),
  }),

  accountPayableList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        issue_date: z.string(),
        due_date: z.string(),
        payment_date: z.string().nullable(),
        amount: z.string(),
        amount_paid: z.string().nullable(),
        businessId: z.string(),
        branchId: z.string(),
        branchName: z.string(),
        serviceOrderId: z.string().nullable(),
        serviceOrderDescription: z.string(),
        registrationUserId: z.string(),
        registrationUserName: z.string(),
        status: z.string(),
        remainingAmount: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
      }),
    ),
    total: z.number(),
  }),

  accountPayableUpdated: z.object({
    message: z.string().default("Conta a pagar atualizada com sucesso!"),
  }),

  accountPayableDeleted: z.object({
    message: z.string().default("Conta a pagar deletada com sucesso!"),
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

  accountPayableNotFound: z.object({
    message: z.string().default("Conta a pagar não encontrada!"),
  }),

  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),

  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada!"),
  }),

  serviceOrderNotFound: z.object({
    message: z.string().default("Ordem de serviço não encontrada!"),
  }),

  accountPayableInvalidAmount: z.object({
    message: z
      .string()
      .default("O valor pago não pode ser maior que o valor total da conta!"),
  }),

  // Grouping errors by route
  createAccountPayableErrors: z.union([
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
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("O valor pago não pode ser maior que o valor total da conta!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Usuário de registro não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Se há data de pagamento, deve haver valor pago e vice-versa. O valor pago não pode ser maior que o valor total.",
        ),
    }),
  ]),

  listAccountPayableErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Usuário não possui empresa associada!"),
    }),
  ]),

  updateAccountPayableErrors: z.union([
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
      message: z.string().default("Conta a pagar não encontrada!"),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("O valor pago não pode ser maior que o valor total da conta!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta conta a pagar não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "É necessário informar um valor pago ao registrar uma data de pagamento!",
        ),
    }),
  ]),

  deleteAccountPayableErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Conta a pagar não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta conta a pagar não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Não é possível excluir uma conta que já foi paga!"),
    }),
  ]),
};

export { accountPayableSchemas, accountPayableResponses };
