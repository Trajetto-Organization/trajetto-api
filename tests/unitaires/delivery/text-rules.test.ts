import { describe, expect, it } from "vitest";

import { reportDeliveryOccurrenceSchema } from "@/schemas/report-delivery-occurrence-schema";
import {
  hasInlineConsecutiveSpaces,
  hasSpaceAtLineEdges,
} from "@/shared/delivery/text-rules";

/**
 * Multiline text (decision 5.5): line breaks may repeat, spaces may not.
 *
 * The single-line rule (/\s{2,}/) counted a line break as a space, so an
 * occurrence described in two paragraphs was refused — and from the driver's
 * offline queue a 400 is a permanent failure (DLV-TXT-1).
 */
const TYPE = "018f0000-0000-7000-8000-0000000000c1";

describe("an occurrence description", () => {
  it.each([
    "Cliente ausente.\n\nVizinho informou que volta às 18h.",
    "Portão fechado.\r\n\r\nSem campainha.",
  ])("accepts paragraphs: %j", (description) => {
    expect(
      reportDeliveryOccurrenceSchema.safeParse({
        occurrenceTypeId: TYPE,
        description,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["Cliente  ausente.", "espaços consecutivos"],
    ["Cliente ausente. \nVizinho informou.", "começar ou terminar"],
    [" Cliente ausente.", "começar ou terminar"],
    ["Cliente ausente.\n", "começar ou terminar"],
  ])("still refuses %j", (description, message) => {
    const parsed = reportDeliveryOccurrenceSchema.safeParse({
      occurrenceTypeId: TYPE,
      description,
    });

    expect(parsed.success).toBe(false);

    if (!parsed.success)
      expect(parsed.error.issues[0].message).toContain(message);
  });
});

describe("the rules themselves, as the web and the app mirror them", () => {
  it("does not count a line break as a space", () => {
    expect(hasInlineConsecutiveSpaces("a\n\nb")).toBe(false);
    expect(hasInlineConsecutiveSpaces("a\t b")).toBe(true);
    expect(hasSpaceAtLineEdges("a\r\nb")).toBe(false);
    expect(hasSpaceAtLineEdges("a \nb")).toBe(true);
  });
});
