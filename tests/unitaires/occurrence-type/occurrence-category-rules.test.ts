import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  acceptedAttachments,
  categoryIssues,
  missingRequirements,
  type CategoryShape,
  type ReportAttachments,
  type ReportRequirements,
} from "@/modules/occurrence-type/rules/occurrence-category-rules";

/**
 * The category matrix and the report requirements (decisions 14.3 and 14.4;
 * design §2.3 and §4.3) against the shared cases the web dialog and the app's
 * proof screen run too.
 */
interface SharedCases {
  matrix: Array<{ name: string; shape: CategoryShape; issues: unknown[] }>;
  missing: Array<{
    name: string;
    type: ReportRequirements;
    sent: ReportAttachments;
    missing: unknown[];
  }>;
}

const CASES = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures/occurrence-requirements-cases.json"),
    "utf8",
  ),
) as SharedCases;

describe("the category matrix", () => {
  it.each(CASES.matrix.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(categoryIssues(entry.shape)).toEqual(entry.issues);
    },
  );
});

describe("the requirements a driver's report leaves unmet", () => {
  it.each(CASES.missing.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(missingRequirements(entry.type, entry.sent)).toEqual(
        entry.missing,
      );
    },
  );
});

describe("what each category takes", () => {
  it("drops the receipt and the signature only in a pause, and who received outside a delivery", () => {
    expect(acceptedAttachments("DELIVERED")).toEqual({
      receipt_photo: true,
      signature: true,
      received_by: true,
    });
    expect(acceptedAttachments("NOT_DELIVERED")).toEqual({
      receipt_photo: true,
      signature: true,
      received_by: false,
    });
    expect(acceptedAttachments("PAUSE")).toEqual({
      receipt_photo: false,
      signature: false,
      received_by: false,
    });
  });
});
