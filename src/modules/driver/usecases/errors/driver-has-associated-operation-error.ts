import { AppError } from "@/shared/errors/AppError";

/**
 * The operation history a driver carries: the deliveries they made, the
 * routes they ran and the conversation with the office (chat messages and
 * support tickets).
 *
 * Three different failures without this guard, and the quieter ones are
 * worse. `Delivery.driver` is optional, so deleting the driver NULLs it — a
 * delivery that is DELIVERED, with a delivered_at, and nobody who delivered
 * it, with no error raised and nothing in the trail to reconstruct it from.
 * The chat thread is CASCADE, so the messages and the tickets went with the
 * driver (decision D-39). `Route.driver` is required, so Postgres refuses
 * instead, and the refusal surfaces as a foreign-key error the use case
 * would turn into a 500.
 *
 * Deactivating the driver is the answer for someone who left: they disappear
 * from every picker, their login can no longer sign in, and the history stays
 * theirs.
 */
class DriverHasAssociatedOperationError extends AppError {
  constructor(
    deliveryCount: number,
    routeCount: number,
    chatMessageCount = 0,
    supportTicketCount = 0,
  ) {
    const parts = [
      deliveryCount > 0 && `${deliveryCount} entrega(s)`,
      routeCount > 0 && `${routeCount} rota(s)`,
      chatMessageCount > 0 && `${chatMessageCount} mensagem(ns) no chat`,
      supportTicketCount > 0 && `${supportTicketCount} atendimento(s)`,
    ].filter((part): part is string => Boolean(part));

    const listed =
      parts.length > 1
        ? `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`
        : parts.join("");

    super(
      `Não é possível excluir este motorista pois existem ${listed} ` +
        `no histórico da operação. Apagá-lo apagaria de quem foi o trabalho.` +
        `\n\nOpções disponíveis:\n` +
        `• Inativar o motorista (recomendado): ele sai das listas, o login dele deixa de entrar no app e o histórico continua dele`,
      409,
      "DRIVER_HAS_OPERATION",
    );
  }
}

export { DriverHasAssociatedOperationError };
