import { beforeEach, describe, expect, it, vi } from "vitest";

const service = vi.hoisted(() => ({
  hasModule: vi.fn(),
  getCompaniesModuleState: vi.fn(),
}));

vi.mock("@/shared/entitlements/entitlement-service", () => service);

import { verifyModuleEnabled } from "@/modules/middlewares/verify-module-enabled";
import { AppError } from "@/shared/errors/AppError";

/**
 * The module gate, answered from the session's own snapshot.
 *
 * ensureAuthenticated loads the user with its company and the modules that
 * company hired. The gate then read the same entitlements again, one more
 * query on every gated request — the driver's position flush included. It now
 * reads the snapshot of this request, and only goes to the database when the
 * request carries none.
 */
const gate = verifyModuleEnabled("DELIVERIES");

function requestWith(user: Record<string, unknown>) {
  return { user } as never;
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
  service.hasModule.mockReset();
  service.getCompaniesModuleState.mockReset();
});

describe("the module gate", () => {
  it("lets a hired module through without a query", async () => {
    await gate(
      requestWith({
        role: "BUSINESS_USER",
        businessId: "business-1",
        entitlements: [
          { module: "FLEET", enabled: false },
          { module: "DELIVERIES", enabled: true },
        ],
      }),
      {} as never,
    );

    expect(service.hasModule).not.toHaveBeenCalled();
  });

  it("refuses a module switched off, without a query", async () => {
    expect(
      await codeOf(
        gate(
          requestWith({
            role: "BUSINESS_ADMIN",
            businessId: "business-1",
            entitlements: [{ module: "DELIVERIES", enabled: false }],
          }),
          {} as never,
        ),
      ),
    ).toBe("MODULE_NOT_ENABLED");

    expect(service.hasModule).not.toHaveBeenCalled();
  });

  it("refuses a module never hired (an empty snapshot is an answer)", async () => {
    expect(
      await codeOf(
        gate(
          requestWith({
            role: "BUSINESS_ADMIN",
            businessId: "business-1",
            entitlements: [],
          }),
          {} as never,
        ),
      ),
    ).toBe("MODULE_NOT_ENABLED");

    expect(service.hasModule).not.toHaveBeenCalled();
  });

  it("asks the database when the request carries no snapshot", async () => {
    service.hasModule.mockResolvedValue(true);

    await gate(
      requestWith({ role: "BUSINESS_USER", businessId: "business-1" }),
      {} as never,
    );

    expect(service.hasModule).toHaveBeenCalledWith("business-1", "DELIVERIES");
  });

});


/**
 * MASTER is gated too (decision 4.3), on every company the request names.
 *
 * It used to pass without looking, so the back office read and wrote
 * deliveries and fuelling of companies that never hired the module, and the
 * "não contratado" state never appeared in /admin.
 */
describe("the module gate for a MASTER", () => {
  const COMPANY = "018f0000-0000-7000-8000-00000000000a";
  const OTHER = "018f0000-0000-7000-8000-00000000000b";

  function masterRequest(parts: {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
  }) {
    return {
      user: { role: "MASTER", businessId: null },
      params: parts.params ?? {},
      query: parts.query ?? {},
      body: parts.body,
    } as never;
  }

  /** What the database knows: every id listed exists, active unless said. */
  function companies(
    rows: Array<{ id: string; isActive?: boolean; moduleEnabled: boolean }>,
  ) {
    service.getCompaniesModuleState.mockResolvedValue(
      rows.map((row) => ({ isActive: true, ...row })),
    );
  }

  it("refuses the company named in the path when it lacks the module", async () => {
    companies([{ id: COMPANY, moduleEnabled: false }]);

    expect(
      await codeOf(gate(masterRequest({ params: { businessId: COMPANY } }), {} as never)),
    ).toBe("MODULE_NOT_ENABLED");

    expect(service.getCompaniesModuleState).toHaveBeenCalledWith(
      [COMPANY],
      "DELIVERIES",
    );
  });

  it("lets through a company that hired it", async () => {
    companies([{ id: COMPANY, moduleEnabled: true }]);

    expect(
      await codeOf(gate(masterRequest({ query: { businessId: COMPANY } }), {} as never)),
    ).toBeNull();
  });

  it("checks every company the request names, not the first one found", async () => {
    // ?businessId=<hired> with a body naming another company: the use case
    // may read either.
    companies([
      { id: COMPANY, moduleEnabled: true },
      { id: OTHER, moduleEnabled: false },
    ]);

    expect(
      await codeOf(
        gate(
          masterRequest({
            query: { businessId: COMPANY },
            body: { businessId: OTHER },
          }),
          {} as never,
        ),
      ),
    ).toBe("MODULE_NOT_ENABLED");

    expect(service.getCompaniesModuleState).toHaveBeenCalledWith(
      [COMPANY, OTHER],
      "DELIVERIES",
    );
  });

  it("asks once, with each company once, however many places name it", async () => {
    companies([{ id: COMPANY, moduleEnabled: true }]);

    await gate(
      masterRequest({
        params: { businessId: COMPANY },
        query: { businessId: COMPANY },
        body: { businessId: COMPANY },
      }),
      {} as never,
    );

    expect(service.getCompaniesModuleState).toHaveBeenCalledTimes(1);
    expect(service.getCompaniesModuleState).toHaveBeenCalledWith(
      [COMPANY],
      "DELIVERIES",
    );
  });

  it("does not look anything up for a request that names no company", async () => {
    // Safe because no module route serves company data to such a request:
    // proven route by route in tests/E2E/master-module-gate-http.test.ts.
    await gate(masterRequest({ params: { vehicleId: "v-1" } }), {} as never);

    expect(service.getCompaniesModuleState).not.toHaveBeenCalled();
  });

  it("names the switch to flip in the message", async () => {
    companies([{ id: COMPANY, moduleEnabled: false }]);

    try {
      await gate(masterRequest({ params: { businessId: COMPANY } }), {} as never);
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).message).toMatch(/Módulos Contratados/);
      expect((error as AppError).statusCode).toBe(403);
    }
  });

  it("answers 404 for a company that does not exist, not a plan refusal", async () => {
    companies([]);

    try {
      await gate(masterRequest({ params: { businessId: COMPANY } }), {} as never);
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).statusCode).toBe(404);
      expect((error as AppError).code).toBe("TENANT_NOT_FOUND");
    }
  });

  it("answers TENANT_INACTIVE for a switched-off company without the module", async () => {
    companies([{ id: COMPANY, isActive: false, moduleEnabled: false }]);

    expect(
      await codeOf(gate(masterRequest({ query: { businessId: COMPANY } }), {} as never)),
    ).toBe("TENANT_INACTIVE");
  });

  it("leaves a switched-off company that hired the module to the tenant gate", async () => {
    // Not this gate's refusal: routes with verifyBusinessActive refuse it,
    // exactly as before the MASTER was gated here.
    companies([{ id: COMPANY, isActive: false, moduleEnabled: true }]);

    expect(
      await codeOf(gate(masterRequest({ query: { businessId: COMPANY } }), {} as never)),
    ).toBeNull();
  });
});
