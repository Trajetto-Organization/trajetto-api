import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";

const requiredTextField = (label: string, min: number, max: number) =>
  z
    .string()
    .min(min, `${label} deve ter no mínimo ${min} caracteres.`)
    .max(max, `${label} deve ter no máximo ${max} caracteres.`)
    .superRefine((value, ctx) => {
      if (isEmptyOrWhitespace(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${label} não pode conter apenas espaços.`,
        });

        return;
      }

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
    });

const optionalTextField = (label: string, max: number) =>
  z.preprocess(
    (val) => (val === "" ? null : val),
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
      .nullable()
      .optional(),
  );

const optionalDigits = (label: string, pattern: RegExp, message: string) =>
  z.preprocess(
    (val) => {
      if (typeof val === "string") {
        const digits = val.replace(/\D/g, "");
        return digits === "" ? null : digits;
      }

      return val;
    },
    z.string().regex(pattern, message).nullable().optional(),
  );

const deliveryItemSchema = z.object({
  description: requiredTextField("A descrição do item", 2, 200),
  quantity: z.coerce
    .number()
    .positive("A quantidade deve ser maior que zero.")
    .max(999999, "A quantidade não pode exceder 999.999.")
    .default(1),
  unit: optionalTextField("A unidade", 20),
  unit_value: z.coerce
    .number()
    .nonnegative("O valor unitário não pode ser negativo.")
    .max(99999999, "O valor unitário excede o limite.")
    .nullable()
    .optional(),
});

const createDeliverySchema = z.object({
  shipperId: z.string().min(1, "O embarcador é obrigatório."),
  code: optionalTextField("O código do pedido", 60),
  invoice_key: z.preprocess(
    (val) => {
      if (typeof val === "string") {
        const digits = val.replace(/\D/g, "");
        return digits === "" ? null : digits;
      }

      return val;
    },
    z
      .string()
      .length(44, "A chave da NF-e deve ter exatamente 44 dígitos.")
      .regex(/^\d{44}$/, "A chave da NF-e deve conter apenas números.")
      .nullable()
      .optional()
      .describe("Chave de acesso da NF-e — âncora de dedupe do import."),
  ),
  invoice_number: optionalTextField("O número da nota", 20),
  recipient_name: requiredTextField("O nome do destinatário", 2, 150),
  recipient_document: optionalDigits(
    "O documento do destinatário",
    /^(\d{11}|\d{14})$/,
    "O documento deve ser um CPF (11 dígitos) ou CNPJ (14 dígitos).",
  ),
  recipient_email: z.preprocess(
    (val) => (val === "" ? null : val),
    z
      .string()
      .email("O e-mail do destinatário não é válido.")
      .max(100, "O e-mail deve ter no máximo 100 caracteres.")
      .nullable()
      .optional(),
  ),
  recipient_telephone: optionalDigits(
    "O telefone do destinatário",
    /^\d{10,11}$/,
    "O telefone deve conter 10 ou 11 dígitos numéricos incluindo o DDD.",
  ),
  // Required on manual entry, like every other address form: the route is
  // built from this address. Imported NFe deliveries never pass through this
  // schema — a note may legitimately omit the CEP, so the column stays
  // nullable and the importer writes what the note had.
  cep: z.preprocess(
    (val) => (typeof val === "string" ? val.replace(/\D/g, "") : val),
    z
      .string()
      .length(8, "O CEP deve ter exatamente 8 dígitos.")
      .regex(/^\d{8}$/, "O CEP deve conter apenas números."),
  ),
  city: requiredTextField("A cidade", 2, 100),
  uf: z
    .string()
    .length(2, "UF deve ter exatamente 2 caracteres.")
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "UF deve conter apenas letras."),
  street: requiredTextField("A rua", 2, 150),
  address_number: optionalTextField("O número do endereço", 10),
  complement: optionalTextField("O complemento", 50),
  neighborhood: optionalTextField("O bairro", 100),
  scheduled_date: z.preprocess(
    (val) => (val === "" || val === null ? null : val),
    z.coerce.date().nullable().optional(),
  ),
  notes: optionalTextField("As observações", 500),
  vehicleId: z.preprocess(
    (val) => (val === "" ? null : val),
    z.string().nullable().optional(),
  ),
  driverId: z.preprocess(
    (val) => (val === "" ? null : val),
    z.string().nullable().optional(),
  ),
  // A list is cleared by sending it empty, not by sending null — nullable
  // here only exists for the scalar fields the edit form can blank out.
  items: z
    .array(deliveryItemSchema)
    .max(200, "Uma entrega não pode ter mais de 200 itens.")
    .optional(),
});

export { createDeliverySchema, deliveryItemSchema };
