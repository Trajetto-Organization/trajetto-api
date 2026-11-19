import database, { readDatabase, replicaDatabase } from "@/../infra/database";

import { Prisma, type PrismaClient } from "@prisma/client";

import { env } from "@/env";
import { relatedTo, rowsByKey } from "@/shared/database/related-rows";
import { CURRENT_TIMELINE } from "@/shared/health/cluster-epoch";
import { countFeedConversion } from "@/shared/integration/feed-metrics";
import { logger } from "@/shared/logging/logger";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import {
  FeedEpochStaleError,
  convertedPosition,
  cursorOf,
  feedStart,
  positionAfter,
  type FeedPosition,
} from "../commit-order";

import type {
  CursorPage,
  IIntegrationRepository,
  IntegrationEventListProps,
  IntegrationListProps,
} from "./IIntegration-repository";

import {
  toIso,
  toPublicDelivery,
  toPublicRoute,
  type PublicDelivery,
  type PublicRoute,
} from "@/shared/integration/public-shapes";

import type { StoredDelivery } from "../usecases/create-delivery/replay-fingerprint";

/** The columns the public delivery shape reads, and no others. */
const deliverySelect = {
  id: true,
  // Never published: it signs proof_url (L7).
  businessId: true,
  code: true,
  invoice_key: true,
  invoice_number: true,
  status: true,
  kind: true,
  recipient_name: true,
  recipient_document: true,
  street: true,
  address_number: true,
  complement: true,
  neighborhood: true,
  city: true,
  uf: true,
  cep: true,
  scheduled_date: true,
  delivered_at: true,
  received_by: true,
  created_at: true,
  updated_at: true,

  // The latest stop's route, read by withStopRoutes for the stops present.
  stops: {
    orderBy: { created_at: "desc" as const },
    take: 1,
    select: { routeId: true },
  },
};

/**
 * The route of each delivery's latest stop, read once for the page and not
 * at all when no delivery is on a route. As a nested select, Prisma 7
 * queried it under a page of stopless deliveries — the usual page of an
 * integration that is not routing (shared/database/related-rows.ts).
 */
async function withStopRoutes<
  Row extends { stops: Array<{ routeId: string }> },
>(client: Pick<PrismaClient, "route">, rows: Row[]) {
  const routes = await rowsByKey(
    rows.flatMap((row) => row.stops.map((stop) => stop.routeId)),
    (ids) =>
      client.route.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true },
      }),
  );

  return rows.map((row) => ({
    ...row,
    stops: row.stops.map((stop) => ({
      route: relatedTo(routes, stop.routeId),
    })),
  }));
}

const routeSelect = {
  id: true,
  code: true,
  name: true,
  status: true,
  scheduled_date: true,
  destination: true,
  planned_departure_at: true,
  planned_arrival_at: true,
  started_at: true,
  completed_at: true,
  created_at: true,

  driver: { select: { id: true, name: true } },
  vehicle: { select: { id: true, license_plate: true } },

  stops: {
    orderBy: { sequence: "asc" as const },
    select: {
      sequence: true,
      status: true,
      delivery: { select: { id: true, code: true, invoice_key: true } },
    },
  },
};

/**
 * Cursor paging, keyed on the row id.
 *
 * `id` and not `updated_at`: the cursor has to be unique or a page boundary
 * between two rows written in the same millisecond either repeats a document
 * or skips one — and an integration that silently loses a delivery is the
 * worst failure this API can have, because nobody notices for weeks.
 *
 * The next page is `id > cursor`, by the value, never Prisma's `cursor`,
 * which looks the row up and answers an empty page when it is not there.
 * These lists may read on the standby (plano-escala F4-42), and the page
 * before may have come from the primary, through another replica: a
 * standby that has not replayed that row yet would end the walk there,
 * with every row after it, of any age, left out. By value, the walk goes
 * on after the row wherever it is (and after a row deleted since).
 */
function cursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): { page: T[]; next_cursor: string | null } {
  const page = rows.slice(0, limit);

  return {
    page,
    next_cursor: rows.length > limit ? page[page.length - 1].id : null,
  };
}

