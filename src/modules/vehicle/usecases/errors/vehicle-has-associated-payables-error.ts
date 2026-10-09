/**
 * Bills that name the vehicle as their cost centre (decision 8.4).
 *
 * The foreign key is SET NULL, so the delete would succeed and silently wipe
 * the cost centre from every bill of the truck: the finance history would
 * stop adding up per vehicle with nothing said. Refused with the count, like
 * the fines and fuellings.
 */
class VehicleHasAssociatedPayablesError extends Error {
  constructor(payableCount: number) {
    super(
      `Não é possível deletar este veículo pois existem ${payableCount} conta(s) a pagar com ele como centro de custo. ` +
        `\n\nOpções disponíveis:\n` +
        `• Inativar o veículo (recomendado) — ele sai das listas e o histórico fica\n` +
        `• Trocar o veículo dessas contas antes de deletar`,
    );
  }
}

export { VehicleHasAssociatedPayablesError };
