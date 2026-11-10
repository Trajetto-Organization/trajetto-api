import { AppError } from "@/shared/errors/AppError";

import type { NotCancellableStatus } from "@/shared/integration/cancel-delivery-rules";

/**
 * Why the public cancel refuses, one sentence per status it refuses. Typed
 * over the refused statuses, so a status that starts being refused does not
 * compile until it has its own.
 */
const NOT_CANCELLABLE_MESSAGES: Record<NotCancellableStatus, string> = {
  DELIVERED: "A entrega já foi concluída e não pode ser cancelada.",
  IN_TRANSIT:
    "A entrega já saiu com o motorista. O cancelamento de uma carga em rota é feito pela transportadora, no painel.",
};

/**
 * 409: the request is valid, the delivery's state is what refuses it. The
 * body also says which state (`delivery_status`), so an ERP decides without
 * a second call — and without the read scope a cancel-only key does not have.
 */
class DeliveryNotCancellableError extends AppError {
  constructor(readonly deliveryStatus: NotCancellableStatus) {
    super(
      NOT_CANCELLABLE_MESSAGES[deliveryStatus],
      409,
      "DELIVERY_NOT_CANCELLABLE",
    );
  }
}

/**
 * 409: the delivery moved between the read and the write to another status
 * the API cancels (Insucesso sent back to Pendente, say), and nothing was
 * written. Safe to repeat: the next call decides on the status it finds. The
 * panel's sentence asks to refresh a screen; an ERP has none, and a
 * cancel-only key cannot read the delivery either.
 */
class IntegrationDeliveryStatusConflictError extends AppError {
  constructor() {
    super(
      "O status desta entrega mudou durante o pedido e nada foi gravado. Repita o pedido: a resposta considera o status novo.",
      409,
      "DELIVERY_STATUS_CONFLICT",
    );
  }
}

export {
  DeliveryNotCancellableError,
  IntegrationDeliveryStatusConflictError,
  NOT_CANCELLABLE_MESSAGES,
};
