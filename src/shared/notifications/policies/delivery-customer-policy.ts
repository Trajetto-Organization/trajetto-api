import { NotificationCategory } from "@prisma/client";

import type {
  DeliveryCustomerPayload,
  ExternalRecipient,
  NotificationPolicyEntry,
  PolicyDeps,
  RenderedExternalMessage,
} from "../notification-types";

import type {
  DeliveryContactState,
  IExternalRecipientRepository,
} from "@/modules/delivery/repositories/IExternal-recipient-repository";
import type {
  DeliveryMessageTopic,
  IDeliveryMessageTemplateRepository,
} from "@/modules/delivery/repositories/IDelivery-message-template-repository";

import {
  renderDeliveryMessage,
  type DeliveryMessageVariables,
} from "@/shared/delivery/message-template";
import { customerLinks } from "@/shared/delivery/whatsapp-body";
import {
  buildCustomerWhatsApp,
  deliveryReference,
} from "@/shared/delivery/customer-whatsapp-templates";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { formatDateOnlyBR } from "@/shared/delivery/date-only-field";
import { resolveTimeZone } from "@/shared/time/business-day";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "delivery-customer-policy" });

/**
 * The moments a carrier tells the person waiting for their delivery.
 *
 * Four, and that is the whole design. A notification per event would mean a
 * customer's phone buzzing when a dispatcher reassigns a driver, when a route
 * departs, when a stop is reordered — none of which the customer can act on,
 * and all of which teach them to ignore the next one. These they can act on:
 * it left, the driver is heading to you now (decision 6.4 — be at the door),
 * it arrived, it did not arrive.
 *
 * No in-app and no push: there is no app and no inbox on this side. No
 * preferences either — an outsider never had a row to express one, and the way
 * they say stop is the opt-out link carried in every message.
 *
 * NOT mandatory, unlike the driver's notifications, and the difference is
 * deliberate: a company telling its own driver that their day changed is
 * operational, while a company messaging a stranger is marketing-adjacent and
 * has to respect a "pare" the moment it arrives.
 */
const TOPIC_BY_EVENT: Record<string, DeliveryMessageTopic> = {
  "delivery.dispatched": "DISPATCHED",
  "delivery.on_the_way": "ON_THE_WAY",
  "delivery.delivered": "DELIVERED",
  "delivery.failed": "FAILED",
};

/**
 * An instant the way the person reading the message writes it, on the
 * carrier's clock (decision 1.1): "17/09/2026, 14:30".
 */
function formatMoment(
  value: Date | string | null | undefined,
  timeZone: string,
): string {
  if (!value) return "";

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone,
  }).format(date);
}

function buildVariables(
  payload: DeliveryCustomerPayload,
  recipient: ExternalRecipient,
  carrierName: string,
  timeZone?: string | null,

  /** Every delivery of the stop the message speaks of (B6), when several. */
  members?: ReadonlyArray<{
    invoiceNumber: string | null;
    code: string | null;
  }>,
): DeliveryMessageVariables {
  const several = members && members.length > 1 ? members : null;

  const joined = (values: Array<string | null>) =>
    [
      ...new Set(values.filter((value): value is string => Boolean(value))),
    ].join(", ");

  return {
    destinatario: recipient.name ?? payload.recipientName,
    transportadora: carrierName,

    // One message per stop lists every NF-e (and order) of the stop.
    nota: several
      ? joined(several.map((member) => member.invoiceNumber))
      : (payload.invoiceNumber ?? ""),
    pedido: several
      ? joined(several.map((member) => member.code))
      : (payload.code ?? ""),

    cidade: payload.city,
    uf: payload.uf,

    // The expected date is a DAY (decision 1.3): no time, read as the civil
    // day it stores. The delivery moment is an instant, in the company's zone.
    previsao: formatDateOnlyBR(payload.scheduledDate),
    data_entrega: formatMoment(payload.deliveredAt, resolveTimeZone(timeZone)),

    recebido_por: payload.receivedBy ?? "",

    // link and link_descadastro, built in one place with the save's length
    // check (see whatsapp-body.ts).
    ...customerLinks(recipient.access_token),
  };
}

/**
 * The delivery statuses at which each message has been overtaken.
 *
 * "Saiu para entrega" is true only while the load is out: start-route
 * publishes it only for deliveries its departure moved to IN_TRANSIT, in the
 * same transaction, so PENDING afterwards is the load back in the pool — the
 * route ended with the stop still open, or the dispatcher moved it back — and
 * delivered, failed or cancelled is the delivery over. "A caminho" is true
 * under exactly the same statuses: it is published only for a stop pending on
 * a running route, and the driver heading there means nothing once the load
 * is off the street or the delivery is over. "Entregue" is true only
 * while it IS delivered: an override back to failed makes it false. "Não
 * entregue" is overtaken once it went out again, arrived or was cancelled;
 * PENDING after it is the carrier still deciding on a redelivery, so the
 * customer is still owed it.
 */
