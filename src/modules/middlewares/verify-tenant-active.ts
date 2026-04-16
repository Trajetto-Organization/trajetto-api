import { FastifyReply, FastifyRequest } from "fastify";

import { BusinessRepository } from "../business/repositories/business-repository";
import { BranchRepository } from "../branch/repositories/branch-repository";

import { AppError } from "@/shared/errors/AppError";

type Business = {
  id: string;
  is_active: boolean;
};

type Branch = {
  id: string;
  businessId: string;
  is_active: boolean;
};

declare module "fastify" {
  interface FastifyRequest {
    business?: Business;
    branch?: Branch;
  }
}

type TenantParams = {
  businessId?: string;
  branchId?: string;
};

type TenantRequest = FastifyRequest<{
  Params: TenantParams;
  Body: TenantParams;
  Querystring: TenantParams;
}>;

function getTenantId(
  request: TenantRequest,
  key: "businessId" | "branchId",
): string | undefined {
  return request.params?.[key] ?? request.body?.[key] ?? request.query?.[key];
}

async function verifyBusinessActive(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const req = request as TenantRequest;

  const businessId = getTenantId(req, "businessId");
  if (!businessId) return;

  const businessRepository = new BusinessRepository();
  const business = (await businessRepository.findBusinessById(
    businessId,
  )) as Business | null;

  if (!business) {
    throw new AppError("Empresa não encontrada!", 404);
  }

  if (!business.is_active) {
    throw new AppError(
      "Esta empresa está desativada. Entre em contato com o administrador para reativar o acesso.",
      403,
    );
  }

  request.business = business;
}

async function verifyBranchActive(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const req = request as TenantRequest;

  const branchId = getTenantId(req, "branchId");
  if (!branchId) return;

  const branchRepository = new BranchRepository();
  const branch = (await branchRepository.findBranchById(
    branchId,
  )) as Branch | null;

  if (!branch) {
    throw new AppError("Filial não encontrada!", 404);
  }

  if (!branch.is_active) {
    throw new AppError(
      "Esta filial está desativada. Entre em contato com o administrador para reativar o acesso.",
      403,
    );
  }

  request.branch = branch;
}

async function verifyBranchBelongsToBusiness(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  if (!request.branch || !request.business) return;
  if (request.branch.businessId !== request.business.id) {
    throw new AppError("Esta filial não pertence à empresa informada.", 403);
  }
}

export {
  verifyBusinessActive,
  verifyBranchActive,
  verifyBranchBelongsToBusiness,
};
