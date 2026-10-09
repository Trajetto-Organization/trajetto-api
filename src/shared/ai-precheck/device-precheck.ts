import { z } from "zod";

/**
 * The phone's offline pre-check of a photo (decision 14.2; design
 * ia-local-implementacao §P5).
 *
 * The app reads the receipt or the odometer with ML Kit on the device, with
 * no network, and compares in code: is the expected invoice number on the
 * receipt, is a legible date outside the business day, is the typed km on
 * the odometer. Only booleans travel: the text read never leaves the phone,
 * because the server reads the same photo itself and a receipt carries a
 * person's name.
 *
 * What the API does with it is deliberately little: the field is a
 * declaration of the device. It never moves a status, a quota unit or a
 * suggestion; it is stored once, with the submission, next to the server's
 * own reading so a person (and the metrics) can compare the two.
 */

const DEVICE_PRECHECK_ENGINE = "mlkit-text-v2-latin";

type DevicePrecheckKind = "proof" | "odometer";

const devicePrecheckSchema = z
  .object({
    engine: z.literal(DEVICE_PRECHECK_ENGINE),
    engine_version: z.string().max(20),
    rules_version: z.number().int().min(1),
    ran_at: z.string().datetime({ offset: true }),
    duration_ms: z.number().int().min(0).max(60_000),
    kind: z.enum(["proof", "odometer"]),
    // proof
    invoice_number_found: z.boolean().nullable(),
    // proof; null = no legible date on the photo
    date_out_of_window: z.boolean().nullable(),
    // odometer
    typed_mileage_found: z.boolean().nullable(),
    outcome: z.enum(["ok", "warned", "error"]),
    // sent anyway after a warning
    driver_overrode: z.boolean(),
  })
  .strict();

type DevicePrecheck = z.infer<typeof devicePrecheckSchema>;

/**
 * The body field. A malformed pre-check is DROPPED, never refused: from the
 * driver's offline queue a 400 is a permanent failure, and losing a proof of
 * delivery over a hint nobody needs to accept it would be absurd. The phone
 * may also be a build whose rules are newer than this API.
 */
const devicePrecheckField = devicePrecheckSchema
  .nullable()
  .optional()
  .catch(undefined)
  .describe(
    "Pré-checagem feita offline no celular (ML Kit, decisão 14.2): só booleanos, nunca o texto lido. É uma declaração do aparelho — não muda status, cota nem sugestão. Gravada uma única vez com o envio (um reenvio com a mesma chave não a reescreve) e só quando a empresa tem a leitura automática contratada; fora disso é descartada. Um valor mal formado é ignorado, não recusado.",
  );

interface PrecheckEntitlement {
  /** Business.ai_analysis_limit: zero is how a company says it did not buy the reading. */
  aiAnalysisLimit: number | null | undefined;

  /** aiProviderConfigured(): the server can read photos at all. */
  providerConfigured: boolean;
}

/**
 * Whether a pre-check sent with a submission is kept.
 *
 * Contracted and the server reading on — not "quota left": a phone that ran
 * the check with a flag cached for up to 7 days belongs to a company that did
 * buy the reading, and when the month's quota is spent the device hint is the
 * only one the reviewer gets. Keeping it costs no unit.
 */
function precheckStorable({ aiAnalysisLimit, providerConfigured }: PrecheckEntitlement): boolean {
  return (aiAnalysisLimit ?? 0) > 0 && providerConfigured;
}

/**
 * The value to store, or null: nothing sent, not contracted, or a pre-check
 * of another kind (an odometer result on a receipt is not about this photo).
 */
function acceptDevicePrecheck(
  value: DevicePrecheck | null | undefined,
  options: PrecheckEntitlement & { kind: DevicePrecheckKind },
): DevicePrecheck | null {
  if (!value) return null;
  if (value.kind !== options.kind) return null;
  if (!precheckStorable(options)) return null;

  return value;
}

type PrecheckOffReason = "not_contracted" | "quota_exhausted" | "unavailable";

interface SessionPrecheckFlag {
  precheck: boolean;
  reason: PrecheckOffReason | null;
}

/**
 * The session's `ai` flag (/user/me): whether the app runs the pre-check.
 *
 * The app shows nothing at all when it is off; `reason` is for its
 * diagnostics only. Off when the company did not buy the reading, when the
 * server reading is off (nothing would confirm the hint), or when the
 * month's quota is spent (the server will not read this photo either).
 */
function sessionPrecheckFlag(input: {
  aiAnalysisLimit: number | null | undefined;
  providerConfigured: boolean;

  /** Units left in the period; null when it could not be read. */
  remaining: number | null;
}): SessionPrecheckFlag {
  if ((input.aiAnalysisLimit ?? 0) <= 0) {
    return { precheck: false, reason: "not_contracted" };
  }

  if (!input.providerConfigured) return { precheck: false, reason: "unavailable" };

  if (input.remaining !== null && input.remaining <= 0) {
    return { precheck: false, reason: "quota_exhausted" };
  }

  return { precheck: true, reason: null };
}

type DeviceAgreement = "AGREE" | "DISAGREE" | "NOT_APPLICABLE";

/**
 * The server's verdict on a receipt pre-check (§P5.2): the device's "invoice
 * number found on the photo" against the server's "the number read matches
 * the expected one".
 *
 * Null while there is nothing to compare (no pre-check, or no server reading
 * yet). NOT_APPLICABLE when either side could not say: a delivery with no
 * invoice number, a check that errored, a photo the server could not read.
 */
function proofDeviceAgreement(
  precheck: unknown,
  reading: { documentMatches?: unknown } | null | undefined,
): DeviceAgreement | null {
  const parsed = devicePrecheckSchema.safeParse(precheck);

  if (!parsed.success || parsed.data.kind !== "proof" || !reading) return null;

  const device = parsed.data.outcome === "error" ? null : parsed.data.invoice_number_found;
  const server =
    reading.documentMatches === "yes" ? true : reading.documentMatches === "no" ? false : null;

  if (device === null || server === null) return "NOT_APPLICABLE";

  return device === server ? "AGREE" : "DISAGREE";
}

/**
 * The server's verdict on an odometer pre-check (§P5.2): the device's "the
 * typed km is on the photo" against the server's "the km read matches the
 * km informed" (`serverMatches`, null when the server could not read it).
 *
 * Null without an odometer pre-check. NOT_APPLICABLE when either side could
 * not say: a check that errored, or a photo the server could not read.
 */
function odometerDeviceAgreement(
  precheck: unknown,
  serverMatches: boolean | null,
): DeviceAgreement | null {
  const parsed = devicePrecheckSchema.safeParse(precheck);

  if (!parsed.success || parsed.data.kind !== "odometer") return null;

  const device = parsed.data.outcome === "error" ? null : parsed.data.typed_mileage_found;

  if (device === null || serverMatches === null) return "NOT_APPLICABLE";

  return device === serverMatches ? "AGREE" : "DISAGREE";
}

export {
  DEVICE_PRECHECK_ENGINE,
  odometerDeviceAgreement,
  acceptDevicePrecheck,
  devicePrecheckField,
  devicePrecheckSchema,
  precheckStorable,
  proofDeviceAgreement,
  sessionPrecheckFlag,
};
export type {
  DeviceAgreement,
  DevicePrecheck,
  DevicePrecheckKind,
  PrecheckEntitlement,
  PrecheckOffReason,
  SessionPrecheckFlag,
};
