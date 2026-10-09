import { AppError } from "@/shared/errors/AppError";

/**
 * The operation history a driver carries: the deliveries they made and the
 * routes they ran.
 *
 * Two different failures without this guard, and the quieter one is worse.
 * `Delivery.driver` is optional, so deleting the driver NULLs it — a delivery
 * that is DELIVERED, with a delivered_at, and nobody who delivered it, with no
 * error raised and nothing in the trail to reconstruct it from.
 * `Route.driver` is required, so Postgres refuses instead, and the refusal
 * surfaces as a foreign-key error the use case would turn into a 500.
 *
 * Deactivating the driver is the answer for someone who left: they disappear
 * from every picker, cannot log in, and the history stays theirs.
 */
class DriverHasAssociatedOperationError extends AppError {
  constructor(deliveryCount: number, routeCount: number) {
    const parts = [
      deliveryCount > 0 && `${deliveryCount} entrega(s)`,
      routeCount > 0 && `${routeCount} rota(s)`,
    ].filter(Boolean);

    super(
      `Não é possível deletar este motorista pois existem ${parts.join(" e ")} ` +
        `no histórico da operação. Apagá-lo apagaria de quem foi o trabalho.` +
        `\n\nOpções disponíveis:\n` +
        `• Inativar o motorista (recomendado) — ele sai das listas e o histórico fica\n` +
        `• Transferir o histórico para outro motorista antes de deletar`,
      409,
      "DRIVER_HAS_OPERATION",
    );
  }
}

export { DriverHasAssociatedOperationError };
