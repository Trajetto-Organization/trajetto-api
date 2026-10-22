import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodObject, ZodUnion, type ZodTypeAny } from "zod";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import {
  introspectRoutes,
  type IntrospectedRoute,
} from "./support/introspect-routes";

/**
 * The published refusals of the I–Z modules, against the bodies the handler
 * really sends (decision 11.3).
 *
 * ResourceNotFoundError (the session user is gone) became 404 USER_NOT_FOUND
 * and BusinessNotFoundError is 404 BUSINESS_NOT_FOUND; a document that still
 * files their sentences under 400 sends a client to handle a status the API
 * never answers. And every 4xx body carries `code`, so a route schema that
 * describes a code-less `{ message }` is describing a body that cannot exist.
 */
const OWNED_PREFIXES = [
  "/import",
  "/integrations",
  "/integration/v1",
  "/kanban",
  "/notification",
  "/occurrence-type",
  "/part",
  "/permission",
  "/profile-access",
  "/quote",
  "/route",
  "/service-order",
  "/service-order-part",
  "/shipper",
  "/status-change-reason",
  "/supplier",
  "/uploads",
  "/user",
  "/vehicle",
  "/vehicle-checklist",
  "/vehicle-type",
  "/whatsapp",
  "/driver-pause",
];

/** Sentences of errors whose status is 404 wherever they are thrown. */
const NOT_FOUND_SENTENCES = [
  "Recurso não encontrado!",
  "Empresa não encontrada! Por favor, tente novamente.",
];

/**
 * Routes whose use case looks the session user up and throws
 * ResourceNotFoundError when it is gone: each must publish a 404 that names
 * USER_NOT_FOUND.
 */
const SESSION_USER_ROUTES = [
  "GET /notification/stream",
  "GET /notification/unread-count",
  "PATCH /notification/{notificationId}/read",
  "DELETE /notification/{notificationId}",
  "PATCH /notification/read-all",
  "POST /notification/push-token",
  "DELETE /notification/push-token",
  "GET /notification/preferences",
  "PUT /notification/preferences",
  "POST /kanban/column/create/{businessId}",
  "PATCH /kanban/column/update/{columnId}/business/{businessId}",
  "DELETE /kanban/column/delete/{columnId}/business/{businessId}",
  "POST /kanban/columns/reorder",
  "GET /kanban/list/{businessId}",
  "POST /kanban/card/create",
  "PATCH /kanban/card/update/{cardId}",
  "DELETE /kanban/card/delete/{cardId}",
  "POST /kanban/cards/reorder",
  "GET /quote/list-quote",
  "PATCH /quote/update-quote-status/{quoteId}",
  "DELETE /quote/delete-quote/{quoteId}",
  "GET /user/me",
  "PATCH /user/avatar",
  "DELETE /user/avatar",
  "GET /whatsapp/settings",
  "PATCH /whatsapp/settings",
  "PATCH /user/password",
  "PATCH /user/username",
  "PATCH /user/twofactor",
  "GET /user/search-user-business",
  "GET /user/list-master-users",
  "GET /permission/list-permission",
  "GET /permission/list-by-profile/{profileAccessId}",
  "POST /integrations/api-key/{businessId}",
  "GET /integrations/api-keys",
  "DELETE /integrations/api-key/{id}/business/{businessId}",
  "POST /integrations/webhook-endpoint/{businessId}",
  "PUT /integrations/webhook-endpoint/{id}/business/{businessId}",
  "POST /integrations/webhook-endpoint/{id}/business/{businessId}/reactivate",
  "POST /integrations/webhook-endpoint/{id}/business/{businessId}/rotate-secret",
  "GET /integrations/webhook-endpoints",
  "DELETE /integrations/webhook-endpoint/{id}/business/{businessId}",
  "GET /integrations/webhook-deliveries",
  "GET /integrations/api-usage",
  "POST /integrations/webhook-delivery/{id}/business/{businessId}/resend",
];

const SRC = resolve(__dirname, "../../../src");
const ROUTES_DIR = join(SRC, "routes");

