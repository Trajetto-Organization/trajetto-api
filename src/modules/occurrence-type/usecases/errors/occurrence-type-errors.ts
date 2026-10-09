import { ZodError } from "zod";

import { AppError } from "@/shared/errors/AppError";
import type { CategoryIssue } from "../../rules/occurrence-category-rules";

/**
 * Honest HTTP with a code (decision 11.3). The catalogue's own writes also
 * give it for a type of another company: a separate "not yours" refusal
 * would tell a caller which ids exist at other carriers.
 */
class OccurrenceTypeNotFoundError extends AppError {
  constructor() {
    super(
      "Tipo de ocorrência não encontrado! Por favor, tente novamente.",
      404,
      "OCCURRENCE_TYPE_NOT_FOUND",
    );
  }
}

class OccurrenceTypeNameAlreadyExistsError extends AppError {
  constructor() {
    super(
      "Já existe um tipo de ocorrência com este nome nesta empresa.",
      409,
      "OCCURRENCE_TYPE_NAME_TAKEN",
    );
  }
}

class OccurrenceTypeInUseError extends AppError {
  constructor(details: string) {
    super(
      `Não é possível excluir este tipo de ocorrência. ${details} ` +
        "A trilha precisa continuar nomeando o que aconteceu — desative o " +
        "tipo para ocultá-lo de novos registros sem apagar o histórico.",
      409,
      "OCCURRENCE_TYPE_IN_USE",
    );
  }
}

/**
 * The platform writes "Comprovante rejeitado" itself (DLVP-OCC-3). Renamed,
 * it would keep is_system and vanish from the driver and the monitoring
 * count without a word, and the next rejection would create a second one;
 * deleted, the rejections already recorded would lose their name.
 */
class OccurrenceTypeSystemError extends AppError {
  constructor() {
    super(
      "Este tipo é do sistema e não pode ser editado nem excluído.",
      409,
      "OCCURRENCE_TYPE_SYSTEM",
    );
  }
}

/**
 * The category or the legal nature of a type that was already used (an
 * occurrence or a pause names it) or that the platform seeded (decision
 * 14.3): changing it would rewrite what past reports meant.
 */
class OccurrenceTypeCategoryLockedError extends AppError {
  constructor() {
    super(
      "A categoria e a natureza não mudam depois que o tipo foi usado, nem nos tipos padrão.",
      409,
      "OCCURRENCE_TYPE_CATEGORY_LOCKED",
    );
  }
}

/** The company would be left without an active delivery (or pause) type. */
class OccurrenceTypeLastOfCategoryError extends AppError {
  constructor(category: "DELIVERED" | "PAUSE") {
    super(
      category === "DELIVERED"
        ? "É preciso ao menos um tipo ativo de entrega: sem ele o motorista não consegue comprovar."
        : "É preciso ao menos um tipo ativo de pausa: sem ele o motorista não consegue pausar.",
      409,
      "OCCURRENCE_TYPE_LAST_OF_CATEGORY",
    );
  }
}

/** The legacy adapters find the seeded types by key: they are never deleted. */
class OccurrenceTypeDefaultError extends AppError {
  constructor() {
    super(
      "Tipo padrão: pode ser editado ou desativado, não excluído.",
      409,
      "OCCURRENCE_TYPE_DEFAULT",
    );
  }
}

/**
 * The category matrix refused the configuration: 400 VALIDATION_ERROR with
 * one sentence per issue, through the global handler (a ZodError).
 */
function categoryValidationError(issues: CategoryIssue[]): ZodError {
  return new ZodError(
    issues.map((issue) => ({
      code: "custom" as const,
      path: [issue.field],
      message: issue.message,
    })),
  );
}

export {
  categoryValidationError,
  OccurrenceTypeCategoryLockedError,
  OccurrenceTypeDefaultError,
  OccurrenceTypeLastOfCategoryError,
  OccurrenceTypeNotFoundError,
  OccurrenceTypeNameAlreadyExistsError,
  OccurrenceTypeInUseError,
  OccurrenceTypeSystemError,
};
