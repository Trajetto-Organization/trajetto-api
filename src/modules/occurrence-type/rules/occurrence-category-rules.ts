/**
 * Occurrence categories and per-type requirements (decisions 14.3 and 14.4;
 * docs/desenho/categorias-de-ocorrencia-e-pausas.md §2.3 and §4.3).
 *
 * Pure and import-free on purpose: the web (form dialog) and the app (proof
 * screen) keep a copy of this file, compared line for line below this
 * comment, and all three run the shared cases in
 * tests/unitaires/occurrence-type/fixtures/occurrence-requirements-cases.json.
 */

const OCCURRENCE_CATEGORIES = ["DELIVERED", "NOT_DELIVERED", "PAUSE"] as const;

type OccurrenceCategoryKey = (typeof OCCURRENCE_CATEGORIES)[number];

const PAUSE_KINDS = ["MEAL", "REST", "OTHER"] as const;

type PauseKindKey = (typeof PAUSE_KINDS)[number];

const OCCURRENCE_CATEGORY_LABELS: Record<OccurrenceCategoryKey, string> = {
  DELIVERED: "Entrega",
  NOT_DELIVERED: "Não entrega",
  PAUSE: "Pausa",
};

const PAUSE_KIND_LABELS: Record<PauseKindKey, string> = {
  MEAL: "Refeição",
  REST: "Descanso",
  OTHER: "Outra",
};

/** The configuration of a type, as the matrix reads it. */
interface CategoryShape {
  category: OccurrenceCategoryKey;
  requires_photo: boolean;
  requires_receipt_photo: boolean;
  requires_signature: boolean;
  requires_authorization: boolean;
  blocks_delivery: boolean;
  pause_kind: PauseKindKey | null;
  /** The type has at least one form question. */
  has_form: boolean;
}

interface CategoryIssue {
  /** The field the dialog marks. */
  field: "pause_kind" | "blocks_delivery" | "requirements";
  message: string;
}

const CATEGORY_MESSAGES = {
  pauseKindRequired: "Escolha a natureza legal da pausa (refeição, descanso ou outra).",
  pauseKindOnlyForPause: "A natureza legal só existe em tipos de pausa.",
  pauseRequirements:
    "Tipos de pausa não exigem fotos, assinatura, formulário nem autorização.",
  blocksOnlyNotDelivered: "Só tipos de não entrega podem ser impeditivos.",
} as const;

/**
 * What the category matrix refuses in a type's configuration; [] when valid.
 * The database CHECKs say the same (migration 20261005120100); this answers
 * first, with a sentence per field instead of a 500.
 */
function categoryIssues(shape: CategoryShape): CategoryIssue[] {
  const issues: CategoryIssue[] = [];

  if (shape.category === "PAUSE") {
    if (shape.pause_kind === null) {
      issues.push({ field: "pause_kind", message: CATEGORY_MESSAGES.pauseKindRequired });
    }

    if (
      shape.requires_photo ||
      shape.requires_receipt_photo ||
      shape.requires_signature ||
      shape.requires_authorization ||
      shape.has_form
    ) {
      issues.push({ field: "requirements", message: CATEGORY_MESSAGES.pauseRequirements });
    }
  } else if (shape.pause_kind !== null) {
    issues.push({ field: "pause_kind", message: CATEGORY_MESSAGES.pauseKindOnlyForPause });
  }

  if (shape.category !== "NOT_DELIVERED" && shape.blocks_delivery) {
    issues.push({ field: "blocks_delivery", message: CATEGORY_MESSAGES.blocksOnlyNotDelivered });
  }

  return issues;
}

/** What a type asks of a driver's report (the subset the check reads). */
interface ReportRequirements {
  category: OccurrenceCategoryKey;
  requires_photo: boolean;
  requires_receipt_photo: boolean;
  requires_signature: boolean;
}

/** What the driver is sending. */
interface ReportAttachments {
  receipt_photo: boolean;
  signature: boolean;
  photos: number;
}

type MissingRequirementCode =
  | "OCCURRENCE_RECEIPT_PHOTO_REQUIRED"
  | "OCCURRENCE_SIGNATURE_REQUIRED"
  | "OCCURRENCE_PHOTO_REQUIRED";

interface MissingRequirement {
  code: MissingRequirementCode;
  message: string;
}

const REQUIREMENT_MESSAGES: Record<MissingRequirementCode, string> = {
  OCCURRENCE_RECEIPT_PHOTO_REQUIRED: "Este tipo exige a foto do canhoto.",
  OCCURRENCE_SIGNATURE_REQUIRED: "Este tipo exige a assinatura de quem recebeu.",
  OCCURRENCE_PHOTO_REQUIRED: "Este tipo de ocorrência exige foto anexada ao registro.",
};

/**
 * The requirements a driver's report leaves unmet, in the order the API
 * checks them (receipt, signature, photos). The first one is the refusal.
 */
function missingRequirements(
  type: ReportRequirements,
  sent: ReportAttachments,
): MissingRequirement[] {
  const missing: MissingRequirement[] = [];
  const add = (code: MissingRequirementCode) =>
    missing.push({ code, message: REQUIREMENT_MESSAGES[code] });

  if (type.requires_receipt_photo && !sent.receipt_photo) {
    add("OCCURRENCE_RECEIPT_PHOTO_REQUIRED");
  }

  if (type.requires_signature && !sent.signature) {
    add("OCCURRENCE_SIGNATURE_REQUIRED");
  }

  if (type.requires_photo && sent.photos === 0) add("OCCURRENCE_PHOTO_REQUIRED");

  return missing;
}

/** Which attachments a category takes at all; the others are dropped, not refused. */
function acceptedAttachments(category: OccurrenceCategoryKey): {
  receipt_photo: boolean;
  signature: boolean;
  received_by: boolean;
} {
  return {
    receipt_photo: category !== "PAUSE",
    signature: category !== "PAUSE",
    received_by: category === "DELIVERED",
  };
}

export {
  CATEGORY_MESSAGES,
  OCCURRENCE_CATEGORIES,
  OCCURRENCE_CATEGORY_LABELS,
  PAUSE_KINDS,
  PAUSE_KIND_LABELS,
  REQUIREMENT_MESSAGES,
  acceptedAttachments,
  categoryIssues,
  missingRequirements,
};
export type {
  CategoryIssue,
  CategoryShape,
  MissingRequirement,
  MissingRequirementCode,
  OccurrenceCategoryKey,
  PauseKindKey,
  ReportAttachments,
  ReportRequirements,
};
