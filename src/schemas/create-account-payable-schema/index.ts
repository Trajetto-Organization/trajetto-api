import { z } from "zod";
import { AccountPayableCategory } from "@prisma/client";

import {
  emptyStringToNull,
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isValidDateString,
} from "@/shared/utils/zod-schema-helpers";
import { optionalMultilineText } from "@/shared/delivery/text-rules";
import { dateOnlyFromKey } from "@/shared/time/business-day";

/**
 * The bill's fields, as the form sends them. Mirrored by the web's
 * schemas/create-update-account-payable-schema (same limits, same messages).
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day: 2026-02-30 is refused, not rolled over. */
function isCalendarDay(key: string): boolean {
  try {
    dateOnlyFromKey(key);
    return true;
  } catch {
    return false;
  }
}

/** A day ("YYYY-MM-DD", what the form sends) or, from older clients, an ISO instant. */
function billDate(label: string) {
  return z
    .string()
    .min(1, `${label} é obrigatória.`)
    .refine(
      (value) =>
        DATE_ONLY.test(value) ? isCalendarDay(value) : isValidDateString(value),
      `${label} inválida.`,
    )
    .describe(`${label}: AAAA-MM-DD (um dia, no fuso da empresa).`);
}

/** A single-line optional text: empty is absent, no edge or repeated spaces. */
function optionalLine(label: string, max: number) {
  return z.preprocess(
    emptyStringToNull,
    z
      .string()
      .max(max, `${label} deve ter no máximo ${max} caracteres.`)
      .superRefine((value, ctx) => {
        if (hasConsecutiveSpaces(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não deve conter espaços consecutivos.`,
          });

          return;
        }

        if (hasSpaceAtEdges(value)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${label} não pode começar ou terminar com espaço em branco.`,
          });
        }
      })
      .optional()
      .nullable(),
  );
}

const optionalId = (message: string) =>
  z.preprocess(
    emptyStringToNull,
    z.string().uuid(message).optional().nullable(),
  );

const accountPayableFields = {
  category: z
    .nativeEnum(AccountPayableCategory, {
      errorMap: () => ({ message: "Categoria da conta inválida." }),
    })
    .describe(
      "Categoria/tipo da conta (FUEL, MAINTENANCE, INSURANCE, TAXES_FEES, FINES, TOLLS, RENTAL, PAYROLL, OTHER). Com OTHER, category_description é obrigatória.",
    ),
  category_description: optionalLine("A descrição da categoria", 120).describe(
    "Descrição livre da categoria — usada quando category = OTHER.",
  ),
  due_date: billDate("Data de vencimento"),
  payment_date: z.preprocess(
    emptyStringToNull,
    billDate("Data de pagamento").optional().nullable(),
  ),
  amount: z
    .number({ invalid_type_error: "O valor deve ser numérico." })
    .positive("O valor deve ser um valor positivo.")
    .min(1, "O valor deve ser no mínimo R$ 1,00")
    .max(9999999.99, "O valor não pode exceder R$ 9.999.999,99."),
  amount_paid: z
    .number({ invalid_type_error: "O valor pago deve ser numérico." })
    .nonnegative("O valor pago deve ser um valor não negativo.")
    .min(1, "O valor pago deve ser no mínimo R$ 1,00")
    .max(9999999.99, "O valor pago não pode exceder R$ 9.999.999,99.")
    .optional()
    .nullable(),
  branchId: z
    .string({ required_error: "ID da filial é obrigatória!" })
    .uuid("ID da filial é inválido."),
  serviceOrderId: optionalId("ID da ordem de serviço é inválido."),
  registrationUserId: z
    .string({ required_error: "ID do usuário responsável é obrigatório!" })
    .uuid("ID do usuário responsável é inválido.")
    .describe(
      "O responsável pela conta, avisado da criação; pode ser um motorista, que vê as suas.",
    ),
  supplierId: optionalId("ID do fornecedor é inválido.").describe(
    "Favorecido cadastrado (fornecedor). Informe ele OU payee_name.",
  ),
  payee_name: optionalLine("O nome do favorecido", 120).describe(
    "Favorecido sem cadastro (pedágio, prestador avulso). Informe ele OU supplierId.",
  ),
  vehicleId: optionalId("ID do veículo é inválido.").describe(
    "Veículo que carrega o custo (centro de custo).",
  ),
  description: optionalMultilineText("A descrição", 500).describe(
    "Do que se trata a conta; aceita quebras de linha.",
  ),
  document_number: optionalLine("O número do documento", 60).describe(
    "Número da nota, boleto ou fatura.",
  ),
};

type PaymentShape = {
  payment_date?: string | null;
  amount_paid?: number | null;
  amount?: number;
};

const paymentConsistent = (data: PaymentShape) => {
  if (data.payment_date && !data.amount_paid) return false;
  if (data.amount_paid && !data.payment_date) return false;

  return !(
    data.amount_paid &&
    data.amount !== undefined &&
    data.amount_paid > data.amount
  );
};

const PAYMENT_MESSAGE =
  "Se há data de pagamento, deve haver valor pago e vice-versa. O valor pago não pode ser maior que o valor total.";

const ONE_PAYEE_MESSAGE =
  "Informe o fornecedor cadastrado ou o nome do favorecido, não os dois.";

const createAccountPayableSchema = z
  .object(accountPayableFields)
  .refine(paymentConsistent, {
    message: PAYMENT_MESSAGE,
    path: ["amount_paid"],
  })
  .refine(
    (data) => data.category !== "OTHER" || Boolean(data.category_description),
    {
      message: 'Descreva a categoria ao selecionar "Outros".',
      path: ["category_description"],
    },
  )
  // Decision 8.4: a bill says who is paid — a supplier or a name.
  .refine((data) => Boolean(data.supplierId) || Boolean(data.payee_name), {
    message: "Informe o favorecido: um fornecedor cadastrado ou um nome.",
    path: ["payee_name"],
  })
  .refine((data) => !(data.supplierId && data.payee_name), {
    message: ONE_PAYEE_MESSAGE,
    path: ["payee_name"],
  })
  // A description for a named category is stale text waiting to mislead.
  .transform((data) =>
    data.category === "OTHER" ? data : { ...data, category_description: null },
  );

export {
  ONE_PAYEE_MESSAGE,
  PAYMENT_MESSAGE,
  accountPayableFields,
  createAccountPayableSchema,
  paymentConsistent,
};
