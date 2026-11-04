import { describe, expect, it } from "vitest";

import { refusalPaddingMs } from "@/shared/security/refusal-pacing";

/**
 * The wait that evens out the CPF login's refusals (SEC-4): a refusal that
 * compared the password with `done` logins waits as long as the comparisons
 * it skipped would have taken, so every refusal costs `target` comparisons
 * of wall time — and no more CPU than the comparisons it really made.
 */
describe("refusalPaddingMs", () => {
  it("pads one comparison up to the target, at this request's own pace", () => {
    expect(refusalPaddingMs(70, 1, 10)).toBe(630);
  });

  it("pads three comparisons by the seven that were skipped", () => {
    expect(refusalPaddingMs(210, 3, 10)).toBe(490);
  });

  it("does not wait once the target was compared", () => {
    expect(refusalPaddingMs(700, 10, 10)).toBe(0);
    expect(refusalPaddingMs(770, 11, 10)).toBe(0);
  });

  it("does not wait without a measured comparison", () => {
    expect(refusalPaddingMs(0, 0, 10)).toBe(0);
    expect(refusalPaddingMs(0, 1, 10)).toBe(0);
    expect(refusalPaddingMs(-5, 1, 10)).toBe(0);
  });
});
