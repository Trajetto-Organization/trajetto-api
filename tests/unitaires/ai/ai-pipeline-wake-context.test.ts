import { describe, expect, it, vi } from "vitest";

import { AIAnalysisPipelineService } from "@/shared/ai/ai-analysis-pipeline-service";
import {
  enterRequestContext,
  getRequestContext,
  withoutRequestContext,
} from "@/shared/http/request-context";

/**
 * The AI pipeline woken by a request does not run inside it (OBS-06, INV-12).
 *
 * `AIAnalysisService.requestAnalysis` wakes the pipeline from inside the
 * request that queued an analysis, and `enterWith` hands that request's
 * context to everything started from there. The cycle drains EVERY pending
 * analysis, of every tenant — and the outbox stamps each event it publishes
 * with the request id it finds in the context. So an `ai-verification.issue`
 * of company B went out carrying the id of company A's request, which only
 * happened to wake the batch: following A's id led to B's deliveries.
 */
vi.mock("@/websocket", () => ({ sendAIVerificationEvent: vi.fn() }));
vi.mock("@/../infra/database", () => ({ default: {} }));

describe("the AI pipeline woken from a request", () => {
  it("runs its cycle with no request context, so nothing it publishes is stamped with that request", async () => {
    let seen: unknown = "the cycle never ran";

    vi.spyOn(
      AIAnalysisPipelineService.prototype as never,
      "runCycle",
    ).mockImplementation((async () => {
      seen = getRequestContext();
    }) as never);

    // As a request does: its context entered, then the wake.
    await withoutRequestContext(async () => {
      enterRequestContext({ requestId: "request-that-woke-the-batch" });

      AIAnalysisPipelineService.getInstance().wake();
    });

    expect(seen).toBeUndefined();
  });
});
