import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Edges of the permission and module gates left alive by the 06/10 mutation
 * run: the driver's whole permission table, an employee who is not a driver,
 * the refusal kept when no alternative passes, the MASTER's targets, the
 * company-less request, and what each gate publishes for /docs.
 */

const service = vi.hoisted(() => ({
  hasModule: vi.fn(),
  getCompaniesModuleState: vi.fn(),
}));

vi.mock("@/shared/entitlements/entitlement-service", () => service);

import {
  DRIVER_PERMISSIONS,
  decideAnyPermission,
  decidePermission,
  verifyPermission,
} from "@/modules/middlewares/verify-permission";
import {
  requireModuleForPlugin,
  verifyModuleEnabled,
} from "@/modules/middlewares/verify-module-enabled";
import { AppError } from "@/shared/errors/AppError";

const driver = {
  role: "BUSINESS_USER",
  driverId: "driver-1",
  profileAccess: null,
} as const;

const explain = (error: AppError | null) =>
  error && {
    status: error.statusCode,
    code: error.code,
    message: error.message,
  };

describe("decidePermission for a driver", () => {
  it("follows the driver's table exactly", () => {
    expect(DRIVER_PERMISSIONS).toEqual({
      vehicle_manage: ["read"],
      vehicle_checklist_manage: ["read", "write"],
      service_order_manage: ["read"],
      fuel_manage: ["read", "write"],
      delivery_manage: ["read", "write"],
      occurrence_manage: ["write"],
    });

    const expected: Record<string, string[]> = DRIVER_PERMISSIONS as never;
    for (const key of [...Object.keys(expected), "fine_manage"]) {
      for (const access of ["read", "write"] as const) {
        const granted = (expected[key] ?? []).includes(access);
        const refusal = decidePermission(driver as never, key as never, access);

        expect(refusal === null).toBe(granted);
        if (!granted) {
          expect(explain(refusal)).toEqual({
            status: 403,
            code: "PERMISSION_DENIED",
            message:
              "Motoristas não possuem permissão para acessar este recurso.",
          });
        }
      }
    }
  });

  it("reads an employee who is not a driver from the profile", () => {
    const employee = {
      role: "BUSINESS_USER",
      driverId: null,
      profileAccess: {
        permissions: [
          { permissionKey: "fine_manage", canRead: true, canWrite: false },
        ],
      },
    };

    expect(
      decidePermission(employee as never, "fine_manage", "read"),
    ).toBeNull();
  });

  it("says a missing profile is a configuration problem", () => {
    expect(
      explain(
        decidePermission(
          {
            role: "BUSINESS_USER",
            driverId: null,
            profileAccess: null,
          } as never,
          "fine_manage",
          "read",
        ),
      ),
    ).toEqual({
      status: 403,
      code: "AUTH_PROFILE_NOT_CONFIGURED",
      message: "Perfil de acesso não associado ao usuário.",
    });
  });
});

describe("decideAnyPermission", () => {
  const readOnly = {
    role: "BUSINESS_USER",
    driverId: null,
    profileAccess: {
      permissions: [
        { permissionKey: "driver_manage", canRead: true, canWrite: false },
      ],
    },
  };

  it("keeps the first alternative's refusal", () => {
    const outcome = decideAnyPermission(readOnly as never, [
      { key: "driver_manage", access: "write" },
      { key: "delivery_manage", access: "write" },
    ]);

    expect("refusal" in outcome && outcome.refusal.message).toBe(
      "Seu perfil de acesso permite apenas a leitura desta seção.",
    );
  });

  it("denies by default with no alternative", () => {
    const outcome = decideAnyPermission(readOnly as never, []);

    expect("refusal" in outcome && explain(outcome.refusal)).toEqual({
      status: 403,
      code: "PERMISSION_DENIED",
      message: "Seu perfil de acesso não inclui esta seção.",
    });
  });
});

