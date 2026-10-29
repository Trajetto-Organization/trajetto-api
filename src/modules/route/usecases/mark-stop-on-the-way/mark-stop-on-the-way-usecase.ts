import { inject, injectable } from "tsyringe";

import database from "@/../infra/database";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { NotificationService } from "@/shared/services/notification-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import {
  buildDeliveryCustomerPayload,
  hasSomebodyToTell,
} from "@/shared/delivery/customer-notice";
import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";

import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";
import { sendRouteEventToBusiness } from "@/websocket";

import type { IStopOnTheWayRepository } from "./IStop-on-the-way-repository";
import { StopOnTheWayRepository } from "./stop-on-the-way-repository";

import {
  laterOf,
  onTheWayInstant,
  onTheWayRefusal,
  shouldNoticeCustomer,
} from "./on-the-way-rules";

interface MarkStopOnTheWayRequest {
  userId: string;
  businessId: string;
  routeId: string;
  stopId: string;

  client_submission_id: string;
  latitude?: number | null;
  longitude?: number | null;

  /**
   * When the driver tapped, for a mark the app sent later
   * (resolveOccurredAt). Absent means now.
   */
  occurredAt?: Date | null;
}

interface MarkStopOnTheWayResult {
  stopId: string;
  routeId: string;
  deliveryId: string;

  /** The instant this mark recorded; a replay answers the same one. */
  on_the_way_at: Date;
}

function stopNotFound(): AppError {
  return new AppError(
    "Parada não encontrada nesta rota.",
    404,
    "ROUTE_STOP_NOT_FOUND",
  );
}

function submissionReused(): AppError {
  return new AppError(
    "Esta chave de envio já foi usada em outro registro. Gere uma chave nova e envie de novo.",
    409,
    "SUBMISSION_ID_REUSED",
  );
}

/**
 * "Estou a caminho" (decision 6.4): the driver tells the operation which
 * address they are heading to now.
 *
 * One tap, three consequences, and only the first is a write the driver
 * waits for:
 * - the stop keeps the instant (`on_the_way_at`) and the delivery's trail an
 *   ON_THE_WAY event, in one transaction;
 * - the tower, the monitoring board and the Rotas screens hear it over the
 *   socket after the commit;
 * - the person waiting is told through the customer notice pipeline — and
 *   only when the company wrote an active "a caminho" template, the delivery
 *   has a contact and the person did not opt out. None of that is decided
 *   here: this publishes the moment, the policy decides whether it speaks.
 *
 * Idempotent for the app's outbox by `client_submission_id`: a resend of a
 * mark that landed answers the same result, even after the stop moved on.
 */
