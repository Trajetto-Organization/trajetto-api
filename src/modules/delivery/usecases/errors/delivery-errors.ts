class DeliveryNotFoundError extends Error {
  constructor() {
    super("Entrega não encontrada! Por favor, tente novamente.");
  }
}

class DeliveryNotBelongBusinessError extends Error {
  constructor() {
    super("Esta entrega não pertence à empresa informada.");
  }
}

class DeliveryInvoiceKeyExistsError extends Error {
  constructor() {
    super(
      "Já existe uma entrega com esta chave de NF-e nesta empresa. " +
        "A mesma nota não pode gerar duas entregas.",
    );
  }
}

class DeliveryNotEditableError extends Error {
  constructor() {
    super(
      "Esta entrega não pode ser editada no status atual. " +
        "Apenas entregas pendentes ou com insucesso podem ser alteradas.",
    );
  }
}

class DeliveryNotAssignableError extends Error {
  constructor(labels: string[]) {
    super(
      "Só entregas pendentes podem ser atribuídas. Ajuste a seleção e " +
        `tente novamente: ${labels.join(", ")}.`,
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

class DeliveryDriverInactiveError extends Error {
  constructor() {
    super("Só é possível atribuir entregas a um motorista ativo.");
  }
}

class DeliveryVehicleUnavailableError extends Error {
  constructor() {
    super(
      "O veículo selecionado está inativo ou bloqueado e não pode receber " +
        "entregas.",
    );
  }
}

export {
  DeliveryNotFoundError,
  DeliveryNotBelongBusinessError,
  DeliveryInvoiceKeyExistsError,
  DeliveryNotEditableError,
  DeliveryNotAssignableError,
  DeliveryAssignmentConflictError,
  DeliveryStatusConflictError,
  DeliveryDriverInactiveError,
  DeliveryVehicleUnavailableError,
};
