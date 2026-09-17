class RouteNotFoundError extends Error {
  constructor() {
    super("Rota não encontrada! Por favor, tente novamente.");
  }
}

class RouteNotBelongBusinessError extends Error {
  constructor() {
    super("Esta rota não pertence à empresa informada.");
  }
}

/**
 * The route moved between the moment its status was read and validated and the
 * moment the write ran, so nothing was written.
 *
 * Four surfaces drive the same route — the driver's app, the dispatcher's
 * dashboard, the admin panel and the control tower — and they are frequently
 * looking at it at the same time. Same reasoning, and same 409, as
 * DeliveryStatusConflictError.
 */
class RouteStatusConflictError extends Error {
  constructor() {
    super(
      "O status desta rota mudou enquanto você trabalhava nela e nada foi " +
        "gravado. Atualize a tela e tente novamente.",
    );
  }
}

/**
 * Raised by the partial unique index `route_active_vehicle_idx`.
 *
 * Planning two routes for the same vehicle is allowed on purpose — a
 * dispatcher lays out the whole week. What cannot happen is the second
 * departure: the truck is on one road.
 */
class RouteVehicleBusyError extends Error {
  constructor() {
    super(
      "Este veículo já está em outra rota em andamento. Encerre a rota atual " +
        "ou escolha outro veículo.",
    );
  }
}

/**
 * Raised by the partial unique index `route_stop_active_delivery_idx`.
 *
 * The message names the situation rather than the constraint, because the
 * dispatcher's next move depends on it: the delivery is not "invalid", it is
 * somewhere else.
 */
class DeliveryAlreadyOnRouteError extends Error {
  constructor(count: number) {
    super(
      count === 1
        ? "Uma das entregas já está em outra rota em andamento. Atualize a " +
            "lista e tente novamente."
        : `${count} das entregas já estão em outra rota em andamento. ` +
            "Atualize a lista e tente novamente.",
    );
  }
}

class RouteDriverInactiveError extends Error {
  constructor() {
    super("Só é possível montar uma rota para um motorista ativo.");
  }
}

class RouteVehicleUnavailableError extends Error {
  constructor() {
    super(
      "O veículo selecionado está inativo ou bloqueado e não pode receber " +
        "uma rota.",
    );
  }
}

/** A stop that no longer exists, or that belongs to a different route. */
class RouteStopNotFoundError extends Error {
  constructor() {
    super("Parada não encontrada nesta rota.");
  }
}

/**
 * The reorder did not describe the route's current stops.
 *
 * Reordering takes the COMPLETE list rather than a move instruction, so a list
 * that does not match means the dispatcher was looking at a stale route — a
 * stop was added or removed by someone else in the meantime.
 */
class RouteReorderMismatchError extends Error {
  constructor() {
    super(
      "A ordem enviada não corresponde às paradas atuais da rota. Atualize a " +
        "tela e refaça a ordenação.",
    );
  }
}

/**
 * Two dispatchers took the same route number at the same instant.
 *
 * Nobody did anything wrong and nothing is broken: the per-company code is
 * allocated by reading the highest one and adding a step, and two readers in
 * the same millisecond read the same number. Retrying picks the next one.
 *
 * It exists as its own error because the retry used to live inside the
 * repository, where it could re-run the INSERT on its own. Once the caller
 * owns the transaction — which is what makes the route and its events
 * atomic — the repository can no longer retry anything, so it has to say
 * what happened and let the caller run the whole unit of work again.
 */
class RouteCodeTakenError extends Error {
  constructor() {
    super("O número da rota já foi usado. Tente novamente.");
    this.name = "RouteCodeTakenError";
  }
}

export {
  RouteCodeTakenError,
  DeliveryAlreadyOnRouteError,
  RouteDriverInactiveError,
  RouteNotBelongBusinessError,
  RouteNotFoundError,
  RouteReorderMismatchError,
  RouteStatusConflictError,
  RouteStopNotFoundError,
  RouteVehicleBusyError,
  RouteVehicleUnavailableError,
};
