import { z } from "zod";

/**
 * The occurrence form (decision 6.2): what a company asks the driver when a
 * type is reported, and the check of what the driver answered.
 *
 * Pure and self-contained on purpose (no project imports but zod): the same
 * rules run in the web (form builder, panel report) and in the app (offline,
 * before the outbox), and a copy that depends on nothing is a copy that can
 * stay identical. Mirrors:
 *   - trajetto-ui/src/features/deliveries/occurrence-types/form-builder/rules.ts
 *   - trajetto-mobile (mobile-occ package), from docs/contratos-app/occurrences.md
 * The shared cases live in tests/unitaires/occurrence-type/occurrence-form-rules.test.ts.
 */

const OCCURRENCE_FORM_FIELD_TYPES = [
  "text",
  "number",
  "boolean",
  "select",
  "date",
] as const;

type OccurrenceFormFieldType = (typeof OCCURRENCE_FORM_FIELD_TYPES)[number];

/** A form the driver fills on the street: long enough, never a survey. */
const MAX_FORM_FIELDS = 20;
const MAX_LABEL_LENGTH = 80;
const MAX_HELP_LENGTH = 200;
const MAX_OPTION_LENGTH = 60;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 20;

/** Text answers: the default and the ceiling a company may pick. */
const DEFAULT_TEXT_MAX_LENGTH = 200;
const MAX_TEXT_MAX_LENGTH = 500;

/** A stable slug: answers are stored by it, labels may change freely. */
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface OccurrenceFormField {
  key: string;
  label: string;
  type: OccurrenceFormFieldType;
  required: boolean;
  /** Guidance shown under the field to the driver. */
  help?: string;
  /** select only. */
  options?: string[];
  /** text only. */
  max_length?: number;
  /** text only: line breaks allowed (decision 5.5 rules). */
  multiline?: boolean;
  /** number only. */
  min?: number;
  max?: number;
  integer?: boolean;
}

type OccurrenceFormAnswer = string | number | boolean;
type OccurrenceFormAnswers = Record<string, OccurrenceFormAnswer>;

// Single-line text rules, the same everywhere in the product.
const hasSpaceAtEdges = (value: string): boolean => /^\s|\s$/.test(value);
const hasConsecutiveSpaces = (value: string): boolean => /\s{2,}/.test(value);

// Multiline (decision 5.5): a line break is not a space.
const hasInlineConsecutiveSpaces = (value: string): boolean =>
  /[^\S\r\n]{2,}/.test(value);
const hasSpaceAtLineEdges = (value: string): boolean =>
  value.split(/\r?\n/).some((line) => /^[^\S\r\n]|[^\S\r\n]$/.test(line));

/** The label/option/help rule: no blank text, no edge or double spaces. */
function singleLineText(label: string, max: number) {
  return z
    .string({ invalid_type_error: `${label} deve ser um texto.` })
    .min(1, `${label} é obrigatório.`)
    .max(max, `${label} deve ter no máximo ${max} caracteres.`)
    .superRefine((value, ctx) => {
      if (value.trim().length === 0) {
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
}

const occurrenceFormFieldSchema = z
  .object({
    key: z
      .string({ required_error: "A chave do campo é obrigatória." })
      .regex(
        FIELD_KEY_PATTERN,
        "A chave do campo deve começar com letra minúscula e ter só letras minúsculas, números e _ (até 40).",
      ),
    label: singleLineText("O rótulo do campo", MAX_LABEL_LENGTH),
    type: z.enum(OCCURRENCE_FORM_FIELD_TYPES, {
      errorMap: () => ({
        message: "Tipo de campo inválido: use texto, número, sim/não, lista ou data.",
      }),
    }),
    required: z.boolean().default(false),
    help: z.preprocess(
      (value) => (value === "" || value === null ? undefined : value),
      singleLineText("A orientação do campo", MAX_HELP_LENGTH).optional(),
    ),
    options: z
      .array(singleLineText("A opção", MAX_OPTION_LENGTH))
      .min(MIN_OPTIONS, `A lista precisa de pelo menos ${MIN_OPTIONS} opções.`)
      .max(MAX_OPTIONS, `A lista aceita no máximo ${MAX_OPTIONS} opções.`)
      .optional(),
    max_length: z
      .number()
      .int("O limite de caracteres deve ser um número inteiro.")
      .min(1, "O limite de caracteres deve ser pelo menos 1.")
      .max(
        MAX_TEXT_MAX_LENGTH,
        `O limite de caracteres deve ser no máximo ${MAX_TEXT_MAX_LENGTH}.`,
      )
      .optional(),
    multiline: z.boolean().optional(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
    integer: z.boolean().optional(),
  })
  // A property that does not belong to the field's type is refused rather
  // than stored: a select with a max_length would read as a promise the
  // validation never keeps.
  .strict("O campo tem uma propriedade desconhecida.")
  .superRefine((field, ctx) => {
    const misplaced = (property: string, allowedFor: string) =>
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [property],
        message: `"${field.label}": ${property} só vale para campos do tipo ${allowedFor}.`,
      });

    if (field.type === "select") {
      if (!field.options) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["options"],
          message: `"${field.label}": uma lista precisa das opções.`,
        });
      } else {
        const seen = new Set<string>();

        for (const option of field.options) {
          const normalized = option.toLocaleLowerCase("pt-BR");

          if (seen.has(normalized)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["options"],
              message: `"${field.label}": a opção "${option}" está repetida.`,
            });
          }

          seen.add(normalized);
        }
      }
    } else if (field.options !== undefined) {
      misplaced("options", "lista");
    }

    if (field.type !== "text") {
      if (field.max_length !== undefined) misplaced("max_length", "texto");
      if (field.multiline !== undefined) misplaced("multiline", "texto");
    }

    if (field.type !== "number") {
      if (field.min !== undefined) misplaced("min", "número");
      if (field.max !== undefined) misplaced("max", "número");
      if (field.integer !== undefined) misplaced("integer", "número");
    } else {
      if (
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["min"],
          message: `"${field.label}": o mínimo não pode ser maior que o máximo.`,
        });
      }

      if (field.integer) {
        for (const bound of ["min", "max"] as const) {
          const value = field[bound];

          if (value !== undefined && !Number.isInteger(value)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [bound],
              message: `"${field.label}": num campo inteiro, o ${bound === "min" ? "mínimo" : "máximo"} também é inteiro.`,
            });
          }
        }
      }
    }
  });

