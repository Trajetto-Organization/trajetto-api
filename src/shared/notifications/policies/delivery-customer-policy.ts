import { NotificationCategory } from "@prisma/client";

import type {
  DeliveryCustomerPayload,
  ExternalRecipient,
  NotificationPolicyEntry,
  PolicyDeps,
  RenderedExternalMessage,
} from "../notification-types";

import type { IExternalRecipientRepository } from "@/modules/delivery/repositories/IExternal-recipient-repository";
import type {
  DeliveryMessageTopic,
  IDeliveryMessageTemplateRepository,
} from "@/modules/delivery/repositories/IDelivery-message-template-repository";

import {
  renderDeliveryMessage,
  type DeliveryMessageVariables,
} from "@/shared/delivery/message-template";

import type { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { env } from "@/env";

/**
 * The three moments a carrier tells the person waiting for their delivery.
 *
 * Only three, and that is the whole design. A notification per event would
 * mean a customer's phone buzzing when a dispatcher reassigns a driver, when a
 * route departs, when a stop is reordered — none of which the customer can act
 * on, and all of which teach them to ignore the next one. These three they can
 * act on: it is coming, it arrived, it did not arrive.
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
  "delivery.delivered": "DELIVERED",
  "delivery.failed": "FAILED",
};

/** Dates the way the person reading the message writes them. */
function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "";

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo",
  }).format(date);
}

function buildVariables(
  payload: DeliveryCustomerPayload,
  recipient: ExternalRecipient,
  carrierName: string,
): DeliveryMessageVariables {
  const base = env.HTTP_REQUEST.replace(/\/+$/, "");

  return {
    destinatario: recipient.name ?? payload.recipientName,
    transportadora: carrierName,

    nota: payload.invoiceNumber ?? "",
    pedido: payload.code ?? "",

    cidade: payload.city,
    uf: payload.uf,

    previsao: formatDate(payload.scheduledDate),
    data_entrega: formatDate(payload.deliveredAt),

    recebido_por: payload.receivedBy ?? "",

    link: `${base}/acompanhar/${recipient.access_token}`,
    link_descadastro: `${base}/acompanhar/${recipient.access_token}/parar`,
  };
}

/**
 * Creates the recipient row if this delivery has never had one, and refuses to
 * invent contact details it does not have.
 *
 * An empty array is the ordinary answer, not an error: most deliveries carry
 * no e-mail and no phone for the person receiving them, and a carrier that
 * collects neither simply never notifies anybody.
 */
async function resolveCustomer(
  payload: DeliveryCustomerPayload,
  deps: PolicyDeps,
): Promise<ExternalRecipient[]> {
  if (!payload.recipientEmail && !payload.recipientTelephone) return [];

  const repository =
    deps.externalRecipientRepository as IExternalRecipientRepository;

  const recipient = await repository.ensureForDelivery({
    deliveryId: payload.deliveryId,
    businessId: payload.businessId,
    name: payload.recipientName,
    email: payload.recipientEmail,
    telephone: payload.recipientTelephone,
  });

  return [recipient as unknown as ExternalRecipient];
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

  // Null, not a default sentence. A carrier that has not written this message
  // does not want one sent in their name. Read BEFORE the business, so a
  // company with no template costs one query instead of two.
  if (!template) return null;

  const businesses = deps.businessRepository as IBusinessRepository;

  const business = await businesses.findBusinessById(payload.businessId);

  const carrierName =
    business?.fantasy_name?.trim() || business?.corporate_reason || "";

  const variables = buildVariables(payload, recipient, carrierName);

  return {
    subject: template.subject
      ? renderDeliveryMessage(template.subject, variables)
      : `${carrierName} — atualização da sua entrega`,

    body: renderDeliveryMessage(template.body, variables),
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
      return resolveCustomer(payload, deps);
    },

    async renderExternal(payload, recipient, deps, channel) {
      return renderCustomer(topic, payload, recipient, deps, channel);
    },
  };
}

const deliveryDispatchedPolicy = customerPolicy("delivery.dispatched");
const deliveryDeliveredPolicy = customerPolicy("delivery.delivered");
const deliveryFailedPolicy = customerPolicy("delivery.failed");

export {
  TOPIC_BY_EVENT,
  buildVariables,
  deliveryDeliveredPolicy,
  deliveryDispatchedPolicy,
  deliveryFailedPolicy,
  renderCustomer,
  resolveCustomer,
};