/** `@/modules/x/usecases/y/z-controller` → the folder of that use case. */
function useCaseFolderOf(importPath: string): string {
  return dirname(join(SRC, importPath.replace(/^@\//, "")));
}

/** Both throws answer 404 USER_NOT_FOUND (the Entregas modules use the second). */
const SESSION_USER_GONE =
  /new ResourceNotFoundError\(|throw callerNotFound\(\)/;

/** True when the use case (or a helper it imports) says the session user is gone. */
function throwsSessionUserGone(folder: string): boolean {
  if (!existsSync(folder)) return false;

  const files = readdirSync(folder).filter((file) => file.endsWith(".ts"));
  const read = (file: string) => readFileSync(join(folder, file), "utf-8");

  // A controller that catches it answers another status on purpose (the
  // pre-login 2FA flow says 400 AUTH_2FA_NOT_FOUND to avoid enumeration).
  const remapped = files
    .filter((file) => file.endsWith("-controller.ts"))
    .some((file) => /instanceof ResourceNotFoundError/.test(read(file)));

  if (remapped) return false;

  const sources = files
    .filter((file) => !file.endsWith("-controller.ts"))
    .map((file) => [join(folder, file), read(file)] as const);

  // One level of imports too: the tower's use cases share operations-viewer,
  // which is where the session user is looked up.
  const imported = sources.flatMap(([path, text]) =>
    [...text.matchAll(/from "((?:\.{1,2}\/|@\/modules\/)[^"]+)"/g)].map(
      (match) => {
        const target = match[1].startsWith("@/")
          ? join(SRC, match[1].slice(2))
          : join(dirname(path), match[1]);

        return `${target}.ts`;
      },
    ),
  );

  const texts = [
    ...sources.map(([, text]) => text),
    ...imported
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf-8")),
  ];

  return texts.some((text) => SESSION_USER_GONE.test(text));
}

/**
 * Routes whose use case throws ResourceNotFoundError, read from the source
 * instead of typed by hand: the hand-picked list let supplier, vehicle,
 * vehicle-type and route slip through. The route file names its controller
 * per registration, the controller import names the use case folder, and
 * routes.ts gives the plugin prefix.
 */
function sessionUserRoutesFromSource(): string[] {
  const registry = readFileSync(join(ROUTES_DIR, "routes.ts"), "utf-8");
  const fileOfPlugin = new Map<string, string>();

  for (const match of registry.matchAll(
    /import \{ (\w+) \} from "\.\/([\w.-]+)"/g,
  )) {
    fileOfPlugin.set(match[1], match[2]);
  }

  const ids: string[] = [];

  for (const match of registry.matchAll(
    /app\.register\((\w+), \{ prefix: "([^"]+)" \}\)/g,
  )) {
    const [, plugin, prefix] = match;
    const file = fileOfPlugin.get(plugin);

    if (!file || !OWNED_PREFIXES.includes(prefix)) continue;

    const source = readFileSync(join(ROUTES_DIR, `${file}.ts`), "utf-8");
    const classImport = new Map<string, string>();

    for (const imported of source.matchAll(
      /import \{\s*(\w+Controller)\s*\} from "([^"]+)"/g,
    )) {
      classImport.set(imported[1], imported[2]);
    }

    const instanceClass = new Map<string, string>();

    for (const created of source.matchAll(
      /const (\w+) = new (\w+Controller)\(/g,
    )) {
      instanceClass.set(created[1], created[2]);
    }

    const registrations = source.split(
      /app\.(?=(?:get|post|put|patch|delete)\()/,
    );

    for (const chunk of registrations.slice(1)) {
      const head = chunk.match(/^(get|post|put|patch|delete)\(\s*"([^"]*)"/);
      const handler = chunk.match(/(\w+)\.handle\b/);

      if (!head || !handler) continue;

      const importPath = classImport.get(instanceClass.get(handler[1]) ?? "");

      if (!importPath || !throwsSessionUserGone(useCaseFolderOf(importPath)))
        continue;

      const path = `${prefix}${head[2]}`
        .replace(/:([A-Za-z0-9_]+)/g, "{$1}")
        .replace(/\/+$/, "");

      ids.push(`${head[1].toUpperCase()} ${path}`);
    }
  }

  return ids;
}

let owned: IntrospectedRoute[] = [];
let close: () => Promise<void>;

function isOwned(route: IntrospectedRoute): boolean {
  return OWNED_PREFIXES.some(
    (prefix) =>
      route.openapiPath === prefix ||
      route.openapiPath.startsWith(`${prefix}/`),
  );
}

type JsonSchema = Record<string, unknown>;

function responseSchema(
  route: IntrospectedRoute,
  status: string,
): JsonSchema | undefined {
  return route.operation?.responses?.[status]?.content?.["application/json"]
    ?.schema as JsonSchema | undefined;
}

/** Every message default a published schema carries, unions included. */
function messageDefaults(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];

  const options = [
    ...((schema.anyOf as JsonSchema[] | undefined) ?? []),
    ...((schema.oneOf as JsonSchema[] | undefined) ?? []),
    ...((schema.allOf as JsonSchema[] | undefined) ?? []),
  ];
  const own = (schema.properties as Record<string, JsonSchema> | undefined)
    ?.message;
  const values = [own?.default, own?.example].filter(
    (value): value is string => typeof value === "string",
  );

  return [...values, ...options.flatMap(messageDefaults)];
}

/** What the document says about a status: its description and its code's. */
function describedCodes(route: IntrospectedRoute, status: string): string {
  const response = route.operation?.responses?.[status];
  const schema = responseSchema(route, status);
  const code = (schema?.properties as Record<string, JsonSchema> | undefined)
    ?.code;

  return [response?.description, code?.description]
    .filter((text): text is string => typeof text === "string")
    .join(" ");
}

/** The objects a declared zod response is made of (a union's options). */
function objectsOf(schema: ZodTypeAny): ZodTypeAny[] {
  if (schema instanceof ZodUnion) {
    return (schema.options as ZodTypeAny[]).flatMap(objectsOf);
  }

  return [schema];
}

beforeAll(async () => {
  const introspected = await introspectRoutes();

  owned = introspected.routes.filter(
    (route) => !route.hidden && isOwned(route),
  );
  close = introspected.close;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe("refusals published by the I–Z modules", () => {
  it("files the not-found sentences under 404 only", () => {
    const misfiled = owned.flatMap((route) =>
      Object.keys(route.operation?.responses ?? {})
        .filter((status) => status !== "404")
        .flatMap((status) =>
          messageDefaults(responseSchema(route, status))
            .filter((message) => NOT_FOUND_SENTENCES.includes(message))
            .map((message) => `${route.id} ${status}: ${message}`),
        ),
    );

    expect(misfiled).toEqual([]);
  });

  it("never names USER_NOT_FOUND under a status other than 404", () => {
    // RESPONSIBLE_USER_NOT_FOUND and friends are body links (400); only the
    // bare code is the gone session user.
    const bare = /(?<![A-Z_])USER_NOT_FOUND/;

    const misfiled = owned.flatMap((route) =>
      Object.keys(route.operation?.responses ?? {})
        .filter(
          (status) =>
            status !== "404" && bare.test(describedCodes(route, status)),
        )
        .map((status) => `${route.id} ${status}`),
    );

    expect(misfiled).toEqual([]);
  });

  it("publishes 404 USER_NOT_FOUND on every route that looks the session user up", () => {
    const byId = new Map(owned.map((route) => [route.id, route]));
    const derived = sessionUserRoutesFromSource();

    // The derivation must keep finding the routes, or the check is vacuous.
    expect(derived.length).toBeGreaterThan(60);

    const expected = [...new Set([...SESSION_USER_ROUTES, ...derived])];
    const missing = expected.filter((id) => {
      const route = byId.get(id);

      if (!route) return true;

      return !describedCodes(route, "404").includes("USER_NOT_FOUND");
    });

    expect(missing).toEqual([]);
  });

  it("declares every 4xx body with a code, as the handler sends it", () => {
    const codeless = owned.flatMap((route) => {
      const responses = (route.schema?.response ?? {}) as Record<
        string,
        unknown
      >;

      return Object.entries(responses)
        .filter(([status]) => Number(status) >= 400 && Number(status) < 500)
        .filter(([, schema]) =>
          objectsOf(schema as ZodTypeAny).some(
            (option) =>
              option instanceof ZodObject && !("code" in option.shape),
          ),
        )
        .map(([status]) => `${route.id} ${status}`);
    });

    expect(codeless).toEqual([]);
  });
});