/**
 * The whole definition. `null` and `[]` both mean "no form"; the stored
 * value is then null (see normalizeFormFields).
 */
const occurrenceFormFieldsSchema = z
  .array(occurrenceFormFieldSchema)
  .max(MAX_FORM_FIELDS, `O formulário aceita no máximo ${MAX_FORM_FIELDS} campos.`)
  .superRefine((fields, ctx) => {
    const keys = new Set<string>();
    const labels = new Set<string>();

    fields.forEach((field, index) => {
      if (keys.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "key"],
          message: `A chave "${field.key}" aparece em mais de um campo.`,
        });
      }

      keys.add(field.key);

      // Two questions read the same on the phone and the answers could not
      // be told apart in the history.
      const label = field.label.toLocaleLowerCase("pt-BR");

      if (labels.has(label)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "label"],
          message: `O rótulo "${field.label}" aparece em mais de um campo.`,
        });
      }

      labels.add(label);
    });
  });

/**
 * The stored shape: defaults applied, properties of other types dropped, key
 * order fixed. Comparing two normalized definitions is how an edit decides
 * whether the form changed (and form_version moves).
 */
function normalizeFormFields(
  fields: ReadonlyArray<z.input<typeof occurrenceFormFieldSchema>> | null | undefined,
): OccurrenceFormField[] | null {
  if (!fields || fields.length === 0) return null;

  return fields.map((field) => {
    const normalized: OccurrenceFormField = {
      key: field.key,
      label: field.label,
      type: field.type,
      required: field.required === true,
    };

    if (typeof field.help === "string" && field.help.length > 0) {
      normalized.help = field.help;
    }

    if (field.type === "select") normalized.options = [...(field.options ?? [])];

    if (field.type === "text") {
      normalized.max_length = field.max_length ?? DEFAULT_TEXT_MAX_LENGTH;
      normalized.multiline = field.multiline === true;
    }

    if (field.type === "number") {
      if (field.min !== undefined) normalized.min = field.min;
      if (field.max !== undefined) normalized.max = field.max;
      normalized.integer = field.integer === true;
    }

    return normalized;
  });
}

