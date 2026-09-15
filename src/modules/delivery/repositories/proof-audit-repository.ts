import database from "@/../infra/database";

import { Prisma } from "@prisma/client";

import type { IProofAuditRepository } from "./IProof-audit-repository";
import type {
  ListProofAuditsProps,
  ListProofAuditsResult,
  ProofAuditCard,
  ProofAuditRecord,
  ProofAuditSuggestion,
} from "../dtos/proof-audit-dto";

class ProofAuditRepository implements IProofAuditRepository {
  constructor(private prisma = database) {}

  async enqueue(
    deliveryId: string,
    businessId: string,
  ): Promise<ProofAuditRecord> {
    const saved = await this.prisma.deliveryProofAudit.upsert({
      where: { deliveryId },
      create: { deliveryId, businessId },
      update: {
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

  async attachSuggestion(
    deliveryId: string,
    businessId: string,
    suggestion: ProofAuditSuggestion,
    confidence: number,
  ): Promise<void> {
    // updateMany, so a card already decided by a person while the model was
    // thinking is not dragged back to PENDING by a late answer.
    await this.prisma.deliveryProofAudit.updateMany({
      where: { deliveryId, businessId, status: "PENDING" },
      data: {
        ai_suggestion: suggestion as unknown as Prisma.InputJsonValue,
        ai_confidence: confidence,
        ai_analyzed_at: new Date(),
      },
    });
  }

  async findById(
    auditId: string,
    businessId: string,
  ): Promise<ProofAuditRecord | null> {
    const found = await this.prisma.deliveryProofAudit.findFirst({
      where: { id: auditId, businessId },
    });

    return found as unknown as ProofAuditRecord | null;
  }

  async listQueue({
    businessId,
    status,
    page,
    pageSize,
  }: ListProofAuditsProps): Promise<ListProofAuditsResult> {
    const [rows, total, counts, reviewed] = await Promise.all([
      this.prisma.deliveryProofAudit.findMany({
        where: { businessId, status },

        // Oldest first within the queue. The model's priority orders inside a
        // page in the use case — Postgres cannot sort by a value buried in a
        // JSON column without an expression index, and the page is fifty rows.
        orderBy: { created_at: "asc" },

        skip: (page - 1) * pageSize,
        take: pageSize,

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
      }),

      this.prisma.deliveryProofAudit.count({ where: { businessId, status } }),

      this.prisma.deliveryProofAudit.groupBy({
        by: ["status"],
        where: { businessId },
        _count: { _all: true },
      }),

      // The agreement rate: how often the machine and the person said the same
      // thing. Only over the cards that HAVE a suggestion — a photo the model
      // never answered about is not a disagreement.
      this.prisma.deliveryProofAudit.findMany({
        where: {
          businessId,
          status: { in: ["APPROVED", "REJECTED"] },
          ai_suggestion: { not: Prisma.DbNull },
        },
        select: { status: true, ai_suggestion: true },
      }),
    ]);

    const countOf = (name: string) =>
      counts.find((entry) => entry.status === name)?._count._all ?? 0;

    let agreed = 0;

    for (const row of reviewed) {
      const suggestion = row.ai_suggestion as unknown as ProofAuditSuggestion;

      const machineSaidFine =
        suggestion?.assessment?.suggestion === "looks_good";

      if (machineSaidFine === (row.status === "APPROVED")) agreed += 1;
    }

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
        } as ProofAuditCard;
      }),

      total,

      meta: {
        pending: countOf("PENDING"),
        approved: countOf("APPROVED"),
        rejected: countOf("REJECTED"),

        agreementRate:
          reviewed.length > 0 ? agreed / reviewed.length : null,
      },
    };
  }

  async review({
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
  }): Promise<ProofAuditRecord | null> {
    // The precondition is in the `where`, not in a read above it: two
    // reviewers open the same card and both press approve, and the second must
    // be told rather than overwriting the first name on the record.
    const { count } = await this.prisma.deliveryProofAudit.updateMany({
      where: { id: auditId, businessId, status: "PENDING" },
      data: {
        status,
        reviewedById,
        reviewed_at: new Date(),
        rejection_reason,
      },
    });

    if (count === 0) return null;

    return this.findById(auditId, businessId);
  }
}

export { ProofAuditRepository };
