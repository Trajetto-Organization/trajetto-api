import { describe, expect, it } from "vitest";

import {
  PAUSED_MESSAGE,
  isPausedReading,
  progressError,
} from "@/modules/ai-analysis/usecases/get-analysis-progress/progress-error";

/**
 * What the progress route tells the tenant about a request's last error
 * (AI-8): a stable code and our own sentence, never the provider's text.
 */
describe("the progress route's error", () => {
  it("says a reading the provider refused is paused, in our words", () => {
    const error = progressError(
      "PENDING",
      "AI_PROVIDER_PAUSED: This request would exceed your organization's spend limit.",
    );

    expect(error).toEqual({
      code: "AI_PROVIDER_PAUSED",
      message: PAUSED_MESSAGE,
    });
    expect(error?.message).not.toContain("spend limit");
  });

  it("never passes the provider's raw error on", () => {
    const raw =
      '401 {"type":"authentication_error","message":"invalid x-api-key"}';

    expect(progressError("FAILED", raw)).toEqual({
      code: "AI_ANALYSIS_ERROR",
      message: "A leitura automática não pôde ser concluída.",
    });
    expect(progressError("PENDING", raw)).toEqual({
      code: "AI_ANALYSIS_ERROR",
      message:
        "A última tentativa de leitura falhou; uma nova tentativa está agendada.",
    });
  });

  it("tells the quota, a superseded input and a malformed answer apart", () => {
    expect(
      progressError("SKIPPED", "Limite de análises do período atingido")?.code,
    ).toBe("AI_QUOTA_EXCEEDED");
    expect(
      progressError(
        "COMPLETED",
        "AI_INPUT_SUPERSEDED: a foto deste item foi trocada.",
      )?.code,
    ).toBe("AI_INPUT_SUPERSEDED");
    expect(
      progressError(
        "FAILED",
        "AI_INVALID_RESPONSE: resposta sem JSON — Desculpe",
      )?.message,
    ).toBe("O modelo respondeu fora do formato esperado.");
    expect(progressError("COMPLETED", null)).toBeNull();
  });

  it("counts as paused a waiting request while the provider refuses service", () => {
    const paused = progressError("PENDING", "AI_PROVIDER_PAUSED: limite");

    expect(isPausedReading("PENDING", paused, false)).toBe(true);

    // Queued during the outage: no error of its own, held by the circuit.
    expect(isPausedReading("PENDING", null, true)).toBe(true);

    expect(isPausedReading("PENDING", null, false)).toBe(false);
    expect(isPausedReading("PROCESSING", null, true)).toBe(false);
    expect(isPausedReading("COMPLETED", paused, true)).toBe(false);
  });
});
