import { FastifyReply, FastifyRequest } from "fastify";

import { BusinessRepository } from "../business/repositories/business-repository";
import { BranchRepository } from "../branch/repositories/branch-repository";
import { UserRepository } from "../user/repositories/user-repository";

import { AppError } from "@/shared/errors/AppError";
import { tenantInactive } from "@/shared/errors/access-errors";
import { assertTenantAccess } from "./tenant-authorization";

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

  assertTenantAccess(request.user, businessId);

  /**
   * The caller's own company, answered from this request's session lookup.
   *
   * For anyone but MASTER the line above has just forced `businessId` to be
   * the user's own company — and ensureAuthenticated loaded that company with
   * the user, and refused an inactive one, milliseconds ago in this request.
   * Reading every column of it again was one more query on every route with
   * a :businessId. findUserById is memoised per request, so this is the row
   * already in hand; never a cache across requests. MASTER, who may name any
   * company, still reads it below.
   */
  if (
    request.user.role !== "MASTER" &&
    businessId === request.user.businessId
  ) {
    const own = (await new UserRepository().findUserById(request.user.id))
      ?.business;

    if (own) {
      if (!own.is_active) throw inactiveBusiness();

      request.business = { id: businessId, is_active: true };

      return;
    }
  }

  const businessRepository = new BusinessRepository();
  const business = (await businessRepository.findBusinessById(
    businessId,
  )) as Business | null;

  if (!business) throw businessNotFound();

  if (!business.is_active) throw inactiveBusiness();

  request.business = business;
}

/** Shared with the MASTER's module gate, so both say it the same way. */
function businessNotFound(): AppError {
  return new AppError("Empresa não encontrada!", 404, "TENANT_NOT_FOUND");
}

function branchNotFound(): AppError {
  return new AppError("Filial não encontrada!", 404, "BRANCH_NOT_FOUND");
}

function inactiveBusiness(): AppError {
  return tenantInactive(
    "Esta empresa está desativada. Entre em contato com o administrador para reativar o acesso.",
  );
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

  // Another company's branch is answered like one that does not exist, and
  // before its status is looked at: a 403 for "exists elsewhere" beside a
  // 404 for "exists nowhere" let a carrier map another's branch ids
  // (decision 8.1). The MASTER may name any company's branch.
  const foreign =
    branch !== null &&
    request.user.role !== "MASTER" &&
    branch.businessId !== request.user.businessId;

  if (!branch || foreign) throw branchNotFound();

  if (!branch.is_active) {
    throw new AppError(
      "Esta filial está desativada. Entre em contato com o administrador para reativar o acesso.",
      403,
      "BRANCH_INACTIVE",
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
    throw new AppError(
      "Esta filial não pertence à empresa informada.",
      403,
      "BRANCH_TENANT_MISMATCH",
    );
  }
}

export {
  businessNotFound,
  inactiveBusiness,
  verifyBusinessActive,
  verifyBranchActive,
  verifyBranchBelongsToBusiness,
};
