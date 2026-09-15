import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { globSync } from "glob";

import { ALL_TOPICS } from "@/shared/integration/webhook-catalogue";

/**
 * Every topic the catalogue publishes is a topic something actually fires.
 *
 * A catalogue that promises an event nobody sends is worse than a smaller
 * catalogue: a customer subscribes, waits, and eventually calls support to ask
 * why their ERP never hears about cancellations. Nobody finds that bug from
 * the inside, because from the inside the topic is right there in the list.
 *
 * So this walks the source and asserts that each published name appears at a
 * call site. It is a coarse check by design — it proves the wiring exists, not
 * that it fires under the right conditions, which is what the use case tests
 * are for.
 */
/**
 * Read lazily and narrowly.
 *
 * Only the two trees that can hold a call site, and only when a test asks for
 * them: globbing the whole of `src` at module scope pulled six hundred files
 * into every worker this file landed in, and the runner died with a segfault
 * rather than a failure — which is the worst way for a test to be wrong,
 * because it takes the rest of the suite down with it.
 */
let cached: string | null = null;

function source(): string {
  if (cached !== null) return cached;

  cached = globSync(["src/modules/**/*.ts", "src/shared/**/*.ts"], {
    absolute: true,
  })
    .filter((file) => !file.includes("webhook-catalogue"))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");

  return cached;
}

/**
 * The topics a computed expression fires, which a plain string search cannot
 * see. Listed here rather than loosening the assertion: naming them is what
 * makes somebody delete a line from this list when they delete the branch.
 */
const FIRED_BY_EXPRESSION: Record<string, string> = {
  "delivery.failed":
    'update-delivery-status: `integrationTopic` picks it for status === "FAILED"',
  "delivery.cancelled":
    'update-delivery-status: `integrationTopic` picks it for status === "CANCELLED"',
  "delivery.in_transit":
    'update-delivery-status: `integrationTopic` picks it for status === "IN_TRANSIT"',
  "proof.approved":
    "review-proof-audit: the ternary on the reviewer's verdict",
  "proof.rejected":
    "review-proof-audit: the ternary on the reviewer's verdict",
};

describe("the catalogue is honest", () => {
  it("fires every topic it publishes", () => {
    const missing = ALL_TOPICS.filter((topic) => {
      if (source().includes(`"${topic}"`)) return false;

      // Fired by a computed expression, and named above so the pair stays in
      // step.
      return !FIRED_BY_EXPRESSION[topic];
    });

    expect(missing, `Tópicos publicados que nada dispara: ${missing.join(", ")}`)
      .toEqual([]);
  });

  it("does not carry a note about a topic that was removed", () => {
    // The other half of the pair: a branch deleted without its note here
    // would leave this file claiming coverage that is gone.
    for (const topic of Object.keys(FIRED_BY_EXPRESSION)) {
      expect(ALL_TOPICS as string[], topic).toContain(topic);
    }
  });

  it("reaches both families", () => {
    // A catalogue where every wired topic happened to be one family would be
    // a catalogue half of which is decoration.
    const wired = ALL_TOPICS.filter(
      (topic) => source().includes(`"${topic}"`) || FIRED_BY_EXPRESSION[topic],
    );

    expect(wired.some((topic) => topic.startsWith("route."))).toBe(true);
    expect(wired.some((topic) => topic.startsWith("delivery."))).toBe(true);

    expect(wired.some((topic) => topic.startsWith("proof."))).toBe(true);
    expect(wired.some((topic) => topic.startsWith("occurrence."))).toBe(true);
  });
});
