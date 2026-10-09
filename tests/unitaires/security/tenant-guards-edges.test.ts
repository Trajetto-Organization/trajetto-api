import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tenant and role guards' verdicts, at unit level (mutation run 06/10:
 * these hooks were only reached by E2E suites, which the mutation run does
 * not execute, so their branches survived or had no coverage). Only the
 * repositories are stand-ins; the hooks and the rules are the real ones.
 */

const repositories = vi.hoisted(() => ({
  findBusinessById: vi.fn(),
  findUserById: vi.fn(),
  findBranchById: vi.fn(),
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

vi.mock("@/modules/branch/repositories/branch-repository", () => ({
  BranchRepository: class {
    findBranchById = repositories.findBranchById;
  },
}));

import {
  assertTenantAccessToRecord,
  authorizeRequestedTenant,
  enforceRequestedTenant,
  foreignRecordRefusal,
  getRequestedTenantId,
  requestedTenantValues,
} from "@/modules/middlewares/tenant-authorization";
import {
  verifyBranchActive,
  verifyBranchBelongsToBusiness,
  verifyBusinessActive,
} from "@/modules/middlewares/verify-tenant-active";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";
import { AppError } from "@/shared/errors/AppError";

const OWN = "business-own";
const OTHER = "business-other";

type Refusal = { status: number; code: string; message: string } | null;

async function refusalOf(run: () => unknown): Promise<Refusal> {
  try {
    await run();
    return null;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.statusCode, code: error.code, message: error.message };
  }
}

const TENANT_DENIED = { status: 403, code: "TENANT_ACCESS_DENIED", message: "Acesso negado aos dados desta empresa." };

const request = (
  user: { role: string; businessId?: string | null; id?: string } | undefined,
  where: { params?: unknown; query?: unknown; body?: unknown } = {},
) => ({ user: user && { id: "user-1", ...user }, ...where }) as never;

const employee = { role: "BUSINESS_USER", businessId: OWN };
const master = { role: "MASTER", businessId: null };

beforeEach(() => {
  repositories.findBusinessById.mockReset();
  repositories.findUserById.mockReset();
  repositories.findBranchById.mockReset();
});

describe("assertTenantAccessToRecord", () => {
  // The caller's own "not found": another company's id must read exactly
  // like an id that does not exist (IDOR sweep, 10/2026).
  const missing = () => new AppError("Registro não encontrado.", 404, "RECORD_NOT_FOUND");
  const NOT_FOUND = { status: 404, code: "RECORD_NOT_FOUND", message: "Registro não encontrado." };

  it("lets only a MASTER touch a record of no tenant", async () => {
    expect(
      await refusalOf(() => assertTenantAccessToRecord({ role: "BUSINESS_ADMIN", businessId: OWN }, null, missing)),
    ).toEqual(NOT_FOUND);
    expect(await refusalOf(() => assertTenantAccessToRecord({ role: "MASTER" }, null, missing))).toBeNull();
  });

  it("compares a tenant record with the principal's company", async () => {
    expect(await refusalOf(() => assertTenantAccessToRecord(employee as never, OTHER, missing))).toEqual(NOT_FOUND);
    expect(await refusalOf(() => assertTenantAccessToRecord(employee as never, OWN, missing))).toBeNull();
  });

  it("refuses a principal with no company at all", async () => {
    expect(
      await refusalOf(() => assertTenantAccessToRecord({ role: "BUSINESS_USER", businessId: null }, OWN, missing)),
    ).toEqual(NOT_FOUND);
  });
});

describe("foreignRecordRefusal", () => {
  const mismatch = () => new AppError("Não é desta empresa.", 403, "X_TENANT_MISMATCH");
  const missing = () => new AppError("Não encontrado.", 404, "X_NOT_FOUND");

  it("hides another company's row from a tenant user behind the not-found answer", () => {
    expect(foreignRecordRefusal({ role: "BUSINESS_ADMIN" } as never, mismatch, missing).code).toBe("X_NOT_FOUND");
    expect(foreignRecordRefusal({ role: "BUSINESS_USER" } as never, mismatch, missing).code).toBe("X_NOT_FOUND");
  });

  it("keeps the specific mismatch for the MASTER, who may see every company", () => {
    expect(foreignRecordRefusal({ role: "MASTER" } as never, mismatch, missing).code).toBe("X_TENANT_MISMATCH");
  });
});

describe("requestedTenantValues", () => {
  it("reads every location, flattening arrays and skipping null and non-objects", () => {
    expect(
      requestedTenantValues(
        request(employee, { params: { businessId: "a" }, query: { businessId: ["b", "c"] }, body: { businessId: null } }),
      ),
    ).toEqual(["a", "b", "c"]);
    expect(requestedTenantValues(request(employee, { params: "x", query: null, body: { businessId: undefined } }))).toEqual([]);
  });
});

describe("getRequestedTenantId", () => {
  it("is the one id named everywhere, or nothing", () => {
    expect(getRequestedTenantId(request(employee, { params: { businessId: OWN }, body: { businessId: OWN } }))).toBe(OWN);
    expect(getRequestedTenantId(request(employee, { params: { businessId: OWN }, body: { businessId: OTHER } }))).toBeUndefined();
    expect(getRequestedTenantId(request(employee, { query: { businessId: "" } }))).toBeUndefined();
    expect(getRequestedTenantId(request(employee, { query: { businessId: 5 } }))).toBeUndefined();
    expect(getRequestedTenantId(request(employee, {}))).toBeUndefined();
  });
});

describe("authorizeRequestedTenant", () => {
  it("refuses a malformed or foreign value anywhere, with the tenant message", async () => {
    for (const where of [
      { query: { businessId: "" } },
      { body: { businessId: 7 } },
      { params: { businessId: OWN }, body: { businessId: OTHER } },
    ]) {
      expect(await refusalOf(() => authorizeRequestedTenant(request(employee, where)))).toEqual(TENANT_DENIED);
    }
  });

  it("lets the MASTER name any company, and a user their own", async () => {
    expect(await refusalOf(() => authorizeRequestedTenant(request(master, { body: { businessId: "" } })))).toBeNull();
    expect(await refusalOf(() => authorizeRequestedTenant(request(employee, { params: { businessId: OWN } })))).toBeNull();
  });

  it("does nothing on a public route", async () => {
    expect(await refusalOf(() => enforceRequestedTenant(request(undefined, { body: { businessId: OTHER } })))).toBeNull();
  });
});

describe("verifyUserRole", () => {
  const run = (roles: string[], role: string | undefined) => {
    let outcome: Error | undefined | "not called" = "not called";
    verifyUserRole(roles as never)(request(role ? { role } : { role: undefined as never }), {} as never, (error) => {
      outcome = error;
    });
    return outcome;
  };

  it("lets an allowed role through and refuses the rest with 403", () => {
    expect(run(["MASTER", "BUSINESS_ADMIN"], "BUSINESS_ADMIN")).toBeUndefined();

    for (const role of ["BUSINESS_USER", undefined]) {
      const error = run(["MASTER", "BUSINESS_ADMIN"], role) as unknown as AppError;
      expect(error).toBeInstanceOf(AppError);
      expect([error.statusCode, error.code, error.message]).toEqual([403, "AUTH_ROLE_FORBIDDEN", "Usuário não autorizado!"]);
    }
  });

  it("publishes its roles for the OpenAPI document", () => {
    expect(verifyUserRole(["MASTER"] as never).openapi).toEqual({ roles: ["MASTER"] });
  });
});

describe("verifyBusinessActive", () => {
  it("reads the company from the body or the query when the path has none", async () => {
    repositories.findUserById.mockResolvedValue({ business: { is_active: true } });

    const fromBody = request(employee, { params: {}, body: { businessId: OWN } }) as { business?: unknown };
    await verifyBusinessActive(fromBody as never, {} as never);
    expect(fromBody.business).toEqual({ id: OWN, is_active: true });

    const fromQuery = request(employee, { query: { businessId: OWN } }) as { business?: unknown };
    await verifyBusinessActive(fromQuery as never, {} as never);
    expect(fromQuery.business).toEqual({ id: OWN, is_active: true });
  });

  it("does nothing without a company in the request", async () => {
    expect(await refusalOf(() => verifyBusinessActive(request(employee, { params: {} }), {} as never))).toBeNull();
    expect(repositories.findBusinessById).not.toHaveBeenCalled();
  });

  it("answers an unknown company with 404 and an inactive one with TENANT_INACTIVE", async () => {
    repositories.findBusinessById.mockResolvedValueOnce(null);
    expect(await refusalOf(() => verifyBusinessActive(request(master, { params: { businessId: OTHER } }), {} as never))).toEqual({
      status: 404,
      code: "TENANT_NOT_FOUND",
      message: "Empresa não encontrada!",
    });

    repositories.findBusinessById.mockResolvedValueOnce({ id: OTHER, is_active: false });
    expect(await refusalOf(() => verifyBusinessActive(request(master, { params: { businessId: OTHER } }), {} as never))).toEqual({
      status: 403,
      code: "TENANT_INACTIVE",
      message: "Esta empresa está desativada. Entre em contato com o administrador para reativar o acesso.",
    });
  });

  it("never uses the session's snapshot for a MASTER, who has no company of its own", async () => {
    repositories.findBusinessById.mockResolvedValue({ id: OTHER, is_active: true });

    await verifyBusinessActive(request(master, { params: { businessId: OTHER } }), {} as never);

    expect(repositories.findUserById).not.toHaveBeenCalled();
    expect(repositories.findBusinessById).toHaveBeenCalledWith(OTHER);
  });

  it("reads the company again when the session has no snapshot of it", async () => {
    repositories.findUserById.mockResolvedValue(null);
    repositories.findBusinessById.mockResolvedValue({ id: OWN, is_active: true });

    await verifyBusinessActive(request(employee, { params: { businessId: OWN } }), {} as never);

    expect(repositories.findBusinessById).toHaveBeenCalledWith(OWN);
  });
});

describe("verifyBranchActive", () => {
  const branch = (over = {}) => ({ id: "branch-1", businessId: OWN, is_active: true, ...over });
  const NOT_FOUND = { status: 404, code: "BRANCH_NOT_FOUND", message: "Filial não encontrada!" };

  it("does nothing without a branch in the request", async () => {
    expect(await refusalOf(() => verifyBranchActive(request(employee, { params: {} }), {} as never))).toBeNull();
    expect(repositories.findBranchById).not.toHaveBeenCalled();
  });

  it("keeps the company's own active branch on the request", async () => {
    repositories.findBranchById.mockResolvedValue(branch());
    const req = request(employee, { query: { branchId: "branch-1" } }) as { branch?: unknown };

    await verifyBranchActive(req as never, {} as never);

    expect(req.branch).toEqual(branch());
  });

  it("answers a missing branch and another company's branch alike, with 404", async () => {
    repositories.findBranchById.mockResolvedValueOnce(null);
    expect(await refusalOf(() => verifyBranchActive(request(employee, { params: { branchId: "x" } }), {} as never))).toEqual(NOT_FOUND);

    repositories.findBranchById.mockResolvedValueOnce(branch({ businessId: OTHER, is_active: false }));
    expect(await refusalOf(() => verifyBranchActive(request(employee, { params: { branchId: "x" } }), {} as never))).toEqual(NOT_FOUND);
  });

  it("lets the MASTER reach another company's branch, but not an inactive one", async () => {
    repositories.findBranchById.mockResolvedValueOnce(branch({ businessId: OTHER }));
    expect(await refusalOf(() => verifyBranchActive(request(master, { body: { branchId: "x" } }), {} as never))).toBeNull();

    repositories.findBranchById.mockResolvedValueOnce(branch({ is_active: false }));
    expect(await refusalOf(() => verifyBranchActive(request(employee, { params: { branchId: "x" } }), {} as never))).toEqual({
      status: 403,
      code: "BRANCH_INACTIVE",
      message: "Esta filial está desativada. Entre em contato com o administrador para reativar o acesso.",
    });
  });
});

describe("verifyBranchBelongsToBusiness", () => {
  const withBoth = (branchBusiness: string) =>
    ({ branch: { id: "b1", businessId: branchBusiness, is_active: true }, business: { id: OWN, is_active: true } }) as never;

  it("refuses a branch of another company than the one named", async () => {
    expect(await refusalOf(() => verifyBranchBelongsToBusiness(withBoth(OTHER), {} as never))).toEqual({
      status: 403,
      code: "BRANCH_TENANT_MISMATCH",
      message: "Esta filial não pertence à empresa informada.",
    });
    expect(await refusalOf(() => verifyBranchBelongsToBusiness(withBoth(OWN), {} as never))).toBeNull();
  });

  it("has nothing to compare without both", async () => {
    expect(await refusalOf(() => verifyBranchBelongsToBusiness({ branch: { businessId: OTHER } } as never, {} as never))).toBeNull();
    expect(await refusalOf(() => verifyBranchBelongsToBusiness({ business: { id: OWN } } as never, {} as never))).toBeNull();
  });
});
