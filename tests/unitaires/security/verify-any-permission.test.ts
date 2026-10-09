import { describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { z } from "zod";

import {
  anyPermissionDoc,
  decideAnyPermission,
  verifyAnyPermission,
  type PermissionAlternative,
} from "@/modules/middlewares/verify-permission";
import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { openapiTransform } from "@/routes/documentation/openapi-transform";
import { AppError } from "@/shared/errors/AppError";

/**
 * Either of two grants (decision 4.7), in one place.
 *
 * The driver picker, the vehicle picker and the service-order reads each
 * let a dispatcher (`delivery_manage:write`) in beside the catalogue's own
 * key, and each wrote the OR by hand on top of decidePermission. The OpenAPI
 * transform reads a list of permissions as "all of", so those routes could
 * only document their first key and explain the second in prose.
 */
type Principal = {
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  driverId?: string | null;
  profileAccess?: {
    permissions: Array<{
      permissionKey: string;
      canRead: boolean;
      canWrite: boolean;
    }>;
  } | null;
};

const PICKER: PermissionAlternative[] = [
  { key: "driver_manage", access: "read", options: { allowDriver: false } },
  { key: "delivery_manage", access: "write", options: { allowDriver: false } },
];

const profile = (
  ...rows: Array<[string, boolean, boolean]>
): Principal => ({
  role: "BUSINESS_USER",
  profileAccess: {
    permissions: rows.map(([permissionKey, canRead, canWrite]) => ({
      permissionKey,
      canRead,
      canWrite,
    })),
  },
});

function run(principal: Principal): AppError | undefined {
  let outcome: Error | undefined;

  verifyAnyPermission(PICKER)(
    { user: { id: "user-1", ...principal } } as never,
    {} as never,
    (error?: Error) => {
      outcome = error;
    },
  );

  if (outcome && !(outcome instanceof AppError)) {
    throw new Error(`not an AppError: ${outcome.message}`);
  }

  return outcome as AppError | undefined;
}

describe("either of the grants", () => {
  it.each([
    ["MASTER", { role: "MASTER" } as Principal],
    ["BUSINESS_ADMIN", { role: "BUSINESS_ADMIN" } as Principal],
    ["the catalogue reader", profile(["driver_manage", true, false])],
    ["the dispatcher", profile(["delivery_manage", true, true])],
  ])("lets %s in", (_label, principal) => {
    expect(run(principal)).toBeUndefined();
  });

  it("names which grant let the caller in", () => {
    const verdict = decideAnyPermission(
      profile(["delivery_manage", true, true]) as never,
      PICKER,
    );

    expect(verdict).toEqual({ granted: PICKER[1] });
  });

  it("refuses with the first grant's refusal when none applies", () => {
    // Read-only dispatch is not dispatch; no catalogue key either.
    const refusal = run(profile(["delivery_manage", true, false]));

    expect(refusal?.statusCode).toBe(403);
    expect(refusal?.code).toBe("PERMISSION_DENIED");
    expect(refusal?.message).toContain("não inclui esta seção");
  });

  it("refuses a driver token on every grant that opts drivers out", () => {
    // The driver map grants delivery_manage:write for the app's own
    // deliveries; that is no reason to read the colleagues' list.
    const refusal = run({ role: "BUSINESS_USER", driverId: "driver-1" });

    expect(refusal?.code).toBe("PERMISSION_DENIED");
  });

  it("refuses to be wired with no grant at all", () => {
    expect(() => verifyAnyPermission([])).toThrow(/at least one/);
    expect("refusal" in decideAnyPermission({ role: "BUSINESS_USER" }, [])).toBe(
      true,
    );
  });
});

describe("the published contract of a route with alternatives", () => {
  function document(preHandler: unknown[]) {
    const schema = {
      response: { 200: z.object({ ok: z.boolean() }) },
    };

    const route = {
      method: "GET",
      url: "/picker",
      onRequest: [ensureAuthenticated],
      preHandler,
      schema,
    } as unknown as RouteOptions;

    return openapiTransform({ schema, url: "/picker", route }).schema as Record<
      string,
      unknown
    > & {
      description?: string;
      response: Record<string, unknown>;
    };
  }

  it("says 'uma entre' and lists the grants apart from x-permissions", () => {
    const schema = document([verifyAnyPermission(PICKER)]);

    expect(schema["x-permissions-any"]).toEqual([
      [
        { key: "driver_manage", access: "read" },
        { key: "delivery_manage", access: "write" },
      ],
    ]);
    expect(schema["x-permissions"]).toBeUndefined();
    expect(schema.description).toContain(
      "uma entre `driver_manage` (leitura) ou `delivery_manage` (escrita)",
    );
    expect(JSON.stringify(schema.response["403"])).toContain("PERMISSION_DENIED");
  });

  it("is what a hand-written guard attaches too", () => {
    const pickerHook = Object.assign(() => undefined, anyPermissionDoc(PICKER));

    expect(document([pickerHook])["x-permissions-any"]).toEqual(
      document([verifyAnyPermission(PICKER)])["x-permissions-any"],
    );
  });
});
