import { describe, expect, it } from "vitest";

import { verifyPermission } from "@/modules/middlewares/verify-permission";
import { AppError } from "@/shared/errors/AppError";

import type { PermissionKey } from "@/config/permissions";

/**
 * The permission gate, role by role, key by key (decision 4.1).
 *
 * Every refusal here used to carry AppError's default code, BAD_REQUEST, so a
 * client could not tell "your profile lacks this" from "your company never
 * hired this" — and the web showed "Módulo não contratado" to a read-only
 * user of a company that had hired it. The missing-profile branch answered
 * 401, which both clients read as an expired session and log the user out.
 *
 * Driven through the real hook, the same function every route registers.
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

function run(
  principal: Principal,
  key: PermissionKey,
  access: "read" | "write",
  options?: { allowDriver?: boolean },
): AppError | undefined {
  let outcome: Error | undefined;

  verifyPermission(key, access, options)(
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

const MASTER: Principal = { role: "MASTER" };
const ADMIN: Principal = { role: "BUSINESS_ADMIN" };

const FULL_USER: Principal = {
  role: "BUSINESS_USER",
  profileAccess: {
    permissions: [
      { permissionKey: "delivery_manage", canRead: true, canWrite: true },
      { permissionKey: "occurrence_manage", canRead: true, canWrite: true },
    ],
  },
};

const READ_ONLY_USER: Principal = {
  role: "BUSINESS_USER",
  profileAccess: {
    permissions: [
      { permissionKey: "delivery_manage", canRead: true, canWrite: false },
    ],
  },
};

const DRIVER: Principal = { role: "BUSINESS_USER", driverId: "driver-1" };

describe("who passes", () => {
  it.each([
    ["MASTER", MASTER, "delivery_manage", "write"],
    ["BUSINESS_ADMIN", ADMIN, "integration_manage", "write"],
    ["full user reading", FULL_USER, "delivery_manage", "read"],
    ["full user writing", FULL_USER, "occurrence_manage", "write"],
    ["read-only user reading", READ_ONLY_USER, "delivery_manage", "read"],
    ["driver reading the day", DRIVER, "delivery_manage", "read"],
    ["driver reporting an occurrence", DRIVER, "occurrence_manage", "write"],
    ["driver fuelling", DRIVER, "fuel_manage", "write"],
  ] as const)("%s", (_label, principal, key, access) => {
    expect(run(principal, key, access)).toBeUndefined();
  });
});

describe("who is refused, and with which code", () => {
  it.each([
    ["read-only user writing", READ_ONLY_USER, "delivery_manage", "write"],
    ["read-only user on another key", READ_ONLY_USER, "occurrence_manage", "read"],
    ["full user on a key it lacks", FULL_USER, "fine_manage", "read"],
    ["driver reading the occurrence catalogue", DRIVER, "occurrence_manage", "read"],
    ["driver on payables", DRIVER, "account_payable_manage", "read"],
    ["driver writing service orders", DRIVER, "service_order_manage", "write"],
  ] as const)("%s → 403 PERMISSION_DENIED", (_label, principal, key, access) => {
    const refusal = run(principal, key, access);

    expect(refusal?.statusCode).toBe(403);
    expect(refusal?.code).toBe("PERMISSION_DENIED");
  });

  it("refuses a key that is present but not readable (canRead false)", () => {
    // The bulk permission screen could store canRead:false; the gate must
    // read the flag, not the presence of the row.
    const refusal = run(
      {
        role: "BUSINESS_USER",
        profileAccess: {
          permissions: [
            { permissionKey: "delivery_manage", canRead: false, canWrite: false },
          ],
        },
      },
      "delivery_manage",
      "read",
    );

    expect(refusal?.code).toBe("PERMISSION_DENIED");
  });

  it("refuses the write of a row that can write but not read (ROUTE-KEY-1)", () => {
    // The web treats an unreadable row as no access and hides the section;
    // the API used to accept writes on it all the same, so the two sides
    // disagreed about what canRead:false means.
    const refusal = run(
      {
        role: "BUSINESS_USER",
        profileAccess: {
          permissions: [
            { permissionKey: "delivery_manage", canRead: false, canWrite: true },
          ],
        },
      },
      "delivery_manage",
      "write",
    );

    expect(refusal?.statusCode).toBe(403);
    expect(refusal?.code).toBe("PERMISSION_DENIED");
    expect(refusal?.message).toMatch(/não permite visualizar/);
  });

  it("answers a user with no profile with a 403, never a 401", () => {
    // A 401 makes both clients throw the session away; this is a
    // configuration problem of the account, named like the session check
    // names it.
    const refusal = run({ role: "BUSINESS_USER", profileAccess: null }, "delivery_manage", "read");

    expect(refusal?.statusCode).toBe(403);
    expect(refusal?.code).toBe("AUTH_PROFILE_NOT_CONFIGURED");
  });

  it("tells the read-only user it is a read-only profile", () => {
    // The message is what the toast shows; "sem permissão" alone reads as a
    // bug to somebody who can see the screen.
    expect(run(READ_ONLY_USER, "delivery_manage", "write")?.message).toMatch(
      /apenas a leitura/,
    );
  });
});

describe("the route-level driver opt-out", () => {
  it("refuses a driver on a key the driver map grants, when the route says so", () => {
    // Company-wide reads that the driver's screens never call (decision 4.4)
    // can refuse driver tokens without touching the shared map.
    expect(run(DRIVER, "vehicle_manage", "read")).toBeUndefined();

    const refusal = run(DRIVER, "vehicle_manage", "read", { allowDriver: false });

    expect(refusal?.code).toBe("PERMISSION_DENIED");
  });

  it("does not touch anybody else", () => {
    expect(
      run(FULL_USER, "delivery_manage", "read", { allowDriver: false }),
    ).toBeUndefined();
    expect(run(ADMIN, "vehicle_manage", "read", { allowDriver: false })).toBeUndefined();
  });
});
