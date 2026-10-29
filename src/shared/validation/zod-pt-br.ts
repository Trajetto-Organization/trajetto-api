import { z, type ZodErrorMap } from "zod";

/**
 * zod's default sentences in pt-BR.
 *
 * Fields without a message of their own reached the clients as "Required" or
 * "Expected boolean, received string", inside a body whose message was the
 * English "Validation Error"; the web and the app showed them as they came.
 * A schema's own message still wins: zod asks this map only for the default.
 */

const TYPE_NAMES: Record<string, string> = {
  string: "um texto",
  number: "um número",
  integer: "um número inteiro",
  float: "um número",
  boolean: "verdadeiro ou falso",
  date: "uma data",
  array: "uma lista",
  object: "um objeto",
  null: "nulo",
  undefined: "ausente",
  bigint: "um número inteiro",
  nan: "um número válido",
};

/** `"pageSize"`, `"items.2.name"`; null for a value at the root. */
function fieldOf(path: (string | number)[]): string | null {
  return path.length > 0 ? path.join(".") : null;
}

function subject(path: (string | number)[]): string {
  const field = fieldOf(path);

  return field ? `O campo "${field}"` : "O valor";
}

const ptBrErrorMap: ZodErrorMap = (issue, ctx) => {
  const who = subject(issue.path);

  switch (issue.code) {
    case z.ZodIssueCode.invalid_type:
      if (issue.received === "undefined")
        return { message: `${who} é obrigatório.` };

      return {
        message: `${who} deve ser ${TYPE_NAMES[issue.expected] ?? issue.expected}.`,
      };

    case z.ZodIssueCode.invalid_literal:
    case z.ZodIssueCode.invalid_enum_value:
    case z.ZodIssueCode.invalid_union:
    case z.ZodIssueCode.invalid_union_discriminator:
      return { message: `${who} tem um valor não aceito.` };

    case z.ZodIssueCode.unrecognized_keys:
      return { message: `Campos não aceitos: ${issue.keys.join(", ")}.` };

    case z.ZodIssueCode.invalid_date:
      return { message: `${who} deve ser uma data válida.` };

    case z.ZodIssueCode.invalid_string:
      return { message: `${who} está em um formato inválido.` };

    case z.ZodIssueCode.too_small:
      if (issue.type === "string") {
        return {
          message: `${who} deve ter ao menos ${issue.minimum} caractere(s).`,
        };
      }

      if (issue.type === "array" || issue.type === "set") {
        return {
          message: `${who} deve ter ao menos ${issue.minimum} item(ns).`,
        };
      }

      return {
        message: `${who} deve ser ${issue.inclusive ? "no mínimo" : "maior que"} ${issue.minimum}.`,
      };

    case z.ZodIssueCode.too_big:
      if (issue.type === "string") {
        return {
          message: `${who} deve ter no máximo ${issue.maximum} caractere(s).`,
        };
      }

      if (issue.type === "array" || issue.type === "set") {
        return {
          message: `${who} deve ter no máximo ${issue.maximum} item(ns).`,
        };
      }

      return {
        message: `${who} deve ser ${issue.inclusive ? "no máximo" : "menor que"} ${issue.maximum}.`,
      };

    case z.ZodIssueCode.not_multiple_of:
      return { message: `${who} deve ser múltiplo de ${issue.multipleOf}.` };

    case z.ZodIssueCode.not_finite:
      return { message: `${who} deve ser um número finito.` };

    case z.ZodIssueCode.custom:
      return { message: `${who} é inválido.` };

    default:
      return { message: ctx.defaultError };
  }
};

let installed = false;

/** Installs the map once per process; the HTTP entry calls it at import. */
function installPtBrZodErrors(): void {
  if (installed) return;

  z.setErrorMap(ptBrErrorMap);
  installed = true;
}

/** The pt-BR sentence a 400 VALIDATION_ERROR carries as its `message`. */
const GENERIC_VALIDATION_MESSAGE = "Os dados enviados são inválidos.";

/**
 * The `message` of a 400 VALIDATION_ERROR: the first refused field's own
 * sentence, so a client that shows `message` shows something a person can
 * act on; `issues` keeps every sentence.
 */
function validationErrorMessage(issues: readonly string[]): string {
  const first = issues.find((issue) => issue.trim().length > 0);

  return first ?? GENERIC_VALIDATION_MESSAGE;
}

installPtBrZodErrors();

export {
  GENERIC_VALIDATION_MESSAGE,
  installPtBrZodErrors,
  ptBrErrorMap,
  validationErrorMessage,
};