const OVERTAKEN_AT: Record<DeliveryMessageTopic, ReadonlySet<string>> = {
  DISPATCHED: new Set(["PENDING", "DELIVERED", "FAILED", "CANCELLED"]),
  ON_THE_WAY: new Set(["PENDING", "DELIVERED", "FAILED", "CANCELLED"]),
  DELIVERED: new Set(["PENDING", "IN_TRANSIT", "FAILED", "CANCELLED"]),
  FAILED: new Set(["IN_TRANSIT", "DELIVERED", "CANCELLED"]),
};

/** Whether a customer message still describes the delivery. Pure. */
function customerMessageStillTrue(
  topic: DeliveryMessageTopic,
  deliveryStatus: string,
): boolean {
  return !OVERTAKEN_AT[topic].has(deliveryStatus);
}

interface StopMember {
  deliveryId: string;
  invoiceNumber: string | null;
  code: string | null;
  state: DeliveryContactState;
}

/**
 * The deliveries a message speaks of, as they are NOW: one, or every NF-e of
 * the stop (B6). A delivery deleted since is left out.
 */
async function stopMembers(
  payload: DeliveryCustomerPayload,
  repository: IExternalRecipientRepository,
): Promise<StopMember[]> {
  const listed = payload.deliveries?.length
    ? payload.deliveries
    : [
        {
          deliveryId: payload.deliveryId,
          invoiceNumber: payload.invoiceNumber,
          code: payload.code,
        },
      ];

  // The merge of "entregue" can list one twice (a proof replayed inside the
  // window): the first entry wins.
  const unique = [
    ...new Map(listed.map((member) => [member.deliveryId, member])).values(),
  ];

  const states = await Promise.all(
    unique.map((member) => repository.findDeliveryState(member.deliveryId)),
  );

  return unique.flatMap((member, index) => {
    const state = states[index];

    return state
      ? [
          {
            deliveryId: member.deliveryId,
            invoiceNumber: member.invoiceNumber ?? null,
            code: member.code ?? null,
            state,
          },
        ]
      : [];
  });
}

/**
 * Whose link the stop's message carries: the lowest delivery id of the stop,
 * so "saiu", "a caminho" and "entregue" of one visit point at the same
 * tracking page — which lists the stop's other deliveries (B6).
 */
function anchorOf(members: StopMember[]): StopMember {
  return members.reduce((lowest, member) =>
    member.deliveryId < lowest.deliveryId ? member : lowest,
  );
}

/**
 * Creates the recipient row if this delivery has never had one, and refuses to
 * invent contact details it does not have.
 *
 * An empty array is the ordinary answer, not an error: most deliveries carry
 * no e-mail and no phone for the person receiving them, and a carrier that
 * collects neither simply never notifies anybody.
 *
 * The contact comes from the DELIVERY, read now, not from the event. The
 * event holds it as it was when published; a late expansion — a backlog, a
 * lease another replica reclaimed, a retry of an old event — used to write
 * that old phone back over the one the dispatcher had since corrected, and
 * the next message went to the wrong number.
 */
async function resolveCustomer(
  topic: DeliveryMessageTopic,
  payload: DeliveryCustomerPayload,
  deps: PolicyDeps,
): Promise<ExternalRecipient[]> {
  const repository =
    deps.externalRecipientRepository as IExternalRecipientRepository;

  const members = await stopMembers(payload, repository);

  // Deleted since: nobody to tell, and no row to create for it.
  if (members.length === 0) return [];

  const anchor = anchorOf(members);
  const current = anchor.state;

  if (!current.email && !current.telephone) return [];

  // A channel without the company's active row for this moment is a
  // DECISION not to send (DLVP-NOTIF-2). Deciding it here, before any row
  // exists, is what keeps it out of the failure counters: a row created for
  // it could only ever end as a non-retryable "no active template" failure.
  // On WhatsApp the row is only the on/off switch (B3): the text is fixed.
  const templates =
    deps.messageTemplateRepository as IDeliveryMessageTemplateRepository;

  const [emailTemplate, whatsappTemplate] = await Promise.all([
    current.email
      ? templates.findActive(payload.businessId, topic, "EMAIL")
      : Promise.resolve(null),
    current.telephone
      ? templates.findActive(payload.businessId, topic, "WHATSAPP")
      : Promise.resolve(null),
  ]);

  // An e-mail row without text (impossible by the CHECK) sends nothing.
  const email = emailTemplate?.body ? current.email : null;
  const telephone = whatsappTemplate ? current.telephone : null;

  if (!email && !telephone) {
    log.debug(
      { topic, deliveryId: payload.deliveryId, reason: "no_template" },
      "customer notice suppressed",
    );

    return [];
  }

  const recipient = (await repository.ensureForDelivery({
    deliveryId: anchor.deliveryId,
    businessId: payload.businessId,
    name: current.name || payload.recipientName,
    email: current.email,
    telephone: current.telephone,
  })) as unknown as ExternalRecipient;

  // Somebody who asked any message of this stop to stop has asked them all:
  // an earlier message of the stop may have carried another delivery's link.
  const optedOut =
    recipient.opted_out_at ??
    (members.some((member) => member.state.optedOut) ? new Date() : null);

  // The stored contact stays whole (the next moment may have a template for
  // the other channel); only the channels this moment can use are offered.
  return [{ ...recipient, email, telephone, opted_out_at: optedOut }];
}

