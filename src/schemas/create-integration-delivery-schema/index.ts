import { z, ZodError } from "zod";

import { createDeliverySchema } from "@/schemas/create-delivery-schema";
import { isValidCnpj } from "@/shared/delivery/cnpj";

/**
 * The body of POST /integration/v1/deliveries (decision 5.10).
 *
 * The manual create's fields, with the manual create's rules — the SAME zod
 * definitions, not copies — so a delivery that the panel refuses the API
 * refuses too, with the same sentence. Only two things differ, and both are
 * about who is on the other side:
 *
 *   - the shipper can be named by CNPJ. An ERP knows its shippers by the NF-e
 *     issuer's CNPJ; our shipper id is something no public endpoint hands out.
 *   - unknown fields are refused instead of dropped, in the body and in each
 *     item. A person cannot misspell a form field; an integration can, and
 *     `adress_number` silently ignored is an address nobody notices is
 *     missing until the driver is lost.
 */
const manualFields = createDeliverySchema.omit({
  shipperId: true,
  items: true,
}).shape;

/**
 * The manual item list, closed to unknown fields like the body. The manual
 * list's own item rules and its own limit (value and sentence) are reused;
 * only `.strict()` is added — a `unitValue` silently dropped is a price
 * nobody notices is missing.
 */
const manualItemList = createDeliverySchema.shape.items.unwrap();

const itemLimit = manualItemList._def.maxLength;

const strictItemList = z.array(manualItemList.element.strict());

const itemList = itemLimit
  ? strictItemList.max(itemLimit.value, itemLimit.message)
  : strictItemList;

/**
 * "" (or blanks) is an absent field, as on the manual create: ERPs serialise
 * an empty column as "". Without this, `shipper_id` next to `shipper_cnpj: ""`
 * was refused for naming the shipper twice.
 */
function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

const shipperIdField = z.preprocess(
  (value) => (isBlank(value) ? null : value),
  z
    .string({ invalid_type_error: "deve ser um texto." })
    .uuid("deve ser o id (UUID) de um embarcador da sua empresa.")
    .nullish(),
);

const shipperCnpjField = z.preprocess(
  (value) => {
    if (isBlank(value)) return null;

    return typeof value === "string" ? value.replace(/\D/g, "") : value;
  },
  z
    .string({ invalid_type_error: "deve ser um texto com o CNPJ." })
    .length(14, "O CNPJ do embarcador deve ter 14 dígitos.")
    // The same check digits the shipper form applies (decision 5.7).
    .refine(isValidCnpj, "O CNPJ do embarcador não é válido.")
    .nullish(),
);

const createIntegrationDeliverySchema = z
  .object({
    shipper_id: shipperIdField.describe(
      "Id do embarcador no Trajetto. Informe este OU `shipper_cnpj`, nunca os dois.",
    ),

    shipper_cnpj: shipperCnpjField.describe(
      "CNPJ do embarcador (com ou sem máscara), como cadastrado no Trajetto. Informe este OU `shipper_id`.",
    ),

    ...manualFields,

    // The same rules; only the description. The schema publishes the cleaned
    // value (`^\d{8}$`…), while the API also accepts masks and a lower-case
    // UF: a strict generated client must not refuse what the API takes.
    cep: manualFields.cep.describe(
      "CEP com 8 dígitos, com ou sem máscara (13010-000 ou 13010000); publicado sem.",
    ),
    recipient_document: manualFields.recipient_document.describe(
      "CPF (11 dígitos) ou CNPJ (14 dígitos) do destinatário, com ou sem máscara; publicado sem. Opcional.",
    ),
    recipient_telephone: manualFields.recipient_telephone.describe(
      "Telefone com DDD, 10 ou 11 dígitos, com ou sem máscara; publicado sem. Opcional.",
    ),
    uf: manualFields.uf.describe(
      "UF com 2 letras; aceita minúsculas e grava em maiúsculas (sp vira SP).",
    ),

    // `null` reads as "no items" here: ERPs serialise absent lists as null.
    items: z
      .preprocess(
        (value) => (value === null ? undefined : value),
        itemList.optional(),
      )
      .describe("Itens da carga, até 200. Opcional."),
  })
  .strict()
  .superRefine((body, ctx) => {
    const named = [body.shipper_id, body.shipper_cnpj].filter(
      (value) => value !== undefined && value !== null,
    ).length;

    if (named === 1) return;

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shipper_id"],
      message:
        named === 0
          ? "informe o embarcador por shipper_id ou por shipper_cnpj."
          : "informe o embarcador por shipper_id OU por shipper_cnpj, não pelos dois.",
    });
  });

type CreateIntegrationDeliveryBody = z.infer<
  typeof createIntegrationDeliverySchema
>;

const TYPE_NAMES: Record<string, string> = {
  string: "texto",
  number: "número",
  integer: "número inteiro",
  boolean: "verdadeiro ou falso",
  array: "lista",
  object: "objeto",
  null: "null",
  date: "data",
};

/**
 * Portuguese for the sentences zod would otherwise write in English.
 *
 * Only the issues that carry no message of their own reach here: every rule
 * of the manual create already says its sentence, and it wins. What is left
 * is the generic "Required" and "Expected string, received number" — which,
 * without the field in front, told an integrator nothing at all.
 */
const integrationErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    // The body itself: nothing, or something that is not an object.
    if (issue.path.length === 0) {
      return { message: "envie um objeto JSON com os campos da entrega." };
    }

    if (issue.received === "undefined")
      return { message: "campo obrigatório." };

    return {
      message: `esperado ${TYPE_NAMES[issue.expected] ?? issue.expected}, recebido ${TYPE_NAMES[issue.received] ?? issue.received}.`,
    };
  }

  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return {
      message: `${issue.keys.length === 1 ? "campo não reconhecido" : "campos não reconhecidos"}: ${issue.keys.join(", ")}. Confira os nomes na documentação.`,
    };
  }

  return { message: ctx.defaultError };
};

/** `items.0.description`, or "corpo" for the body itself. */
function issuePath(path: Array<string | number>): string {
  return path.length === 0 ? "corpo" : path.join(".");
}

/**
 * Parses the body, or throws the ZodError the error handler turns into
 * 400 VALIDATION_ERROR — with each sentence prefixed by the field it is
 * about. The handler publishes `issues` as sentences only; "O CEP deve ter 8
 * dígitos" is enough on a form, where the red field is right there, and not
 * enough in an ERP's log.
 */
function parseIntegrationDeliveryBody(
  body: unknown,
): CreateIntegrationDeliveryBody {
  const parsed = createIntegrationDeliverySchema.safeParse(body, {
    errorMap: integrationErrorMap,
  });

  if (parsed.success) return parsed.data;

  throw new ZodError(
    parsed.error.issues.map((issue) => ({
      ...issue,
      message: `${issuePath(issue.path)}: ${issue.message}`,
    })),
  );
}

export {
  createIntegrationDeliverySchema,
  integrationErrorMap,
  parseIntegrationDeliveryBody,
};
export type { CreateIntegrationDeliveryBody };
