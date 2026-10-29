import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";

import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";

import {
  ShipperNotFoundError,
  ShipperInactiveError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { DeliveryInvoiceKeyExistsError } from "../errors/delivery-errors";
import { AppError } from "@/shared/errors/AppError";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryEventPayload } from "@/shared/integration/announce";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { Delivery, CreateDeliveryProps } from "../../dtos/delivery-dto";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";
import { isUniqueViolation } from "@/shared/http/idempotency-key";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";

@injectable()
class CreateDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  /**
   * No driver or vehicle (DLV-EDIT-4): putting a delivery in a driver's hands
   * is an assignment, which builds the route and its stop (assign-deliveries).
   * The create schema does not carry them, and the type says so.
   */
  async execute(
    deliveryData: Omit<CreateDeliveryProps, "driverId" | "vehicleId">,
    userId: string,
  ): Promise<Delivery> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Defense in depth: the route guard must not be the only wall between
    // tenants (same check as get-delivery and the list/exports).
    assertTenantAccess(findUser, deliveryData.businessId);

    // One definition, shared: see assertDispatcher.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(
      deliveryData.businessId,
    );

    if (!findBusiness) {
      throw businessNotFound();
    }

    // The same form sent twice — a lost answer, a second click — is the
    // delivery it already created, announced once (IDEMP-14). Before the
    // access-key check: a resend of a delivery WITH a key would otherwise be
    // refused as "this invoice already exists", which reads as a failure.
    const replay = await this.replayOf(deliveryData);

    if (replay) return replay;

    const findShipper = await this.shipper.findShipperById(
      deliveryData.shipperId,
    );

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findShipper || findShipper.businessId !== deliveryData.businessId) {
      throw new ShipperNotFoundError();
    }

    if (findShipper.is_active === false) {
      throw new ShipperInactiveError();
    }

    // The same NFe never spawns two deliveries (manual or imported).
    if (deliveryData.invoice_key) {
      const existing = await this.delivery.findDeliveryByInvoiceKey(
        deliveryData.businessId,
        deliveryData.invoice_key,
      );

      if (existing) {
        throw new DeliveryInvoiceKeyExistsError();
      }
    }

    try {
      // One transaction for the row and the event it announces. Queued after
      // the commit instead, a crash in between leaves the document in our
      // database and absent from the ERP that sent it — and the ERP has no
      // way to notice, because from its side the push succeeded.
      const deliveryCreated = await database.$transaction(async (tx) => {
        const created = await this.delivery.createDelivery(deliveryData, tx);

        // The customers' systems. An ERP that pushed a document to us wants
        // our id back, which is what lets it match our events to its own rows
        // from here on.
        await this.webhooks.announce(
          "delivery.created",
          deliveryData.businessId,
          deliveryEventPayload({ ...created, id: created.id! }),
          tx,
        );

        return created;
      });

      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "create",
        entityId: deliveryCreated.id as string,
        description: `Entrega para ${deliveryCreated.recipient_name} criada | ID: ${deliveryCreated.id}`,
        status: "Pendente",
        performedBy: userId,
        businessId: deliveryData.businessId,
      });

      return deliveryCreated;
    } catch (error) {
      // The twin of this submission committed after the replay check: the
      // insert met the unique key, and the twin's delivery is the answer.
      if (isUniqueViolation(error)) {
        const replay = await this.replayOf(deliveryData);

        if (replay) return replay;

        // Two creates with the same NF-e key raced past the check above: the
        // unique index decided, and the loser gets the same 409 the check
        // gives (DLV-EDIT-5), not a 500.
        if (violatesUniqueOn(error, "invoice_key")) {
          throw new DeliveryInvoiceKeyExistsError();
        }
      }

      throw new AppError(
        "Houve um erro ao tentar criar a entrega! Por favor, tente novamente.",
        500,
      );
    }
  }

  private async replayOf(
    deliveryData: CreateDeliveryProps,
  ): Promise<Delivery | null> {
    if (!deliveryData.client_submission_id) return null;

    return this.delivery.findDeliveryBySubmissionId(
      deliveryData.businessId,
      deliveryData.client_submission_id,
    );
  }
}

export { CreateDeliveryUseCase };
