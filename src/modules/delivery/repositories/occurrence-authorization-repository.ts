import { Prisma } from "@prisma/client";

import database from "@/../infra/database";

import type { DeliveryStatus } from "@/shared/delivery/delivery-rules";

import type {
  DecideAuthorizationInput,
  EscalationClaim,
  IOccurrenceAuthorizationRepository,
  OccurrenceForDecision,
  PendingAuthorizationRow,
} from "./IOccurrence-authorization-repository";

/** A UTC timestamp column compared with an instant, whatever the session zone. */
function utc(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * What the liveness rule reads, joined to a `delivery_occurrence o`: the
 * delivery (dl), the reporter (u), the delivery's open stop now (s, at most
 * one under route_stop_active_delivery_idx) and the route recorded by the
 * request's own OCCURRENCE event (ev).
 */
const ATTEMPT_JOINS = Prisma.sql`
  JOIN "delivery" dl ON dl."id" = o."deliveryId"
  JOIN "user" u ON u."id" = o."reportedById"
  LEFT JOIN LATERAL (
    SELECT rs."routeId", rs."created_at"
      FROM "route_stop" rs
     WHERE rs."deliveryId" = o."deliveryId"
       AND rs."status" IN ('PENDING', 'ARRIVED')
     ORDER BY rs."created_at" DESC
     LIMIT 1
  ) s ON true
  LEFT JOIN LATERAL (
    SELECT e."routeId"
      FROM "delivery_event" e
     WHERE e."occurrenceId" = o."id"
       AND e."type" = 'OCCURRENCE'
     ORDER BY e."created_at" ASC
     LIMIT 1
  ) ev ON true
`;

/**
 * authorizationRequestIsLive (authorization-liveness.ts) in SQL, over
 * ATTEMPT_JOINS. Three-valued on purpose: wrap it in `IS TRUE` / `IS NOT
 * TRUE`, since a NULL (no driver, no route) must read as "not live".
 */
const ATTEMPT_IS_LIVE = Prisma.sql`(
  dl."status" IN ('PENDING', 'IN_TRANSIT')
  AND (u."driverId" IS NULL OR dl."driverId" = u."driverId")
  AND NOT EXISTS (
    SELECT 1
      FROM "delivery_event" sc
     WHERE sc."deliveryId" = o."deliveryId"
       AND sc."type" = 'STATUS_CHANGE'
       AND sc."created_at" > o."created_at"
  )
  AND (
    CASE
      WHEN s."routeId" IS NULL THEN ev."routeId" IS NULL
      ELSE s."routeId" = ev."routeId" AND s."created_at" <= o."created_at"
    END
  )
)`;

const decisionInclude = {
  occurrenceType: {
    select: {
      id: true,
      name: true,
      blocks_delivery: true,
      requires_authorization: true,
      form_fields: true,
    },
  },
  reportedBy: { select: { id: true, name: true, driverId: true } },
  authorizedBy: { select: { id: true, name: true } },
} as const;

