import fastify, { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { enforceRequestedTenant } from "@/modules/middlewares/tenant-authorization";
import { AppError } from "@/shared/errors/AppError";

const COMPANY_A = "0198a8d0-70c0-7000-8000-00000000000a";
const COMPANY_B = "0198a8d0-70c0-7000-8000-00000000000b";

interface BuildAppProps {
  role?: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  businessId?: string | null;
  authenticated?: boolean;
}

/**
 * Mirrors the real wiring: `ensureAuthenticated` populates `request.user` on
 * `onRequest`, the tenant guard runs on `preHandler`, and routes are added in
 * an encapsulated plugin the same way `app.register(routes)` does it.
 */
function buildApp({
  role = "BUSINESS_ADMIN",
  businessId = COMPANY_A,
  authenticated = true,
}: BuildAppProps = {}): FastifyInstance {
  const app = fastify();

  app.addHook("onRequest", async (request) => {
    if (!authenticated) return;

    request.user = {
      id: "user-1",
      role,
      businessId,
      sessionVersion: 0,
      sessionId: "session-1",
    };
  });

  app.addHook("preHandler", enforceRequestedTenant);
  app.register(async (instance) => {
    instance.post(
      "/update-profile-access/:profileAccessId",
      // A route-level preHandler, like the real `verifyPermission`.
      { preHandler: [async () => undefined] },
      async () => ({ updated: true }),
    );

    instance.get("/by-params/:businessId", async () => ({ ok: true }));
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      return reply
        .status(error.statusCode)
        .send({ code: error.code, message: error.message });
    }

    return reply.status(500).send({ code: "INTERNAL_ERROR" });
  });

  return app;
}

describe("tenant isolation for body-supplied businessId", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("rejects a businessId in the body that belongs to another company", async () => {
    app = buildApp({ role: "BUSINESS_ADMIN", businessId: COMPANY_A });

    const response = await app.inject({
      method: "POST",
      url: "/update-profile-access/any-profile-id",
      payload: { businessId: COMPANY_B, name: "Perfil sequestrado" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });

  it("allows a businessId in the body that belongs to the caller", async () => {
    app = buildApp({ role: "BUSINESS_ADMIN", businessId: COMPANY_A });

    const response = await app.inject({
      method: "POST",
      url: "/update-profile-access/any-profile-id",
      payload: { businessId: COMPANY_A, name: "Perfil proprio" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("still lets MASTER operate across companies", async () => {
    app = buildApp({ role: "MASTER", businessId: null });

    const response = await app.inject({
      method: "POST",
      url: "/update-profile-access/any-profile-id",
      payload: { businessId: COMPANY_B, name: "Perfil de outra empresa" },
    });

    expect(response.statusCode).toBe(200);
  });

  it("keeps rejecting a foreign businessId taken from the route params", async () => {
    app = buildApp({ role: "BUSINESS_ADMIN", businessId: COMPANY_A });

    const response = await app.inject({
      method: "GET",
      url: `/by-params/${COMPANY_B}`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });

  // The guard used to pick ONE candidate (params ?? query ?? body), so the
  // caller chose which one it read. Each case below passed before.
  it("rejects a foreign body businessId even when the query names the caller's own", async () => {
    app = buildApp({ role: "BUSINESS_ADMIN", businessId: COMPANY_A });

    const response = await app.inject({
      method: "POST",
      url: `/update-profile-access/any-profile-id?businessId=${COMPANY_A}`,
      payload: { businessId: COMPANY_B },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("TENANT_ACCESS_DENIED");
  });

  it("rejects an empty businessId instead of skipping the check", async () => {
    app = buildApp({ role: "BUSINESS_ADMIN", businessId: COMPANY_A });

    const response = await app.inject({
      method: "POST",
      url: "/update-profile-access/any-profile-id?businessId=",
      payload: { businessId: COMPANY_B },
    });

    expect(response.statusCode).toBe(403);
  });

  it("rejects a repeated businessId when any of the values is foreign", async () => {
    app = buildApp({ role: "BUSINESS_ADMIN", businessId: COMPANY_A });

    const response = await app.inject({
      method: "POST",
      url: `/update-profile-access/any-profile-id?businessId=${COMPANY_A}&businessId=${COMPANY_B}`,
      payload: { businessId: COMPANY_A },
    });

    expect(response.statusCode).toBe(403);
  });

  it("accepts the caller's own businessId repeated in every location", async () => {
    app = buildApp({ role: "BUSINESS_ADMIN", businessId: COMPANY_A });

    const response = await app.inject({
      method: "POST",
      url: `/update-profile-access/any-profile-id?businessId=${COMPANY_A}`,
      payload: { businessId: COMPANY_A },
    });

    expect(response.statusCode).toBe(200);
  });

  it("does not break public routes that have no authenticated user", async () => {
    app = buildApp({ authenticated: false });

    const response = await app.inject({
      method: "POST",
      url: "/update-profile-access/any-profile-id",
      payload: { businessId: COMPANY_B },
    });

    expect(response.statusCode).toBe(200);
  });
});
