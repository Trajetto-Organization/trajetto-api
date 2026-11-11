import { inject, injectable } from "tsyringe";
import { Prisma } from "@prisma/client";
import type { ZodError } from "zod";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";

import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import { IProofAuditRepository } from "../../repositories/IProof-audit-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { NotificationService } from "@/shared/services/notification-service";

import { UploadService } from "@/shared/services/upload-service";
import { OutboxService } from "@/shared/notifications/outbox-service";
import { validationError } from "@/shared/validation/validation-error";

import database from "@/../infra/database";

import {
  DeliveryNotFoundError,
  DeliveryStatusConflictError,
} from "../errors/delivery-errors";

import { OccurrenceTypeNotFoundError } from "@/modules/occurrence-type/usecases/errors/occurrence-type-errors";

import {
  canTransitionDelivery,
  DELIVERY_STATUS_LABELS,
  isTerminalDeliveryStatus,
  type DeliveryStatus,
} from "@/shared/delivery/delivery-rules";

import type { ProofCapture } from "@/shared/delivery/proof-capture";
import { announceDroppedPlans } from "@/modules/route/usecases/shared/route-plan-change";
import type { PlanBump } from "@/modules/route/dtos/route-dto";
import { announceStopSettled } from "@/shared/route/route-realtime";

import { AppError } from "@/shared/errors/AppError";
import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { submissionReused } from "@/shared/delivery/submission-reused";
import { violatesUniqueOn } from "@/shared/delivery/unique-violation";
import type { GeofenceCheck } from "@/shared/delivery/geofence/geofence-check";
import { resolveEnabledModules } from "@/modules/user/usecases/get-user/get-user-usecase";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";

import {
  readFormFields,
  validateOccurrenceAnswers,
} from "@/modules/occurrence-type/form/occurrence-form-rules";
import {
  acceptedAttachments,
  missingRequirements,
  type MissingRequirement,
  type OccurrenceCategoryKey,
} from "@/modules/occurrence-type/rules/occurrence-category-rules";
import {
  tappedBeforeRequirementsChanged,
  waivedRequirementsNote,
} from "./requirement-waiver";
import { lateProofNote, lateProofVerdict, type LateProof } from "./late-proof";
import type { LostStop } from "@/modules/route/dtos/route-dto";

import { sendOccurrenceAuthorizationToBusiness } from "@/websocket";

import { aiProviderConfigured } from "@/shared/ai/ai-provider";
import {
  acceptDevicePrecheck,
  type DevicePrecheck,
} from "@/shared/ai-precheck/device-precheck";

import type { OccurrenceAuthorizationStatus } from "../../dtos/delivery-dto";

import {
  announceOccurrenceEffect,
  flipDeliveryForOccurrence,
  type OccurrenceEffectDeps,
  type SettledStop,
} from "./occurrence-effect";
import {
  applyDeliveryProof,
  requestProofAnalysis,
  type DeliveryProofEffectDeps,
} from "../register-delivery-proof/delivery-proof-effect";
import {
  OccurrenceFormInvalidError,
  OccurrenceFormNeedsAppUpdateError,
  OccurrenceFormOutdatedError,
  OccurrenceTypeInactiveError,
  OccurrenceTypeNotReportableError,
  OccurrenceTypeWrongCategoryError,
} from "./occurrence-report-errors";
import { authorizationRequestedPayload } from "../authorize-occurrence/authorization-notice";
import { isActiveAttemptStatus } from "../authorize-occurrence/authorization-liveness";
import { canDecideAuthorizations } from "../authorize-occurrence/decider-rule";

import type { IOccurrenceAuthorizationRepository } from "../../repositories/IOccurrence-authorization-repository";
import type { OccurrenceTicketService } from "@/modules/chat/usecases/shared/ticket-operations";
import { shouldOpenTicketForOccurrence } from "@/modules/chat/usecases/shared/ticket-rules";
import type { PermissionPrincipal } from "@/modules/middlewares/verify-permission";

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

