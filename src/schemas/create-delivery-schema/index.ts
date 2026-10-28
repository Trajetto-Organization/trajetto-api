import { z } from "zod";
import {
  hasConsecutiveSpaces,
  hasSpaceAtEdges,
  isEmptyOrWhitespace,
} from "@/shared/utils/zod-schema-helpers";
import { dateOnlyField } from "@/shared/delivery/date-only-field";
import { optionalMultilineText } from "@/shared/delivery/text-rules";
import { WRITABLE_DELIVERY_KINDS } from "@/shared/delivery/delivery-kind";

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
  z.preprocess((val) => {
    if (typeof val === "string") {
      const digits = val.replace(/\D/g, "");
      return digits === "" ? null : digits;
    }

    return val;
  }, z.string().regex(pattern, message).nullable().optional());

/** The smallest quantity numeric(10, 3), rounding half up, keeps above 0. */
const MIN_STORED_QUANTITY = 0.0005;

const deliveryItemSchema = z.object({
  description: requiredTextField("A descrição do item", 2, 200),
  quantity: z.coerce
    .number()
    .positive("A quantidade deve ser maior que zero.")
    .max(999999, "A quantidade não pode exceder 999.999.")
    // Judged on what numeric(10, 3) will hold: 0.0004 passes `.positive()`
    // and is stored as 0.000. Postgres reads a float at 15 significant digits
    // and rounds half up, so the smallest quantity it keeps above zero is
    // 0.0005. A non-positive value is already reported above.
    .refine(
      (value) =>
        value <= 0 || Number(value.toPrecision(15)) >= MIN_STORED_QUANTITY,
      "A quantidade deve ser maior que zero.",
    )
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
  // The meeting of 14/10/2026: every new record has a type. Optional on the
  // wire so the callers written before it keep working; absent is DELIVERY
  // (the column default). On the edit, absent keeps the current type.
  kind: z
    .enum(WRITABLE_DELIVERY_KINDS, {
      errorMap: () => ({
        message:
          "Tipo inválido. Use DELIVERY (entrega) ou SERVICE_ORDER (ordem de serviço).",
      }),
    })
    .optional()
    .describe(
      "Tipo: DELIVERY (entrega, o padrão quando ausente) ou SERVICE_ORDER (ordem de serviço — uma parada para executar um serviço no endereço, como recolher cestos retornáveis; não é a ordem de serviço da frota).",
    ),
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
  // A day, not an instant (decision 1.3): "YYYY-MM-DD", stored as UTC midnight.
  scheduled_date: dateOnlyField("A data prevista").describe(
    "Data prevista (AAAA-MM-DD), sem hora.",
  ),
  // Multiline: blank lines between paragraphs are allowed (decision 5.5).
  notes: optionalMultilineText("As observações", 500),
  // No driverId/vehicleId (DLV-EDIT-4): putting a delivery in a driver's
  // hands is an assignment, which builds the route and its stop
  // (assign-deliveries). A field on this form bypassed both.
  // A list is cleared by sending it empty, not by sending null — nullable
  // here only exists for the scalar fields the edit form can blank out.
  items: z
    .array(deliveryItemSchema)
    .max(200, "Uma entrega não pode ter mais de 200 itens.")
    .optional(),
});

export { createDeliverySchema, deliveryItemSchema };
