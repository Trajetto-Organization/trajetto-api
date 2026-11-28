import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The staging fixture (tests/load/staging-fixture.mjs, plano-escala LOAD-09)
 * signs in with an administrator's password and creates drivers, vehicles,
 * deliveries and routes in whatever company that password opens. So it must
 * refuse production and any company that is not 'Carga (staging)' BEFORE
 * any write, and running it twice must not double anything: the burn-in
 * runs it every time.
 *
 * Executed for real (node, the global fetch) against a stub of the API that
 * answers the routes it calls the way the API does (NDJSON listings with
 * the meta line, Idempotency-Key replays, 429 with Retry-After).
 */
const FIXTURE = resolve(process.cwd(), "tests", "load", "staging-fixture.mjs");
const BUSINESS = "b0000000-0000-4000-8000-000000000001";
const PASSWORD = "carga-admin-password-only-here";

interface Call {
  method: string;
  path: string;
  auth?: string;
  key?: string;
  body?: Record<string, unknown>;
}

interface Api {
  url: string;
  calls: Call[];
  company: string;
  twoFactor: boolean;
  enrollThrottles: number;
  drivers: Array<{ id: string; name: string }>;
  users: Array<{ id: string; name: string; driverId: string }>;
  vehicles: Array<{ id: string; license_plate: string }>;
  shippers: Array<{ id: string; name: string }>;
  fuels: Array<{ id: string; description: string }>;
  deliveries: Map<string, string>;
  routes: Map<string, { id: string; driverId: string; status: string }>;
  close(): Promise<void>;
}

