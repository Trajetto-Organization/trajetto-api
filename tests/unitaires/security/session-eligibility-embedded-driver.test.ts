import { describe, expect, it, vi } from "vitest";

import { assertSessionEligible } from "@/modules/user/services/session-eligibility";
import { AppError } from "@/shared/errors/AppError";

/**
 * A driver's session check, answered from the user the session already loaded.
 *
 * Every authenticated request of a driver loaded the user WITH its driver
 * (id, status), and then asked the driver repository for the same driver
 * again — with its branch and its user — to read three fields. On the
 * position flush that was three statements of sixteen, for every driver on
 * the road every two minutes.
 *
 * The session lookup now carries businessId, branchId and the branch switch,
 * so the check reads them there. The verdicts and their codes must be exactly
 * the ones the repository path gives, and every caller that loads the user
 * some other way (login, refresh, 2FA, the socket sweep) must still go to the
 * repository.
 */
const BUSINESS = "business-1";

function driverUser(driver: Record<string, unknown> | undefined) {
  return {
    id: "user-1",
    role: "BUSINESS_USER",
    email: "motorista@exemplo.com.br",
    access_revoked: false,
    password: "x",
    name: "Motorista",
    businessId: BUSINESS,
    driverId: "driver-1",
    business: { is_active: true, entitlements: [] },
    driver,
  } as never;
}

function repository() {
  return { findDriverById: vi.fn() };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;

    return null;
  } catch (error) {
    return error instanceof AppError
      ? (error.code ?? null)
      : "not-an-app-error";
  }
}

describe("a driver's session check", () => {
  it("is answered from the embedded driver without asking the repository", async () => {
    const drivers = repository();

    const result = await assertSessionEligible(
      driverUser({
        id: "driver-1",
        status: "ACTIVE",
        businessId: BUSINESS,
        branchId: "branch-1",
        branch: { is_active: true },
      }),
      drivers,
    );

    expect(result.driver).toEqual({ id: "driver-1", branchId: "branch-1" });
    expect(drivers.findDriverById).not.toHaveBeenCalled();
  });

  it("accepts a driver with no branch", async () => {
    const drivers = repository();

    const result = await assertSessionEligible(
      driverUser({
        id: "driver-1",
        status: "ACTIVE",
        businessId: BUSINESS,
        branchId: null,
        branch: null,
      }),
      drivers,
    );

    expect(result.driver).toEqual({ id: "driver-1", branchId: null });
    expect(drivers.findDriverById).not.toHaveBeenCalled();
  });

  it("refuses an inactive driver with the same code", async () => {
    const drivers = repository();

    expect(
      await codeOf(
        assertSessionEligible(
          driverUser({
            id: "driver-1",
            status: "INACTIVE",
            businessId: BUSINESS,
            branchId: "branch-1",
            branch: { is_active: true },
          }),
          drivers,
        ),
      ),
    ).toBe("AUTH_DRIVER_INACTIVE");

    expect(drivers.findDriverById).not.toHaveBeenCalled();
  });

  it("refuses a driver of another company with the same code", async () => {
    expect(
      await codeOf(
        assertSessionEligible(
          driverUser({
            id: "driver-1",
            status: "ACTIVE",
            businessId: "business-2",
            branchId: "branch-1",
            branch: { is_active: true },
          }),
          repository(),
        ),
      ),
    ).toBe("AUTH_DRIVER_TENANT_MISMATCH");
  });

  it("refuses a driver whose branch was switched off with the same code", async () => {
    expect(
      await codeOf(
        assertSessionEligible(
          driverUser({
            id: "driver-1",
            status: "ACTIVE",
            businessId: BUSINESS,
            branchId: "branch-1",
            branch: { is_active: false },
          }),
          repository(),
        ),
      ),
    ).toBe("AUTH_BRANCH_INACTIVE");
  });

  it("asks the repository when the user was loaded without those fields", async () => {
    // What login, refresh and 2FA pass: at most id and status.
    const drivers = repository();

    drivers.findDriverById.mockResolvedValue({
      id: "driver-1",
      status: "ACTIVE",
      businessId: BUSINESS,
      branchId: "branch-1",
      branch: { is_active: false },
    });

    expect(
      await codeOf(
        assertSessionEligible(
          driverUser({ id: "driver-1", status: "ACTIVE" }),
          drivers,
        ),
      ),
    ).toBe("AUTH_BRANCH_INACTIVE");

    expect(drivers.findDriverById).toHaveBeenCalledWith("driver-1");
  });

  it("asks the repository when the embedded driver is not the linked one", async () => {
    const drivers = repository();

    drivers.findDriverById.mockResolvedValue(null);

    expect(
      await codeOf(
        assertSessionEligible(
          driverUser({
            id: "someone-else",
            status: "ACTIVE",
            businessId: BUSINESS,
            branchId: null,
            branch: null,
          }),
          drivers,
        ),
      ),
    ).toBe("AUTH_DRIVER_INACTIVE");

    expect(drivers.findDriverById).toHaveBeenCalledWith("driver-1");
  });
});