@injectable()
class MarkStopOnTheWayUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject(StopOnTheWayRepository)
    private stops: IStopOnTheWayRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  async execute({
    userId,
    businessId,
    routeId,
    stopId,
    client_submission_id,
    latitude,
    longitude,
    occurredAt,
  }: MarkStopOnTheWayRequest): Promise<MarkStopOnTheWayResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    // The dispatcher has `delivery_manage:write` too; heading somewhere is
    // the driver's statement to make. A permission refusal, so the one code
    // decision 4.1 gives it.
    if (!findUser.driverId) {
      throw permissionDenied(
        "Apenas o motorista da rota pode avisar que está a caminho.",
      );
    }

    const target = await this.stops.findTarget(stopId, routeId, businessId);

    // Missing, of another route, of another company or of another driver's
    // route: one answer, so a driver token cannot learn which ids are real.
    if (!target || target.route.driverId !== findUser.driverId) {
      throw stopNotFound();
    }

    const replayed = await this.replayOf(
      client_submission_id,
      businessId,
      target,
    );

    if (replayed) return replayed;

    // Asked before the transaction for a cheap refusal, and again under the
    // route lock, where it decides.
    const early = onTheWayRefusal({
      routeStatus: target.route.status,
      stopStatus: target.stop.status,
    });

    if (early) throw new AppError(early.message, 409, early.code);

    const now = new Date();

    const at = onTheWayInstant({
      occurredAt,
      startedAt: target.route.started_at,
      now,
    });

    try {
      await database.$transaction(async (tx) => {
        const locked = await this.stops.lockForMark(
          stopId,
          routeId,
          businessId,
          tx,
        );

        if (!locked || locked.driverId !== findUser.driverId) {
          throw stopNotFound();
        }

        const refusal = onTheWayRefusal({
          routeStatus: locked.routeStatus,
          stopStatus: locked.stopStatus,
        });

        if (refusal) throw new AppError(refusal.message, 409, refusal.code);

        await this.stops.applyMark(
          {
            stopId,
            routeId,
            businessId,
            deliveryId: locked.deliveryId,
            stopOnTheWayAt: laterOf(locked.on_the_way_at, at),
            at,
            reportedById: userId,
            client_submission_id,
            latitude: latitude ?? null,
            longitude: longitude ?? null,
          },
          tx,
        );

        // In the same commit as the mark, like "saiu para entrega": an event
        // queued after it is one a crash in between erases. The previous
        // instant is read under the lock, so two first marks racing on one
        // stop tell the customer once; the key says so again to the outbox.
        if (
          shouldNoticeCustomer({
            previousOnTheWayAt: locked.on_the_way_at,
            at,
            now,
          }) &&
          hasSomebodyToTell(target.delivery)
        ) {
          await this.outbox.publish(tx, {
            topic: "delivery.on_the_way",
            aggregateType: "delivery",
            aggregateId: locked.deliveryId,
            businessId,
            actorId: userId,
            eventKey: `delivery.on_the_way:${stopId}`,
            payload: buildDeliveryCustomerPayload(locked.deliveryId, {
              ...target.delivery,
              businessId,
            }),
          });
        }
      });
    } catch (error) {
      // Two sends of the same submission racing: the loser's insert hits the
      // unique index. The winner's mark is the answer, as for any resend.
      if (violatesUniqueOn(error, "client_submission_id")) {
        const winner = await this.replayOf(
          client_submission_id,
          businessId,
          target,
        );

        if (winner) return winner;

        // Used by another company: its row is invisible here, but the key is
        // not free.
        throw submissionReused();
      }

      if (error instanceof AppError) throw error;

      throw new AppError(
        "Houve um erro ao tentar avisar que está a caminho! Por favor, tente novamente.",
        500,
      );
    }

    // After the commit: a frame about a write that rolled back is a lie the
    // board cannot undo. The board patches the dot from it.
    sendRouteEventToBusiness(businessId, {
      type: "route-stop.on_the_way",
      routeId,
      routeCode: target.route.code,
      stopId,
      stopStatus: "PENDING",
      deliveryId: target.stop.deliveryId,
      onTheWayAt: at.toISOString(),
    });

    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "update",
      entityId: target.stop.deliveryId,
      description:
        `Entrega para ${target.delivery.recipient_name}: ` +
        "motorista a caminho do endereço",
      status: DELIVERY_STATUS_LABELS.IN_TRANSIT,
      performedBy: userId,
      businessId,
    });

    return {
      stopId,
      routeId,
      deliveryId: target.stop.deliveryId,
      on_the_way_at: at,
    };
  }

  /**
   * The answer a submission already got, or null when it is new.
   *
   * The same key on anything else — another event type, another delivery or
   * route — is a client bug, refused rather than answered with somebody
   * else's result.
   */
  private async replayOf(
    clientSubmissionId: string,
    businessId: string,
    target: { stop: { id: string; deliveryId: string }; route: { id: string } },
  ): Promise<MarkStopOnTheWayResult | null> {
    const recorded = await this.stops.findBySubmission(
      clientSubmissionId,
      businessId,
    );

    if (!recorded) return null;

    if (
      recorded.type !== "ON_THE_WAY" ||
      recorded.deliveryId !== target.stop.deliveryId ||
      recorded.routeId !== target.route.id
    ) {
      throw submissionReused();
    }

    return {
      stopId: target.stop.id,
      routeId: target.route.id,
      deliveryId: target.stop.deliveryId,
      on_the_way_at: recorded.at,
    };
  }
}

export { MarkStopOnTheWayUseCase };
export type { MarkStopOnTheWayRequest, MarkStopOnTheWayResult };