async function stubApi(): Promise<Api> {
  let next = 0;
  const id = () =>
    `00000000-0000-4000-8000-${String((next += 1)).padStart(12, "0")}`;

  const api = {
    calls: [] as Call[],
    company: "Carga (staging)",
    twoFactor: false,
    enrollThrottles: 0,
    drivers: [] as Api["drivers"],
    users: [] as Api["users"],
    vehicles: [] as Api["vehicles"],
    deliveries: new Map<string, string>(),
    routes: new Map<string, { id: string; driverId: string; status: string }>(),
    shippers: [] as Array<{ id: string; name: string }>,
    fuels: [] as Array<{ id: string; description: string }>,
  };

  const readBody = (request: IncomingMessage) =>
    new Promise<string>((done) => {
      let text = "";
      request
        .on("data", (chunk) => (text += chunk))
        .on("end", () => done(text));
    });

  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stub");
    const text = await readBody(request);
    const body = text
      ? (JSON.parse(text) as Record<string, unknown>)
      : undefined;
    const auth = request.headers.authorization?.replace("Bearer ", "");
    const key = request.headers["idempotency-key"] as string | undefined;
    const path = url.pathname;
    const search = url.searchParams.get("search") ?? "";

    api.calls.push({ method: request.method ?? "", path, auth, key, body });

    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const ndjson = (items: unknown[]) => {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(
        [{ meta: { total: 0 } }, ...items]
          .map((line) => JSON.stringify(line))
          .join("\n") + "\n",
      );
    };
    const route = `${request.method} ${path}`;

    if (route === "POST /user/session") {
      if (body?.password !== PASSWORD)
        return json(401, { code: "AUTH_INVALID_CREDENTIALS" });
      if (api.twoFactor)
        return json(200, { message: "código", twoFactorVerification: true });
      return json(200, {
        token: "admin-token",
        refresh_token: "r",
        role: "BUSINESS_ADMIN",
      });
    }
    if (route === "GET /user/me") {
      return json(200, {
        user: { id: "admin", role: "BUSINESS_ADMIN", businessId: BUSINESS },
      });
    }
    if (route === `GET /business/get-ai-usage/${BUSINESS}`) {
      return json(200, {
        data: {
          id: BUSINESS,
          corporate_reason: api.company,
          fantasy_name: null,
        },
      });
    }
    if (route === "GET /shipper/search-shipper-business") {
      return ndjson(api.shippers.filter((s) => s.name.includes(search)));
    }
    if (route === `POST /shipper/create-shipper/${BUSINESS}`) {
      api.shippers.push({ id: id(), name: String(body?.name) });
      // As the API: a message, no id (the fixture searches again).
      return json(201, { message: "Embarcador criado com sucesso!" });
    }
    if (route === "GET /fuel-type/search-fuel-type-business") {
      return ndjson(api.fuels.filter((f) => f.description.includes(search)));
    }
    if (route === `POST /fuel-type/create-fuel-type/${BUSINESS}`) {
      api.fuels.push({ id: id(), description: String(body?.description) });
      return json(201, { message: "Tipo de combustível criado com sucesso!" });
    }
    if (route === "GET /driver/search-driver-business") {
      return ndjson(api.drivers.filter((d) => d.name.includes(search)));
    }
    if (route === `POST /driver/create-driver/${BUSINESS}`) {
      api.drivers.push({ id: id(), name: String(body?.name) });
      return json(201, { message: "Motorista criado com sucesso!" });
    }
    if (route === "GET /user/search-user-business") {
      return ndjson(api.users.filter((u) => u.name.includes(search)));
    }
    if (route === "POST /user/create-user") {
      api.users.push({
        id: id(),
        name: String(body?.name),
        driverId: String(body?.driverId),
      });
      return json(201, { message: "Usuário criado com sucesso!" });
    }
    if (route === "GET /vehicle/search-vehicle-business") {
      return ndjson(
        api.vehicles.filter((v) => v.license_plate.includes(search)),
      );
    }
    if (route === `POST /vehicle/create-vehicle/${BUSINESS}`) {
      if (!body?.fuelTypeId) return json(400, { code: "VALIDATION_ERROR" });
      api.vehicles.push({
        id: id(),
        license_plate: String(body?.license_plate),
      });
      return json(201, { message: "Veículo criado com sucesso!" });
    }
    if (request.method === "POST" && /^\/user\/[^/]+\/enrollment$/.test(path)) {
      return json(201, {
        qrToken: `qr-${path.split("/")[2]}`,
        accessCode: "ABCD1234",
      });
    }
    if (route === "POST /user/session/enroll") {
      if (api.enrollThrottles > 0) {
        api.enrollThrottles -= 1;
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "1",
        });
        return response.end(JSON.stringify({ code: "RATE_LIMITED" }));
      }
      return json(200, {
        token: `driver-${String(body?.qrToken)}-${next++}`,
        role: "BUSINESS_USER",
      });
    }
    if (route === "GET /route/list-routes") {
      const driverId = url.searchParams.get("driverId");
      const status = url.searchParams.get("status");
      return ndjson(
        [...api.routes.values()].filter(
          (r) => r.driverId === driverId && (!status || r.status === status),
        ),
      );
    }
    if (route === `POST /delivery/create-delivery/${BUSINESS}`) {
      if (!key) return json(400, { code: "VALIDATION_ERROR" });
      if (!api.deliveries.has(key)) api.deliveries.set(key, id());
      return json(201, { data: { id: api.deliveries.get(key) } });
    }
    if (route === `POST /route/create-route/${BUSINESS}`) {
      if (!key) return json(400, { code: "VALIDATION_ERROR" });
      if (!api.routes.has(key)) {
        api.routes.set(key, {
          id: id(),
          driverId: String(body?.driverId),
          status: "PLANNED",
        });
      }
      return json(201, { data: api.routes.get(key) });
    }
    if (
      request.method === "PATCH" &&
      path.startsWith("/route/release-route/")
    ) {
      return json(200, { data: { unchanged: false } });
    }
    if (request.method === "POST" && path.startsWith("/route/start-route/")) {
      const routeId = path.split("/")[3];
      const started = [...api.routes.values()].find((r) => r.id === routeId);
      if (!started || !auth?.startsWith("driver-"))
        return json(404, { code: "DELIVERY_ROUTE_NOT_FOUND" });
      started.status = "IN_PROGRESS";
      return json(200, { data: started });
    }

    return json(404, { code: "ROUTE_NOT_FOUND", message: route });
  });

  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

  return Object.assign(api, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  });
}

function fixture(env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(process.execPath, [FIXTURE], {
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          FIXTURE_ADMIN_EMAIL: "carga-admin@example.com",
          FIXTURE_ADMIN_PASSWORD: PASSWORD,
          FIXTURE_DRIVERS: "2",
          FIXTURE_STOPS: "2",
          ...env,
        },
      });
      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (status) => done({ status, stdout, stderr }));
    },
  );
}

