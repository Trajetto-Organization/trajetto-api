import database from "@/../infra/database";

import { Prisma } from "@prisma/client";

import type { IProofAuditRepository } from "./IProof-audit-repository";
import type {
  ListProofAuditsProps,
  ListProofAuditsQueue,
  ProofAnalysisStatus,
  ProofAuditQueueRow,
  ProofAuditQueueSettings,
  ProofAuditRecord,
  ProofAuditStatus,
} from "../dtos/proof-audit-dto";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";

class ProofAuditRepository implements IProofAuditRepository {
  constructor(private prisma = database) {}

  async enqueue(
    deliveryId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
    options?: { devicePrecheck?: DevicePrecheck | null },
  ): Promise<ProofAuditRecord> {
    const devicePrecheck = options?.devicePrecheck
      ? (options.devicePrecheck as Prisma.InputJsonObject)
      : Prisma.DbNull;

    const saved = await (tx ?? this.prisma).deliveryProofAudit.upsert({
      where: { deliveryId },
      create: { deliveryId, businessId, device_precheck: devicePrecheck },
      update: {
        // The phone's check is about the photo too (decision 14.2).
        device_precheck: devicePrecheck,
        device_agreement: null,
        // A re-proof is a new photo, so the old verdict and the old suggestion
        // are about a picture that is no longer the one on file.
        status: "PENDING",
        ai_suggestion: Prisma.DbNull,
        ai_confidence: null,
        ai_analyzed_at: null,
        reviewedById: null,
        reviewed_at: null,
        rejection_reason: null,
      },
    });

    return saved as unknown as ProofAuditRecord;
  }

