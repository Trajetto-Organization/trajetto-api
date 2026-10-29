import { AppError } from "@/shared/errors/AppError";

/**
 * The caller's own user row, the first read of every Entregas use case, is
 * gone (deleted between the auth hook and the use case). Honest HTTP
 * (decision 11.3): 404 with a code, the same answer as the proof-audit
 * routes. The code-less ResourceNotFoundError it replaces reached the client
 * as a 400.
 */
function callerNotFound(): AppError {
  return new AppError("Usuário não encontrado.", 404, "USER_NOT_FOUND");
}

/**
 * A MASTER asked for a company that does not exist: 404, not a 400. The same
 * code and sentence the route guards give (verify-tenant-active), which run
 * first on every Entregas route; this is the use case's own second line, and
 * two codes for one fact would make clients branch on both. Not imported from
 * the middleware: that module pulls the Prisma repositories into every unit
 * test of these use cases.
 */
function businessNotFound(): AppError {
  return new AppError("Empresa não encontrada!", 404, "TENANT_NOT_FOUND");
}

export { businessNotFound, callerNotFound };
