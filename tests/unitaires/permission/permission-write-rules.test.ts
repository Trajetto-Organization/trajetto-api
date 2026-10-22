import { describe, expect, it } from "vitest";

import {
  PermissionOwnProfileError,
  assertNotOwnProfile,
} from "@/modules/permission/usecases/errors/permission-own-profile-error";
import { bulkConfigurePermissionsSchema } from "@/schemas/bulk-configure-permissions-schema";

/**
 * The two rules the permission writes add on top of the route guards: a
 * BUSINESS_USER never touches their own profile, and a bulk set names each
 * resource once. The HTTP behaviour is proven in
 * tests/E2E/admin-users-lists-http.test.ts; these pin the rules themselves.
 */
const OWN = "0190c7a0-0000-7000-8000-000000000001";
const OTHER = "0190c7a0-0000-7000-8000-000000000002";

describe("assertNotOwnProfile", () => {
  it("refuses a BUSINESS_USER targeting their own profile, as a permission refusal", () => {
    let caught: unknown;

    try {
      assertNotOwnProfile({ role: "BUSINESS_USER", profileAccessId: OWN }, OWN);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(PermissionOwnProfileError);
    expect(caught).toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
  });

  it("lets them manage any other profile", () => {
    expect(() =>
      assertNotOwnProfile(
        { role: "BUSINESS_USER", profileAccessId: OWN },
        OTHER,
      ),
    ).not.toThrow();
  });

  it("never refuses someone without a profile of their own", () => {
    // Administrators and the MASTER have no profile; a missing one on either
    // side is not a match.
    expect(() =>
      assertNotOwnProfile(
        { role: "BUSINESS_ADMIN", profileAccessId: null },
        OWN,
      ),
    ).not.toThrow();
    expect(() => assertNotOwnProfile({ role: "MASTER" }, OWN)).not.toThrow();
    expect(() =>
      assertNotOwnProfile(
        { role: "BUSINESS_USER", profileAccessId: null },
        null,
      ),
    ).not.toThrow();
  });
});

describe("bulkConfigurePermissionsSchema", () => {
  const base = { businessId: OTHER, profileAccessId: OWN };

  it("refuses a resource named twice, pointing at the repeated row", () => {
    const parsed = bulkConfigurePermissionsSchema.safeParse({
      ...base,
      permissions: [
        { permissionKey: "kanban_manage", canRead: true, canWrite: false },
        { permissionKey: "supplier_manage", canRead: true, canWrite: false },
        { permissionKey: "kanban_manage", canRead: true, canWrite: true },
      ],
    });

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([
      expect.objectContaining({
        path: ["permissions", 2, "permissionKey"],
        message: "Cada recurso pode aparecer uma única vez na configuração.",
      }),
    ]);
  });

  it("accepts each resource once, and an empty set", () => {
    expect(
      bulkConfigurePermissionsSchema.safeParse({
        ...base,
        permissions: [
          { permissionKey: "kanban_manage", canRead: true, canWrite: false },
          { permissionKey: "supplier_manage", canRead: true, canWrite: true },
        ],
      }).success,
    ).toBe(true);

    expect(
      bulkConfigurePermissionsSchema.safeParse({ ...base, permissions: [] })
        .success,
    ).toBe(true);
  });
});
