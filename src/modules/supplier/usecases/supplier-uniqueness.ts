import type { ISupplierRepository } from "../repositories/ISupplier-repository";

import { SupplierNameAlreadyExistsError } from "./errors/supplier-name-already-exists-error";
import { SupplierCnpjAlreadyExistsError } from "./errors/supplier-cnpj-already-exists-error";
import { SupplierEmailAlreadyExistsError } from "./errors/supplier-email-already-exists-error";

interface SupplierIdentity {
  businessId: string;
  name?: string | null;
  cnpj?: string | null;
  email?: string | null;
  /** The supplier being edited: meeting itself is not a conflict. */
  exceptId?: string;
}

/**
 * Name, CNPJ and e-mail are unique inside one company and only there
 * (decision 8.1). Create and update ask the same three questions in the same
 * order, so they refuse with the same words. A field that is absent or empty
 * is not checked.
 */
async function assertSupplierIsUnique(
  suppliers: ISupplierRepository,
  identity: SupplierIdentity,
): Promise<void> {
  const isOther = (found: { id: string } | null) =>
    found !== null && found.id !== identity.exceptId;

  if (identity.name) {
    const found = await suppliers.findSupplierByNameAndBusinessId(
      identity.name,
      identity.businessId,
    );

    if (isOther(found)) throw new SupplierNameAlreadyExistsError();
  }

  if (identity.cnpj) {
    const found = await suppliers.findSupplierByCnpjAndBusinessId(
      identity.cnpj,
      identity.businessId,
    );

    if (isOther(found)) throw new SupplierCnpjAlreadyExistsError();
  }

  if (identity.email) {
    const found = await suppliers.findSupplierByEmailAndBusinessId(
      identity.email,
      identity.businessId,
    );

    if (isOther(found)) throw new SupplierEmailAlreadyExistsError();
  }
}

export { assertSupplierIsUnique };