describe("verifyPermission", () => {
  it("publishes its key and access for /docs", () => {
    expect(verifyPermission("fuel_manage", "write").openapi).toEqual({
      permission: { key: "fuel_manage", access: "write" },
    });
  });
});

describe("verifyModuleEnabled", () => {
  const gate = verifyModuleEnabled("DELIVERIES");

  async function refusalOf(
    user: Record<string, unknown> | undefined,
    where: Record<string, unknown> = {},
  ) {
    try {
      await gate({ user, ...where } as never, {} as never);
      return null;
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      return {
        status: error.statusCode,
        code: error.code,
        message: error.message,
      };
    }
  }

  beforeEach(() => {
    service.hasModule.mockReset();
    service.getCompaniesModuleState.mockReset();
  });

  it("refuses a request without a company with 400", async () => {
    expect(
      await refusalOf({ role: "BUSINESS_USER", businessId: null }),
    ).toEqual({
      status: 400,
      code: "MODULE_BUSINESS_MISSING",
      message: "Empresa não identificada na requisição.",
    });
    expect(await refusalOf(undefined)).toEqual({
      status: 400,
      code: "MODULE_BUSINESS_MISSING",
      message: "Empresa não identificada na requisição.",
    });
  });

  it("asks the database when the session carries no snapshot, and says why it refuses", async () => {
    service.hasModule.mockResolvedValue(false);

    expect(
      await refusalOf({
        role: "BUSINESS_USER",
        businessId: "b1",
        entitlements: null,
      }),
    ).toEqual({
      status: 403,
      code: "MODULE_NOT_ENABLED",
      message:
        "Este módulo não está habilitado para a sua empresa. Fale com o suporte para contratar.",
    });
    expect(service.hasModule).toHaveBeenCalledWith("b1", "DELIVERIES");
  });

  it("checks each company a MASTER names once, ignoring what names none", async () => {
    service.getCompaniesModuleState.mockResolvedValue([
      { id: "b1", isActive: true, moduleEnabled: true },
      { id: "b2", isActive: true, moduleEnabled: true },
    ]);

    expect(
      await refusalOf(
        { role: "MASTER" },
        {
          params: { businessId: "b1" },
          query: { businessId: ["b1", "", "b2"] },
          body: { businessId: 5 },
        },
      ),
    ).toBeNull();
    expect(service.getCompaniesModuleState).toHaveBeenCalledWith(
      ["b1", "b2"],
      "DELIVERIES",
    );
  });

  it("names the module the MASTER must enable", async () => {
    service.getCompaniesModuleState.mockResolvedValue([
      { id: "b1", isActive: true, moduleEnabled: false },
    ]);

    expect(
      await refusalOf({ role: "MASTER" }, { params: { businessId: "b1" } }),
    ).toEqual({
      status: 403,
      code: "MODULE_NOT_ENABLED",
      message:
        "O módulo Entregas não está habilitado para esta empresa. Habilite-o em Empresas, na opção Módulos Contratados.",
    });

    const fleet = verifyModuleEnabled("FLEET");
    await expect(
      fleet(
        { user: { role: "MASTER" }, params: { businessId: "b1" } } as never,
        {} as never,
      ),
    ).rejects.toThrow(
      "O módulo Gestão de Frota não está habilitado para esta empresa.",
    );
  });

  it("publishes its module for /docs, on the hook and on every route of a plugin", () => {
    expect(gate.openapi).toEqual({ module: "DELIVERIES" });

    const hooks: Record<
      string,
      (route: { config?: Record<string, unknown> }) => void
    > = {};
    const app = {
      addHook: (name: string, hook: never) => void (hooks[name] = hook),
    };
    requireModuleForPlugin(app as never, "FLEET");

    const route: { config?: Record<string, unknown> } = {
      config: { rateLimit: false, openapi: { roles: ["MASTER"] } },
    };
    hooks.onRoute(route);

    expect(route.config).toEqual({
      rateLimit: false,
      openapi: { roles: ["MASTER"], module: "FLEET" },
    });
    expect(typeof hooks.preHandler).toBe("function");
  });
});
