import { describe, expect, it } from "vitest";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  TRAJETTO_WATERMARK_FRAME,
  TRAJETTO_WATERMARK_PNG,
  TRAJETTO_WATERMARK_SHA256,
  TRAJETTO_WATERMARK_SYMBOL,
} from "@/shared/services/proof-assets.generated";
import { isDecodablePng } from "@/shared/services/png-integrity";

/**
 * The watermark embedded in the receipt worker (decision 14.8, design §2) is
 * the versioned PNG, byte for byte: neither may change without the other
 * (regenerate with `npx tsx scripts/generate-proof-assets.ts`).
 */
const ROOT = resolve(__dirname, "../../..");

describe("the embedded Trajetto watermark", () => {
  it("is exactly assets/proof/trajetto-logo.png", () => {
    const versioned = readFileSync(
      resolve(ROOT, "assets/proof/trajetto-logo.png"),
    );

    expect(
      createHash("sha256").update(TRAJETTO_WATERMARK_PNG).digest("hex"),
    ).toBe(createHash("sha256").update(versioned).digest("hex"));
    expect(TRAJETTO_WATERMARK_SHA256).toBe(
      createHash("sha256").update(versioned).digest("hex"),
    );
  });

  it("is a decodable PNG whose symbol box sits inside its frame", () => {
    expect(isDecodablePng(TRAJETTO_WATERMARK_PNG)).toBe(true);
    expect(TRAJETTO_WATERMARK_PNG.length).toBeLessThanOrEqual(40 * 1024);

    expect(TRAJETTO_WATERMARK_SYMBOL.x0).toBeGreaterThanOrEqual(0);
    expect(TRAJETTO_WATERMARK_SYMBOL.y0).toBeGreaterThanOrEqual(0);
    expect(TRAJETTO_WATERMARK_SYMBOL.x1).toBeLessThanOrEqual(
      TRAJETTO_WATERMARK_FRAME.width,
    );
    expect(TRAJETTO_WATERMARK_SYMBOL.y1).toBeLessThanOrEqual(
      TRAJETTO_WATERMARK_FRAME.height,
    );
  });
});
