import { describe, expect, it } from "vitest";

import {
  formatEventCursorV2,
  parseEventCursor,
} from "@/modules/integration/cursor";
import { AppError } from "@/shared/errors/AppError";

/**
 * The cursor of /integration/v1/events (plano-escala F2-04).
 *
 * The commit-order feed of wave 10 emits `v2.<epoch>.<txid>.<id>.<floorMs>`;
 * a release can only emit what the release before it already reads, so this
 * one reads v2 (still by the id) and keeps emitting the legacy id. The
 * format is fixed from here on, the cluster epoch included, so there is
 * never a v3. Anything that is neither is 400 INVALID_CURSOR, never the
 * empty last page an integrator reads as "up to date".
 */
const ID = "018f5000-0000-7000-8000-00000000000a";

function refusal(raw: string): AppError | null {
  try {
    parseEventCursor(raw);

    return null;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

describe("the events cursor", () => {
  it("reads the legacy id as txid 0, with no epoch and no floor", () => {
    expect(parseEventCursor(ID)).toEqual({
      format: "legacy",
      epoch: null,
      txid: 0n,
      id: ID,
      floorMs: null,
    });
  });

  it("keeps a legacy id as it came, either case, as the walk by id always did", () => {
    expect(parseEventCursor(ID.toUpperCase()).id).toBe(ID.toUpperCase());
  });

  it("reads v2, and reads back what it writes", () => {
    const position = {
      epoch: 3,
      txid: 9_876_543_210n,
      id: ID,
      floorMs: 1_794_900_000_000,
    };
    const text = formatEventCursorV2(position);

    expect(text).toBe(`v2.3.9876543210.${ID}.1794900000000`);
    expect(parseEventCursor(text)).toEqual({ format: "v2", ...position });
  });

  it("reads the extremes of each field", () => {
    expect(
      parseEventCursor(
        `v2.2147483647.9223372036854775807.${ID}.8640000000000000`,
      ),
    ).toEqual({
      format: "v2",
      epoch: 2_147_483_647,
      txid: 9_223_372_036_854_775_807n,
      id: ID,
      floorMs: 8_640_000_000_000_000,
    });
    expect(parseEventCursor(`v2.0.0.${ID}.0`)).toMatchObject({
      epoch: 0,
      txid: 0n,
      floorMs: 0,
    });
  });

  it.each([
    ["empty", ""],
    ["free text", "abc"],
    ["an id cut short", ID.slice(0, 35)],
    ["the prefix alone", "v2."],
    ["a field missing", `v2.1.2.${ID}`],
    ["a field too many", `v2.1.2.${ID}.0.0`],
    ["another version", `v3.1.2.${ID}.0`],
    ["a leading zero", `v2.01.2.${ID}.0`],
    ["a sign", `v2.1.-2.${ID}.0`],
    ["an exponent", `v2.1.2.${ID}.1e3`],
    ["a decimal point inside a field", `v2.1.2.5.${ID}.0`],
    ["spaces", ` v2.1.2.${ID}.0`],
    ["an epoch past int", `v2.2147483648.2.${ID}.0`],
    ["a txid past bigint", `v2.1.9223372036854775808.${ID}.0`],
    ["a floor past any date", `v2.1.2.${ID}.8640000000000001`],
    ["an id in upper case inside v2", `v2.1.2.${ID.toUpperCase()}.0`],
    ["an id that is not a uuid", `v2.1.2.${"x".repeat(36)}.0`],
    ["a cursor far too long", `v2.1.2.${ID}.${"9".repeat(500)}`],
  ])("refuses %s with 400 INVALID_CURSOR", (_label, raw) => {
    const error = refusal(raw);

    expect(error).not.toBeNull();
    expect(error!.statusCode).toBe(400);
    expect(error!.code).toBe("INVALID_CURSOR");
    expect(error!.message).toMatch(/next_cursor/);
  });
});
