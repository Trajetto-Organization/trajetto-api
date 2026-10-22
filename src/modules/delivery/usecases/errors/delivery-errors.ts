import { AppError } from "@/shared/errors/AppError";

/**
 * 404 with a code (decision 11.3). The panel's own reads and writes give it
 * for another company's delivery too, so a caller cannot probe which ids
 * exist at other carriers. The driver's routes still map it themselves.
 */
class DeliveryNotFoundError extends AppError {
  constructor() {
    super(
      "Entrega não encontrada! Por favor, tente novamente.",
      404,
      "DELIVERY_NOT_FOUND",
    );
  }
}

/**
 * 409 with a code (decision 11.3): the request is well formed, the key is
 * simply taken — by another delivery, or by a twin request that committed
 * first (the unique index answers the race, see create/update).
 */
class DeliveryInvoiceKeyExistsError extends AppError {
  constructor() {
    super(
      "Já existe uma entrega com esta chave de NF-e nesta empresa. " +
        "A mesma nota não pode gerar duas entregas.",
      409,
      "DELIVERY_INVOICE_KEY_EXISTS",
    );
  }
}

/**
 * The NF-e key is set once (decision 5.2): it is the dedupe anchor of the XML
 * import and the id the customers' ERPs match on. The number travels with it.
 */
class DeliveryInvoiceKeyImmutableError extends AppError {
  constructor() {
    super(
      "A chave e o número da NF-e não podem ser alterados depois de informados. " +
        "Se a nota estiver errada, cancele esta entrega e crie outra.",
      400,
      "DELIVERY_INVOICE_KEY_IMMUTABLE",
    );
  }
}

/** Items of a delivery imported from an NF-e are what the note declared. */
class DeliveryItemsLockedError extends AppError {
  constructor() {
    super(
      "Os itens desta entrega vieram do XML da NF-e e não podem ser editados.",
      400,
      "DELIVERY_ITEMS_LOCKED",
    );
  }
}

/**
 * The panel does not put a delivery on the street by itself (decision 5.4):
 * "Em rota" means a driver is carrying it, which is what the route's start
 * records. Without a driver the delivery vanished from Monitoring.
 */
class DeliveryNeedsDriverError extends AppError {
  constructor() {
    super(
      "Atribua um motorista antes de colocar a entrega em rota.",
      400,
      "DELIVERY_WITHOUT_DRIVER",
    );
  }
}

class DeliveryRouteNotStartedError extends AppError {
  constructor() {
    super(
      "Esta entrega está numa rota que ainda não saiu. Inicie a rota para colocá-la em rota.",
      400,
      "DELIVERY_ROUTE_NOT_STARTED",
    );
  }
}

/** Decision 5.3: a panel write-off has no photo or signature to back it. */
class DeliveryReceivedByRequiredError extends AppError {
  constructor() {
    super("Informe quem recebeu a entrega.", 400, "RECEIVED_BY_REQUIRED");
  }
}

/** 409: the request is valid, the delivery's state is what refuses it. */
class DeliveryNotEditableError extends AppError {
  constructor() {
    super(
      "Esta entrega não pode ser editada no status atual. " +
        "Apenas entregas pendentes ou com insucesso podem ser alteradas.",
      409,
      "DELIVERY_NOT_EDITABLE",
    );
  }
}

class DeliveryAssignmentConflictError extends Error {
  constructor() {
    super(
      "Uma das entregas mudou de status durante a atribuição e nada foi " +
        "gravado. Atualize a lista e tente novamente.",
    );
  }
}

/**
 * The delivery moved between the moment its status was read and validated and
 * the moment the write ran, so nothing was written.
 *
 * Four surfaces drive the same delivery — the driver's app, the dispatcher's
 * dashboard, the admin panel and the control tower — and they are frequently
 * looking at it at the same time. Without the precondition on the write, a
 * dispatcher cancelling a delivery while the driver is submitting its proof
 * would leave whichever request finished last standing: a cancelled delivery
 * marked DELIVERED, or a proven one marked CANCELLED. Both are states the
 * status machine forbids and neither is recoverable, since both are terminal.
 */
class DeliveryStatusConflictError extends Error {
  constructor() {
    super(
      "O status desta entrega mudou enquanto você trabalhava nela e nada " +
        "foi gravado. Atualize a tela e tente novamente.",
    );
  }
}

export {
  DeliveryNotFoundError,
  DeliveryInvoiceKeyExistsError,
  DeliveryInvoiceKeyImmutableError,
  DeliveryItemsLockedError,
  DeliveryNeedsDriverError,
  DeliveryRouteNotStartedError,
  DeliveryReceivedByRequiredError,
  DeliveryNotEditableError,
  DeliveryAssignmentConflictError,
  DeliveryStatusConflictError,
};
