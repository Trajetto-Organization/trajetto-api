import { describe, expect, it } from "vitest";

import {
  ANALYSIS_WAIT_MS,
  proofAiState,
  type ProofAiStateInput,
} from "@/modules/delivery/usecases/list-proof-audits/proof-ai-state";

/**
 * What a card says about the automatic reading (DLVP-PROOF-4).
 *
 * One "Sem leitura automática" covered a company without the AI, a reading
 * still running and a reading that failed, so the reviewer could not tell
 * whether to wait for it.
 */
const NOW = new Date("2026-09-28T15:00:00.000Z");

const state = (overrides: Partial<ProofAiStateInput>) =>
  proofAiState({
    hasSuggestion: false,
    analysisStatus: null,
    aiContracted: true,
    cardStatus: "PENDING",
    createdAt: new Date(NOW.getTime() - 60_000),
    now: NOW,
    ...overrides,
  });

describe("the reading state of a card", () => {
  it("is 'read' whenever the suggestion is there", () => {
    expect(state({ hasSuggestion: true, analysisStatus: "FAILED" })).toBe("read");
  });

  it("follows the latest request's status", () => {
    expect(state({ analysisStatus: "PENDING" })).toBe("analyzing");
    expect(state({ analysisStatus: "PROCESSING" })).toBe("analyzing");
    expect(state({ analysisStatus: "FAILED" })).toBe("failed");
    expect(state({ analysisStatus: "PARTIAL" })).toBe("failed");
    expect(state({ analysisStatus: "SKIPPED" })).toBe("quota_exceeded");
  });

  it("says the company did not contract the reading when nothing was asked", () => {
    expect(state({ aiContracted: false })).toBe("not_contracted");
  });

  it("waits for a request that may still be opened, but not forever", () => {
    expect(state({})).toBe("analyzing");

    const stale = new Date(NOW.getTime() - ANALYSIS_WAIT_MS - 1);

    expect(state({ createdAt: stale })).toBe("unavailable");
  });

  it("treats an answer that never reached the card as waiting only while the card waits", () => {
    // A re-proof reopens the card before its new request exists.
    expect(state({ analysisStatus: "COMPLETED" })).toBe("analyzing");

    // Decided before the answer landed.
    expect(state({ analysisStatus: "COMPLETED", cardStatus: "APPROVED" })).toBe(
      "unavailable",
    );
  });

  it("never says 'analyzing' on a decided card with no request", () => {
    expect(state({ cardStatus: "REJECTED" })).toBe("unavailable");
  });
});