class OccurrenceAuthorizationRepository
  implements IOccurrenceAuthorizationRepository
{
  constructor(private prisma = database) {}

  async findForDecision(
    occurrenceId: string,
    businessId: string,
  ): Promise<OccurrenceForDecision | null> {
    // By id AND company: another carrier's id reads exactly like a missing one.
    return this.prisma.deliveryOccurrence.findFirst({
      where: { id: occurrenceId, businessId },
      include: decisionInclude,
    });
  }

  async decide(
    input: DecideAuthorizationInput,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;

    // Conditional on PENDING: the second operator's UPDATE waits on the
    // first one's row lock, then matches nothing.
    const { count } = await client.deliveryOccurrence.updateMany({
      where: {
        id: input.occurrenceId,
        businessId: input.businessId,
        authorization_status: "PENDING",
      },
      data: {
        authorization_status: input.status,
        authorizedById: input.authorizedById,
        authorized_at: input.at,
        authorization_note: input.note,
      },
    });

    return count === 1;
  }

  async supersede(
    occurrenceId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const client = tx ?? this.prisma;

    const { count } = await client.deliveryOccurrence.updateMany({
      where: { id: occurrenceId, businessId, authorization_status: "PENDING" },
      data: { authorization_status: "SUPERSEDED" },
    });

    return count === 1;
  }

  async lockAttempt(
    occurrenceId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ live: boolean; deliveryStatus: DeliveryStatus } | null> {
    // The delivery row first: every writer that ends an attempt (proof,
    // status change, route cancel) updates it, so they queue behind this.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT dl."id"
        FROM "delivery" dl
        JOIN "delivery_occurrence" o ON o."deliveryId" = dl."id"
       WHERE o."id" = ${occurrenceId}
         AND o."businessId" = ${businessId}
         FOR UPDATE OF dl
    `;

    if (locked.length === 0) return null;

    // A new statement: in READ COMMITTED it sees whatever committed while
    // the lock above waited.
    const [state] = await tx.$queryRaw<
      Array<{ status: DeliveryStatus; live: boolean }>
    >`
      SELECT dl."status"::text AS "status", (${ATTEMPT_IS_LIVE}) IS TRUE AS "live"
        FROM "delivery_occurrence" o
        ${ATTEMPT_JOINS}
       WHERE o."id" = ${occurrenceId}
    `;

    return state ? { live: state.live, deliveryStatus: state.status } : null;
  }

  async lockDeliveryForRequest(
    deliveryId: string,
    businessId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ status: DeliveryStatus; driverId: string | null } | null> {
    const [row] = await tx.$queryRaw<
      Array<{ status: DeliveryStatus; driverId: string | null }>
    >`
      SELECT "status"::text AS "status", "driverId"
        FROM "delivery"
       WHERE "id" = ${deliveryId}
         AND "businessId" = ${businessId}
         FOR UPDATE
    `;

    return row ?? null;
  }

  async isWaiting(occurrenceId: string, businessId: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ live: boolean }>>`
      SELECT (${ATTEMPT_IS_LIVE}) IS TRUE AS "live"
        FROM "delivery_occurrence" o
        ${ATTEMPT_JOINS}
       WHERE o."id" = ${occurrenceId}
         AND o."businessId" = ${businessId}
         AND o."authorization_status" = 'PENDING'
    `;

    return rows[0]?.live === true;
  }

  async listPending(
    businessId: string,
    limit: number,
  ): Promise<{ rows: PendingAuthorizationRow[]; total: number }> {
    // The status spelled as a literal: the partial index
    // delivery_occurrence_pending_authorization_idx only serves a query whose
    // predicate says 'PENDING' in the text. The window count runs before the
    // LIMIT, so the total rides on the same scan. A request whose attempt is
    // over is not answerable, so it is not queued even before the sweep
    // closes it.
    const page = await this.prisma.$queryRaw<
      Array<{ id: string; total: number }>
    >`
      SELECT o."id", (count(*) OVER ())::int AS "total"
      FROM "delivery_occurrence" o
      ${ATTEMPT_JOINS}
      WHERE o."businessId" = ${businessId}
        AND o."authorization_status" = 'PENDING'
        AND (${ATTEMPT_IS_LIVE}) IS TRUE
      ORDER BY o."created_at" ASC, o."id" ASC
      LIMIT ${limit}
    `;

    if (page.length === 0) return { rows: [], total: 0 };

    const found = await this.prisma.deliveryOccurrence.findMany({
      where: { id: { in: page.map((row) => row.id) }, businessId },
      include: {
        ...decisionInclude,
        delivery: {
          select: {
            id: true,
            code: true,
            invoice_number: true,
            recipient_name: true,
            street: true,
            address_number: true,
            neighborhood: true,
            city: true,
            uf: true,
            status: true,
            driver: { select: { id: true, name: true } },
          },
        },
      },
    });

    const byId = new Map(found.map((row) => [row.id, row]));

    return {
      // The page's order, not the IN list's.
      rows: page.flatMap((row) => {
        const hit = byId.get(row.id);

        return hit ? [hit as PendingAuthorizationRow] : [];
      }),
      total: page[0].total,
    };
  }

  async supersedeStale(
    limit: number,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<Array<{ id: string; businessId: string; deliveryId: string }>> {
    // The same shape as the claim below: SKIP LOCKED so a decision holding a
    // row is never waited on (it re-checks liveness under its own lock), and
    // the PENDING condition repeated on the row being written.
    return tx.$queryRaw<
      Array<{ id: string; businessId: string; deliveryId: string }>
    >`
      UPDATE "delivery_occurrence" w
         SET "authorization_status" = 'SUPERSEDED',
             "updated_at" = ${utc(at)}
       WHERE w."id" IN (
               SELECT o."id"
                 FROM "delivery_occurrence" o
                 ${ATTEMPT_JOINS}
                WHERE o."authorization_status" = 'PENDING'
                  AND (${ATTEMPT_IS_LIVE}) IS NOT TRUE
                ORDER BY o."created_at" ASC, o."id" ASC
                LIMIT ${limit}
                  FOR UPDATE OF o SKIP LOCKED
             )
         AND w."authorization_status" = 'PENDING'
      RETURNING w."id", w."businessId", w."deliveryId"
    `;
  }

  async claimDueEscalations(
    cutoff: Date,
    limit: number,
    at: Date,
    tx: Prisma.TransactionClient,
  ): Promise<EscalationClaim[]> {
    // One statement: pick the due rows with SKIP LOCKED (a second replica
    // running the same sweep takes others, or none), and stamp escalated_at
    // under the same condition, so a row is escalated exactly once. Only a
    // live request: nobody is told a driver waits on a delivery that was
    // cancelled, delivered or moved in the meantime.
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "delivery_occurrence" w
         SET "escalated_at" = ${utc(at)},
             "updated_at" = ${utc(at)}
       WHERE w."id" IN (
               SELECT o."id"
                 FROM "delivery_occurrence" o
                 ${ATTEMPT_JOINS}
                WHERE o."authorization_status" = 'PENDING'
                  AND o."escalated_at" IS NULL
                  AND o."created_at" <= ${utc(cutoff)}
                  AND (${ATTEMPT_IS_LIVE}) IS TRUE
                ORDER BY o."created_at" ASC, o."id" ASC
                LIMIT ${limit}
                  FOR UPDATE OF o SKIP LOCKED
             )
         AND w."authorization_status" = 'PENDING'
         AND w."escalated_at" IS NULL
      RETURNING w."id"
    `;

    if (claimed.length === 0) return [];

    const rows = await tx.deliveryOccurrence.findMany({
      where: { id: { in: claimed.map((row) => row.id) } },
      orderBy: [{ created_at: "asc" }, { id: "asc" }],
      select: {
        id: true,
        businessId: true,
        deliveryId: true,
        created_at: true,
        description: true,
        photos: true,
        form_answers: true,
        category: true,
        occurrenceType: {
          select: { name: true, blocks_delivery: true, form_fields: true },
        },
        reportedBy: { select: { name: true, driverId: true } },
        delivery: { select: { recipient_name: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      businessId: row.businessId,
      deliveryId: row.deliveryId,
      created_at: row.created_at,
      description: row.description,
      photosCount: row.photos.length,
      form_answers: row.form_answers,
      occurrenceTypeName: row.occurrenceType.name,
      blocksDelivery: row.occurrenceType.blocks_delivery,
      formFields: row.occurrenceType.form_fields,
      reporterName: row.reportedBy.name,
      reporterIsDriver: row.reportedBy.driverId !== null,
      recipientName: row.delivery.recipient_name,
      category: row.category,
    }));
  }
}

export { OccurrenceAuthorizationRepository };
