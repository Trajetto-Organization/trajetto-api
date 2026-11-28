import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { OPEN_STOP_STATUSES } from "@/shared/route/route-rules";

/**
 * Which stops of a route are the same visit (plan of 02/11/2026, item B6;
 * decision D37): the same normalized address AND the same recipient — by
 * document, or by phone when there is no document. Three NF-e for the same
 * shop on the same route are one stop for the customer: one "saiu", one "a
 * caminho", one "entregue". Two shops in the same building are not.
 *
 * The key is a hash, written on RouteStop.stop_group_key when the stop is
 * created (createRoute, addStops) and recomputed on the open stops when the
 * delivery's address or recipient is edited (K9). Null — a stop of its own — when the delivery
 * names neither a document nor a phone: without a person to match, sharing an
 * address is not enough to merge two customers' messages.
 */
interface StopGroupSource {
  street: string | null;
  address_number?: string | null;
  complement?: string | null;
  city: string | null;
  uf: string | null;
  cep?: string | null;
  recipient_document?: string | null;
  recipient_telephone?: string | null;
}

/** Lower case, no accents, one space between words, punctuation dropped. */
function normalizePart(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function digitsOf(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

/** Pure: the stop's group key, or null when there is nobody to match by. */
function stopGroupKey(source: StopGroupSource): string | null {
  const document = digitsOf(source.recipient_document);
  const phone = digitsOf(source.recipient_telephone);

  const person = document ? `doc:${document}` : phone ? `tel:${phone}` : null;

  if (!person) return null;

  const address = [
    normalizePart(source.street),
    normalizePart(source.address_number),
    normalizePart(source.complement),
    normalizePart(source.city),
    normalizePart(source.uf),
    digitsOf(source.cep),
  ].join("|");

  // The street and the city are required on a delivery; without them there
  // is no address to share.
  if (!normalizePart(source.street) || !normalizePart(source.city)) return null;

  return createHash("sha256")
    .update(`v1|${address}|${person}`)
    .digest("hex")
    .slice(0, 40);
}

const GROUP_SOURCE_SELECT = {
  street: true,
  address_number: true,
  complement: true,
  city: true,
  uf: true,
  cep: true,
  recipient_document: true,
  recipient_telephone: true,
} as const;

/**
 * Writes the group key of a route's stops — all of them, or only those of
 * `deliveryIds` (the ones just added) — inside the caller's transaction, so
 * the stops and their keys commit together. One UPDATE per distinct key.
 */
async function assignStopGroupKeys(
  tx: Prisma.TransactionClient,
  routeId: string,
  deliveryIds?: readonly string[],
): Promise<void> {
  const stops = await tx.routeStop.findMany({
    where: {
      routeId,
      ...(deliveryIds ? { deliveryId: { in: [...deliveryIds] } } : {}),
    },
    select: { id: true, delivery: { select: GROUP_SOURCE_SELECT } },
  });

  await writeKeys(tx, stops);
}

/**
 * Recomputes the key of a delivery's OPEN stops after its address or
 * recipient was edited (K9): a stop must keep matching the visit it now is.
 *
 * A closed stop (delivered, failed, cancelled) is no visit any more and is
 * left alone: its updated_at is the instant it was closed, which the late
 * proof (findLostStop's lostAt, K7) and the route's completion time read.
 * Touching it on an edit of the delivery would move that instant.
 */
async function refreshStopGroupKeysOfDelivery(
  tx: Prisma.TransactionClient,
  deliveryId: string,
): Promise<void> {
  const stops = await tx.routeStop.findMany({
    where: { deliveryId, status: { in: OPEN_STOP_STATUSES } },
    select: { id: true, delivery: { select: GROUP_SOURCE_SELECT } },
  });

  await writeKeys(tx, stops);
}

async function writeKeys(
  tx: Prisma.TransactionClient,
  stops: Array<{ id: string; delivery: StopGroupSource }>,
): Promise<void> {
  const byKey = new Map<string | null, string[]>();

  for (const stop of stops) {
    const key = stopGroupKey(stop.delivery);
    byKey.set(key, [...(byKey.get(key) ?? []), stop.id]);
  }

  // Only the stops whose key changes are written: the update also stamps
  // updated_at, and a stop whose visit did not change keeps its instant.
  for (const [key, ids] of byKey) {
    await tx.routeStop.updateMany({
      where:
        key === null
          ? { id: { in: ids }, stop_group_key: { not: null } }
          : {
              id: { in: ids },
              OR: [{ stop_group_key: null }, { stop_group_key: { not: key } }],
            },
      data: { stop_group_key: key },
    });
  }
}

/**
 * "A caminho" of one stop is "a caminho" of its siblings (B6): the driver is
 * heading to one door with three NF-e. The open siblings that were not yet
 * marked get the same instant, in the caller's transaction, so the app and
 * the board show them on the way and a later tap on one of them does not
 * tell the customer a second time. Returns the stops it marked.
 */
async function markSiblingStopsOnTheWay(
  tx: Prisma.TransactionClient,
  input: { routeId: string; stopId: string; at: Date },
): Promise<Array<{ id: string; deliveryId: string }>> {
  const stop = await tx.routeStop.findUnique({
    where: { id: input.stopId },
    select: { stop_group_key: true },
  });

  if (!stop?.stop_group_key) return [];

  const siblings = await tx.routeStop.findMany({
    where: {
      routeId: input.routeId,
      stop_group_key: stop.stop_group_key,
      id: { not: input.stopId },
      status: "PENDING",
      on_the_way_at: null,
    },
    select: { id: true, deliveryId: true },
  });

  if (siblings.length === 0) return [];

  await tx.routeStop.updateMany({
    where: {
      id: { in: siblings.map((sibling) => sibling.id) },
      on_the_way_at: null,
    },
    data: { on_the_way_at: input.at },
  });

  return siblings;
}

export {
  assignStopGroupKeys,
  markSiblingStopsOnTheWay,
  refreshStopGroupKeysOfDelivery,
  stopGroupKey,
};

export type { StopGroupSource };
