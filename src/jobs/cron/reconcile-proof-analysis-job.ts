import database from "@/../infra/database";

import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import { logger } from "@/shared/logging/logger";

import { AIAnalysisService } from "@/shared/ai/ai-analysis-service";
import { aiProviderConfigured } from "@/shared/ai/ai-provider";
import { buildProofAnalysisInput } from "@/shared/delivery/proof-analysis-input";

const log = logger.child({ component: "cron", job: "reconcile-proof-analysis" });

/**
 * How long a card waits before the sweep considers its request lost.
 *
 * The proof asks for the reading right after its commit; a card younger than
 * this may simply be waiting for that call to finish, and asking twice at the
 * same moment is a race the idempotency key absorbs but a log line reports.
 */
const SETTLE_MS = 10 * 60 * 1000;

/**
 * How far back the sweep looks. A reading that arrives days after the proof
 * is a reading nobody will use — the reviewer has already decided — and the
 * bound keeps every run a short range scan of the pending-queue index.
 */
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * The review cards whose AI reading was never requested (IDEMP-08).
 *
 * The card commits with the proof (INV-08); the request for the model's
 * reading runs after the commit and swallows its errors, because the driver in
 * the street must never lose a proof over a hint for the office. That makes it
 * at-most-once: a pool timeout or a crash between the commit and the request
 * leaves a card that never gets a suggestion, and the app's resend cannot heal
 * it — a known submission returns before any side effect.
 *
 * This asks again, for a PENDING card with no reading and no request for the
 * photo the delivery holds now, on a company that bought the reading. The input is built
 * by the same function the proof uses, from the proof's own event, so the
 * request is the one the proof would have opened. requestAnalysis is
 * idempotent by that input, and quota is reserved exactly as it would have
 * been.
 *
 * Per company through a LATERAL, so each company's cards come off the partial
 * pending-queue index (businessId, created_at) WHERE status = 'PENDING' as a
 * range, and only companies with the reading switched on are visited. The
 * statuses are SQL literals so the partial index is provable.
 *
 * A RE-proof whose new request was lost is found too: the first proof's
 * request exists for the delivery, but not for the photo on file now. Its
 * card counts as settled from its last change (the re-proof resets it), and
 * only cards first proven inside the lookback are visited, which keeps the
 * read a range of the pending-queue index.
 *
 * Cron: every 10 minutes, on one replica (the scheduler's election).
 */
const reconcileProofAnalysisJob: CronJobDefinition = {
  name: "reconcile-proof-analysis",
  schedule: "*/10 * * * *",

  async handler() {
    // Without a provider every request is only marked unavailable (dev).
    if (!aiProviderConfigured()) return;

    const settledBefore = new Date(Date.now() - SETTLE_MS);
    const since = new Date(Date.now() - LOOKBACK_MS);

    const cards = await database.$queryRaw<
      Array<{ deliveryId: string; businessId: string; timezone: string | null }>
    >`
      SELECT card."deliveryId", card."businessId", b."timezone"
      FROM "business" b
      CROSS JOIN LATERAL (
        SELECT c."deliveryId", c."businessId"
        FROM "delivery_proof_audit" c
        WHERE c."businessId" = b."id"
          AND c."status" = 'PENDING'
          AND c."created_at" >= ${since}
          AND c."updated_at" < ${settledBefore}
          AND c."ai_analyzed_at" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "ai_analysis_request" r
            WHERE r."type" = 'DELIVERY_PROOF'
              AND r."recordId" = c."deliveryId"
              AND r."input"->>'photoPath' IS NOT DISTINCT FROM (
                SELECT e."photo"
                FROM "delivery_event" e
                WHERE e."deliveryId" = c."deliveryId"
                  AND e."type" = 'PROOF'
                ORDER BY e."created_at" DESC, e."id" DESC
                LIMIT 1
              )
          )
        ORDER BY c."created_at"
        LIMIT 50
      ) card
      WHERE b."ai_analysis_limit" > 0
      LIMIT 200
    `;

    let requested = 0;

    for (const card of cards) {
      try {
        const proof = await database.deliveryEvent.findFirst({
          where: { deliveryId: card.deliveryId, type: "PROOF" },
          orderBy: [{ created_at: "desc" }, { id: "desc" }],
          select: {
            photo: true,
            signature: true,
            reportedById: true,
            occurred_at: true,
            created_at: true,
            delivery: {
              select: { invoice_number: true, code: true, recipient_name: true },
            },
          },
        });

        // A card without a driver's proof behind it has nothing to read.
        if (!proof?.photo || !proof.reportedById) continue;

        await AIAnalysisService.getInstance().requestAnalysis({
          type: "DELIVERY_PROOF",
          recordId: card.deliveryId,
          businessId: card.businessId,
          requestedById: proof.reportedById,
          input: buildProofAnalysisInput({
            photoPath: proof.photo,
            signaturePath: proof.signature,
            delivery: proof.delivery,
            provenAt: proof.occurred_at ?? proof.created_at,
            // The proof's own caller passes the same zone: the input is
            // hashed, and a day computed differently would open a second,
            // billed request for the same photo (DLVP-PROOF-4).
            timeZone: card.timezone,
          }),
        });

        requested += 1;
      } catch (error) {
        // One card never sinks the sweep; the next run tries it again.
        log.warn(
          { err: error, deliveryId: card.deliveryId },
          "could not request the missing proof analysis",
        );
      }
    }

    if (cards.length > 0) {
      log.info(
        { found: cards.length, requested },
        "proof analyses requested for cards left without one",
      );
    }
  },
};

export { reconcileProofAnalysisJob };