/**
 * Why this message should no longer go out, or null. Asked before every
 * attempt: a "saiu para entrega" held in backoff must not land after the
 * "entregue" that overtook it (GAP2-5). For a stop's message (B6), only once
 * every delivery it speaks of has moved past it.
 */
async function customerSupersededReason(
  topic: DeliveryMessageTopic,
  payload: DeliveryCustomerPayload,
  deps: PolicyDeps,
): Promise<string | null> {
  const repository =
    deps.externalRecipientRepository as IExternalRecipientRepository;

  const members = await stopMembers(payload, repository);

  if (members.length === 0) return "A entrega não existe mais";

  if (
    members.every(
      (member) => !customerMessageStillTrue(topic, member.state.status),
    )
  ) {
    return `Mensagem ${topic} superada: a entrega está ${anchorOf(members).state.status}`;
  }

  return null;
}

async function renderCustomer(
  topic: DeliveryMessageTopic,
  payload: DeliveryCustomerPayload,
  recipient: ExternalRecipient,
  deps: PolicyDeps,
  channel: string,
): Promise<RenderedExternalMessage | null> {
  const templates =
    deps.messageTemplateRepository as IDeliveryMessageTemplateRepository;

  const template = await templates.findActive(
    payload.businessId,
    topic,
    channel,
  );

  // Null, not a default sentence. A carrier that switched this message off
  // (or never wrote its e-mail) does not want one sent in their name. Read
  // BEFORE the business, so a company without it costs one query, not two.
  if (!template) return null;

  // The e-mail is the company's text; without it there is nothing to send.
  // A WhatsApp row's body is never read (B3): its text is Meta's template.
  const emailBody = template.body;

  if (channel !== "WHATSAPP" && emailBody === null) return null;

  const businesses = deps.businessRepository as IBusinessRepository;

  const business = await businesses.findBusinessById(payload.businessId);

  const carrierName =
    business?.fantasy_name?.trim() || business?.corporate_reason || "";

  const timeZone = (business as { timezone?: string | null } | null)?.timezone;

  // The deliveries of the stop the message still speaks of (B6).
  const members = await stopMembers(
    payload,
    deps.externalRecipientRepository as IExternalRecipientRepository,
  );

  const live = members.filter((member) =>
    customerMessageStillTrue(topic, member.state.status),
  );

  const spoken = live.length > 0 ? live : members;

  const variables = buildVariables(
    payload,
    recipient,
    carrierName,
    timeZone,
    spoken,
  );

  if (channel === "WHATSAPP") {
    const whatsapp = buildCustomerWhatsApp(topic, {
      recipientName: variables.destinatario,
      carrierName,
      reference: deliveryReference(
        spoken.length > 0
          ? spoken
          : [{ invoiceNumber: payload.invoiceNumber, code: payload.code }],
      ),
      deliveredAt: variables.data_entrega,
      accessToken: recipient.access_token,
    });

    return {
      subject: "",
      body: whatsapp.preview,
      link: variables.link,
      whatsapp: {
        name: whatsapp.name,
        parameters: whatsapp.parameters,
        urlButtonSuffixes: whatsapp.urlButtonSuffixes,
      },
    };
  }

  return {
    subject: template.subject
      ? renderDeliveryMessage(template.subject, variables)
      : `${carrierName} — atualização da sua entrega`,
    body: renderDeliveryMessage(emailBody as string, variables),
    link: variables.link,
  };
}

function customerPolicy(
  event: keyof typeof TOPIC_BY_EVENT,
): NotificationPolicyEntry<DeliveryCustomerPayload> {
  const topic = TOPIC_BY_EVENT[event];

  return {
    category: NotificationCategory.TASKS,

    // Nobody inside the company is notified by these. The dispatcher's board
    // already shows every one of them the moment it happens, and a bell for
    // each would be sixty a day at a company with thirty drivers.
    async resolveRecipients() {
      return [];
    },

    async resolveExternalRecipients(payload, deps) {
      return resolveCustomer(topic, payload, deps);
    },

    async renderExternal(payload, recipient, deps, channel) {
      return renderCustomer(topic, payload, recipient, deps, channel);
    },

    async supersededReason(payload, deps) {
      return customerSupersededReason(topic, payload, deps);
    },
  };
}

const deliveryDispatchedPolicy = customerPolicy("delivery.dispatched");
const deliveryOnTheWayPolicy = customerPolicy("delivery.on_the_way");
const deliveryDeliveredPolicy = customerPolicy("delivery.delivered");
const deliveryFailedPolicy = customerPolicy("delivery.failed");

export {
  TOPIC_BY_EVENT,
  buildVariables,
  customerMessageStillTrue,
  deliveryDeliveredPolicy,
  deliveryDispatchedPolicy,
  deliveryFailedPolicy,
  deliveryOnTheWayPolicy,
  renderCustomer,
  resolveCustomer,
};
