import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IExternalRecipientRepository } from "../../repositories/IExternal-recipient-repository";
import type { NotificationService } from "@/shared/services/notification-service";

import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { callerNotFound } from "@/shared/delivery/caller-not-found";
import {
  serializeMessageOptOut,
  type SerializedMessageOptOut,
} from "@/shared/notifications/customer-message-suppression";

import { DeliveryNotFoundError } from "../errors/delivery-errors";

interface ReactivateCustomerMessagesRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
}

interface ReactivateCustomerMessagesResult {
  messageOptOut: SerializedMessageOptOut;
}

/**
 * Undoes "Parar de receber" from the delivery's detail (contract C2 of
 * 03/11/2026).
 *
 * The opt-out by phone and e-mail inside the carrier (D38) had no undo in
 * the product: support deleted the row. The dispatcher now reactivates it
 * on the delivery: the company's suppressions of the recipient's phone and
 * e-mail go, and every recipient row of the company opted out with the same
 * contact is cleared — so the next message of any delivery to that person
 * goes out again (both checks at send time read exactly these rows).
 *
 * The dispatcher's: `delivery_manage` is open to drivers for the app's own
 * surface, so the use case refuses them (assertDispatcher). Another
 * company's delivery reads as a missing one. Idempotent: pressing it twice,
 * or on a delivery that receives, answers the same state with nothing
 * written — and the activity line is recorded only when something changed,
 * in the same transaction as the change.
 */
@injectable()
class ReactivateCustomerMessagesUseCase {
  constructor(
    @inject("UserRepository")
    private users: IUserRepository,
    @inject("ExternalRecipientRepository")
    private recipients: Pick<
      IExternalRecipientRepository,
      "reactivateCustomerMessages" | "messageOptOutState"
    >,
    @inject("NotificationService")
    private notificationService: Pick<
      NotificationService,
      "createActivityIfEnabled"
    >,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
  }: ReactivateCustomerMessagesRequest): Promise<ReactivateCustomerMessagesResult> {
    const caller = await this.users.findUserById(userId);

    if (!caller) throw callerNotFound();

    assertDispatcher(caller);
    // Defense in depth: the route's tenant guard is not the only wall.
    assertTenantAccess(caller, businessId);

    const outcome = await this.recipients.reactivateCustomerMessages(
      businessId,
      deliveryId,
      (tx) =>
        this.notificationService.createActivityIfEnabled(
          {
            type: "Entrega",
            action: "update",
            entityId: deliveryId,
            description: "Mensagens ao cliente reativadas",
            status: "Ativo",
            performedBy: userId,
            businessId,
          },
          tx,
        ),
    );

    // Not this company's (or gone): the same answer as a missing one.
    if (!outcome) throw new DeliveryNotFoundError();

    const state = await this.recipients.messageOptOutState(
      businessId,
      deliveryId,
    );

    return { messageOptOut: serializeMessageOptOut(state) };
  }
}

export { ReactivateCustomerMessagesUseCase };
export type {
  ReactivateCustomerMessagesRequest,
  ReactivateCustomerMessagesResult,
};