/**
 * The public name of a delivery event in the feed, or null when the feed
 * leaves it out.
 *
 * `PROOF` is an internal word; the catalogue says `proof.registered` and that
 * is what a subscriber matched on. "A caminho" (decision 6.4) is named like
 * the arrival: an operational fact, not a webhook topic. An occurrence report
 * (TWR-6) is `occurrence.reported`, the webhook's name, once it took effect:
 * a request still waiting for the tower, denied, or closed without a decision
 * (decision 6.3) changed nothing and sent no webhook, so the feed does not
 * announce it either. The judgement is read now, at poll time; a request
 * approved after a poller walked past it reaches that poller through the
 * `delivery.failed` the approval writes, when the type blocks the delivery.
 */
function publicEventTopic(event: {
  type: string;
  status_from?: string | null;
  status_to: string | null;
  occurrence?: {
    authorization_status: string | null;
    category?: string | null;
  } | null;
}): string | null {
  switch (event.type) {
    case "PROOF":
      return "proof.registered";
    case "ARRIVAL":
      return "delivery.arrived";
    case "ON_THE_WAY":
      return "delivery.on_the_way";
    case "STATUS_CHANGE":
      // The line every delivery starts with (F2-06): from nothing is its
      // creation, the webhook's `delivery.created`, not a `delivery.pending`.
      if (event.status_from === null && event.status_to === "PENDING") {
        return "delivery.created";
      }

      return `delivery.${(event.status_to ?? "").toLowerCase()}`;
    case "OCCURRENCE": {
      // Decision 14.3: a delivery request (DELIVERED) is not a problem. Its
      // fact is the PROOF (proof.registered), whatever the tower decided.
      if (event.occurrence?.category === "DELIVERED") return null;

      // A report whose occurrence row is gone (SetNull) is still a report.
      const status = event.occurrence?.authorization_status ?? "NOT_REQUIRED";

      return status === "NOT_REQUIRED" || status === "APPROVED"
        ? "occurrence.reported"
        : null;
    }
    // Decision 14.7: a route plan change is planning, not a public fact of
    // the delivery; the integrator learns the outcome from the delivery's
    // own events.
    case "ROUTE_ADDED":
    case "ROUTE_REMOVED":
      return null;
    default:
      return "delivery.note";
  }
}

/**
 * How far an event id's clock may trail the row's created_at.
 *
 * The id is a uuid v7 minted by the API process; created_at is the database's
 * now() at the start of the transaction. The id is minted later than that, so
 * it normally runs ahead — only an API clock behind the database's could put
 * it behind, and NTP keeps that to milliseconds. Ten minutes is a margin no
 * sane clock needs, and costs a poller ten minutes of extra rows read.
 */
const EVENT_ID_CLOCK_MARGIN_MS = 10 * 60 * 1000;

/**
 * The smallest uuid v7 an event written at or after `since` can carry.
 *
 * `updated_since` filters on created_at, but the page is walked in id order
 * over (businessId, id). Without a lower bound on the id, that walk starts at
 * the tenant's OLDEST event and reads its whole history up to `since` before
 * the first row qualifies — the planner cannot know that ids and created_at
 * rise together. A uuid v7 starts with its millisecond timestamp, so this
 * bound starts the walk at the window instead. It only narrows where the
 * index scan begins: created_at stays the filter, so the answer is the same.
 *
 * Relies on DeliveryEvent.id being `@default(uuid(7))` — pinned by
 * tests/unitaires/integration/integration-repository-events.test.ts.
 */
