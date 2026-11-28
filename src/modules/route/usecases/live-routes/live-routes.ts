import { AppError } from "@/shared/errors/AppError";

import type { LiveRouteKey } from "../../repositories/IOperation-day-repository";

/**
 * The hard cap of one page of GET /route/live (wave 4).
 *
 * A company has a few dozen routes on the street; five hundred is far past
 * any carrier the product serves today, and still a small read: one probe of
 * route_stop per row and a few primary keys. Past it the answer says so
 * (`meta.truncated`) and hands a cursor, instead of quietly showing the
 * first five hundred as if they were all.
 */
const LIVE_ROUTES_CAP = 500;

/**
 * The largest route code a cursor may carry: `route.code` is a Postgres
 * `integer`, and the repository binds the key as `::int`. A forged cursor
 * past it was a 500 ("integer out of range") instead of a 400.
 */
const MAX_ROUTE_CODE = 2_147_483_647;

const INVALID_CURSOR = () =>
  new AppError(
    "Cursor inválido. Recarregue a lista e tente de novo.",
    400,
    "INVALID_CURSOR",
  );

/** An opaque cursor: the key, as base64url JSON (as the route picker's). */
function encodeLiveRoutesCursor(key: LiveRouteKey): string {
  return Buffer.from(JSON.stringify({ r: key.rank, c: key.code })).toString(
    "base64url",
  );
}

/**
 * The key a cursor carries, or 400 INVALID_CURSOR. Read inside the caller's
 * company: a forged cursor moves the start of a company's own list, never
 * into another company's.
 */
function decodeLiveRoutesCursor(cursor: string): LiveRouteKey {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw INVALID_CURSOR();
  }

  const { r, c } = (parsed ?? {}) as Record<string, unknown>;

  if (
    (r !== 0 && r !== 1) ||
    typeof c !== "number" ||
    !Number.isSafeInteger(c) ||
    c < 0 ||
    c > MAX_ROUTE_CODE
  ) {
    throw INVALID_CURSOR();
  }

  return { rank: r, code: c };
}

/** Where a row sits in the list's order. */
function liveRouteKeyOf(route: {
  status: "IN_PROGRESS" | "RELEASED";
  code: number;
}): LiveRouteKey {
  return { rank: route.status === "IN_PROGRESS" ? 0 : 1, code: route.code };
}

export {
  LIVE_ROUTES_CAP,
  decodeLiveRoutesCursor,
  encodeLiveRoutesCursor,
  liveRouteKeyOf,
};
