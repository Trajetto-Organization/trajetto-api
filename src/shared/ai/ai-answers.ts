import { z } from "zod";

import {
  CONDITION_CHOICES,
  FUEL_LEVELS,
  VERDICT_CHOICES,
  type AnswerKind,
} from "./ai-prompts";
import { INVALID_RESPONSE_MARKER } from "./provider-failure";

/**
 * The model's answer, validated (AI-14).
 *
 * It used to be a regex plus JSON.parse, and a key the model left out became
 * the optimistic default: `corresponde_ao_informado ?? true` turned "no
 * answer" into "confirmed". Every key a verdict depends on is now required; an
 * answer without it is an invalid answer, retried once and then settled as a
 * failure — never a verdict. Only the free text (observação, fraud reasons)
 * may be missing, because nothing is decided from it.
 *
 * Tolerant of FORM, strict about CONTENT: "Não sei" and "nao_sei" are the
 * same answer, "0.9" and 0.9 the same number, a confidence written on the old
 * 0–100 scale is brought to 0–1. None of that invents a value.
 */

class InvalidModelResponseError extends Error {
  constructor(detail: string) {
    super(`${INVALID_RESPONSE_MARKER}: ${detail}`);
  }
}

/** "Não sei" → "nao_sei": case, accents and spaces are not an answer. */
function normalizeChoice(value: unknown): unknown {
  if (typeof value !== "string") return value;

  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function numericString(value: unknown): unknown {
  if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return Number(value);
  }

  return value;
}

function booleanString(value: unknown): unknown {
  if (value === "true") return true;
  if (value === "false") return false;

  return value;
}

/** 0–1, whatever scale the model wrote it on (AI-3). */
const unitScore = z.preprocess(
  numericString,
  z
    .number()
    .finite()
    .min(0)
    .max(100)
    .transform((value) => (value > 1 ? value / 100 : value)),
);

const freeText = z.preprocess(
  (value) => (value === null || value === undefined ? "" : value),
  z.string().transform((value) => value.trim().slice(0, 500)),
);

const verdict = z.preprocess(normalizeChoice, z.enum(VERDICT_CHOICES));

const flag = z.preprocess(booleanString, z.boolean());

/** An odometer figure: a number, or digits the model wrote as text. */
const mileage = z.preprocess((value) => {
  if (typeof value === "string" && /^[\d.\s]+$/.test(value.trim())) {
    return Number(value.replace(/\D/g, ""));
  }

  return value;
}, z.number().finite().min(0).nullable());

/** A transcription: trimmed, bounded, and "" read as not transcribed. */
const transcription = z.preprocess(
  (value) => (typeof value === "number" ? String(value) : value),
  z
    .string()
    .nullable()
    .transform((value) => {
      const trimmed = value?.trim().slice(0, 120) ?? "";
      return trimmed.length > 0 ? trimmed : null;
    }),
);

const answerSchemas = {
  odometer: z.object({
    valor_lido: mileage,
    confianca: unitScore,
    legivel: flag,
    sinais_fraude: flag,
    motivos_fraude: z
      .array(z.string())
      .nullish()
      .transform((reasons) => reasons ?? []),
    observacao: freeText,
    // False when the reader cannot judge fraud at all (OCR: a photo of a
    // screen reads like a dashboard, benchmark O09). Absent = a model that
    // was asked, and every result stored before 05/10/2026.
    fraude_avaliada: flag.optional().transform((assessed) => assessed ?? true),
  }),
  fuel_level: z.object({
    nivel_estimado: z.preprocess(normalizeChoice, z.enum(FUEL_LEVELS)),
    confianca: unitScore,
    observacao: freeText,
  }),
  condition: z.object({
    condicao_observada: z.preprocess(normalizeChoice, z.enum(CONDITION_CHOICES)),
    confianca: unitScore,
    observacao: freeText,
  }),
  working: z.object({
    item_ok: verdict,
    confianca: unitScore,
    observacao: freeText,
  }),
  proof: z.object({
    e_canhoto: verdict,
    numero_documento_lido: transcription,
    data_recebimento_lida: transcription,
    tem_assinatura: verdict,
    // False when the reader cannot see a signature at all (OCR): the
    // signature then stays for a person, whatever the screen signature says.
    assinatura_avaliada: flag.optional().transform((assessed) => assessed ?? true),
    // Shown to the reviewer, never decided on: may be missing.
    nome_recebedor_lido: transcription.optional().transform((name) => name ?? null),
    legivel: verdict,
    qualidade_foto: unitScore,
    confianca: unitScore,
    observacao: freeText,
  }),
} satisfies Record<AnswerKind, z.ZodTypeAny>;

/**
 * Keys a READER declares about itself, never asked of a model: whether it
 * judged fraud and the signature at all. A model's prompt does not list
 * them; an answer without them counts as judged.
 */
const READER_DECLARED_KEYS = ["fraude_avaliada", "assinatura_avaliada"] as const;

type OdometerAnswer = z.infer<typeof answerSchemas.odometer>;
type FuelLevelAnswer = z.infer<typeof answerSchemas.fuel_level>;
type ConditionAnswer = z.infer<typeof answerSchemas.condition>;
type WorkingAnswer = z.infer<typeof answerSchemas.working>;
type ProofAnswer = z.infer<typeof answerSchemas.proof>;

interface AnswerByKind {
  odometer: OdometerAnswer;
  fuel_level: FuelLevelAnswer;
  condition: ConditionAnswer;
  working: WorkingAnswer;
  proof: ProofAnswer;
}

/** The JSON object in the model's text: fenced, prefixed or bare. */
function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end <= start) {
    throw new InvalidModelResponseError(
      `resposta sem JSON — ${text.slice(0, 200)}`,
    );
  }

  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new InvalidModelResponseError(
      `JSON inválido — ${text.slice(0, 200)}`,
    );
  }
}

function parseModelAnswer<K extends AnswerKind>(
  kind: K,
  text: string,
): AnswerByKind[K] {
  const parsed = answerSchemas[kind].safeParse(extractJsonObject(text));

  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 4)
      .map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("; ");

    throw new InvalidModelResponseError(`${kind} fora do formato (${issues})`);
  }

  return parsed.data as AnswerByKind[K];
}

export {
  InvalidModelResponseError,
  READER_DECLARED_KEYS,
  answerSchemas,
  extractJsonObject,
  normalizeChoice,
  parseModelAnswer,
};
export type {
  AnswerByKind,
  ConditionAnswer,
  FuelLevelAnswer,
  OdometerAnswer,
  ProofAnswer,
  WorkingAnswer,
};
