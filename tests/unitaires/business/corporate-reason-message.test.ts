import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { createBranchSchema } from "@/schemas/create-branch-schema";
import { createBusinessSchema } from "@/schemas/create-business-schema";
import { updateBranchSchema } from "@/schemas/update-branch-schema";
import { updateBusinessSchema } from "@/schemas/update-business-schema";

/**
 * "Razão social" is feminine: the four company and branch forms used to say
 * "O razão social deve conter apenas...", the one sentence of the field that
 * broke the agreement its siblings keep ("A razão social não pode começar...").
 * The sentence reaches the manager as is, so it is pinned here.
 */
const SENTENCE =
  "A razão social deve conter apenas letras (inclusive acentos), números, espaços e traços, sem outros caracteres.";

function corporateReasonIssues(schema: ZodType): string[] {
  const parsed = schema.safeParse({ corporate_reason: "Transportes & Filhos" });

  return parsed.success
    ? []
    : parsed.error.issues
        .filter((issue) => issue.path[0] === "corporate_reason")
        .map((issue) => issue.message);
}

describe("the corporate name with a character outside the allowed set", () => {
  it.each([
    ["create business", createBusinessSchema],
    ["update business", updateBusinessSchema],
    ["create branch", createBranchSchema],
    ["update branch", updateBranchSchema],
  ])("is refused with the feminine sentence on %s", (_name, schema) => {
    expect(corporateReasonIssues(schema)).toEqual([SENTENCE]);
  });
});
