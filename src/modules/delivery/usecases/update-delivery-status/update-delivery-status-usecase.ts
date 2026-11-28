import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import { IStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/IStatus-change-reason-repository";

import { NotificationService } from "@/shared/services/notification-service";
import {
  DeliveryNotFoundError,
  DeliveryStatusConflictError,
  DeliveryNeedsDriverError,
  DeliveryRouteNotStartedError,
} from "../errors/delivery-errors";

import {
  canTransitionDelivery,
  DeliveryStatus,
} from "@/shared/delivery/delivery-rules";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { AppError } from "@/shared/errors/AppError";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";
import { Delivery } from "../../dtos/delivery-dto";

import { callerNotFound } from "@/shared/delivery/caller-not-found";

import { applyDeliveryStatusChange } from "./apply-delivery-status-change";

interface UpdateDeliveryStatusRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  status: DeliveryStatus;
  received_by?: string;

  /**
   * Why. Required, from the company's own catalogue.
   *
   * This is the one path in the product that moves a delivery by hand rather
   * than because something happened in the field — the driver's app goes
   * through arrival, proof and occurrence, each of which carries its own
   * evidence. An override has none, so the reason IS the evidence, and three
   * days later it is the only thing support has to answer "por que essa está
   * assim?".
   */
  reasonId: string;

  /** The detail the catalogue cannot carry: "cliente ligou às 14h". */
  note?: string | null;
}

@injectable()
class UpdateDeliveryStatusUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("StatusChangeReasonRepository")
    private reason: IStatusChangeReasonRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    status,
    received_by,
    reasonId,
    note,
  }: UpdateDeliveryStatusRequest): Promise<Delivery> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Defense in depth: the route guard must not be the only wall between
    // tenants (same check as get-delivery and the list/exports).
    assertTenantAccess(findUser, businessId);

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    // Another company's id reads as absent (decision 11.3): a separate
    // "not yours" answer told a caller which ids exist elsewhere.
    if (!findDelivery || findDelivery.businessId !== businessId) {
      throw new DeliveryNotFoundError();
    }

    /**
     * The driver does not come through here.
     *
     * `delivery_manage:write` is open to the driver on purpose (the app runs
     * on it), and without this line a driver marked their own delivery
     * DELIVERED through this endpoint: no photo, no signature, no location,
     * going round `register-delivery-proof`, which exists to require the
     * evidence.
     *
     * The old scope ("a driver only moves their own delivery") protected
     * nothing: their own delivery is exactly the one they would close
     * without proving it.
     */
    assertDispatcher(findUser);

    const verdict = canTransitionDelivery(findDelivery.status, status);

    if (!verdict.allowed) {
      throw new AppError(verdict.reason!, 400, "INVALID_STATUS_TRANSITION");
    }

    // "Em rota" from the panel only for a load a driver is carrying on a
    // route that left (decision 5.4). Without a driver the delivery vanished
    // from Monitoring; on a PLANNED/RELEASED route it read "em rota" with its
    // stop open on a route that never started — starting the route is what
    // puts its deliveries on the street.
    const openRoute = await this.delivery.findOpenStopRoute(deliveryId);

    if (status === "IN_TRANSIT") {
      if (!findDelivery.driverId) {
        throw new DeliveryNeedsDriverError();
      }

      if (openRoute?.status === "PLANNED" || openRoute?.status === "RELEASED") {
        throw new DeliveryRouteNotStartedError();
      }
    }

    const findReason = await this.reason.findStatusChangeReasonById(reasonId);

    // Same 404 for "does not exist" and "belongs to another company": a
    // different refusal for the second would tell a caller which ids are real.
    if (!findReason || findReason.businessId !== businessId) {
      throw new AppError(
        "Motivo não encontrado.",
        404,
        "STATUS_CHANGE_REASON_NOT_FOUND",
      );
    }

    // A retired reason keeps explaining the events that already cite it and
    // stops being offered for new ones — which is exactly what deactivating
    // is for, and why the delete is refused once a reason has been used.
    if (findReason.is_active === false) {
      throw new AppError(
        "Este motivo está desativado e não pode ser usado em novas mudanças de status.",
        400,
        "STATUS_CHANGE_REASON_INACTIVE",
      );
    }

    try {
      // The one writer of a status moved by hand, shared with the public
      // API's cancel (L9): the lock order, the stop, the outbox, the webhook
      // and the announcements after the commit are the same for both.
      return await applyDeliveryStatusChange(
        {
          users: this.user,
          deliveries: this.delivery,
          routes: this.route,
          outbox: this.outbox,
          webhooks: this.webhooks,
          notificationService: this.notificationService,
        },
        {
          businessId,
          deliveryId,
          delivery: findDelivery,
          status,
          received_by,
          actor: { kind: "USER", userId },
          reason: {
            kind: "CATALOGUE",
            id: reasonId,
            name: findReason.name,
            note: note?.trim() || null,
          },
          openRoute,
        },
      );
    } catch (error) {
      // 409, not 500: the request was well formed and the caller was allowed
      // to make it — somebody else simply got there first. The screen has to
      // be able to tell the operator to refresh, not to try again.
      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar mudar o status da entrega! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateDeliveryStatusUseCase };
