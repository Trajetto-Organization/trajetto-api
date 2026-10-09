import { injectable } from "tsyringe";

import database from "@/../infra/database";

import { decidePermission } from "@/modules/middlewares/verify-permission";
import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import { aiProviderConfigured } from "@/shared/ai/ai-provider";
import { PROVIDER_PAUSED_MARKER } from "@/shared/ai/provider-failure";

import {
  PAUSED_MESSAGE,
  isPausedReading,
  progressError,
  type ProgressErrorCode,
} from "./progress-error";

import {
  RECORD_PERMISSION,
  findRecordInScope,
  type AIRecordPrincipal,
  type AIRecordType,
} from "../shared/ai-record-access";

interface GetAnalysisProgressRequest {
  principal: AIRecordPrincipal;
  recordType: AIRecordType;
  recordId: string;
}

interface GetAnalysisProgressResponse {
  status:
    | "none"
    | "PENDING"
    | "PROCESSING"
    | "COMPLETED"
    | "PARTIAL"
    | "FAILED"
    | "SKIPPED";
  unitsTotal: number;
  unitsCompleted: number;
  attempts: number;
  availableAt: string | null;

  /**
   * Why it waits or how it ended, as a stable code (progress-error.ts), and
   * our own pt-BR sentence for it — never the provider's raw error text.
   */
  lastErrorCode: ProgressErrorCode | null;
  lastError: string | null;

  /**
   * Waiting on the provider, not on the queue: it refused service (spend or
   * usage limit, credentials) and the reading resumes by itself (AI-8).
   */
  paused: boolean;

  /** The record's company has AI readings on (limit > 0, provider set up). */
  aiEnabled: boolean;

  /**
   * Whether THIS caller may ask for a (new) reading of the record: the
   * record's write permission, not a driver, readings on. The screens decide
   * the button from this instead of from the company's usage, which only
   * admins may read (AI-1).
   */
  canRequest: boolean;
}

/**
 * Durable progress of the latest AI analysis for a record. The websocket
 * events carry the live progress, but they die with the page — after a
 * refresh this is what lets the details dialog show "3 de 8 fotos" instead
 * of a bare spinner.
 *
 * Scoped to what the caller may see of the record: another company's, or a
 * colleague's for a driver, is 404 like a record that does not exist.
 */
@injectable()
class GetAnalysisProgressUseCase {
  async execute({
    principal,
    recordType,
    recordId,
  }: GetAnalysisProgressRequest): Promise<GetAnalysisProgressResponse> {
    const record = await findRecordInScope(principal, recordType, recordId);

    const [request, business] = await Promise.all([
      database.aIAnalysisRequest.findFirst({
        where: {
          type: recordType === "fuel" ? "FUEL_ODOMETER" : "CHECKLIST",
          recordId: record.id,
          businessId: record.businessId,
        },
        orderBy: { created_at: "desc" },
        include: { units: { select: { status: true } } },
      }),
      database.business.findUnique({
        where: { id: record.businessId },
        select: { ai_analysis_limit: true },
      }),
    ]);

    const aiEnabled =
      (business?.ai_analysis_limit ?? 0) > 0 && aiProviderConfigured();

    const canRequest =
      aiEnabled &&
      decidePermission(principal, RECORD_PERMISSION[recordType], "write", {
        allowDriver: false,
      }) === null;

    if (!request) {
      return {
        status: "none",
        unitsTotal: 0,
        unitsCompleted: 0,
        attempts: 0,
        availableAt: null,
        lastErrorCode: null,
        lastError: null,
        paused: false,
        aiEnabled,
        canRequest,
      };
    }

    let error = progressError(request.status, request.lastError);

    const paused = isPausedReading(
      request.status,
      error,
      request.status === "PENDING" && (await providerPaused()),
    );

    // Queued during the outage, never claimed: no error of its own, but it
    // waits for the same reason as the ones the provider refused.
    if (paused && error?.code !== "AI_PROVIDER_PAUSED") {
      error = { code: "AI_PROVIDER_PAUSED", message: PAUSED_MESSAGE };
    }

    return {
      status: request.status,
      unitsTotal: request.units.length,
      unitsCompleted: request.units.filter(
        (unit) => unit.status === "CONSUMED",
      ).length,
      attempts: request.attempts,
      availableAt: request.availableAt?.toISOString() ?? null,
      lastErrorCode: error?.code ?? null,
      lastError: error?.message ?? null,
      paused,
      aiEnabled,
      canRequest,
    };
  }
}

/**
 * Whether the provider is refusing service right now: this replica's
 * circuit is open, or any replica put a request back with the pause marker
 * that is still waiting (the circuit is per replica; the marker is shared).
 * A yes/no about the provider, never about another company's requests.
 */
async function providerPaused(): Promise<boolean> {
  if (AIAnalysisPipelineService.getInstance().providerCircuit().state !== "closed") {
    return true;
  }

  const rows = await database.$queryRaw<Array<{ paused: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "ai_analysis_request"
      WHERE "status" = 'PENDING'
        AND starts_with("lastError", ${PROVIDER_PAUSED_MARKER})
    ) AS "paused"
  `;

  return rows[0]?.paused === true;
}

export { GetAnalysisProgressUseCase };
export type { GetAnalysisProgressResponse };
