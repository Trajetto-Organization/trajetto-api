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
        issue_date: z.union([z.string(), z.date()]),
        due_date: z.union([z.string(), z.date()]),
        payment_date: z.union([z.string(), z.date()]).nullable(),
        amount: z.number(),
        amount_paid: z.number().nullable(),
        businessId: z.string(),
        branchId: z.string(),
        serviceOrderId: z.string().nullable(),
        registrationUserId: z.string(),
        created_at: z.union([z.string(), z.date()]),
        updated_at: z.union([z.string(), z.date()]),
        business: z
          .object({
            corporate_reason: z.string(),
          })
          .optional(), // Only for MASTER role
        branch: z
          .object({
            corporate_reason: z.string(),
            fantasy_name: z.string(),
          })
          .optional(),
        serviceOrder: z
          .object({
            id: z.string(),
            date: z.union([z.string(), z.date()]),
            maintenance_type: z.string(),
            vehicle: z.object({
              license_plate: z.string(),
              description: z.string(),
            }),
          })
          .nullable()
          .optional(),
        registrationUser: z
          .object({
            name: z.string(),
          })
          .optional(),
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
    message: z.string().default("Filial não encontrada."),
  }),
  serviceOrderNotFound: z.object({
    message: z.string().default("Ordem de serviço não encontrada!"),
  }),
  accountPayableInvalidAmount: z.object({
    message: z
      .string()
      .default("O valor pago não pode ser maior que o valor total da conta!"),
  }),

  // Grouping errors by route - CREATE (POST)
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
      message: z.string().default("Filial não encontrada."),
    }),
    z.object({
      message: z.string().default("Ordem de serviço não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default("O valor pago não pode ser maior que o valor total da conta!"),
    }),
  ]),

  // Forbidden errors for CREATE (status 403)
  createAccountPayableForbiddenErrors: z.union([
    z.object({
      message: z.string().default("Esta filial não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Esta ordem de serviço não pertence a esta empresa!"),
    }),
  ]),

  // LIST errors (GET)
  listAccountPayableErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  // UPDATE errors (PATCH) - status 400
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
      message: z.string().default("Filial não encontrada."),
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
      message: z.string().default("Usuário de registro não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "É necessário informar um valor pago ao registrar uma data de pagamento!",
        ),
    }),
  ]),

  // Forbidden errors for UPDATE (status 403)
  updateAccountPayableForbiddenErrors: z.union([
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
      message: z.string().default("Este usuário não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Você não tem permissão para transferir contas entre empresas!",
        ),
    }),
  ]),

  // DELETE errors (DELETE) - status 400
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
        .default("Não é possível excluir uma conta que já foi paga!"),
    }),
  ]),

  // Forbidden errors for DELETE (status 403)
  deleteAccountPayableForbiddenErrors: z.object({
    message: z
      .string()
      .default("Esta conta a pagar não pertence a esta empresa!"),
  }),
};

export { accountPayableSchemas, accountPayableResponses };
