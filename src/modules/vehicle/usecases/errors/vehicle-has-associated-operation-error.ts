/**
 * The operation history a vehicle carries: the deliveries it made and the
 * routes it ran.
 *
 * Deleting it here is not blocked by a constraint — both relations are
 * optional, so Postgres NULLs them and the delete succeeds. That is the right
 * referential action for a column that means "assigned to" and the wrong
 * outcome for one that also means "did this work", which is what it becomes
 * the moment the route completes or the delivery is proven.
 *
 * So the block lives here, with a count, like the four before it. Deactivating
 * the vehicle is the answer for a truck that has left the fleet: it keeps the
 * history and takes the vehicle out of every picker.
 */
class VehicleHasAssociatedOperationError extends Error {
  constructor(deliveryCount: number, routeCount: number) {
    const parts = [
      deliveryCount > 0 &&
        `${deliveryCount} entrega(s)`,
      routeCount > 0 && `${routeCount} rota(s)`,
    ].filter(Boolean);

    super(
      `Não é possível deletar este veículo pois existem ${parts.join(" e ")} ` +
        `no histórico da operação. Apagá-lo apagaria de quem foi o trabalho.` +
        `\n\nOpções disponíveis:\n` +
        `• Inativar o veículo (recomendado) — ele sai das listas e o histórico fica\n` +
        `• Transferir o histórico para outro veículo antes de deletar`,
    );
  }
}

export { VehicleHasAssociatedOperationError };
