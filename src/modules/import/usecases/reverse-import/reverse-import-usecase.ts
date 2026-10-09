import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IImportRepository } from "../../repositories/IImport-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import {
  ImportAlreadyReversedError,
  ImportNotFoundError,
} from "../errors/import-errors";

import { AppError } from "@/shared/errors/AppError";
import type { ReversalResult } from "../../dtos/import-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryEventPayload } from "@/shared/integration/announce";

interface ReverseImportRequest {
  userId: string;
  businessId: string;
  importId: string;
}

/**
 * Taking back an upload.
 *
 * The case this exists for: a dispatcher loads the wrong file at 6am —
 * yesterday's sheet, the customer's other branch, a column shifted by one —
 * and needs two hundred deliveries gone. Doing that by hand is not doing it:
 * they will miss some, and the ones they miss go out on a truck.
 *
 * Deliberately PARTIAL rather than all-or-nothing. An upload undone ten
 * minutes later is untouched; one undone at noon has had half its deliveries
 * worked, and refusing the whole undo because three of two hundred are in
 * transit would leave the operator removing the other hundred and ninety-seven
 * by hand — the exact situation this was built to avoid. What was worked
 * stays, named, with the reason.
 */
@injectable()
class ReverseImportUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("ImportRepository")
    private importRepository: IImportRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    importId,
  }: ReverseImportRequest): Promise<ReversalResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    assertDispatcher(findUser);

    const findImport = await this.importRepository.findImportById(
      importId,
      businessId,
    );

    // The read is already scoped by company, so another carrier's upload
    // reads as absent — no separate "exists but is not yours" to learn from.
    if (!findImport) {
      throw new ImportNotFoundError();
    }

    // A running import is still writing rows. Undoing one would delete
    // deliveries while the loop above is creating them, and the two would
    // race over the same ids — the report would name rows that no longer
    // exist and the operator would be left with a half-import nobody can
    // account for.
    if (findImport.status === "IN_PROGRESS") {
      throw new AppError(
        "Esta importação ainda está em andamento. Aguarde o fim para estorná-la.",
        409,
        "IMPORT_IN_PROGRESS",
      );
    }

    // Undoing twice would report removing nothing and read like a failure.
    // Saying so is what tells the operator the first click worked.
    if (findImport.status === "REVERSED") {
      throw new AppError(
        new ImportAlreadyReversedError().message,
        409,
        "IMPORT_ALREADY_REVERSED",
      );
    }

    let result: ReversalResult;

    try {
      // Each delivery the upload announced as `delivery.created` and this undo
      // removes is announced as `delivery.cancelled` (decision 5.1), in the
      // deletion's own transaction: an ERP that heard about the delivery must
      // hear it is gone, or it keeps a ghost record billing for it.
      result = await this.importRepository.reverseImport(
        importId,
        businessId,
        async (removed, tx) => {
          for (const delivery of removed) {
            await this.webhooks.announce(
              "delivery.cancelled",
              businessId,
              deliveryEventPayload({ ...delivery, status: "CANCELLED" }),
              tx,
            );
          }
        },
      );
    } catch (error) {
      // A double click: both passed the check above, and the repository's
      // claim let only one of them undo it (IDEMP-13). The loser gets the
      // same answer the check gives a late second click.
      if (error instanceof ImportAlreadyReversedError) {
        throw new AppError(error.message, 409, "IMPORT_ALREADY_REVERSED");
      }

      throw error;
    }

    const kept = result.keptDeliveries.length + result.keptRoutes.length;

    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "delete",
      entityId: importId,
      description:
        `Importação "${findImport.filename}" estornada: ` +
        `${result.removedDeliveries} entrega(s) e ${result.removedRoutes} rota(s) removida(s)` +
        (kept > 0 ? `, ${kept} mantida(s) por já ter movimento` : ""),
      status: "Estornada",
      performedBy: userId,
      businessId,
    });

    return result;
  }
}

export { ReverseImportUseCase };
export type { ReverseImportRequest };
