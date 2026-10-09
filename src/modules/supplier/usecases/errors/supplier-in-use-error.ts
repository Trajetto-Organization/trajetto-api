import { AppError } from "@/shared/errors/AppError";

import type { SupplierReferenceCounts } from "../../dtos/supplier-dto";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The records a deletion would strip of their supplier, spelled out.
 * Exported for the unit test and for the web, which shows it verbatim.
 */
function describeSupplierReferences(counts: SupplierReferenceCounts): string {
  const parts = [
    counts.serviceOrders > 0 &&
      plural(counts.serviceOrders, "ordem de serviço", "ordens de serviço"),
    counts.parts > 0 && plural(counts.parts, "peça", "peças"),
    counts.accountsPayable > 0 &&
      plural(counts.accountsPayable, "conta a pagar", "contas a pagar"),
  ].filter((part): part is string => Boolean(part));

  if (parts.length <= 1) return parts.join("");

  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/**
 * A supplier with history is not deleted (FLEET-SUP-1). The foreign keys are
 * SET NULL, so deleting it used to erase the workshop from its service
 * orders, the origin of its parts and the payee of its bills, in silence —
 * the reason vehicles, drivers and shippers are guarded the same way.
 */
class SupplierInUseError extends AppError {
  readonly references: SupplierReferenceCounts;

  constructor(references: SupplierReferenceCounts) {
    super(
      `Não é possível excluir este fornecedor: ele está vinculado a ${describeSupplierReferences(references)}. ` +
        "Excluí-lo apagaria o fornecedor desse histórico.",
      409,
      "SUPPLIER_IN_USE",
    );

    this.references = references;
  }
}

export { SupplierInUseError, describeSupplierReferences };
