/**
 * Everything an outside system can subscribe to, in two families.
 *
 * Two and not twenty: route events and document events. A catalogue that grew
 * a topic per internal state change would be a catalogue nobody can implement
 * against — and every one of those topics would be a promise we could never
 * change again, because somebody's ERP would be parsing it.
 *
 * The contract is ours and versioned. Adding a FIELD to a payload does not
 * break a subscriber; removing or renaming one does, and that is what a new
 * version is for.
 */
const WEBHOOK_API_VERSION = "v1";

/** The route's own life: planned, handed over, departed, finished, called off. */
const ROUTE_TOPICS = [
  "route.released",

  // The pull-back. A route can go from RELEASED to PLANNED while nothing has
  // been worked, and an ERP that was told about the release and never told
  // about the reversal dispatches a load that is back in the yard.
  "route.unreleased",

  "route.started",
  "route.completed",
  "route.cancelled",
] as const;

/**
 * What happens to a document — which is what an ERP actually tracks.
 *
 * `delivery.*` is the status of the load; `occurrence.*` is a typed problem in
 * the field; `proof.*` is the receipt. An integration that only wants to know
 * when something is delivered subscribes to one topic and ignores the rest.
 */
const DOCUMENT_TOPICS = [
  "delivery.created",
  "delivery.assigned",
  "delivery.in_transit",
  "delivery.delivered",
  "delivery.failed",
  "delivery.cancelled",

  "occurrence.reported",

  "proof.registered",
  "proof.approved",
  "proof.rejected",
] as const;

type RouteTopic = (typeof ROUTE_TOPICS)[number];
type DocumentTopic = (typeof DOCUMENT_TOPICS)[number];

type WebhookTopic = RouteTopic | DocumentTopic;

const ALL_TOPICS: WebhookTopic[] = [...ROUTE_TOPICS, ...DOCUMENT_TOPICS];

const TOPIC_FAMILY: Record<WebhookTopic, "route" | "document"> = Object.freeze(
  Object.fromEntries([
    ...ROUTE_TOPICS.map((topic) => [topic, "route"]),
    ...DOCUMENT_TOPICS.map((topic) => [topic, "document"]),
  ]) as Record<WebhookTopic, "route" | "document">,
);

/** Human descriptions, for the subscription screen and the public docs. */
const TOPIC_DESCRIPTIONS: Record<WebhookTopic, string> = {
  "route.released": "A rota foi liberada para o motorista.",
  "route.unreleased": "A rota voltou para o planejamento antes de sair.",
  "route.started": "O motorista saiu com a rota.",
  "route.completed": "Todas as paradas da rota foram resolvidas.",
  "route.cancelled": "A rota foi cancelada.",

  "delivery.created": "Uma entrega entrou na operação.",
  "delivery.assigned": "A entrega foi atribuída a um motorista.",
  "delivery.in_transit": "A entrega saiu para o destino.",
  "delivery.delivered": "A entrega foi concluída.",
  "delivery.failed": "A entrega terminou sem sucesso.",
  "delivery.cancelled": "A entrega foi cancelada.",

  "occurrence.reported": "Uma ocorrência foi registrada na entrega.",

  "proof.registered": "O motorista enviou o canhoto.",
  "proof.approved": "O canhoto foi aprovado na auditoria.",
  "proof.rejected": "O canhoto foi rejeitado na auditoria.",
};

function isWebhookTopic(value: string): value is WebhookTopic {
  return (ALL_TOPICS as string[]).includes(value);
}

type TopicFamily = "route" | "document";

/** `delivery.created` → `delivery.*`: the one-level wildcard a topic falls under. */
function wildcardOf(topic: string): string {
  return `${topic.split(".")[0]}.*`;
}

/**
 * The wildcards that mean something: one per topic prefix, derived from the
 * catalogue so a new prefix is subscribable the day it ships.
 *
 * The dispatcher matches a wildcard by prefix, so a family is NOT a wildcard:
 * the document family spans three prefixes (`delivery.*`, `occurrence.*`,
 * `proof.*`). `document.*` was saved by the panel's "Todos os eventos" and
 * matched no topic at all — endpoints subscribed to it received nothing,
 * silently (DLVB-22, decision 5.9).
 */
const TOPIC_WILDCARDS: string[] = [...new Set(ALL_TOPICS.map(wildcardOf))];

/** What "Todos os eventos" of a family subscribes to. */
const FAMILY_WILDCARDS: Record<TopicFamily, string[]> = {
  route: [...new Set(ROUTE_TOPICS.map(wildcardOf))],
  document: [...new Set(DOCUMENT_TOPICS.map(wildcardOf))],
};

/**
 * Old spellings still honoured on the way out.
 *
 * Migration 20260928120700 rewrote every stored `document.*`, and the schema
 * refuses it now. But during a rolling deploy the previous release keeps
 * serving for a moment after the migration ran and can still save one; that
 * endpoint must not go mute again. Read-side only — nothing may write it.
 */
const LEGACY_WILDCARD_ALIASES: Record<string, string[]> = {
  "document.*": FAMILY_WILDCARDS.document,
};

/** A subscription the API accepts: a catalogue topic or a known wildcard. */
function isKnownSubscription(value: string): boolean {
  return isWebhookTopic(value) || TOPIC_WILDCARDS.includes(value);
}

/**
 * Which of an endpoint's subscriptions match a topic.
 *
 * Exact names plus one-level wildcards by prefix — `delivery.*` — because an
 * ERP that wants every document event should not have to be redeployed when
 * we add a status. The wildcard is deliberately not a glob: `*` alone would
 * subscribe somebody to topics that did not exist when they agreed.
 */
function topicMatches(subscription: string, topic: string): boolean {
  if (subscription === topic) return true;

  const alias = LEGACY_WILDCARD_ALIASES[subscription];

  if (alias) return alias.some((wildcard) => topicMatches(wildcard, topic));

  if (!subscription.endsWith(".*") || subscription === ".*") return false;

  const prefix = subscription.slice(0, -1);

  return topic.startsWith(prefix);
}

function endpointWantsTopic(
  subscriptions: string[],
  topic: string,
): boolean {
  return subscriptions.some((subscription) =>
    topicMatches(subscription, topic),
  );
}

export {
  ALL_TOPICS,
  DOCUMENT_TOPICS,
  FAMILY_WILDCARDS,
  LEGACY_WILDCARD_ALIASES,
  ROUTE_TOPICS,
  TOPIC_DESCRIPTIONS,
  TOPIC_FAMILY,
  TOPIC_WILDCARDS,
  WEBHOOK_API_VERSION,
  endpointWantsTopic,
  isKnownSubscription,
  isWebhookTopic,
  topicMatches,
};
export type { DocumentTopic, RouteTopic, TopicFamily, WebhookTopic };
