import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import type { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import type { Delivery } from "@/modules/delivery/dtos/delivery-dto";
import { DeliveryStatusConflictError } from "@/modules/delivery/usecases/errors/delivery-errors";
import { applyDeliveryStatusChange } from "@/modules/delivery/usecases/update-delivery-status/apply-delivery-status-change";

import type { IIntegrationRepository } from "../../repositories/IIntegration-repository";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { NotificationService } from "@/shared/services/notification-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import { AppError } from "@/shared/errors/AppError";
import {
  integrationCancelVerdict,
  isNotCancellable,
} from "@/shared/integration/cancel-delivery-rules";
import {
  toPublicDeliveryCancellation,
  type PublicDeliveryCancellation,
} from "@/shared/integration/public-shapes";

import {
  DeliveryNotCancellableError,
  IntegrationDeliveryStatusConflictError,
} from "./cancel-integration-delivery-errors";

interface CancelIntegrationDeliveryInput {
  /** From the API key, never from the request. */
  businessId: string;
  apiKeyId: string;

  /** The key's name, for the trail and the audit entry: the key is who acted. */
  apiKeyName: string;

  deliveryId: string;

  /** The integration's own words, already checked by the body's schema. */
  reason: string;
}

interface CancelIntegrationDeliveryResult {
  /**
   * True when the delivery was already cancelled (a repeat, another key, the
   * panel): nothing was written and nothing announced.
   */
  replayed: boolean;
  delivery: PublicDeliveryCancellation;
}

/**
 * POST /integration/v1/deliveries/:id/cancel (L9, D49): an ERP whose order
 * was called off stops the delivery without anybody opening the panel.
 *
 * The cancel itself is the panel's, through applyDeliveryStatusChange: the
 * route's lock before the delivery's, the stop dropped from a plan that has
 * not left (and its version moved, and the driver of a released route told),
 * the outbox row for the driver and `delivery.cancelled` in the same commit.
 * Only what is about WHO differs. The panel starts from a user, the tenant
 * check and a reason from the catalogue; a key has no user, its company is
 * the key's, and its reason is its own text — written as the event's note,
 * with actor INTEGRATION and the key's id, and named in the audit entry.
 *
 * Idempotent by the delivery's state, so it needs no Idempotency-Key: a
 * delivery already cancelled answers 200 with `replayed`, and two identical
 * calls at the same time make one write — the loser's guarded write finds
 * the row moved, and the row, read again, says it is cancelled.
 */
@injectable()
class CancelIntegrationDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private users: IUserRepository,
    @inject("DeliveryRepository")
    private deliveries: IDeliveryRepository,
    @inject("RouteRepository")
    private routes: IRouteRepository,
    @inject("IntegrationRepository")
    private integration: IIntegrationRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute(
    input: CancelIntegrationDeliveryInput,
  ): Promise<CancelIntegrationDeliveryResult> {
    const { businessId, deliveryId } = input;

    const found = await this.deliveries.findDeliveryById(deliveryId);

    // Another company's id reads as absent, with the reads' own sentence: a
    // distinct answer would let one customer confirm another's ids.
    if (!found || found.businessId !== businessId) {
      throw new AppError("Entrega não encontrada.", 404, "NOT_FOUND");
    }

    const verdict = this.decide(found);

    if (verdict === "REPLAY") return this.answer(businessId, deliveryId, true);

    try {
      await applyDeliveryStatusChange(
        {
          users: this.users,
          deliveries: this.deliveries,
          routes: this.routes,
          outbox: this.outbox,
          webhooks: this.webhooks,
          notificationService: this.notificationService,
        },
        {
          businessId,
          deliveryId,
          delivery: found,
          status: "CANCELLED",
          actor: {
            kind: "INTEGRATION",
            apiKeyId: input.apiKeyId,
            apiKeyName: input.apiKeyName,
          },
          reason: { kind: "TEXT", text: input.reason },
          openRoute: await this.deliveries.findOpenStopRoute(deliveryId),
        },
      );
    } catch (error) {
      if (!(error instanceof DeliveryStatusConflictError)) throw error;

      // It moved since it was read, and nothing was written. What it moved
      // to decides: cancelled by the twin call (or the panel) is this
      // cancel's answer; on the truck or delivered is the refusal.
      const now = await this.deliveries.findDeliveryById(deliveryId);

      if (
        now &&
        now.businessId === businessId &&
        this.decide(now) === "REPLAY"
      ) {
        return this.answer(businessId, deliveryId, true);
      }

      // Back to another status the API cancels (Insucesso sent to Pendente):
      // nothing was written, and the next call decides on it.
      throw new IntegrationDeliveryStatusConflictError();
    }

    return this.answer(businessId, deliveryId, false);
  }

  /** CANCEL or REPLAY; a refused status throws its 409. */
  private decide(delivery: Delivery): "CANCEL" | "REPLAY" {
    if (isNotCancellable(delivery.status)) {
      throw new DeliveryNotCancellableError(delivery.status);
    }

    return integrationCancelVerdict(delivery.status) === "REPLAY"
      ? "REPLAY"
      : "CANCEL";
  }

  /** The delivery as committed, narrowed to what a cancel-only key may see. */
  private async answer(
    businessId: string,
    deliveryId: string,
    replayed: boolean,
  ): Promise<CancelIntegrationDeliveryResult> {
    const published = await this.integration.findDelivery(
      businessId,
      deliveryId,
    );

    if (!published) {
      throw new AppError("Entrega não encontrada.", 404, "NOT_FOUND");
    }

    return { replayed, delivery: toPublicDeliveryCancellation(published) };
  }
}

export { CancelIntegrationDeliveryUseCase };
export type { CancelIntegrationDeliveryInput, CancelIntegrationDeliveryResult };
