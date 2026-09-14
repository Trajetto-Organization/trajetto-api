import { FastifyReply, FastifyRequest } from "fastify";
import { BusinessModule } from "@prisma/client";

import { AppError } from "@/shared/errors/AppError";
import { hasModule } from "@/shared/entitlements/entitlement-service";

type ModuleParams = {
  businessId?: string;
};

type ModuleRequest = FastifyRequest<{
  Params: ModuleParams;
  Body: ModuleParams;
  Querystring: ModuleParams;
}>;

/**
 * Route guard for sellable modules: registered as a preHandler on every
 * route of a module (the Entregas routes will be the first consumer), it
 * rejects companies that never hired — or had disabled — the module.
 *
 * MASTER passes: back office operates across companies regardless of what
 * each one hired. The businessId is resolved the same way the tenant
 * guards do (params, then body, then query).
 */
function verifyModuleEnabled(module: BusinessModule) {
  return async function (
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    if (request.user?.role === "MASTER") return;

    const req = request as ModuleRequest;
    const businessId =
      req.params?.businessId ??
      req.body?.businessId ??
      req.query?.businessId ??
      request.user?.businessId;

    if (!businessId) {
      throw new AppError(
        "Empresa não identificada na requisição.",
        400,
        "MODULE_BUSINESS_MISSING",
      );
    }

    const enabled = await hasModule(businessId, module);

    if (!enabled) {
      throw new AppError(
        "Este módulo não está habilitado para a sua empresa. Fale com o suporte para contratar.",
        403,
        "MODULE_NOT_ENABLED",
      );
    }
  };
}

export { verifyModuleEnabled };