interface ReportOccurrenceRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  occurrenceTypeId: string;
  description?: string;
  latitude?: number;
  longitude?: number;
  photos?: string[];
  client_submission_id?: string;

  /**
   * When the driver reported it, for a report the app sent later
   * (resolveOccurredAt). Absent means now.
   */
  occurredAt?: Date | null;

  /** The answers to the type's form, by field key (decision 6.2). */
  form_answers?: Record<string, unknown> | null;

  /**
   * The form_version the client rendered. Only tells a stale form (409
   * OCCURRENCE_FORM_OUTDATED) from wrong answers (400): the answers are
   * always checked against the CURRENT form.
   */
  form_version?: number;

  /** Decision 14.3: the receipt photo's storage key (presigned PUT). */
  receipt_photo?: string;
  /** The on-screen signature's storage key (presigned PUT, PNG). */
  signature?: string;
  /** DELIVERED only: who received it. */
  received_by?: string;

  /**
   * The installed app's proof route (contract <= 2), adapted onto the
   * company's default delivered type. That app has no type picker, so the
   * default is used even when deactivated (design §4.7).
   */
  legacy?: boolean;

  /**
   * DELIVERED from the app (decision 14.8, design §7.2): when the receipt
   * photo was taken and which phone sent it, for the PROOF event.
   */
  capture?: ProofCapture;

  /**
   * Decision 14.2: the phone's offline check of the receipt photo. Kept on
   * the audit card of the proof it came with; a declaration of the device
   * that never moves status, quota or suggestion.
   */
  device_precheck?: DevicePrecheck | null;

  /** E4: the fix's accuracy (metres) and age at the tap, for the geofence. */
  accuracy?: number | null;
  positionAgeMs?: number | null;
}

interface ReportOccurrenceResult {
  id: string;
  /**
   * NOT_REQUIRED: the effect applied now. PENDING: waiting for the tower.
   * APPROVED: a panel report of a type that asks the tower, by someone who
   * could approve it in the queue. SUPERSEDED: the attempt had already ended
   * (delivered, cancelled, failed, or no longer this driver's): nothing to authorize.
   */
  authorization_status: OccurrenceAuthorizationStatus;

  /** True when this was a resend of a submission already recorded. */
  replayed: boolean;

  /** Decision 14.3: the category of the type reported. */
  category: OccurrenceCategoryKey;

  /** The delivery's status after the report (DELIVERED for an applied proof). */
  delivery_status: DeliveryStatus;

  /** Decision 14.5: the support ticket the report opened (or already had). */
  ticket?: { id: string; number: number } | null;

  /**
   * A proof that arrived after the delivery left the driver (K7, decision
   * D27): APPLIED, accepted as Entregue and flagged; EVIDENCE, kept with no
   * effect. Either way the tower reviews it — the app says "Enviado para
   * análise da central". Absent for every other report.
   */
  late_proof?: LateProof;
}

/** A delivered report without its key: the proof's idempotency anchor. */
function deliveredKeyRequired(): ZodError {
  return validationError([
    {
      code: "custom",
      path: ["client_submission_id"],
      message:
        "A chave de idempotência do envio (client_submission_id) é obrigatória para registrar uma entrega.",
    },
  ]);
}