function eventIdFloor(since: Date): string | null {
  const at = since.getTime() - EVENT_ID_CLOCK_MARGIN_MS;

  if (!Number.isFinite(at)) return null;

  const hex = Math.max(0, at).toString(16).padStart(12, "0");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/** The columns the feed reads of an event, in both walks. */
const EVENT_SELECT = {
  id: true,
  type: true,
  created_at: true,
  occurred_at: true,
  status_from: true,
  status_to: true,
  received_by: true,
  note: true,

  delivery: { select: { id: true, code: true, invoice_key: true } },
  // Whether an occurrence report took effect (see publicEventTopic), and its
  // type's ERP code (L8).
  occurrence: {
    select: {
      authorization_status: true,
      category: true,
      occurrenceType: { select: { code: true } },
    },
  },
} satisfies Prisma.DeliveryEventSelect;

type FeedEvent = Prisma.DeliveryEventGetPayload<{
  select: typeof EVENT_SELECT;
}>;

type EventPage = Awaited<ReturnType<IIntegrationRepository["listEvents"]>>;

/**
 * The page as the integrator reads it. Left-out events are dropped AFTER
 * the page is cut: the cursor stays the last row read, so the walk never
 * skips or repeats one, even when a page comes back shorter than the limit.
 */
function publishEvents(page: FeedEvent[]): EventPage["data"] {
  return page.flatMap((event) => {
    const topic = publicEventTopic(event);

    if (!topic) return [];

    return [
      {
        id: event.id,

        // The public name, not the column (see publicEventTopic).
        topic,

        // What the field promises: when it happened. A proof the driver's app
        // sent hours later carries the moment it was signed (MOB-08); the
        // `updated_since` filter stays on created_at, the receipt, so a
        // late-arriving event is never skipped by a poller already past it.
        occurred_at: toIso(event.occurred_at ?? event.created_at)!,

        delivery: event.delivery,

        data: {
          status_from: event.status_from,
          status_to: event.status_to,
          received_by: event.received_by,
          note: event.note,

          // The key the webhook of the same topic carries (L8): what an ERP
          // matches an occurrence by, since the name can be renamed. Only on
          // occurrence.reported, as in the webhook; null elsewhere.
          occurrence_code:
            topic === "occurrence.reported"
              ? (event.occurrence?.occurrenceType?.code ?? null)
              : null,
        },
      },
    ];
  });
}

/** The larger of two id floors (uuid text sorts in time order); null: none. */
function maxId(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;

  return a > b ? a : b;
}

class IntegrationRepository implements IIntegrationRepository {
  constructor(
    private prisma = database,
    /**
     * The standby for /integration/v1/events (plano-escala F4-43): the
     * replica guard's client while it vouches for it, else null. Read only
     * with INTEGRATION_EVENTS_READ_REPLICA, by the commit walk alone.
     */
    private standby: () => PrismaClient | null = replicaDatabase,
  ) {}

  /**
   * The heavy reads' bulkhead (plano-escala F3-17), for the LISTS of
   * /integration/v1/deliveries and /routes (one delivery, one route, the
   * events and the submissions stay on the primary: an ERP reads them right
   * after its own write): a pool of its own, 3 connections and 10 s a
   * statement, so a burst of them waits among itself instead of taking the
   * connections every other request needs. A repository built on another
   * client (a test's) reads on that client. A getter, so a module that mocks
   * infra/database without it only needs it when one of these reads runs.
   * With DATABASE_REPLICA_URL, readDatabase() sends them to the standby
   * while the replica guard vouches for it: lists only (plano-escala F4-42,
   * tests/unitaires/database/read-routing-guard.test.ts).
   */
  private get read(): typeof this.prisma {
    return this.prisma === database ? readDatabase() : this.prisma;
  }

  async listDeliveries({
    businessId,
    limit,
    cursor,
    updated_since,
    status,
  }: IntegrationListProps): Promise<CursorPage<PublicDelivery>> {
    // One server for the page and its stops: the standby may not have the
    // stops of a delivery the primary just gave.
    const read = this.read;
    const rows = await read.delivery.findMany({
      where: {
        businessId,
        ...(status && {
          status: status as Prisma.EnumDeliveryStatusFilter["equals"],
        }),
        ...(updated_since && { updated_at: { gte: new Date(updated_since) } }),
        // After the cursor by its value (cursorPage says why).
        ...(cursor && { id: { gt: cursor } }),
      },

      select: deliverySelect,
      orderBy: { id: "asc" },

      // One more than asked, so "is there another page?" costs nothing extra.
      take: limit + 1,
    });

    const { page, next_cursor } = cursorPage(rows, limit);

    const data = await withStopRoutes(read, page);

    return { data: data.map(toPublicDelivery), next_cursor };
  }

  async findDelivery(
    businessId: string,
    deliveryId: string,
  ): Promise<PublicDelivery | null> {
    const found = await this.prisma.delivery.findFirst({
      where: { id: deliveryId, businessId },
      select: deliverySelect,
    });

    if (!found) return null;

    const [delivery] = await withStopRoutes(this.prisma, [found]);

    return toPublicDelivery(delivery);
  }

  async listRoutes({
    businessId,
    limit,
    cursor,
    updated_since,
    status,
  }: IntegrationListProps): Promise<CursorPage<PublicRoute>> {
    const rows = await this.read.route.findMany({
      where: {
        businessId,
        ...(status && {
          status: status as Prisma.EnumRouteStatusFilter["equals"],
        }),
        ...(updated_since && { updated_at: { gte: new Date(updated_since) } }),
        ...(cursor && { id: { gt: cursor } }),
      },

      select: routeSelect,
      orderBy: { id: "asc" },

      take: limit + 1,
    });

    const { page, next_cursor } = cursorPage(rows, limit);

    return { data: page.map(toPublicRoute), next_cursor };
  }

  async findRoute(
    businessId: string,
    routeId: string,
  ): Promise<PublicRoute | null> {
    const found = await this.prisma.route.findFirst({
      where: { id: routeId, businessId },
      select: routeSelect,
    });

    return found ? toPublicRoute(found) : null;
  }

  async listEvents(props: IntegrationEventListProps): Promise<EventPage> {
    // Read from the delivery events themselves rather than from the outbox:
    // the outbox is purged, and an integration that polls a week of history
    // must not find a hole where the cleanup ran.
    //
    // Commit order only with INTEGRATION_FEED_ORDER=commit (F2-05): the
    // image before this one cannot read the v2 cursor that walk hands out.
    return env.INTEGRATION_FEED_ORDER === "commit"
      ? this.listEventsByCommit(props)
      : this.listEventsById(props);
  }

  /**
   * The walk every release before F2-05 does: by the event's id, with the
   * id as the cursor. An event whose transaction minted its id first and
   * committed last lands behind a poller already past it, and is skipped:
   * the reason for the commit walk below.
   */
  private async listEventsById({
    businessId,
    limit,
    position,
    updated_since,
  }: IntegrationEventListProps): Promise<EventPage> {
    // The tenant is the event's own column, not `delivery: { businessId }`.
    // Through the relation Postgres either walked the primary key across
    // every tenant's events, joining each to its delivery, or joined all the
    // tenant's deliveries and sorted their whole history to keep one page.
    // (businessId, id) walks exactly this tenant in cursor order and stops at
    // the page; the delivery is then read by primary key for the rows kept.
    const since = updated_since ? new Date(updated_since) : null;
    const idFloor = since ? eventIdFloor(since) : null;

    const rows = await this.prisma.deliveryEvent.findMany({
      where: {
        businessId,
        ...(since && { created_at: { gte: since } }),
        ...(idFloor && { id: { gte: idFloor } }),
      },

      select: EVENT_SELECT,
      orderBy: { id: "asc" },

      take: limit + 1,
      // By the id, for the legacy cursor and for v2 alike (F2-04).
      ...(position && { skip: 1, cursor: { id: position.id } }),
    });

    const { page, next_cursor } = cursorPage(rows, limit);

    return {
      data: publishEvents(page),
      next_cursor,
      // The id walk's cursor: the last row read, or where this page began.
      resume_cursor: page[page.length - 1]?.id ?? position?.id ?? null,
    };
  }

  /**
   * The walk in commit order (plano-escala F2-05): by (txid, id), only
   * below the oldest transaction still open, from a floor of ids
   * (commit-order.ts and feed-floor.ts say why none is ever skipped).
   *
   * Three short reads: the cluster's epoch with the snapshot's xmin; the
   * page's keys on the feed's index ("businessId", COALESCE(txid, 0), id);
   * the page's rows by primary key, through the same select as the id walk.
   * A conversion (a legacy cursor, or one of another epoch) adds one: the
   * smallest txid among the events that may be unseen.
   */
  private async listEventsByCommit(
    props: IntegrationEventListProps,
  ): Promise<EventPage> {
    // On the standby (plano-escala F4-43), behind its own flag: a page
    // there is whole, every read of it on the standby, so its horizon is
    // the standby's own pg_current_snapshot(). Everything below that xmin
    // has been replayed there (a transaction still open on the primary, or
    // whose commit the standby has not replayed yet, is at or above it),
    // so nothing is skipped; a cursor from a fresher primary page only
    // waits there until the standby passes it, never going back.
    // tests/E2E/infra/events-on-standby.test.ts interleaves both servers.
    const standby = env.INTEGRATION_EVENTS_READ_REPLICA ? this.standby() : null;

    if (!standby) return this.walkByCommit(this.prisma, props);

    try {
      return await this.walkByCommit(standby, props);
    } catch (error) {
      // A read the standby cancelled (a conflict with its recovery) or a
      // standby gone mid-page: the same page from the primary, which has
      // everything the standby has.
      logger.warn(
        { code: (error as { code?: unknown })?.code ?? null },
        "integration feed: the standby failed the page; served by the primary",
      );

      return this.walkByCommit(this.prisma, props);
    }
  }

  /** One page of the commit walk, every read of it on `client`. */
  private async walkByCommit(
    client: PrismaClient,
    { businessId, limit, position, updated_since }: IntegrationEventListProps,
  ): Promise<EventPage> {
    const marginMs = env.FEED_FLOOR_MARGIN_MS;

    // With the epoch, whether its row still describes the cluster: the
    // same pair the release step and cluster-epoch-stale compare (null
    // without a row).
    const [horizon] = await client.$queryRaw<
      Array<{
        epoch: number | null;
        changed_at: Date | null;
        xmin: string;
        describes_cluster: boolean | null;
      }>
    >`
      SELECT e."epoch", e."changed_at",
             (pg_snapshot_xmin(pg_current_snapshot()))::text AS "xmin",
             (e."system_identifier" = s.system_identifier
               AND e."timeline" = ${CURRENT_TIMELINE}) AS "describes_cluster"
      FROM pg_control_system() s
      CROSS JOIN pg_control_checkpoint() c
      LEFT JOIN "cluster_epoch" e ON e."id" = 1
    `;

    // A promote or a PITR the release step has not recorded (the review of
    // wave 17): the epoch below is the history before, and a cursor of that
    // history would be read as a position in this one, skipping its events
    // for good. No page until the step runs (FeedEpochStaleError); on the
    // standby, listEventsByCommit then asks the primary.
    if (horizon?.describes_cluster === false) {
      logger.warn(
        { businessId, epoch: horizon.epoch },
        "integration feed: cluster_epoch does not describe the cluster (a promote or a restore before the release step); page refused until the step runs",
      );

      throw new FeedEpochStaleError();
    }

    // No epoch row yet (the release step has not run on this database):
    // epoch 0, which the first epoch (1) converts, at least once. When the
    // epoch began decides whether another epoch in a cursor is that change
    // reaching the integrator (paged) or a stray claim (counted only).
    const epoch = horizon?.epoch ?? 0;
    const start = feedStart(
      position,
      epoch,
      marginMs,
      Date.now(),
      horizon?.changed_at ? horizon.changed_at.getTime() : null,
    );

    let from: FeedPosition | null =
      start.kind === "position" ? start.position : null;

    if (start.kind === "convert") {
      const [smallest] = await client.$queryRaw<Array<{ txid: string | null }>>`
        SELECT (min(COALESCE("txid", 0)))::text AS "txid"
        FROM "delivery_event"
        WHERE "businessId" = ${businessId}::text
          AND ${
            "above" in start.scan
              ? Prisma.sql`"id" > ${start.scan.above}::text`
              : Prisma.sql`"id" >= ${start.scan.from}::text`
          }
      `;

      from = convertedPosition(
        smallest?.txid == null ? null : BigInt(smallest.txid),
        BigInt(horizon.xmin),
        start.floorMs,
      );

      countFeedConversion(start.reason);

      if (start.reason === "epoch") {
        logger.warn(
          {
            businessId,
            cursorEpoch: position?.epoch ?? null,
            epoch,
            floorMs: start.floorMs,
          },
          "integration feed: cursor of another cluster epoch converted from its floor; events since then are sent again",
        );
      } else if (start.reason === "stray") {
        // Not the cluster's doing: info, and no page (feed-metrics.ts).
        logger.info(
          {
            businessId,
            cursorEpoch: position?.epoch ?? null,
            epoch,
            floorMs: start.floorMs,
          },
          "integration feed: cursor of another epoch with no recent epoch change behind it (edited, from another environment, or long after a change) converted from its floor",
        );
      }
    }

    const since = updated_since ? new Date(updated_since) : null;
    const idFloor = maxId(
      from && from.floorMs > 0 ? uuid7Floor(from.floorMs) : null,
      since ? eventIdFloor(since) : null,
    );

    const keys = await client.$queryRaw<
      Array<{ id: string; txid: string; created_at: Date }>
    >`
      SELECT "id", (COALESCE("txid", 0))::text AS "txid", "created_at"
      FROM "delivery_event"
      WHERE "businessId" = ${businessId}::text
        AND COALESCE("txid", 0) < ((pg_snapshot_xmin(pg_current_snapshot()))::text)::bigint
        ${
          from
            ? Prisma.sql`AND (COALESCE("txid", 0), "id") > (${from.txid.toString()}::bigint, ${from.id}::text)`
            : Prisma.empty
        }
        ${idFloor ? Prisma.sql`AND "id" >= ${idFloor}::text` : Prisma.empty}
        ${since ? Prisma.sql`AND "created_at" >= ${since}` : Prisma.empty}
      ORDER BY COALESCE("txid", 0), "id"
      LIMIT ${limit + 1}::int
    `;

    const pageKeys = keys.slice(0, limit);

    const found = pageKeys.length
      ? await client.deliveryEvent.findMany({
          where: { businessId, id: { in: pageKeys.map((key) => key.id) } },
          select: EVENT_SELECT,
        })
      : [];

    const byId = new Map(found.map((event) => [event.id, event]));

    // Back in the walk's order; a key whose row vanished between the two
    // reads (an event cascading with its delivery) is simply not published.
    const page = pageKeys.flatMap((key) => {
      const event = byId.get(key.id);

      return event ? [event] : [];
    });

    const last = pageKeys[pageKeys.length - 1] as
      (typeof pageKeys)[number] | undefined;
    const after = last
      ? positionAfter(
          { txid: BigInt(last.txid), id: last.id, created_at: last.created_at },
          marginMs,
        )
      : from;

    return {
      data: publishEvents(page),
      next_cursor: keys.length > limit && after ? cursorOf(after, epoch) : null,
      resume_cursor: after ? cursorOf(after, epoch) : null,
    };
  }

  async findSubmission(
    businessId: string,
    idempotencyKey: string,
  ): Promise<(StoredDelivery & { id: string }) | null> {
    return this.prisma.delivery.findUnique({
      where: {
        businessId_client_submission_id: {
          businessId,
          client_submission_id: idempotencyKey,
        },
      },

      // Exactly what the create writes from the request, and nothing it
      // does not: the status, the driver or the route moving later is not
      // the caller's body changing.
      select: {
        id: true,
        shipperId: true,
        code: true,
        invoice_key: true,
        invoice_number: true,
        recipient_name: true,
        recipient_document: true,
        recipient_email: true,
        recipient_telephone: true,
        cep: true,
        city: true,
        uf: true,
        street: true,
        address_number: true,
        complement: true,
        neighborhood: true,
        scheduled_date: true,
        notes: true,
        kind: true,
        // The point the body gave is MANUAL; a GEOCODER one came later and is
        // not compared (replay-fingerprint, plan E1).
        latitude: true,
        longitude: true,
        geo_source: true,
        // Whether an API key made it: the panel's submissions are not replayed.
        apiKeyId: true,
        items: {
          select: {
            description: true,
            quantity: true,
            unit: true,
            unit_value: true,
          },
        },
      },
    });
  }

  async findProofLinkTarget(deliveryId: string): Promise<{
    businessId: string;
    status: string;
    created_at: Date;
  } | null> {
    return this.prisma.delivery.findUnique({
      where: { id: deliveryId },
      select: { businessId: true, status: true, created_at: true },
    });
  }
}

export { IntegrationRepository, cursorPage, eventIdFloor };
