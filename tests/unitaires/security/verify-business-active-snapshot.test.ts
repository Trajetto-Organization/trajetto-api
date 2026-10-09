import { beforeEach, describe, expect, it, vi } from "vitest";

const repositories = vi.hoisted(() => ({
  findBusinessById: vi.fn(),
  findUserById: vi.fn(),
}));

vi.mock("@/modules/business/repositories/business-repository", () => ({
  BusinessRepository: class {
    findBusinessById = repositories.findBusinessById;
  },
}));

vi.mock("@/modules/user/repositories/user-repository", () => ({
  UserRepository: class {
    findUserById = repositories.findUserById;
  },
}));

import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";
import { AppError } from "@/shared/errors/AppError";

/**
 * The company gate, answered from the session's own lookup (GAP3-9).
 *
 * For anyone but MASTER the tenant guard already forces the company named in
 * the request to be the user's own — and ensureAuthenticated loaded that very
 * company, and refused an inactive one, a few milliseconds earlier in this
 * same request. The gate read it again anyway, every column of it, on every
 * route that carries a :businessId. It now reads the request's snapshot (a
 * memo hit on findUserById), and only MASTER — who may act on any company —
 * goes to the database.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER = "018f0000-0000-7000-8000-00000000000c";
const USER = "018f0000-0000-7000-8000-0000000000aa";

function requestFor(
  user: { role: string; businessId: string | null },
  businessId: string,
) {
  return {
    user: { id: USER, ...user },
    params: { businessId },
  } as unknown as Parameters<typeof verifyBusinessActive>[0] & {
    business?: { id: string; is_active: boolean };
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;

    return null;
  } catch (error) {
    return error instanceof AppError ? (error.code ?? null) : "not-an-app-error";
  }
}

beforeEach(() => {
  repositories.findBusinessById.mockReset();
  repositories.findUserById.mockReset();

  repositories.findBusinessById.mockResolvedValue({
    id: BUSINESS,
    is_active: true,
  });
});

describe("the company gate", () => {
  it("answers a user's own company from the session, without reading it again", async () => {
    repositories.findUserById.mockResolvedValue({
      id: USER,
      businessId: BUSINESS,
      business: { is_active: true, entitlements: [] },
    });

    const request = requestFor(
      { role: "BUSINESS_ADMIN", businessId: BUSINESS },
      BUSINESS,
    );

    await verifyBusinessActive(request, {} as never);

    // Before: SELECT * FROM business on every request with a :businessId.
    expect(repositories.findBusinessById).not.toHaveBeenCalled();
    expect(request.business).toEqual({ id: BUSINESS, is_active: true });
  });

  it("still refuses an inactive company, from the same snapshot", async () => {
    repositories.findUserById.mockResolvedValue({
      id: USER,
      businessId: BUSINESS,
      business: { is_active: false, entitlements: [] },
    });

    expect(
      await codeOf(
        verifyBusinessActive(
          requestFor({ role: "BUSINESS_USER", businessId: BUSINESS }, BUSINESS),
          {} as never,
        ),
      ),
    ).toBe("TENANT_INACTIVE");

    expect(repositories.findBusinessById).not.toHaveBeenCalled();
  });

  it("reads the company for MASTER, who may name any of them", async () => {
    const request = requestFor({ role: "MASTER", businessId: null }, BUSINESS);

    await verifyBusinessActive(request, {} as never);

    expect(repositories.findBusinessById).toHaveBeenCalledTimes(1);
    expect(repositories.findUserById).not.toHaveBeenCalled();
  });

  it("still refuses another company before reading anything", async () => {
    expect(
      await codeOf(
        verifyBusinessActive(
          requestFor({ role: "BUSINESS_ADMIN", businessId: BUSINESS }, OTHER),
          {} as never,
        ),
      ),
    ).toBe("TENANT_ACCESS_DENIED");

    expect(repositories.findBusinessById).not.toHaveBeenCalled();
    expect(repositories.findUserById).not.toHaveBeenCalled();
  });

  it("falls back to the database when the session carries no company", async () => {
    repositories.findUserById.mockResolvedValue({
      id: USER,
      businessId: BUSINESS,
      business: null,
    });

    await verifyBusinessActive(
      requestFor({ role: "BUSINESS_ADMIN", businessId: BUSINESS }, BUSINESS),
      {} as never,
    );

    expect(repositories.findBusinessById).toHaveBeenCalledTimes(1);
  });
});
