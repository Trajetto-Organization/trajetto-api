import { describe, expect, it } from "vitest";

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * ROUTE_NOT_FOUND is the router's "no such endpoint" (http.ts). The app's
 * offline queue reads it as "this build no longer speaks the API" and sends
 * the item again by itself after every app update (trajetto-mobile
 * outbox-rules CONTRACT_CODES). A domain refusal answered with it — a route
 * id in a checklist that no longer exists, say — would never fail on the
 * merits: it would come back after each upgrade and be refused again.
 *
 * error-classes-b guards the error classes; this guards every literal in the
 * source, AppError built inline included.
 */
const SRC = path.resolve(__dirname, "../../../src");

/** The answers that really mean "this endpoint does not exist here". */
const ALLOWED = new Set(
  [
    "http.ts",
    // Local storage's PUT endpoint, absent when local uploads are off.
    "modules/upload/usecases/create-presigned-upload/local-upload-controller.ts",
  ].map((file) => path.join(SRC, file)),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const full = path.join(directory, entry);

    if (statSync(full).isDirectory()) return sourceFiles(full);

    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("the unknown-endpoint code is reserved", () => {
  it("is answered only by the router's not-found handler", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.has(file))
      .filter((file) =>
        /["'`]ROUTE_NOT_FOUND["'`]/.test(readFileSync(file, "utf8")),
      )
      .map((file) => path.relative(SRC, file).replace(/\\/g, "/"));

    expect(offenders).toEqual([]);
  });
});
