import "reflect-metadata";

import { describe, expect, it, vi } from "vitest";

const sendSecurityEventToBusiness = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendSecurityEventToBusiness }));

// The switch and its audit entry run in one transaction on the real client;
// here the callback runs with a stand-in client.
vi.mock("@/../infra/database", () => ({
  default: {
    $transaction: (callback: (tx: unknown) => unknown) => callback({}),
  },
}));

import { ToggleBusinessActiveUseCase } from "@/modules/business/usecases/toggle-business-active/toggle-business-active-usecase";

/**
 * Deactivating a company tells its open sessions WHY they end (decision 4.1).
 *
 * It reused `access_revoked`, so the driver's app said "seu acesso foi
 * revogado" to a whole company that had simply been switched off; the app
 * has its own words for `business_inactive`, and the web re-reads /user/me,
 * which answers AUTH_BUSINESS_INACTIVE.
 */
const BUSINESS = "018fe7d0-0000-7000-8000-00000000000a";

function useCase(active: boolean) {
  return new ToggleBusinessActiveUseCase(
    { findUserById: async () => ({ id: "master", role: "MASTER" }) } as never,
    {
      findBusinessById: async () => ({ id: BUSINESS, is_active: active }),
      toggleBusinessActive: async (_id: string, current: boolean) => ({
        id: BUSINESS,
        corporate_reason: "Transportadora",
        is_active: !current,
      }),
    } as never,
    { createActivityIfEnabled: vi.fn() } as never,
  );
}

describe("toggling a company", () => {
  it("ends its sessions with the company's own reason when it is deactivated", async () => {
    sendSecurityEventToBusiness.mockClear();

    await useCase(true).execute(BUSINESS, "master");

    expect(sendSecurityEventToBusiness.mock.calls).toEqual([
      [BUSINESS, { reason: "business_inactive" }],
    ]);
  });

  it("ends nothing when it is reactivated", async () => {
    sendSecurityEventToBusiness.mockClear();

    await useCase(false).execute(BUSINESS, "master");

    expect(sendSecurityEventToBusiness).not.toHaveBeenCalled();
  });
});

describe("who may switch a company on or off", () => {
  it("refuses a company admin inside the use case, not only at the route, and writes nothing", async () => {
    // Red before: only verifyUserRole(['MASTER']) stood in the way; its
    // siblings (create, update, delete) already re-check with assertCallerRole.
    const toggleBusinessActive = vi.fn();
    const toggle = new ToggleBusinessActiveUseCase(
      {
        findUserById: async () => ({
          id: "admin",
          role: "BUSINESS_ADMIN",
          businessId: BUSINESS,
        }),
      } as never,
      {
        findBusinessById: async () => ({ id: BUSINESS, is_active: true }),
        toggleBusinessActive,
      } as never,
      { createActivityIfEnabled: vi.fn() } as never,
    );

    await expect(toggle.execute(BUSINESS, "admin")).rejects.toMatchObject({
      statusCode: 403,
      code: "AUTH_ROLE_FORBIDDEN",
    });
    expect(toggleBusinessActive).not.toHaveBeenCalled();
  });
});
