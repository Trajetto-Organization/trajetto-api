import { Prisma } from "@prisma/client";

import { AppError } from "./AppError";
import {
  isForeignKeyViolation,
  sqlStateOf,
  uniqueTargetOf,
} from "./prisma-error-meta";

/**
 * The 409 behind a database conflict the use case's own checks could not see
 * (batch of 14/11/2026).
 *
 * Every write that has a unique key looks first and refuses with its domain
 * error; two requests that both looked before either wrote reach the index,
 * and a delete that counted the references reaches a RESTRICT key when one
 * lands in between. Several catches did not map either one, so the loser of
 * the race got "Houve um erro… tente novamente" (500) — or, uncaught, the
 * global handler's English "Internal server error" — for what is a conflict
 * the person can act on.
 */

/** Whether a write was refused by a unique index (P2002, or 23505 raw or at COMMIT). */
function isUniqueConflict(error: unknown): boolean {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    return true;
  }

  return sqlStateOf(error) === "23505";
}

/** The unique key a conflict names, as one string to match fragments in. */
function uniqueTargetText(error: unknown): string {
  const target = uniqueTargetOf(error);

  return Array.isArray(target) ? target.join(",") : String(target ?? "");
}

/**
 * How a unique key is named to the person, by a fragment of its columns or
 * of its index name (Prisma 7 names the index: `vehicle_businessId_
 * license_plate_key`). Longest first: "erp_code" before "code",
 * "corporate_reason" before "name". A key with no entry (a permission's
 * composite, an idempotency key) gets the sentence without a label.
 */
const UNIQUE_FIELD_LABELS: ReadonlyArray<[fragment: string, label: string]> = [
  ["license_plate", "placa"],
  ["renavam", "RENAVAM"],
  ["invoice_key", "chave da NF-e"],
  ["erp_code", "código ERP"],
  ["corporate_reason", "nome"],
  ["description", "descrição"],
  ["driverId", "motorista"],
  ["email", "e-mail"],
  ["cnpj", "CNPJ"],
  ["cpf", "CPF"],
  ["cnh", "CNH"],
  ["name", "nome"],
  ["code", "código"],
];

/** The label of the field behind a unique conflict, or null when unknown. */
function uniqueFieldLabel(error: unknown): string | null {
  const target = uniqueTargetText(error);

  for (const [fragment, label] of UNIQUE_FIELD_LABELS) {
    if (target.includes(fragment)) return label;
  }

  return null;
}

/**
 * The floor for a conflict nobody mapped: the global handler answers it, and
 * so does conflictFromPrisma when a use case's map has no entry for it.
 *
 * - unique: 409 UNIQUE_CONFLICT, naming the field ("placa") and never the
 *   row it collided with — that row may be another company's (a global key
 *   like the branch CNPJ), and the message must not confirm it exists;
 * - foreign key: 409 RECORD_IN_USE. On a delete, the row is still in use; on
 *   any other write, what it points to is gone (deleted in between).
 *
 * Null for anything else.
 */
function prismaConflictFloor(
  error: unknown,
  operation: "delete" | "write" = "write",
): AppError | null {
  if (isUniqueConflict(error)) {
    const label = uniqueFieldLabel(error);

    return new AppError(
      label
        ? `Já existe um registro com este valor nesta empresa (${label}).`
        : "Já existe um registro com este valor nesta empresa.",
      409,
      "UNIQUE_CONFLICT",
    );
  }

  if (isForeignKeyViolation(error)) {
    return new AppError(
      operation === "delete"
        ? "Este registro está em uso por outros cadastros. Inative-o ou remova os vínculos antes de excluir."
        : "Um cadastro ligado a este registro não existe mais. Atualize a página e tente de novo.",
      409,
      "RECORD_IN_USE",
    );
  }

  return null;
}

interface ConflictMap {
  /**
   * The domain's 409 for each unique key the write can meet, by a fragment
   * of its column or index name ("email", "driverId", "name").
   */
  unique?: Record<string, () => Error>;

  /**
   * A foreign key refused the write (the delete met a reference committed
   * after the use case counted): count again and answer what the count
   * would have answered. Null from it falls to the floor.
   */
  inUse?: () => Promise<Error | null>;
}

/**
 * The 409 for a Prisma conflict, for the catch of a use case: the domain's
 * own error when the map names it (an AppError, or an error its module's
 * HTTP table answers), else the floor; null when the error is no conflict at
 * all (the caller keeps its 500). A map with `inUse` is a delete.
 */
async function conflictFromPrisma(
  error: unknown,
  map: ConflictMap,
): Promise<Error | null> {
  if (isUniqueConflict(error) && map.unique) {
    const target = uniqueTargetText(error);

    for (const [fragment, build] of Object.entries(map.unique)) {
      if (target.includes(fragment)) return build();
    }
  }

  if (isForeignKeyViolation(error) && map.inUse) {
    const recounted = await map.inUse();

    if (recounted) return recounted;
  }

  return prismaConflictFloor(error, map.inUse ? "delete" : "write");
}

export {
  conflictFromPrisma,
  isUniqueConflict,
  prismaConflictFloor,
  UNIQUE_FIELD_LABELS,
  uniqueFieldLabel,
  uniqueTargetText,
  type ConflictMap,
};
