import { DELIVERY_STATUS_LABELS, type DeliveryStatus } from "./delivery-rules";

import type { DeliveryEventActor, DeliveryEventType } from "@/modules/delivery/dtos/delivery-dto";

/**
 * Everything that ever happened to one delivery, in one list, newest first.
 *
 * Built by MERGING the tables that already own these facts rather than by
 * copying them into a timeline table. An arrival lives in delivery_event, a
 * typed occurrence in delivery_occurrence, a message in chat_message — each
 * with its own writer, its own rules and its own screens. A timeline table
 * would be a second writer for every one of them, and two writers for one fact
 * is how a fact starts disagreeing with itself.
 *
 * The cost is this function. The benefit is that support reads exactly what
 * the operation recorded, with nothing in between that could drift.
 *
 * Pure on purpose: what the SAC sees is a product decision, and a product
 * decision that needs a database to test is a product decision nobody tests.
 */
type TimelineKind =
  | "ARRIVAL"
  | "PROOF"
  | "STATUS_CHANGE"
  | "NOTE"
  | "OCCURRENCE"
  | "MESSAGE";

interface TimelineAuthor {
  /** Who produced it. MESSAGE and OCCURRENCE are always people today. */
  kind: DeliveryEventActor;
  name: string | null;

  /** DRIVER_APP only — support is regularly asked to tell two phones apart. */
  device: string | null;
}

interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  at: Date;

  /** One line, already in Portuguese, ready to render. */
  title: string;

  /** The detail under it, when there is one. */
  detail: string | null;

  author: TimelineAuthor;

  photos: string[];
  location: { latitude: number; longitude: number } | null;

  /** STATUS_CHANGE only. */
  statusFrom: DeliveryStatus | null;
  statusTo: DeliveryStatus | null;
  reason: string | null;

  /** OCCURRENCE only: whether the type flipped the delivery to Insucesso. */
  blocking: boolean;
}

interface EventSource {
  id: string;
  type: DeliveryEventType;
  created_at: Date | string;

  actor?: DeliveryEventActor | null;
  device?: string | null;

  latitude?: number | null;
  longitude?: number | null;

  photo?: string | null;
  signature?: string | null;
  received_by?: string | null;

  note?: string | null;
  status_from?: DeliveryStatus | null;
  status_to?: DeliveryStatus | null;

  reason?: { name: string } | null;
  reportedBy?: { name: string } | null;
}

interface OccurrenceSource {
  id: string;
  created_at: Date | string;
  description?: string | null;

  latitude?: number | null;
  longitude?: number | null;
  photos?: string[] | null;

  occurrenceType?: { name: string; blocks_delivery?: boolean | null } | null;
  reportedBy?: { name: string } | null;
}

interface MessageSource {
  id: string;
  created_at: Date | string;
  kind: string;
  body?: string | null;
  sender?: { name: string } | null;
}

interface TimelineSources {
  events?: EventSource[] | null;
  occurrences?: OccurrenceSource[] | null;
  messages?: MessageSource[] | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function authorOf(
  kind: DeliveryEventActor,
  name: string | null | undefined,
  device?: string | null,
): TimelineAuthor {
  return { kind, name: name ?? null, device: device ?? null };
}

function titleForEvent(event: EventSource): string {
  switch (event.type) {
    case "ARRIVAL":
      return "Motorista chegou ao endereço";

    case "PROOF":
      return event.received_by
        ? `Entrega comprovada — recebido por ${event.received_by}`
        : "Entrega comprovada";

    case "STATUS_CHANGE": {
      const from = event.status_from
        ? DELIVERY_STATUS_LABELS[event.status_from]
        : "—";

      const to = event.status_to
        ? DELIVERY_STATUS_LABELS[event.status_to]
        : "—";

      // The reason rides in the title rather than the detail: it is the
      // sentence support is scanning for, and burying it under a note that may
      // not exist would hide the answer half the time.
      return event.reason
        ? `Status alterado de ${from} para ${to} — ${event.reason.name}`
        : `Status alterado de ${from} para ${to}`;
    }

    case "NOTE":
      return "Apontamento";

    default:
      return "Evento";
  }
}

function fromEvent(event: EventSource): TimelineEntry {
  const photos = [event.photo, event.signature].filter(
    (value): value is string => Boolean(value),
  );

  return {
    id: event.id,
    kind: event.type as TimelineKind,
    at: toDate(event.created_at),

    title: titleForEvent(event),
    detail: event.note ?? null,

    // An event written before the actor column existed reads as USER, which is
    // what every source was at the time.
    author: authorOf(event.actor ?? "USER", event.reportedBy?.name, event.device),

    photos,
    location:
      event.latitude != null && event.longitude != null
        ? { latitude: event.latitude, longitude: event.longitude }
        : null,

    statusFrom: event.status_from ?? null,
    statusTo: event.status_to ?? null,
    reason: event.reason?.name ?? null,

    blocking: false,
  };
}

function fromOccurrence(occurrence: OccurrenceSource): TimelineEntry {
  return {
    id: occurrence.id,
    kind: "OCCURRENCE",
    at: toDate(occurrence.created_at),

    title: occurrence.occurrenceType?.name ?? "Ocorrência",
    detail: occurrence.description ?? null,

    // Occurrences are typed in the field or on the panel; both are people.
    author: authorOf("USER", occurrence.reportedBy?.name),

    photos: occurrence.photos ?? [],
    location:
      occurrence.latitude != null && occurrence.longitude != null
        ? { latitude: occurrence.latitude, longitude: occurrence.longitude }
        : null,

    statusFrom: null,
    statusTo: null,
    reason: null,

    blocking: occurrence.occurrenceType?.blocks_delivery === true,
  };
}

function fromMessage(message: MessageSource): TimelineEntry {
  // The body, or what the attachment was. A timeline row saying nothing is
  // worse than one saying "foto".
  const fallback = message.kind === "AUDIO" ? "Mensagem de voz" : "Foto";

  return {
    id: message.id,
    kind: "MESSAGE",
    at: toDate(message.created_at),

    title: `Mensagem de ${message.sender?.name ?? "alguém"}`,
    detail: message.body || (message.kind === "TEXT" ? null : fallback),

    author: authorOf("USER", message.sender?.name),

    photos: [],
    location: null,

    statusFrom: null,
    statusTo: null,
    reason: null,

    blocking: false,
  };
}

/**
 * The whole trail, newest first.
 *
 * Ties are broken by id, which is a uuid v7 and therefore time-ordered: two
 * things written in the same transaction — a proof and the status it stamped —
 * would otherwise come back in an order that changes between reads, and a
 * support screen that reorders itself on refresh is a support screen nobody
 * trusts.
 */
function buildDeliveryTimeline(sources: TimelineSources): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...(sources.events ?? []).map(fromEvent),
    ...(sources.occurrences ?? []).map(fromOccurrence),
    ...(sources.messages ?? []).map(fromMessage),
  ];

  return entries.sort((left, right) => {
    const byTime = right.at.getTime() - left.at.getTime();

    if (byTime !== 0) return byTime;

    return right.id.localeCompare(left.id);
  });
}

export { buildDeliveryTimeline };
export type {
  TimelineAuthor,
  TimelineEntry,
  TimelineKind,
  TimelineSources,
};
