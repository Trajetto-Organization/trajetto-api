import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  acceptDevicePrecheck,
  devicePrecheckField,
  devicePrecheckSchema,
  odometerDeviceAgreement,
  proofDeviceAgreement,
  sessionPrecheckFlag,
} from "@/shared/ai-precheck/device-precheck";
import {
  countDeviceAgreement,
  deviceAgreementTotals,
} from "@/shared/ai-precheck/device-agreement-metrics";
import { proofAiState } from "@/modules/delivery/usecases/list-proof-audits/proof-ai-state";
import { InMemoryProofAuditRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-audit-repository";

/**
 * The phone's pre-check on the API side (decision 14.2): what is kept, what
 * is dropped, and how it is compared with the server's reading.
 */
const sent = {
  engine: "mlkit-text-v2-latin",
  engine_version: "16.0.1",
  rules_version: 1,
  ran_at: "2026-10-05T13:20:00.000-03:00",
  duration_ms: 380,
  kind: "proof",
  invoice_number_found: true,
  date_out_of_window: false,
  typed_mileage_found: null,
  outcome: "ok",
  driver_overrode: false,
} as const;

const on = { aiAnalysisLimit: 100, providerConfigured: true };

describe("the body field", () => {
  const body = z.object({ device_precheck: devicePrecheckField });

  it("passes a well-formed pre-check through", () => {
    expect(body.parse({ device_precheck: sent }).device_precheck).toEqual(sent);
  });

  it("drops a malformed one instead of refusing the submission", () => {
    // A 400 parks the driver's queue for good; the hint is not worth that.
    expect(body.parse({ device_precheck: { ...sent, text: "MARIA" } }).device_precheck).toBeUndefined();
    expect(body.parse({ device_precheck: "{}" }).device_precheck).toBeUndefined();
    expect(body.parse({ device_precheck: { ...sent, engine: "tesseract" } }).device_precheck).toBeUndefined();
    expect(body.parse({}).device_precheck).toBeUndefined();
  });

  it("never carries the text read: the schema is strict", () => {
    expect(devicePrecheckSchema.safeParse({ ...sent, lines: ["NF 123"] }).success).toBe(false);
  });
});

describe("acceptDevicePrecheck", () => {
  it("keeps it for a company that bought the reading, with the server reading on", () => {
    expect(acceptDevicePrecheck(sent, { ...on, kind: "proof" })).toEqual(sent);
  });

  it("drops it without the contract, with the reading off, or for another kind of photo", () => {
    expect(acceptDevicePrecheck(sent, { ...on, aiAnalysisLimit: 0, kind: "proof" })).toBeNull();
    expect(acceptDevicePrecheck(sent, { ...on, aiAnalysisLimit: null, kind: "proof" })).toBeNull();
    expect(acceptDevicePrecheck(sent, { ...on, providerConfigured: false, kind: "proof" })).toBeNull();
    expect(acceptDevicePrecheck(sent, { ...on, kind: "odometer" })).toBeNull();
    expect(acceptDevicePrecheck(undefined, { ...on, kind: "proof" })).toBeNull();
  });
});

describe("sessionPrecheckFlag", () => {
  it("is on only with the contract, the server reading and quota left", () => {
    expect(sessionPrecheckFlag({ ...on, remaining: 5 })).toEqual({ precheck: true, reason: null });
    // The ledger could not be read: the server's reservation still gates.
    expect(sessionPrecheckFlag({ ...on, remaining: null })).toEqual({ precheck: true, reason: null });
    expect(sessionPrecheckFlag({ ...on, remaining: 0 })).toEqual({
      precheck: false,
      reason: "quota_exhausted",
    });
    expect(sessionPrecheckFlag({ ...on, aiAnalysisLimit: 0, remaining: null })).toEqual({
      precheck: false,
      reason: "not_contracted",
    });
    expect(sessionPrecheckFlag({ ...on, providerConfigured: false, remaining: null })).toEqual({
      precheck: false,
      reason: "unavailable",
    });
  });
});

describe("proofDeviceAgreement", () => {
  it("compares 'number found' with 'number matches'", () => {
    expect(proofDeviceAgreement(sent, { documentMatches: "yes" })).toBe("AGREE");
    expect(proofDeviceAgreement(sent, { documentMatches: "no" })).toBe("DISAGREE");
    expect(
      proofDeviceAgreement({ ...sent, invoice_number_found: false }, { documentMatches: "no" }),
    ).toBe("AGREE");
    expect(
      proofDeviceAgreement({ ...sent, invoice_number_found: false }, { documentMatches: "yes" }),
    ).toBe("DISAGREE");
  });

  it("is n/a when either side could not say", () => {
    expect(proofDeviceAgreement(sent, { documentMatches: "unknown" })).toBe("NOT_APPLICABLE");
    expect(proofDeviceAgreement(sent, { documentMatches: "not_applicable" })).toBe("NOT_APPLICABLE");
    expect(
      proofDeviceAgreement({ ...sent, invoice_number_found: null }, { documentMatches: "yes" }),
    ).toBe("NOT_APPLICABLE");
    expect(proofDeviceAgreement({ ...sent, outcome: "error" }, { documentMatches: "yes" })).toBe(
      "NOT_APPLICABLE",
    );
  });

  it("is null with nothing to compare", () => {
    expect(proofDeviceAgreement(null, { documentMatches: "yes" })).toBeNull();
    expect(proofDeviceAgreement(sent, null)).toBeNull();
    expect(proofDeviceAgreement({ ...sent, kind: "odometer" }, { documentMatches: "yes" })).toBeNull();
  });
});

describe("odometerDeviceAgreement", () => {
  const odometer = { ...sent, kind: "odometer", invoice_number_found: null, date_out_of_window: null, typed_mileage_found: true } as const;

  it("compares the phone's 'typed km found' with the server's 'km read matches'", () => {
    expect(odometerDeviceAgreement(odometer, true)).toBe("AGREE");
    expect(odometerDeviceAgreement(odometer, false)).toBe("DISAGREE");
    expect(odometerDeviceAgreement({ ...odometer, typed_mileage_found: false }, false)).toBe("AGREE");
    expect(odometerDeviceAgreement({ ...odometer, typed_mileage_found: false }, true)).toBe("DISAGREE");
  });

  it("is NOT_APPLICABLE when either side could not say", () => {
    expect(odometerDeviceAgreement(odometer, null)).toBe("NOT_APPLICABLE");
    expect(odometerDeviceAgreement({ ...odometer, typed_mileage_found: null }, true)).toBe("NOT_APPLICABLE");
    expect(odometerDeviceAgreement({ ...odometer, outcome: "error" }, true)).toBe("NOT_APPLICABLE");
  });

  it("is null without an odometer pre-check", () => {
    expect(odometerDeviceAgreement(null, true)).toBeNull();
    expect(odometerDeviceAgreement(sent, true)).toBeNull();
  });
});

describe("ai_device_agreement_total", () => {
  it("counts each verdict per kind and result, starting at zero", () => {
    const before = deviceAgreementTotals();

    countDeviceAgreement("proof", "AGREE");
    countDeviceAgreement("proof", "AGREE");
    countDeviceAgreement("fuel_odometer", "DISAGREE");
    countDeviceAgreement("checklist_mileage", null);

    const after = deviceAgreementTotals();

    expect(after.proof.AGREE - before.proof.AGREE).toBe(2);
    expect(after.fuel_odometer.DISAGREE - before.fuel_odometer.DISAGREE).toBe(1);
    expect(after.checklist_mileage).toEqual(before.checklist_mileage);
    expect(after.checklist_mileage.NOT_APPLICABLE).toBeGreaterThanOrEqual(0);
  });
});

describe("proofAiState with the phone's pre-check", () => {
  const base = {
    hasSuggestion: false,
    aiContracted: true,
    cardStatus: "PENDING" as const,
    createdAt: new Date(),
  };

  it("is provisional while the server reads, and 'read' once it did", () => {
    expect(proofAiState({ ...base, analysisStatus: "PENDING", hasDevicePrecheck: true })).toBe(
      "device_provisional",
    );
    expect(proofAiState({ ...base, analysisStatus: "PROCESSING", hasDevicePrecheck: true })).toBe(
      "device_provisional",
    );
    expect(
      proofAiState({ ...base, hasSuggestion: true, analysisStatus: "COMPLETED", hasDevicePrecheck: true }),
    ).toBe("read");
  });

  it("keeps the old states without a pre-check or after a failure", () => {
    expect(proofAiState({ ...base, analysisStatus: "PENDING" })).toBe("analyzing");
    expect(proofAiState({ ...base, analysisStatus: "FAILED", hasDevicePrecheck: true })).toBe("failed");
    expect(proofAiState({ ...base, analysisStatus: "SKIPPED", hasDevicePrecheck: true })).toBe(
      "quota_exceeded",
    );
  });
});

describe("the in-memory audit card, as Postgres keeps it", () => {
  it("writes the pre-check with the card and replaces it (null included) on a re-proof", async () => {
    const repository = new InMemoryProofAuditRepository();

    const card = await repository.enqueue("delivery-1", "business-1", undefined, {
      devicePrecheck: sent,
    });

    expect(card.device_precheck).toEqual(sent);
    // A copy, not the caller's object.
    expect(card.device_precheck).not.toBe(sent);

    card.device_agreement = "AGREE";

    const again = await repository.enqueue("delivery-1", "business-1");

    expect(again.id).toBe(card.id);
    expect(again.device_precheck).toBeNull();
    expect(again.device_agreement).toBeNull();
  });
});
