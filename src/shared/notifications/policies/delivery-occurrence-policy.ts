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
    | IOccurrenceAuthorizationRepository
    | undefined;

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

/** "Motorista" when a driver asked; otherwise who filed it from the panel. */
function reporterLabel(
  payload: DeliveryOccurrenceAuthorizationRequestedPayload,
): string {
  return payload.fromDriver === false ? "Registrado por" : "Motorista";
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

function renderDeliveryOccurrenceWhatsApp(
  payload: DeliveryOccurrenceReportedPayload,
): string {
  return [
    `🚚 *Entrega com insucesso!*`,
    `Destinatário: *${payload.recipientName}*`,
    `Ocorrência: *${payload.occurrenceTypeName}*`,
    payload.description && `Relato: *${payload.description}*`,
    `Registrada por: *${payload.reporterName}*`,
    payload.photosCount > 0 && `Fotos anexadas: *${payload.photosCount}*`,
    `Status atual: *${payload.deliveryStatusAfter}*`,
  ]
    .filter(Boolean)
    .join("\n");
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
  };
}

function renderAuthorizationRequestedWhatsApp(
  payload: DeliveryOccurrenceAuthorizationRequestedPayload,
): string {
  return [
    isDeliveryRequest(payload)
      ? `⏳ *Entrega aguardando autorização*`
      : `⏳ *Ocorrência aguardando autorização*`,
    `Destinatário: *${payload.recipientName}*`,
    `${isDeliveryRequest(payload) ? "Tipo de entrega" : "Ocorrência"}: *${payload.occurrenceTypeName}*`,
    ...payload.answers.map(({ label, value }) => `${label}: *${value}*`),
    payload.description && `Relato: *${payload.description}*`,
    `${reporterLabel(payload)}: *${payload.reporterName}*`,
    `Responda pela torre de controle.`,
  ]
    .filter(Boolean)
    .join("\n");
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
  };
}

function renderAuthorizationEscalatedWhatsApp(
  payload: DeliveryOccurrenceAuthorizationEscalatedPayload,
): string {
  // A panel request has nobody standing at the address.
  const fromDriver = payload.fromDriver !== false;

  return [
    `🚨 *Autorização sem resposta há ${payload.waitingMinutes} min*`,
    `Destinatário: *${payload.recipientName}*`,
    `Ocorrência: *${payload.occurrenceTypeName}*`,
    `${reporterLabel(payload)}: *${payload.reporterName}*`,
    fromDriver
      ? `O motorista está parado aguardando. Decida pela torre de controle.`
      : `A entrega aguarda a decisão. Decida pela torre de controle.`,
  ].join("\n");
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
  };

export {
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
