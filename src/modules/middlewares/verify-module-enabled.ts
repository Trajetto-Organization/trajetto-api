import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { BusinessModule } from "@prisma/client";

import { AppError } from "@/shared/errors/AppError";
import { moduleNotEnabled } from "@/shared/errors/access-errors";
import {
  getCompaniesModuleState,
  hasModule,
} from "@/shared/entitlements/entitlement-service";
import {
  isModuleEnabled,
  masterModuleRefusal,
} from "@/shared/entitlements/entitlement-rules";

import { requestedTenantValues } from "./tenant-authorization";
import { businessNotFound, inactiveBusiness } from "./verify-tenant-active";

/** The names the plan screen uses, so the message points at the right switch. */
const MODULE_LABELS: Record<BusinessModule, string> = {
  FLEET: "Gestão de Frota",
  DELIVERIES: "Entregas",
};

/**
 * Every company a MASTER request names, once each.
 *
 * All of them and not the first: the tenant guard learned the hard way that
 * picking one location lets the caller choose which one is checked, and the
 * use case behind may read another. Anything that is not a non-empty string
 * names no company here; the route's own validation answers for it.
 */
function masterTargets(request: FastifyRequest): string[] {
  const ids = requestedTenantValues(request).filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  return [...new Set(ids)];
}

/**
 * MASTER is gated too (decision 4.3), on every company the request names:
 * the back office used to pass untouched, read and write deliveries or
 * fuelling of a company that never hired them, and never saw the "não
 * contratado" state its customers see.
 *
 * A company that does not exist answers 404 and a switched-off one without
 * the module TENANT_INACTIVE, before the plan is blamed: the web offers to
 * enable the module on MODULE_NOT_ENABLED, which is no way out for either.
 *
 * A MASTER request that names NO company passes. That is safe only because
 * no module route serves a company's data to such a request: the lists and
 * exports refuse the MASTER without a company (BUSINESS_NOT_IDENTIFIED), and
 * the few routes that take no company at all are catalogues without tenant
 * data or scoped to the caller's own company, which a MASTER does not have.
 * tests/E2E/master-module-gate-http.test.ts enumerates those routes from the
 * published document; a new one fails there until its answer is proven.
 */
async function verifyMasterTargets(
  request: FastifyRequest,
  module: BusinessModule,
): Promise<void> {
  const targets = masterTargets(request);

  if (targets.length === 0) return;

  const refusal = masterModuleRefusal(
    targets,
    await getCompaniesModuleState(targets, module),
  );

  if (refusal === "company-not-found") throw businessNotFound();
  if (refusal === "company-inactive") throw inactiveBusiness();

  if (refusal === "module-not-enabled") {
    throw moduleNotEnabled(
      `O módulo ${MODULE_LABELS[module]} não está habilitado para esta empresa. Habilite-o em Empresas, na opção Módulos Contratados.`,
    );
  }
}

/**
 * Route guard for sellable modules: registered as a preHandler on every
 * route of a module, it rejects companies that never hired — or had
 * disabled — the module.
 *
 * Everyone but the MASTER can only ever act on their OWN company — the
 * tenant guard refuses any request that names another one — so their own
 * company is the one whose contract is checked. Reading the id from the
 * request instead let the two guards disagree: this one read the body first
 * while the tenant guard read the query first, so `?businessId=<own>` with a
 * body naming a company that hired the module passed both, each looking at a
 * different id.
 */
function verifyModuleEnabled(module: BusinessModule) {
  const hook = async function (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (request.user?.role === "MASTER") {
      await verifyMasterTargets(request, module);

      return;
    }

    const businessId = request.user?.businessId;

    if (!businessId) {
      throw new AppError(
        "Empresa não identificada na requisição.",
        400,
        "MODULE_BUSINESS_MISSING",
      );
    }

    // The session lookup of this same request loaded the user's company with
    // its hired modules; `businessId` above is that company. Reading them
    // again was one more query on every gated request (the driver's position
    // flush included). Not a cache across requests: the snapshot is exactly
    // as fresh as the session check itself. Without it — a request
    // authenticated some other way — the database answers.
    const snapshot = request.user?.entitlements;

    const enabled = Array.isArray(snapshot)
      ? isModuleEnabled(snapshot, module)
      : await hasModule(businessId, module);

    if (!enabled) {
      throw moduleNotEnabled(
        "Este módulo não está habilitado para a sua empresa. Fale com o suporte para contratar.",
      );
    }
  };

  // Read back by the OpenAPI transform, which only sees the hook itself.
  return Object.assign(hook, { openapi: { module } });
}

/**
 * The same gate on every route of a plugin, and said so in /docs.
 *
 * A plugin-level hook never appears in a route's own options, and those are
 * all the OpenAPI transform gets to see — so the module is also written into
 * each route's config as the route is added. Without it the fleet routes
 * would be documented as if MODULE_NOT_ENABLED could not happen to them.
 */
function requireModuleForPlugin(
  app: FastifyInstance,
  module: BusinessModule,
): void {
  app.addHook("preHandler", verifyModuleEnabled(module));

  app.addHook("onRoute", (route) => {
    route.config = {
      ...route.config,
      openapi: { ...route.config?.openapi, module },
    };
  });
}

export { verifyModuleEnabled, requireModuleForPlugin };
