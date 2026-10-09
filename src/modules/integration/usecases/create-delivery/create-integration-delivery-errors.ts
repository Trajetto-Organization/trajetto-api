import { AppError } from "@/shared/errors/AppError";

import { DeliveryInvoiceKeyExistsError } from "@/modules/delivery/usecases/errors/delivery-errors";

/**
 * The two 409s of the public create, each pointing at the delivery that is
 * in the way. An ERP that gets "already exists" with no id has to ask a person
 * which one; with the id it reconciles on its own. The id never crosses a
 * tenant: both lookups are scoped to the key's company.
 */
interface PointsAtDelivery {
  readonly deliveryId: string | null;
}

/**
 * Who used the key first. The panel's form writes the same column with its
 * own keys; a public key that coincides with one did not create that
 * delivery, so it is not a replay of it.
 */
type KeyHolder = "integration" | "panel";

const REUSED_MESSAGES: Record<KeyHolder, string> = {
  integration:
    "Esta Idempotency-Key já criou uma entrega com outros dados. Para repetir aquele envio, mande o mesmo corpo; para um documento novo, gere uma chave nova.",
  panel:
    "Esta Idempotency-Key já foi usada por um cadastro feito no painel, que criou a entrega indicada em delivery_id. Gere uma chave nova para este documento.",
};

/** Same key, different body (decision 5.10), or a key the panel used. */
class IdempotencyKeyReusedError extends AppError implements PointsAtDelivery {
  constructor(
    readonly deliveryId: string,
    holder: KeyHolder = "integration",
  ) {
    super(REUSED_MESSAGES[holder], 409, "IDEMPOTENCY_KEY_REUSED");
  }
}

/**
 * The panel's own refusal — same code, same sentence — plus the id of the
 * delivery that holds the NF-e key.
 */
class IntegrationInvoiceKeyExistsError
  extends DeliveryInvoiceKeyExistsError
  implements PointsAtDelivery
{
  constructor(readonly deliveryId: string | null) {
    super();
  }
}

function pointsAtDelivery(error: unknown): error is AppError & PointsAtDelivery {
  return (
    error instanceof IdempotencyKeyReusedError ||
    error instanceof IntegrationInvoiceKeyExistsError
  );
}

export {
  IdempotencyKeyReusedError,
  IntegrationInvoiceKeyExistsError,
  pointsAtDelivery,
};
