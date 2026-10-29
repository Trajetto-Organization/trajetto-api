import { uniqueTargetOf } from "@/shared/errors/prisma-error-meta";

/**
 * A unique-constraint violation on a vehicle write, told apart by column.
 *
 * Plate and RENAVAM are unique per company in the database (decision 8.1,
 * `vehicle_businessId_license_plate_key` / `..._renavam_key`). The use cases
 * look before they write, but two requests for the same plate can both look
 * and both find nothing; the second then fails on the index with P2002. That
 * used to fall into the generic catch and answer 500 "Houve um erro", which
 * the form showed as a crash instead of "placa já cadastrada".
 *
 * Only the COLUMN is read from the error, never the conflicting row: the
 * index is per company, so the row that collided is always the caller's own
 * company's and the message names nothing of another tenant.
 */
type VehicleUniqueField = "license_plate" | "renavam";

function isUniqueViolation(error: unknown): error is {
  code: "P2002";
  meta?: { target?: unknown };
} {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * The vehicle column a P2002 names, or null for any other error. `target` is
 * the list of columns (`["businessId", "license_plate"]`, Prisma 6) or the
 * index name (`vehicle_businessId_license_plate_key`, Prisma 7); both
 * spellings contain the column.
 */
function vehicleUniqueFieldOf(error: unknown): VehicleUniqueField | null {
  if (!isUniqueViolation(error)) return null;

  const target = uniqueTargetOf(error);
  const text = Array.isArray(target) ? target.join(",") : String(target ?? "");

  if (text.includes("license_plate")) return "license_plate";
  if (text.includes("renavam")) return "renavam";

  return null;
}

export { isUniqueViolation, vehicleUniqueFieldOf };
export type { VehicleUniqueField };