  async findById(
    auditId: string,
    businessId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<ProofAuditRecord | null> {
    const found = await (tx ?? this.prisma).deliveryProofAudit.findFirst({
      where: { id: auditId, businessId },
    });

    return found as unknown as ProofAuditRecord | null;
  }

  async listQueue({
    businessId,
    status,
    page,
    pageSize,
    agreementSince,
  }: ListProofAuditsProps): Promise<ListProofAuditsQueue> {
    const skip = (page - 1) * pageSize;

    // The page beside the chips, the agreement card after them: at most two
    // of the replica's ten connections (tests/E2E/connection-fan-out.test.ts).
    const [ids, counts] = await Promise.all([
      this.pageIds(businessId, status, skip, pageSize),

      // One grouped count gives the three chips and this tab's total.
      this.prisma.deliveryProofAudit.groupBy({
        by: ["status"],
        where: { businessId },
        _count: { _all: true },
      }),
    ]);

    // How often the machine and the person said the same thing, over the
    // cards that HAVE a suggestion (a photo the model never answered about
    // is not a disagreement), inside the window. Counted here: loading the
    // tenant's whole reviewed history, JSON included, on every listing was
    // unbounded at 5M deliveries a month (DLVB-04). A range of
    // (businessId, status, reviewed_at DESC, id DESC) since 20261007120000
    // (db-perf 10/2026), with the JSON read from the window's rows only.
    //
    // `reviewed_at` is a naive UTC timestamp and Prisma binds a Date as
    // timestamptz: compared as they come, Postgres reads the column in the
    // SESSION zone and the window moved with the connection's TimeZone.
    // Normalised to UTC, the window starts at the company's midnight.
    const agreement = await this.prisma.$queryRaw<
      Array<{ reviewed: number; agreed: number }>
    >`
      SELECT
        count(*)::int AS "reviewed",
        count(*) FILTER (
          WHERE COALESCE(
            "ai_suggestion"->'assessment'->>'suggestion' = 'looks_good',
            false
          ) = ("status" = 'APPROVED')
        )::int AS "agreed"
      FROM "delivery_proof_audit"
      WHERE "businessId" = ${businessId}
        AND "status" IN ('APPROVED', 'REJECTED')
        AND "ai_suggestion" IS NOT NULL
        AND "reviewed_at" >= (${agreementSince.toISOString()}::timestamptz AT TIME ZONE 'UTC')
    `;

    const rows =
      ids.length === 0
        ? []
        : await this.prisma.deliveryProofAudit.findMany({
            where: { id: { in: ids }, businessId },
            include: {
              delivery: {
                select: {
                  id: true,
                  recipient_name: true,
                  city: true,
                  uf: true,
                  invoice_number: true,
                  code: true,
                  delivered_at: true,
                  received_by: true,
                  driver: { select: { name: true } },

                  events: {
                    where: { type: "PROOF" },
                    orderBy: { created_at: "desc" },
                    take: 1,
                    select: { photo: true, signature: true },
                  },
                },
              },

              reviewedBy: { select: { name: true } },
            },
          });

    // `in` does not keep the order the page was chosen in.
    const position = new Map(ids.map((id, index) => [id, index]));
    rows.sort(
      (left, right) => position.get(left.id)! - position.get(right.id)!,
    );

    const analysis = await this.latestAnalysisStatus(
      businessId,
      rows.map((row) => row.deliveryId),
    );

    const countOf = (name: string) =>
      counts.find((entry) => entry.status === name)?._count._all ?? 0;

    const reviewed = agreement[0]?.reviewed ?? 0;
    const agreed = agreement[0]?.agreed ?? 0;

    return {
      data: rows.map((row) => {
        const proof = row.delivery.events[0];

        return {
          ...(row as unknown as ProofAuditRecord),

          delivery: {
            id: row.delivery.id,
            recipient_name: row.delivery.recipient_name,
            city: row.delivery.city,
            uf: row.delivery.uf,
            invoice_number: row.delivery.invoice_number,
            code: row.delivery.code,
            delivered_at: row.delivery.delivered_at,
            received_by: row.delivery.received_by,
            driverName: row.delivery.driver?.name ?? null,
          },

          // Filled by the use case, which owns the signing service.
          photoUrl: proof?.photo ?? null,
          signatureUrl: proof?.signature ?? null,

          reviewerName: row.reviewedBy?.name ?? null,

          analysisStatus: analysis.get(row.deliveryId) ?? null,
        } as ProofAuditQueueRow;
      }),

      total: countOf(status),

      meta: {
        pending: countOf("PENDING"),
        approved: countOf("APPROVED"),
        rejected: countOf("REJECTED"),

        agreementRate: reviewed > 0 ? agreed / reviewed : null,
      },
    };
  }

  /**
   * The ids of one page, in the tab's order.
   *
   * The queue sorts by a value inside the JSON column, which Prisma cannot
   * express. It runs on the partial pending index (businessId, created_at)
   * WHERE status = 'PENDING' — the status is a literal for that reason — and
   * the pending queue of a company is tens to a few thousand rows, so the
   * sort is cheap. The history is ordered by the decision, which
   * (businessId, status, reviewed_at DESC, id DESC) serves since migration
   * 20261007120000: before it every history page top-N sorted the tenant's
   * decided cards (47 ms for 130k on the db-perf dataset, ~0.5 s at 1.2M).
   */
  private async pageIds(
    businessId: string,
    status: ProofAuditStatus,
    skip: number,
    take: number,
  ): Promise<string[]> {
    if (status === "PENDING") {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "delivery_proof_audit"
        WHERE "businessId" = ${businessId}
          AND "status" = 'PENDING'
        ORDER BY
          CASE
            WHEN jsonb_typeof("ai_suggestion"->'assessment'->'reviewPriority') = 'number'
              THEN ("ai_suggestion"->'assessment'->>'reviewPriority')::double precision
            ELSE 0
          END ASC,
          "created_at" ASC,
          "id" ASC
        LIMIT ${take}
        OFFSET ${skip}
      `;

      return rows.map((row) => row.id);
    }

    // Plain DESC (nulls first, Postgres' default): a decided card always has
    // reviewed_at, and this is the order a Prisma @@index(sort: Desc) serves.
    const rows = await this.prisma.deliveryProofAudit.findMany({
      where: { businessId, status },
      orderBy: [{ reviewed_at: "desc" }, { id: "desc" }],
      skip,
      take,
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  /**
   * The status of the latest reading request per delivery, so the card can
   * say "still reading", "failed" or "quota spent" instead of one "no
   * reading" for all of them. On the (type, recordId) index, one page at most.
   */
  private async latestAnalysisStatus(
    businessId: string,
    deliveryIds: string[],
  ): Promise<Map<string, ProofAnalysisStatus>> {
    const latest = new Map<string, ProofAnalysisStatus>();

    if (deliveryIds.length === 0) return latest;

    const requests = await this.prisma.aIAnalysisRequest.findMany({
      where: {
        type: "DELIVERY_PROOF",
        recordId: { in: deliveryIds },
        businessId,
      },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      select: { recordId: true, status: true },
    });

    for (const request of requests) {
      if (!latest.has(request.recordId)) {
        latest.set(request.recordId, request.status);
      }
    }

    return latest;
  }

  async findQueueSettings(
    businessId: string,
  ): Promise<ProofAuditQueueSettings | null> {
    return this.prisma.business.findUnique({
      where: { id: businessId },
      select: { timezone: true, ai_analysis_limit: true },
    });
  }

  async review(
    {
      auditId,
      businessId,
      reviewedById,
      status,
      rejection_reason,
    }: {
      auditId: string;
      businessId: string;
      reviewedById: string;
      status: "APPROVED" | "REJECTED";
      rejection_reason: string | null;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<ProofAuditRecord | null> {
    // The precondition is in the `where`, not in a read above it: two
    // reviewers open the same card and both press approve, and the second must
    // be told rather than overwriting the first name on the record.
    const { count } = await (tx ?? this.prisma).deliveryProofAudit.updateMany({
      where: { id: auditId, businessId, status: "PENDING" },
      data: {
        status,
        reviewedById,
        reviewed_at: new Date(),
        rejection_reason,
      },
    });

    if (count === 0) return null;

    return this.findById(auditId, businessId, tx);
  }
}

export { ProofAuditRepository };