function sameFormFields(
  left: OccurrenceFormField[] | null,
  right: OccurrenceFormField[] | null,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Reads a stored definition defensively: a row written by an older build (or
 * edited by hand) that no longer parses is treated as "no form" for display,
 * never as a crash of the driver's list.
 */
function readFormFields(stored: unknown): OccurrenceFormField[] | null {
  if (stored === null || stored === undefined) return null;

  const parsed = occurrenceFormFieldsSchema.safeParse(stored);

  return parsed.success ? normalizeFormFields(parsed.data) : null;
}

function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

/** Why one answer is not acceptable, or null when it is. */
function answerProblem(field: OccurrenceFormField, value: unknown): string | null {
  const label = `"${field.label}"`;

  switch (field.type) {
    case "text": {
      if (typeof value !== "string") return `${label} deve ser um texto.`;

      const max = field.max_length ?? DEFAULT_TEXT_MAX_LENGTH;

      if (value.length > max) return `${label} deve ter no máximo ${max} caracteres.`;

      const doubled = field.multiline
        ? hasInlineConsecutiveSpaces(value)
        : hasConsecutiveSpaces(value);

      if (doubled) return `${label} não deve conter espaços consecutivos.`;

      const edges = field.multiline
        ? value !== value.trim() || hasSpaceAtLineEdges(value)
        : hasSpaceAtEdges(value);

      if (edges) return `${label} não pode começar ou terminar com espaço em branco.`;

      return null;
    }

    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return `${label} deve ser um número.`;
      }

      if (field.integer && !Number.isInteger(value)) {
        return `${label} deve ser um número inteiro.`;
      }

      if (field.min !== undefined && value < field.min) {
        return `${label} deve ser no mínimo ${field.min}.`;
      }

      if (field.max !== undefined && value > field.max) {
        return `${label} deve ser no máximo ${field.max}.`;
      }

      return null;
    }

    case "boolean":
      return typeof value === "boolean" ? null : `${label} deve ser sim ou não.`;

    case "select":
      return typeof value === "string" && (field.options ?? []).includes(value)
        ? null
        : `Escolha uma das opções de ${label}.`;

    case "date":
      return typeof value === "string" && isValidDateOnly(value)
        ? null
        : `${label} deve ser uma data válida (AAAA-MM-DD).`;

    default:
      return `${label} tem um tipo desconhecido.`;
  }
}

interface AnswersVerdict {
  /** The answers to keep, in the definition's order; null when there is none. */
  answers: OccurrenceFormAnswers | null;

  /** Per field key, the first problem found. Empty when valid. */
  errors: Record<string, string>;
}

/**
 * The driver's answers against a definition.
 *
 * - A required field left blank (absent, null, "" or only spaces) is an
 *   error; `false` IS an answer to a sim/não question.
 * - A blank optional field is simply not stored.
 * - Keys the definition does not have are dropped, not refused: an answer to a
 *   field the company removed meanwhile is no reason to lose the report.
 */
function validateOccurrenceAnswers(
  fields: OccurrenceFormField[] | null,
  answers: unknown,
): AnswersVerdict {
  const errors: Record<string, string> = {};

  if (!fields || fields.length === 0) return { answers: null, errors };

  const given =
    answers && typeof answers === "object" && !Array.isArray(answers)
      ? (answers as Record<string, unknown>)
      : {};

  const kept: OccurrenceFormAnswers = {};

  for (const field of fields) {
    const value = Object.prototype.hasOwnProperty.call(given, field.key)
      ? given[field.key]
      : undefined;

    if (isBlank(value)) {
      if (field.required) {
        errors[field.key] =
          field.type === "boolean"
            ? `Responda "${field.label}".`
            : `Preencha o campo "${field.label}".`;
      }

      continue;
    }

    const problem = answerProblem(field, value);

    if (problem) {
      errors[field.key] = problem;
      continue;
    }

    kept[field.key] = value as OccurrenceFormAnswer;
  }

  return {
    answers: Object.keys(kept).length > 0 ? kept : null,
    errors,
  };
}

/** Pretty value for a history line or a notification ("Sim", "12/09/2026"). */
function formatOccurrenceAnswer(
  field: Pick<OccurrenceFormField, "type"> | undefined,
  value: OccurrenceFormAnswer,
): string {
  if (typeof value === "boolean") return value ? "Sim" : "Não";

  if (field?.type === "date" && typeof value === "string" && isValidDateOnly(value)) {
    const [year, month, day] = value.split("-");

    return `${day}/${month}/${year}`;
  }

  return String(value);
}

export {
  DEFAULT_TEXT_MAX_LENGTH,
  MAX_FORM_FIELDS,
  MAX_TEXT_MAX_LENGTH,
  OCCURRENCE_FORM_FIELD_TYPES,
  formatOccurrenceAnswer,
  normalizeFormFields,
  occurrenceFormFieldSchema,
  occurrenceFormFieldsSchema,
  readFormFields,
  sameFormFields,
  validateOccurrenceAnswers,
};

export type {
  AnswersVerdict,
  OccurrenceFormAnswer,
  OccurrenceFormAnswers,
  OccurrenceFormField,
  OccurrenceFormFieldType,
};