describe("staging-fixture.mjs (LOAD-09)", { timeout: 60_000 }, () => {
  let api: Api;

  beforeEach(async () => {
    api = await stubApi();
  });

  afterEach(() => api.close());

  describe("where it refuses to write", () => {
    it.each([
      "https://api.intrajetto.com",
      "https://www.intrajetto.com",
      "https://api.example.com",
    ])("refuses %s before a single request", async (url) => {
      const result = await fixture({ FIXTURE_BASE_URL: url });

      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/produção|não é um host de staging/);
    });

    it("refuses a company with another name, writing nothing", async () => {
      api.company = "Transportadora de verdade";

      const result = await fixture({ FIXTURE_BASE_URL: api.url });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("outra empresa");
      expect(api.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
        "POST /user/session",
        "GET /user/me",
        `GET /business/get-ai-usage/${BUSINESS}`,
      ]);
    });

    it("refuses an account that asks for a second factor", async () => {
      api.twoFactor = true;

      const result = await fixture({ FIXTURE_BASE_URL: api.url });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("2FA");
      expect(api.calls).toHaveLength(1);
    });

    it("refuses a size beyond its caps", async () => {
      const result = await fixture({
        FIXTURE_BASE_URL: api.url,
        FIXTURE_DRIVERS: "51",
      });

      expect(result.status).toBe(2);
      expect(api.calls).toHaveLength(0);
    });
  });

  describe("what it prepares", () => {
    it("creates drivers, logins, vehicles, deliveries and started routes, and prints the context", async () => {
      const result = await fixture({ FIXTURE_BASE_URL: api.url });

      expect(result.status, result.stderr).toBe(0);

      const context = JSON.parse(result.stdout) as {
        businessId: string;
        managerTokens: string[];
        driverTokens: string[];
      };

      expect(context.businessId).toBe(BUSINESS);
      expect(context.managerTokens).toEqual(["admin-token"]);
      expect(context.driverTokens).toHaveLength(2);

      expect(api.drivers.map((d) => d.name)).toEqual([
        "Carga motorista 01",
        "Carga motorista 02",
      ]);
      expect(api.users).toHaveLength(2);
      expect(api.vehicles.map((v) => v.license_plate)).toEqual([
        "CRG1A01",
        "CRG1A02",
      ]);
      expect(api.deliveries.size).toBe(4);
      expect([...api.routes.values()].map((r) => r.status)).toEqual([
        "IN_PROGRESS",
        "IN_PROGRESS",
      ]);

      // Each route leaves with ITS driver's session, the way the app does.
      const starts = api.calls.filter((call) =>
        call.path.startsWith("/route/start-route/"),
      );

      expect(starts.map((call) => call.auth)).toEqual(context.driverTokens);
    });

    it("never prints the administrator's password", async () => {
      const result = await fixture({ FIXTURE_BASE_URL: api.url });

      expect(result.stdout + result.stderr).not.toContain(PASSWORD);
    });

    it("runs twice without doubling anything, with new tokens", async () => {
      const first = await fixture({ FIXTURE_BASE_URL: api.url });
      const calls = api.calls.length;
      const second = await fixture({ FIXTURE_BASE_URL: api.url });

      expect(second.status, second.stderr).toBe(0);
      expect(api.drivers).toHaveLength(2);
      expect(api.users).toHaveLength(2);
      expect(api.vehicles).toHaveLength(2);
      expect(api.deliveries.size).toBe(4);
      expect(api.routes.size).toBe(2);
      expect(api.shippers).toHaveLength(1);
      expect(api.fuels).toHaveLength(1);

      // The routes already on the street are kept: no new route, no start.
      const again = api.calls
        .slice(calls)
        .map((call) => `${call.method} ${call.path}`);

      expect(again.some((call) => call.includes("create-route"))).toBe(false);
      expect(again.some((call) => call.includes("start-route"))).toBe(false);
      expect(JSON.parse(second.stdout).driverTokens).not.toEqual(
        JSON.parse(first.stdout).driverTokens,
      );
    });

    it("sends a deterministic Idempotency-Key with each delivery and route", async () => {
      await fixture({ FIXTURE_BASE_URL: api.url });

      const keys = api.calls
        .filter((call) => /create-(delivery|route)/.test(call.path))
        .map((call) => call.key);

      expect(keys).toHaveLength(6);
      expect(new Set(keys).size).toBe(6);
      for (const key of keys) {
        expect(key).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
      }
    });

    it("waits for Retry-After when the enrollment limit answers 429", async () => {
      api.enrollThrottles = 1;

      const result = await fixture({ FIXTURE_BASE_URL: api.url });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("429, de novo em 1 s");
      expect(JSON.parse(result.stdout).driverTokens).toHaveLength(2);
    });
  });
});
