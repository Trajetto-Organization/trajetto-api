import { z, type core } from "zod";

/**
 * zod's default sentences in pt-BR.
 *
 * Fields without a message of their own reached the clients as "Required" or
 * "Expected boolean, received string", inside a body whose message was the
 * English "Validation Error"; the web and the app showed them as they came.
 * A schema's own message still wins: zod 4 asks the global `customError`
 * only after the check's and the schema's own `error` (and a parse's).
 */

const TYPE_NAMES: Record<string, string> = {
  string: "um texto",
  number: "um número",
  int: "um número inteiro",
  boolean: "verdadeiro ou falso",
  date: "uma data",
  array: "uma lista",
  tuple: "uma lista",
  object: "um objeto",
  record: "um objeto",
  null: "nulo",
  undefined: "ausente",
  bigint: "um número inteiro",
  nan: "um número válido",
};

/** `"pageSize"`, `"items.2.name"`; null for a value at the root. */
function fieldOf(path: readonly PropertyKey[]): string | null {
  return path.length > 0 ? path.map(String).join(".") : null;
}

function subject(path: readonly PropertyKey[] | undefined): string {
  const field = fieldOf(path ?? []);

  return field ? `O campo "${field}"` : "O valor";
}

/** `too_small` and `too_big` name a string's characters and a list's items. */
function sizeUnit(origin: string): string | null {
  if (origin === "string") return "caractere(s)";
  if (origin === "array" || origin === "set") return "item(ns)";

  return null;
}

/**
 * A refused record key: zod 3 reported the key's own issue at the entry's
 * path ('O campo "a.abcd" deve ter no máximo 3 caractere(s).'); zod 4 wraps
 * it in `invalid_key`, whose own sentence is the locale's English. The inner
 * issue was already worded, at the key's empty path: a sentence of the key
 * schema's own is kept, the default one is worded again at the entry's path.
 * A Map's key or element has no path to name, so its inner sentence stays.
 */
function wrappedIssueMessage(
  issue: core.$ZodRawIssue<
    core.$ZodIssueInvalidKey | core.$ZodIssueInvalidElement
  >,
): string {
  const inner = issue.issues[0];

  if (!inner) return `${subject(issue.path)} é inválido.`;

  if (issue.code !== "invalid_key" || issue.origin !== "record") {
    return inner.message;
  }

  const atKey = { ...inner, input: issue.input } as core.$ZodRawIssue;

  if (inner.message !== ptBrError(atKey)) return inner.message;

  return (
    ptBrError({ ...atKey, path: [...(issue.path ?? []), ...inner.path] }) ??
    inner.message
  );
}

/**
 * zod 4 reports a missing field, a wrong type, an invalid Date and an
 * infinite number with one code (`invalid_type`), and a missing enum with the
 * code of a value off the list (`invalid_value`); the sentences stay the ones
 * zod 3's separate codes had.
 */
const ptBrError = (issue: core.$ZodRawIssue): string | undefined => {
  const who = subject(issue.path);

  switch (issue.code) {
    case "invalid_type":
      if (issue.input === undefined) return `${who} é obrigatório.`;

      if (issue.expected === "date" && issue.input instanceof Date)
        return `${who} deve ser uma data válida.`;

      if (
        issue.expected === "number" &&
        typeof issue.input === "number" &&
        !Number.isNaN(issue.input)
      )
        return `${who} deve ser um número finito.`;

      return `${who} deve ser ${TYPE_NAMES[issue.expected] ?? issue.expected}.`;

    case "invalid_value":
      if (issue.input === undefined) return `${who} é obrigatório.`;

      return `${who} tem um valor não aceito.`;

    case "invalid_union":
      return `${who} tem um valor não aceito.`;

    case "unrecognized_keys":
      return `Campos não aceitos: ${issue.keys.join(", ")}.`;

    case "invalid_format":
      return `${who} está em um formato inválido.`;

    case "too_small": {
      const unit = sizeUnit(issue.origin);

      if (unit) return `${who} deve ter ao menos ${issue.minimum} ${unit}.`;

      return `${who} deve ser ${issue.inclusive ? "no mínimo" : "maior que"} ${issue.minimum}.`;
    }

    case "too_big": {
      const unit = sizeUnit(issue.origin);

      if (unit) return `${who} deve ter no máximo ${issue.maximum} ${unit}.`;

      return `${who} deve ser ${issue.inclusive ? "no máximo" : "menor que"} ${issue.maximum}.`;
    }

    case "not_multiple_of":
      return `${who} deve ser múltiplo de ${issue.divisor}.`;

    case "custom":
      return `${who} é inválido.`;

    case "invalid_key":
    case "invalid_element":
      return wrappedIssueMessage(issue);

    default:
      return undefined;
  }
};

let installed = false;

/** Installs the map once per process; the HTTP entry calls it at import. */
function installPtBrZodErrors(): void {
  if (installed) return;

  z.config({ customError: ptBrError });
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

/** An issue as the error handler reads it, from a ZodError or from Fastify. */
interface RefusedIssue {
  code: string;
  /** The field, as one string ("items/0/description"). */
  path: string;
  message: string;
}

/**
 * The `issues` of a 400 VALIDATION_ERROR: zod 3's list, where a value of the
 * wrong type said nothing more.
 *
 * zod 4 still runs a length check on a value of the wrong type when that
 * value has a length: an array sent for a text came back "deve ser um texto"
 * AND "deve ter no mínimo 2 caracteres", a text sent for a list "esperado
 * lista" AND "não pode ter mais de 200 itens". What follows a wrong type at
 * the same field is dropped.
 */
function validationIssueSentences(issues: readonly RefusedIssue[]): string[] {
  const wrongType = new Set<string>();

  return issues
    .filter((issue) => {
      if (wrongType.has(issue.path)) return false;
      if (issue.code === "invalid_type") wrongType.add(issue.path);

      return true;
    })
    .map(({ message }) => message);
}

installPtBrZodErrors();

export {
  GENERIC_VALIDATION_MESSAGE,
  installPtBrZodErrors,
  ptBrError,
  validationErrorMessage,
  validationIssueSentences,
};
export type { RefusedIssue };
