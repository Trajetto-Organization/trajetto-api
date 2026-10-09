import { describe, expect, it } from "vitest";

import { aiAnalysisHint } from "@/shared/ai/ai-realtime";

/**
 * Who hears that an analysis ended (AI-6). The full progress went only to
 * the requester — almost always the driver's app — so the admin looking at
 * the record on the web never heard the end of it.
 */
describe("the end-of-analysis hint", () => {
  const base = {
    businessId: "biz-1",
    recordId: "rec-1",
    timestamp: "2026-09-29T12:00:00.000Z",
  };

  it("goes to the company room for a fuelling or a checklist, with no reading in it", () => {
    const hint = aiAnalysisHint({
      ...base,
      recordType: "fuel",
      step: "completed",
      overallStatus: "mismatch",
      currentResult: { aiReadValue: 154002, details: "Divergência" },
    });

    expect(hint).toEqual({
      audience: "business",
      payload: { businessId: "biz-1", recordType: "fuel", recordId: "rec-1" },
    });
  });

  it("goes to the operations room for a receipt", () => {
    expect(
      aiAnalysisHint({ ...base, recordType: "proof", step: "completed" })?.audience,
    ).toBe("operations");
  });

  it("is only sent when the analysis ends", () => {
    for (const step of ["queued", "analyzing", "analyzing_field", "reading_odometer"]) {
      expect(aiAnalysisHint({ ...base, recordType: "checklist", step }), step).toBeNull();
    }

    expect(
      aiAnalysisHint({ ...base, recordType: "checklist", step: "skipped" }),
    ).not.toBeNull();
  });

  it("is not sent for an event it cannot place", () => {
    expect(aiAnalysisHint({ ...base, recordType: "other", step: "completed" })).toBeNull();
    expect(aiAnalysisHint({ recordType: "fuel", step: "completed" })).toBeNull();
    expect(aiAnalysisHint(null)).toBeNull();
  });
});