@injectable()
class ReportDeliveryOccurrenceUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("UploadService")
    private uploadService: UploadService,
    @inject("OutboxService")
    private outbox: OutboxService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
    @inject("OccurrenceAuthorizationRepository")
    private authorizations: IOccurrenceAuthorizationRepository,
    @inject("ProofAuditRepository")
    private audits: IProofAuditRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    // Decision 14.5. Optional so callers built before the tickets keep working.
    @inject("OccurrenceTicketService")
    private occurrenceTickets?: OccurrenceTicketService,
    // Plan of 02/11/2026 (E4). Optional for the same reason; the container
    // always provides it.
    @inject("GeofenceCheck")
    private geofence?: GeofenceCheck,
  ) {}

  /** The repositories and services the shared occurrence effect writes through. */
  private get effectDeps(): OccurrenceEffectDeps {
    return {
      delivery: this.delivery,
      route: this.route,
      outbox: this.outbox,
      webhooks: this.webhooks,
    };
  }

  private get proofDeps(): DeliveryProofEffectDeps {
    return {
      ...this.effectDeps,
      audits: this.audits,
      tickets: this.occurrenceTickets,
    };
  }

  async execute({
    userId,
    businessId,
    deliveryId,
    occurrenceTypeId,
    description,
    latitude,
    longitude,
    photos = [],
    client_submission_id,
    occurredAt,
    form_answers,
    form_version,
    receipt_photo,
    signature,
    received_by,
    legacy = false,
    device_precheck,
    capture,
    accuracy,
    positionAgeMs,
  }: ReportOccurrenceRequest): Promise<ReportOccurrenceResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Defense in depth: a dispatcher of another company naming this one was
    // stopped only by the route guard (the driver check below is for drivers).
    assertTenantAccess(findUser, businessId);

    // Outbox resend: the same submission never becomes a second
    // occurrence, and the status flip it caused the first time is not
    // replayed. The answer says where the first one stands.
    if (client_submission_id) {
      const replay = await this.replayIfRecorded(
        client_submission_id,
        businessId,
        deliveryId,
      );

      if (replay) return replay;
    }

    const findDelivery = await this.delivery.findDeliveryById(deliveryId);

    // Another company's delivery reads exactly like a missing one (decision
    // 11.3): a separate "not yours" told any driver which ids exist elsewhere.
    if (!findDelivery || findDelivery.businessId !== businessId) {
      throw new DeliveryNotFoundError();
    }

    // Drivers only report on their own deliveries — except the proof of an
    // attempt a cancellation or a status change took from this driver while
    // they had no signal (K7, decision D27), weighed once the type is known.
    let lostStop: LostStop | null = null;

    if (findUser.driverId && findDelivery.driverId !== findUser.driverId) {
      lostStop = await this.route.findLostStop(
        deliveryId,
        findUser.driverId,
        businessId,
      );

      if (!lostStop) throw new DeliveryNotFoundError();
    }

    const findType =
      await this.occurrenceType.findOccurrenceTypeById(occurrenceTypeId);

    if (!findType || findType.businessId !== businessId) {
      throw new OccurrenceTypeNotFoundError();
    }

    // The platform's "Comprovante rejeitado" is the proof audit's record;
    // the driver's list hides it and a crafted request cannot file it.
    if (findType.is_system === true) {
      throw new OccurrenceTypeNotReportableError();
    }

    const category: OccurrenceCategoryKey =
      findType.category ?? "NOT_DELIVERED";
    const delivered = category === "DELIVERED";
    const byDriver = Boolean(findUser.driverId);

    // Only a proof gets the late path (K7); anything else about a delivery
    // that is no longer the driver's reads as missing, as before.
    if (lostStop && !delivered) throw new DeliveryNotFoundError();

    if (findType.is_active === false && !legacy) {
      // A proof made offline is not lost because somebody deactivated its
      // type afterwards: the tap happened while the type was active (§5.6).
      const tappedWhileActive =
        delivered &&
        occurredAt instanceof Date &&
        findType.deactivated_at instanceof Date &&
        occurredAt.getTime() < findType.deactivated_at.getTime();

      if (!tappedWhileActive) throw new OccurrenceTypeInactiveError();
    }

    // Pauses are an interval of the journey with their own idempotent
    // start/end (decision 14.4), never a report on a delivery.
    if (category === "PAUSE") {
      throw new OccurrenceTypeWrongCategoryError();
    }

    // Proving is the driver's: on the panel, "marcar entregue" is the status
    // change with "quem recebeu" (decision 5.3).
    if (delivered && !byDriver) {
      throw new AppError(
        "Somente o motorista registra uma entrega pelo aplicativo. No painel, use a mudança de status para Entregue.",
        403,
        "DRIVER_ONLY",
      );
    }

    if (delivered && !client_submission_id) {
      throw deliveredKeyRequired();
    }

    // What the category does not take is dropped, not refused: from the
    // offline queue a 400 is a permanent failure over an extra key.
    const accepts = acceptedAttachments(category);
    const receiptKey = accepts.receipt_photo ? (receipt_photo ?? null) : null;
    const signatureKey = accepts.signature ? (signature ?? null) : null;
    const receivedBy = accepts.received_by ? (received_by ?? null) : null;

    // The requirements bind the person in the field: a manager on the web
    // records an administrative fact and is not asked for attachments.
    // What a driver's report went without because the company changed the
    // requirements after the tap (K2): accepted, and flagged on the trail.
    let waived: MissingRequirement[] = [];

    if (byDriver) {
      const missing = missingRequirements(
        {
          category,
          requires_photo: findType.requires_photo === true,
          requires_receipt_photo: findType.requires_receipt_photo === true,
          requires_signature: findType.requires_signature === true,
        },
        {
          receipt_photo: receiptKey !== null,
          signature: signatureKey !== null,
          photos: photos.length,
        },
      );

      if (missing.length > 0) {
        if (
          !tappedBeforeRequirementsChanged(
            occurredAt,
            findType.requirements_changed_at,
          )
        ) {
          throw new AppError(missing[0].message, 400, missing[0].code);
        }

        waived = missing;
      }
    }

    // Decision 6.2: the answers against the form as it is NOW. A phone that
    // rendered an older form is told so (409 with the current form) only
    // when its answers do not fit the new one; otherwise they are taken.
    const fields = readFormFields(findType.form_fields);
    const currentVersion = findType.form_version ?? 1;
    const verdict = validateOccurrenceAnswers(fields, form_answers);

    if (Object.keys(verdict.errors).length > 0) {
      // Every build that renders forms sends the form_version it showed. A
      // driver's report without one comes from a build that cannot show this
      // form at all: an update fixes it, the driver cannot (contract §6).
      if (byDriver && form_version === undefined) {
        throw new OccurrenceFormNeedsAppUpdateError({
          fieldErrors: verdict.errors,
          formFields: fields,
          formVersion: currentVersion,
        });
      }

      if (form_version !== undefined && form_version !== currentVersion) {
        throw new OccurrenceFormOutdatedError({
          fieldErrors: verdict.errors,
          formFields: fields,
          formVersion: currentVersion,
        });
      }

      throw new OccurrenceFormInvalidError(verdict.errors);
    }

    // A delivery that can no longer become DELIVERED: unless this very
    // submission is what made it so (a twin committed after the pre-check),
    // the same refusal the proof route always gave (IDEMP-07) — or the late
    // proof of an attempt this driver lost while offline (K7, D27).
    let lateProof: LateProof | null = null;

    if (delivered) {
      const transition = canTransitionDelivery(
        findDelivery.status,
        "DELIVERED",
      );

      if (!transition.allowed || lostStop) {
        const twin = await this.replayIfRecorded(
          client_submission_id!,
          businessId,
          deliveryId,
        );

        if (twin) return twin;

        lostStop ??= await this.route.findLostStop(
          deliveryId,
          findUser.driverId!,
          businessId,
        );

        if (!lostStop) {
          throw new AppError(
            transition.reason!,
            400,
            "INVALID_STATUS_TRANSITION",
          );
        }

        lateProof = lateProofVerdict({
          occurredAt,
          lostAt: lostStop.lostAt,
          deliveryStatus: findDelivery.status,
          deliveryDriverId: findDelivery.driverId,
          driverId: findUser.driverId!,
          asksTheTower: findType.requires_authorization === true,
          // The lost stop is closed, and a delivery holds one open stop at
          // most: any open stop now is a new plan's.
          onAnotherRoute:
            (await this.delivery.findOpenStopRoute(deliveryId)) !== null,
        });
      }
    }

    // E4: where the driver was against the company's radius, for the proof
    // and the occurrence alike, recorded with the report. Under BLOCK a
    // fresh proof outside it stops here (422 ARRIVAL_OUTSIDE_GEOFENCE); an
    // occurrence or a queued report is only flagged. A manager on the panel
    // is not at the address: nothing to weigh. After every replay check, so
    // a resend never meets a radius changed since.
    const geofence = byDriver
      ? await this.geofence?.evaluate({
          businessId,
          enabledModules: resolveEnabledModules(findUser),
          action: delivered ? "PROOF" : "OCCURRENCE",
          address: findDelivery,
          position: { latitude, longitude },
          accuracy: accuracy ?? null,
          positionAgeMs: positionAgeMs ?? null,
          occurredAt: occurredAt ?? null,
        })
      : undefined;

    // Decision 6.3. A type that asks the tower waits for it — unless the
    // author IS the tower: a panel report by someone the queue would let
    // approve it counts as approved by them. Anyone else (the driver, a
    // profile that only reads deliveries) files a request. Whether that
    // request still has an attempt to be about is read under the delivery's
    // lock, inside the transaction below.
    const asksTheTower = findType.requires_authorization === true;
    const selfAuthorized =
      asksTheTower &&
      !byDriver &&
      canDecideAuthorizations(findUser as unknown as PermissionPrincipal);

    // A late proof kept as evidence (K7) has nothing to apply or to ask:
    // SUPERSEDED, the status of a report whose attempt already ended. One
    // accepted as Entregue applies as a proof does.
    let authorizationStatus: OccurrenceAuthorizationStatus =
      lateProof === "EVIDENCE"
        ? "SUPERSEDED"
        : lateProof === "APPLIED" || !asksTheTower
          ? "NOT_REQUIRED"
          : selfAuthorized
            ? "APPROVED"
            : "PENDING";

    // The effect applies now only for these two; a request (PENDING or
    // SUPERSEDED) applies nothing.
    const appliesNow =
      authorizationStatus === "NOT_REQUIRED" ||
      authorizationStatus === "APPROVED";

    // Only ownership and existence are left to check before the keys
    // become rows — the bytes went straight to the bucket.
    const photoPaths = await this.resolveKeys(photos, businessId);
    const [receiptPath = null] = await this.resolveKeys(
      receiptKey ? [receiptKey] : [],
      businessId,
    );
    const [signaturePath = null] = await this.resolveKeys(
      signatureKey ? [signatureKey] : [],
      businessId,
    );

    // Only with the receipt it is about, and only for a company that bought
    // the reading: a pre-check nobody contracted is not kept (§P5.2). The
    // replay paths above never get here, so the first write is the one kept.
    const devicePrecheck =
      delivered && receiptPath && device_precheck
        ? acceptDevicePrecheck(device_precheck, {
            kind: "proof",
            aiAnalysisLimit: (await this.business.findBusinessById(businessId))
              ?.ai_analysis_limit,
            providerConfigured: aiProviderConfigured(),
          })
        : null;

    // "On which route" for the feed and the history (TWR-6). A late proof
    // (K7) belongs to the route it was made on, the one it was taken from.
    const openStop = await this.delivery.findOpenStopRoute(deliveryId);
    const trailRouteId =
      lateProof && lostStop ? lostStop.routeId : (openStop?.routeId ?? null);

    // The row this attempt wrote, if any: a twin found after a failure is
    // another request's only when it is not this one (the rollback removes
    // ours in Postgres; a store without rollback would hand it back).
    let attemptedId: string | null = null;

    try {
      // Captured to be announced AFTER the commit: a socket event about a
      // write that rolled back is a lie the client cannot undo.
      let settled: SettledStop = null;
      let nextStatus: DeliveryStatus = findDelivery.status;
      let occurrenceId = "";
      let proofApplied = false;
      const supersededTickets = new Set<string>();
      // Plans a stop came off (design §7.1), announced after the commit.
      const droppedPlans: PlanBump[] = [];
      // Cast, not annotated: assigned inside the transaction callback, where
      // control-flow narrowing cannot see it.
      let openedTicket = null as {
        id: string;
        number: number;
        linked: boolean;
      } | null;

      // When the driver reported it: the tap for a report the app sent later
      // (MOB-08), the receipt otherwise. The stop and the webhook say the
      // same instant.
      const reportedAt = occurredAt ?? new Date();

      // Occurrence, trail event, status flip and the alerts commit together:
      // a crash in between can neither ring about a rolled-back occurrence
      // nor record an Insucesso nobody was told about.
      await database.$transaction(async (tx) => {
        // An effect that may flip the delivery and settle its stop takes the
        // running route's row first — the order a route cancellation takes
        // them in. A proof does, always: the occurrence insert below already
        // touches the delivery row (its foreign key).
        if (
          appliesNow &&
          (delivered ||
            (findType.blocks_delivery === true &&
              !isTerminalDeliveryStatus(findDelivery.status)))
        ) {
          await this.route.lockRouteOfOpenStop(deliveryId, businessId, tx);
        }

        // A request is about the attempt as it is NOW, read under the
        // delivery's row lock: a proof committing meanwhile is either seen
        // here (the request is born SUPERSEDED) or waits for this commit and
        // then supersedes the request itself. Delivered, cancelled or failed
        // (the attempt ended), or no longer this driver's: nothing to ask.
        if (authorizationStatus === "PENDING") {
          const current = await this.authorizations.lockDeliveryForRequest(
            deliveryId,
            businessId,
            tx,
          );

          const attemptOpen =
            current !== null &&
            isActiveAttemptStatus(current.status) &&
            (!byDriver || current.driverId === findUser.driverId);

          if (!attemptOpen) authorizationStatus = "SUPERSEDED";
        }

        const pending = authorizationStatus === "PENDING";

        const created = await this.delivery.createOccurrence(
          {
            deliveryId,
            occurrenceTypeId,
            reportedById: userId,
            description,
            latitude,
            longitude,
            photos: photoPaths,
            client_submission_id: client_submission_id ?? null,
            occurred_at: occurredAt ?? null,
            form_answers: verdict.answers,
            form_version: fields ? currentVersion : null,
            authorization_status:
              authorizationStatus === "NOT_REQUIRED"
                ? undefined
                : authorizationStatus,
            authorizedById: authorizationStatus === "APPROVED" ? userId : null,
            authorized_at:
              authorizationStatus === "APPROVED" ? new Date() : null,
            // Copied from the type (immutable once used), so lists and
            // counters filter without a join (decision 14.3).
            category,
            receipt_photo: receiptPath,
            signature: signaturePath,
            received_by: receivedBy,
            ...geofence,
          },
          tx,
        );

        occurrenceId = created.id;
        attemptedId = created.id;

        // K2: the flag that a report went without requirements switched on
        // after its tap, beside the report on the trail and in its commit.
        if (waived.length > 0) {
          await this.delivery.createDeliveryEvent(
            {
              type: "NOTE",
              deliveryId,
              actor: "SYSTEM",
              note: waivedRequirementsNote(findType.name, waived),
              occurred_at: occurredAt ?? null,
              occurrenceId,
              routeId: trailRouteId,
            },
            tx,
          );
        }

        // K7: the flag of a late proof, accepted or kept as evidence.
        if (lateProof && lostStop) {
          await this.delivery.createDeliveryEvent(
            {
              type: "NOTE",
              deliveryId,
              actor: "SYSTEM",
              note: lateProofNote(lateProof, lostStop),
              occurred_at: occurredAt ?? null,
              occurrenceId,
              routeId: trailRouteId,
            },
            tx,
          );
        }

        // Decision 14.5: the report's support ticket, in the same
        // transaction, last (lock order: route, delivery, occurrence,
        // ticket). A late proof always opens one (K7): it is the tower's
        // notice, whatever the category's own rule says.
        const ticketDriverId = lateProof
          ? findUser.driverId
          : findDelivery.driverId;

        const openTicket = async (): Promise<void> => {
          if (
            !this.occurrenceTickets ||
            !ticketDriverId ||
            !(
              lateProof ||
              shouldOpenTicketForOccurrence({
                authorizationStatus,
                byDriver,
                category,
                isSystem: findType.is_system === true,
              })
            )
          ) {
            return;
          }

          const opened = await this.occurrenceTickets.open(
            {
              businessId,
              deliveryId,
              driverId: ticketDriverId,
              occurrenceId,
              occurrenceTypeName: findType.name,
              recipientName: findDelivery.recipient_name,
              actor: {
                kind: byDriver ? "DRIVER_APP" : "USER",
                id: userId,
                name: findUser.name,
              },
            },
            tx,
          );

          openedTicket = {
            id: opened.ticket.id,
            number: opened.ticket.number,
            linked: opened.linked,
          };
        };

        // A delivery that applies now is the PROOF, which names this
        // occurrence: the fact's event is that one, not an OCCURRENCE too.
        if (delivered && appliesNow) {
          settled = await applyDeliveryProof(this.proofDeps, {
            tx,
            businessId,
            deliveryId,
            delivery: findDelivery,
            expectedStatus: findDelivery.status,
            reportedById: userId,
            actorId: userId,
            occurrenceId,
            receiptPhoto: receiptPath,
            signature: signaturePath,
            receivedBy,
            latitude: latitude ?? null,
            longitude: longitude ?? null,
            provenAt: reportedAt,
            occurredAt: occurredAt ?? null,
            eventSubmissionId: client_submission_id ?? null,
            devicePrecheck,
            capture,
            routeId: trailRouteId,
            geofence,
            // A late proof (K7): the delivery goes back to the driver and
            // truck of the route it was taken from, who delivered it.
            owner:
              lateProof === "APPLIED" && lostStop
                ? {
                    driverId: findUser.driverId!,
                    vehicleId: lostStop.vehicleId,
                  }
                : undefined,
            onTicketSuperseded: (ticketId) => supersededTickets.add(ticketId),
            onPlanDropped: (bump) => droppedPlans.push(bump),
          });

          nextStatus = "DELIVERED";
          proofApplied = true;

          // Only a late proof opens a ticket on a delivery (K7).
          await openTicket();

          return;
        }

        // Every report lands on the trail and the tower's feed (TWR-6), a
        // pending one included: the feed reads its authorization status and
        // does not count it as an insucesso while it waits.
        await this.delivery.createDeliveryEvent(
          {
            type: "OCCURRENCE",
            deliveryId,
            reportedById: userId,
            actor: byDriver ? "DRIVER_APP" : "USER",
            latitude: latitude ?? null,
            longitude: longitude ?? null,
            occurred_at: occurredAt ?? null,
            occurrenceId,
            routeId: trailRouteId,
            ...geofence,
          },
          tx,
        );

        await openTicket();

        if (pending) {
          // No effect while it waits: no FAILED, no stop, no webhook. Only
          // the people who can answer are told.
          await this.outbox.publish(tx, {
            topic: "delivery-occurrence.authorization_requested",
            aggregateType: "delivery",
            aggregateId: deliveryId,
            businessId,
            actorId: userId,
            // One request, one notice, whatever retries the pipeline makes.
            eventKey: `delivery-occurrence.authorization_requested:${occurrenceId}`,
            payload: authorizationRequestedPayload({
              occurrenceId,
              deliveryId,
              businessId,
              recipientName: findDelivery.recipient_name,
              occurrenceTypeName: findType.name,
              blocksDelivery: findType.blocks_delivery === true,
              description: description ?? null,
              reporterName: findUser.name,
              fromDriver: byDriver,
              photosCount: photoPaths.length,
              formFields: fields,
              answers: verdict.answers,
              requestedAt: new Date(),
              category: delivered ? "DELIVERED" : "NOT_DELIVERED",
            }),
          });

          return;
        }

        // A delivered request that has nothing left to authorize applies
        // nothing either.
        if (authorizationStatus === "SUPERSEDED" || delivered) return;

        nextStatus = await flipDeliveryForOccurrence(this.effectDeps, {
          tx,
          deliveryId,
          currentStatus: findDelivery.status,
          blocksDelivery: findType.blocks_delivery === true,
        });

        settled = await announceOccurrenceEffect(this.effectDeps, {
          tx,
          businessId,
          deliveryId,
          delivery: findDelivery,
          previousStatus: findDelivery.status,
          nextStatus,
          occurrenceTypeName: findType.name,
          occurrenceTypeCode: findType.code ?? null,
          blocksDelivery: findType.blocks_delivery === true,
          description: description ?? null,
          photosCount: photoPaths.length,
          actorId: userId,
          reporterName: findUser.name,
          at: reportedAt,
          onPlanDropped: (bump) => droppedPlans.push(bump),
        });
      });

      // The receipt is read once the delivery is proven: a pending request
      // waits for the tower, and the approval asks with the same instant
      // (one photo, one unit; decision 14.1).
      if (proofApplied && receiptPath) {
        await requestProofAnalysis(this.business, {
          deliveryId,
          businessId,
          requestedById: userId,
          photoPath: receiptPath,
          signaturePath,
          delivery: findDelivery,
          provenAt: reportedAt,
        });
      }

      // The panel and the control tower are watching this stop.
      announceStopSettled(businessId, settled);

      await announceDroppedPlans(this.user, businessId, droppedPlans);

      // The tickets whose request this proof superseded (design §5.2).
      for (const ticketId of supersededTickets) {
        await this.occurrenceTickets?.announce({
          ticketId,
          businessId,
          type: "ticket.authorization_changed",
          actor: null,
        });
      }

      // As decided inside the transaction, which may have closed the request.
      const pending = authorizationStatus === "PENDING";

      if (pending) {
        // Every open tower and Ocorrências tab adds it to the queue now.
        sendOccurrenceAuthorizationToBusiness(businessId, {
          type: "occurrence.authorization_requested",
          occurrenceId,
          deliveryId,
          status: "PENDING",
          category: delivered ? "DELIVERED" : "NOT_DELIVERED",
        });
      }

      if (openedTicket && this.occurrenceTickets) {
        await this.occurrenceTickets.announce({
          ticketId: openedTicket.id,
          businessId,
          type: openedTicket.linked ? "ticket.linked" : "ticket.opened",
          actor: { id: userId, name: findUser.name },
          alert: {
            reason: pending ? "AUTHORIZATION" : "OCCURRENCE",
            occurrenceTypeName: findType.name,
            recipientName: findDelivery.recipient_name,
          },
        });
      }

      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "update",
        entityId: deliveryId,
        description: proofApplied
          ? `Entrega para ${findDelivery.recipient_name}: ` +
            `${DELIVERY_STATUS_LABELS[findDelivery.status]} → ` +
            `${DELIVERY_STATUS_LABELS.DELIVERED} (comprovada pelo motorista — "${findType.name}")`
          : `${delivered ? "Entrega" : "Ocorrência"} "${findType.name}" registrada na entrega para ` +
            `${findDelivery.recipient_name}` +
            (pending ? " (aguardando autorização da torre)" : ""),
        status: DELIVERY_STATUS_LABELS[nextStatus],
        performedBy: userId,
        businessId,
      });

      return {
        id: occurrenceId,
        authorization_status: authorizationStatus,
        replayed: false,
        category,
        delivery_status: nextStatus,
        ticket: openedTicket
          ? { id: openedTicket.id, number: openedTicket.number }
          : null,
        ...(lateProof && { late_proof: lateProof }),
      };
    } catch (error) {
      // A resend whose twin committed after the pre-check above: its insert
      // meets the twin's row in the unique index on client_submission_id and
      // rolls back. The occurrence exists, so the resend is a success; the
      // twin already ran every side effect (IDEMP-07).
      if (
        client_submission_id &&
        (isUniqueViolation(error) ||
          error instanceof DeliveryStatusConflictError)
      ) {
        const twin = await this.replayIfRecorded(
          client_submission_id,
          businessId,
          deliveryId,
        );

        if (twin && twin.id !== attemptedId) return twin;

        // Refused by the unique index with no twin of this submission
        // behind it: another company spent the key (its row is invisible
        // here). A 409 the app files for review, never a 500 (K13).
        if (violatesUniqueOn(error, "client_submission_id")) {
          throw submissionReused();
        }
      }

      if (error instanceof DeliveryStatusConflictError) {
        throw new AppError(error.message, 409, "DELIVERY_STATUS_CONFLICT");
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar registrar a ocorrência! Por favor, tente novamente.",
        500,
      );
    }
  }

  /**
   * Where an already recorded submission stands, or null. The occurrence is
   * the anchor; a PROOF event carrying the key (a proof recorded by the
   * legacy route before decision 14.3) is the same delivered submission.
   *
   * The key on another delivery, or on an event that is not a PROOF (an
   * arrival, "a caminho"), is not this submission: 409 SUBMISSION_ID_REUSED
   * rather than somebody else's result (K13).
   */
  async replayIfRecorded(
    clientSubmissionId: string,
    businessId: string,
    deliveryId: string,
  ): Promise<ReportOccurrenceResult | null> {
    const occurrence = await this.delivery.findOccurrenceBySubmissionId(
      clientSubmissionId,
      businessId,
    );

    if (occurrence) {
      if (occurrence.deliveryId !== deliveryId) throw submissionReused();

      return {
        id: occurrence.id,
        authorization_status: occurrence.authorization_status,
        replayed: true,
        category: occurrence.category,
        delivery_status: await this.statusOf(deliveryId, businessId),
        // The replay names the ticket the first submission opened.
        ticket: this.occurrenceTickets
          ? await this.occurrenceTickets.ticketOf(occurrence.id, businessId)
          : null,
      };
    }

    const event = await this.delivery.findEventBySubmissionId(
      clientSubmissionId,
      businessId,
    );

    if (event) {
      if (event.type !== "PROOF" || event.deliveryId !== deliveryId) {
        throw submissionReused();
      }

      return {
        id: event.id,
        authorization_status: "NOT_REQUIRED",
        replayed: true,
        category: "DELIVERED",
        delivery_status: await this.statusOf(event.deliveryId, businessId),
      };
    }

    return null;
  }

  private async statusOf(
    deliveryId: string,
    businessId: string,
  ): Promise<DeliveryStatus> {
    const found = await this.delivery.findDeliveryById(deliveryId);

    return found && found.businessId === businessId
      ? found.status
      : "DELIVERED";
  }

  private async resolveKeys(
    keys: string[],
    businessId: string,
  ): Promise<string[]> {
    if (keys.length === 0) return [];

    const resolved = await this.uploadService.resolvePresignedUploads(
      keys.map((key) => ({ key })),
      "deliveryPhotos",
      businessId,
    );

    return resolved.map((entry) => entry.path);
  }
}

export { ReportDeliveryOccurrenceUseCase };
export type { ReportOccurrenceRequest, ReportOccurrenceResult };
