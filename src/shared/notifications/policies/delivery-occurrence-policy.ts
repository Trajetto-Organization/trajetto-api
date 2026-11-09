import { NotificationCategory } from "@prisma/client";

import {
  DeliveryOccurrenceAuthorizationDecidedPayload,
  DeliveryOccurrenceAuthorizationEscalatedPayload,
  DeliveryOccurrenceAuthorizationRequestedPayload,
  DeliveryOccurrenceReportedPayload,
  NotificationPolicyEntry,
  PolicyDeps,
  RenderContext,
  RenderedInApp,
  RenderedPush,
} from "../notification-types";
import { PUSH_TTL_SECONDS } from "../push-validity";
import type { RenderedWhatsApp } from "../whatsapp-templates";
import {
  answersLine as answersWithin,
  oneLine,
  requesterLabel,
} from "../whatsapp-parameters";

import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";
import { logger } from "@/shared/logging/logger";

import type { User } from "@/modules/user/dtos/user-dto";
import type { IOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/IOccurrence-authorization-repository";

/**
 * The occurrence notices of the operation.
 *
 * Who hears them is the people who run the deliveries (DLVP-NOTIF-1): the
 * company's administrators AND the tower's operators — every BUSINESS_USER
 * whose profile writes `delivery_manage`. It used to be the administrators
 * only, so the operator watching the tower learned of an insucesso from the
 * socket and nothing else, and could never be asked to authorize one.
 *
 * - `delivery-occurrence.reported`: a blocking occurrence changed a
 *   delivery's fate to Insucesso. Informational ones stay in the trail.
 * - `delivery-occurrence.authorization_requested`: a driver waits at the
 *   address for the tower's answer (decision 6.3). Mandatory in-app.
 * - `delivery-occurrence.authorization_escalated`: nobody answered within
 *   the window; the administrators hear it once.
 * - `delivery-occurrence.authorization_decided`: the answer, pushed to the
 *   driver who asked.
 */

const TOWER_PATH = "/dashboard/control-tower";

const log = logger.child({ component: "delivery-occurrence-policy" });

/** The WhatsApp's answers line: shorter than the in-app's 280 (B1). */
const WHATSAPP_ANSWERS_MAX = 200;

/**
 * Why a notice about a request is no longer worth fanning out, or null. A
 * request decided, superseded, or whose attempt ended (authorization-liveness)
 * since the notice was written: "a driver waits" would send an operator — or,
 * for the escalation, every administrator — to a request that is not there.
 */
async function authorizationNoLongerWaiting(
  payload: DeliveryOccurrenceAuthorizationRequestedPayload,
  deps: PolicyDeps,
): Promise<string | null> {
  const repository = deps.occurrenceAuthorizationRepository as
    IOccurrenceAuthorizationRepository | undefined;

  // Without the lookup there is nothing to say it stopped waiting.
  if (!repository) return null;

  const waiting = await repository.isWaiting(
    payload.occurrenceId,
    payload.businessId,
  );

  return waiting
    ? null
    : "Pedido de autorização já resolvido: decidido, superado ou a entrega saiu da tentativa";
}

/** Decision 14.3: a DELIVERED request asks to prove the delivery. */
function isDeliveryRequest(payload: { category?: string }): boolean {
  return payload.category === "DELIVERED";
}

/**
 * What tells the app a notice is a request it can answer (wave 4).
 *
 * The notice's `type` stays the generic "delivery" and its `entityId` the
 * delivery: the web, the builds already in the field and `read-by-entity`
 * read them that way. The push adds what the decision endpoint needs, the
 * occurrence id (`POST /delivery/occurrence-authorization/:occurrenceId/
 * business/:businessId`; the company is the push's own `businessId`). The
 * inbox row has no free-form column, so the row keeps today's behaviour.
 */
const OCCURRENCE_AUTHORIZATION_KIND = "occurrence-authorization";

function authorizationPushData(payload: {
  occurrenceId: string;
}): Record<string, string> {
  return {
    kind: OCCURRENCE_AUTHORIZATION_KIND,
    occurrenceId: payload.occurrenceId,
  };
}

function renderDeliveryOccurrenceInApp(
  payload: DeliveryOccurrenceReportedPayload,
  ctx: RenderContext,
): RenderedInApp {
  return {
    type: "delivery",
    title: "Entrega com insucesso",
    message:
      `${payload.occurrenceTypeName}: ${payload.reporterName} registrou a ` +
      `ocorrência na entrega para ${payload.recipientName}.`,
    link: `${ctx.baseUrl}/dashboard/deliveries?search=${payload.deliveryId}&page=1`,
    entityId: payload.deliveryId,
  };
}

/**
 * trajetto_entrega_insucesso (B1). Its fixed text says "Insucesso": the
 * topic is published only when a blocking occurrence moved the delivery to
 * FAILED (occurrence-effect.ts). Anything else reaching here would make the
 * approved text false, so it is not sent — and logged, because it means a
 * publisher broke that rule.
 */
function renderDeliveryOccurrenceWhatsApp(
  payload: DeliveryOccurrenceReportedPayload,
): RenderedWhatsApp | null {
  if (payload.deliveryStatusAfter !== DELIVERY_STATUS_LABELS.FAILED) {
    log.error(
      {
        deliveryId: payload.deliveryId,
        businessId: payload.businessId,
        deliveryStatusAfter: payload.deliveryStatusAfter,
      },
      "delivery-occurrence.reported without an insucesso: whatsapp skipped",
    );

    return null;
  }

  return {
    template: "trajetto_entrega_insucesso",
    parameters: [
      payload.recipientName,
      payload.occurrenceTypeName,
      payload.reporterName,
      oneLine(payload.description),
      payload.photosCount > 0 ? String(payload.photosCount) : null,
    ],
  };
}

/** "Rótulo: valor; Rótulo: valor", capped: a notice is not the report. */
function answersLine(
  answers: Array<{ label: string; value: string }>,
): string | null {
  if (answers.length === 0) return null;

  const line = answers
    .map(({ label, value }) => `${label}: ${value}`)
    .join("; ");

  return line.length > 280 ? `${line.slice(0, 277)}...` : line;
}

function renderAuthorizationRequestedInApp(
  payload: DeliveryOccurrenceAuthorizationRequestedPayload,
  ctx: RenderContext,
): RenderedInApp {
  const answers = answersLine(payload.answers);

  return {
    type: "delivery",
    title: isDeliveryRequest(payload)
      ? "Entrega aguardando autorização"
      : "Ocorrência aguardando autorização",
    message:
      `${payload.reporterName} pede autorização para "${payload.occurrenceTypeName}" ` +
      `na entrega para ${payload.recipientName}.` +
      (answers ? ` ${answers}` : ""),
    link: `${ctx.baseUrl}${TOWER_PATH}`,
    entityId: payload.deliveryId,
    pushData: authorizationPushData(payload),
  };
}

/**
 * trajetto_autorizacao_entrega for a request to prove the delivery (decision
 * 14.3), trajetto_autorizacao_ocorrencia for the rest (B1).
 */
function renderAuthorizationRequestedWhatsApp(
  payload: DeliveryOccurrenceAuthorizationRequestedPayload,
): RenderedWhatsApp {
  return {
    template: isDeliveryRequest(payload)
      ? "trajetto_autorizacao_entrega"
      : "trajetto_autorizacao_ocorrencia",
    parameters: [
      payload.recipientName,
      payload.occurrenceTypeName,
      requesterLabel(payload),
      answersWithin(payload.answers, WHATSAPP_ANSWERS_MAX),
      oneLine(payload.description),
    ],
  };
}

function renderAuthorizationEscalatedInApp(
  payload: DeliveryOccurrenceAuthorizationEscalatedPayload,
  ctx: RenderContext,
): RenderedInApp {
  return {
    type: "delivery",
    title: "Autorização sem resposta",
    message:
      `Há ${payload.waitingMinutes} min ${payload.reporterName} aguarda a torre ` +
      `sobre "${payload.occurrenceTypeName}" na entrega para ` +
      `${payload.recipientName}. Ninguém decidiu ainda.`,
    link: `${ctx.baseUrl}${TOWER_PATH}`,
    entityId: payload.deliveryId,
    // The administrators are asked to decide the same request.
    pushData: authorizationPushData(payload),
  };
}

/**
 * trajetto_autorizacao_sem_resposta (B1). A panel request has nobody
 * standing at the address, so only a driver's says they are waiting.
 */
function renderAuthorizationEscalatedWhatsApp(
  payload: DeliveryOccurrenceAuthorizationEscalatedPayload,
): RenderedWhatsApp {
  return {
    template: "trajetto_autorizacao_sem_resposta",
    parameters: [
      payload.recipientName,
      String(payload.waitingMinutes),
      payload.occurrenceTypeName,
      requesterLabel(payload, { waiting: true }),
    ],
  };
}

function renderAuthorizationDecidedPush(
  payload: DeliveryOccurrenceAuthorizationDecidedPayload,
): RenderedPush {
  const approved = payload.decision === "APPROVED";

  // An approval of a blocking type ends the attempt as an insucesso: "pode
  // seguir" would tell the driver the opposite of what happened.
  const endedAsFailure = approved && payload.deliveryStatus === "FAILED";

  // Decision 14.3: approving a delivery request proved the delivery.
  if (isDeliveryRequest(payload)) {
    return {
      title: approved ? "✅ Entrega autorizada" : "⛔ Entrega não autorizada",
      body: approved
        ? `${payload.occurrenceTypeName} — ${payload.recipientName}: entrega registrada como Entregue.` +
          (payload.note ? ` ${payload.note}` : "")
        : `${payload.occurrenceTypeName} — ${payload.recipientName}: ${payload.note ?? "a torre negou a entrega."}`,
      data: {
        url: "/deliveries",
        entityId: payload.deliveryId,
        occurrenceId: payload.occurrenceId,
        decision: payload.decision,
        deliveryStatus: payload.deliveryStatus ?? null,
        note: payload.note,
        category: "DELIVERED",
        // Tickets design §5.4: the tap opens the ticket the decision closed.
        ticketId: payload.ticketId ?? null,
      },
    };
  }

  return {
    title: approved
      ? "✅ Ocorrência autorizada"
      : "⛔ Ocorrência não autorizada",
    body: endedAsFailure
      ? `${payload.occurrenceTypeName} — ${payload.recipientName}: entrega registrada como Insucesso.` +
        (payload.note ? ` ${payload.note}` : "")
      : approved
        ? `${payload.occurrenceTypeName} — ${payload.recipientName}: pode seguir.` +
          (payload.note ? ` ${payload.note}` : "")
        : `${payload.occurrenceTypeName} — ${payload.recipientName}: ${payload.note ?? "a torre negou o pedido."}`,

    // The app opens the delivery list; the ids let it go to the card. The
    // delivery rides in `entityId`, like the proof warning's: the pipeline
    // stamps its own record id over `data.deliveryId` on every push. The
    // status and the note travel as data so the app does not parse the body.
    data: {
      url: "/deliveries",
      entityId: payload.deliveryId,
      occurrenceId: payload.occurrenceId,
      decision: payload.decision,
      deliveryStatus: payload.deliveryStatus ?? null,
      note: payload.note,
      // Tickets design §5.4: the tap opens the ticket the decision closed.
      ticketId: payload.ticketId ?? null,
    },
  };
}

const deliveryOccurrenceReportedPolicy: NotificationPolicyEntry<DeliveryOccurrenceReportedPayload> =
  {
    category: NotificationCategory.TASKS,

    async resolveRecipients(payload, deps) {
      return deps.userRepository.findDeliveryOperators(payload.businessId);
    },

    // No renderActivity on purpose: the use case already records the trail
    // for every occurrence, blocking or not — a second record here would
    // duplicate it.
    renderInApp: renderDeliveryOccurrenceInApp,
    renderWhatsApp: renderDeliveryOccurrenceWhatsApp,
  };

const deliveryOccurrenceAuthorizationRequestedPolicy: NotificationPolicyEntry<DeliveryOccurrenceAuthorizationRequestedPayload> =
  {
    category: NotificationCategory.TASKS,
    // Somebody is standing at an address waiting: preferences control noise,
    // not a request that blocks a driver.
    mandatory: true,

    // Checked when the notice fans out: a request decided or superseded
    // before that rings nobody. And on every attempt of an e-mail, WhatsApp
    // or push already queued (supersededReason): one decided while its rows
    // waited, or were retried, stops there. The inbox row stays.
    async resolveRecipients(payload, deps) {
      if (await authorizationNoLongerWaiting(payload, deps)) return [];

      return deps.userRepository.findDeliveryOperators(payload.businessId);
    },

    supersededReason: authorizationNoLongerWaiting,

    renderInApp: renderAuthorizationRequestedInApp,
    renderWhatsApp: renderAuthorizationRequestedWhatsApp,
  };

const deliveryOccurrenceAuthorizationEscalatedPolicy: NotificationPolicyEntry<DeliveryOccurrenceAuthorizationEscalatedPayload> =
  {
    category: NotificationCategory.TASKS,
    mandatory: true,

    // Same checks as the request's notice above.
    async resolveRecipients(payload, deps) {
      if (await authorizationNoLongerWaiting(payload, deps)) return [];

      return deps.userRepository.findBusinessAdminsByBusinessId(
        payload.businessId,
      );
    },

    supersededReason: authorizationNoLongerWaiting,

    renderInApp: renderAuthorizationEscalatedInApp,
    renderWhatsApp: renderAuthorizationEscalatedWhatsApp,
  };

const deliveryOccurrenceAuthorizationDecidedPolicy: NotificationPolicyEntry<DeliveryOccurrenceAuthorizationDecidedPayload> =
  {
    category: NotificationCategory.TASKS,
    // Push-only and mandatory, like the route notices: the driver is at the
    // address with the phone in the pocket, waiting for exactly this.
    mandatory: true,

    async resolveRecipients(payload, deps): Promise<User[]> {
      if (!payload.driverUserId) return [];

      const user = await deps.userRepository.findUserById(payload.driverUserId);

      return user ? [user] : [];
    },

    renderPush: renderAuthorizationDecidedPush,
    pushTtlSeconds: PUSH_TTL_SECONDS.towerDecision,
  };

export {
  OCCURRENCE_AUTHORIZATION_KIND,
  deliveryOccurrenceAuthorizationDecidedPolicy,
  deliveryOccurrenceAuthorizationEscalatedPolicy,
  deliveryOccurrenceAuthorizationRequestedPolicy,
  deliveryOccurrenceReportedPolicy,
  renderAuthorizationDecidedPush,
  renderAuthorizationEscalatedInApp,
  renderAuthorizationEscalatedWhatsApp,
  renderAuthorizationRequestedInApp,
  renderAuthorizationRequestedWhatsApp,
  renderDeliveryOccurrenceInApp,
  renderDeliveryOccurrenceWhatsApp,
};
