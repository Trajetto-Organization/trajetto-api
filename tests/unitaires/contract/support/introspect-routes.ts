import type { RouteOptions } from "fastify";

/**
 * The application's routes as Fastify registered them, next to the document
 * Swagger builds from them.
 *
 * The document alone cannot say whether it is honest: `security` is whatever
 * somebody typed, and "responses" always has something in it because the
 * generator fills the gap with a placeholder. The hooks are what actually run,
 * so every contract check that means anything compares the two.
 *
 * No database: `app.ready()` only builds the router and the document, and
 * nothing here sends a request. The limiter's Redis client connects when
 * `@/http` is imported, but no command is ever sent through it.
 */
export interface OpenApiOperation {
  summary?: string;
  description?: string;
  tags?: string[];
  security?: Array<Record<string, unknown>>;
  parameters?: Array<{
    in: string;
    name: string;
    description?: string;
    required?: boolean;
    schema?: Record<string, unknown>;
  }>;
  requestBody?: { content?: Record<string, { schema?: unknown }> };
  responses: Record<
    string,
    {
      description?: string;
      headers?: Record<string, unknown>;
      content?: Record<string, { schema?: Record<string, unknown> }>;
    }
  >;
  [extension: `x-${string}`]: unknown;
}

export interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: Record<string, unknown>;
}

export interface IntrospectedRoute {
  /** "POST /fuel/create-fuel/{businessId}", the id the document uses. */
  id: string;
  method: string;
  url: string;
  openapiPath: string;
  hidden: boolean;
  onRequest: unknown[];
  preHandler: unknown[];
  handler: unknown;
  config: Record<string, unknown>;
  schema: Record<string, unknown> | undefined;
  /** The operation the document publishes for this route, when it does. */
  operation: OpenApiOperation | undefined;
}

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];

  return Array.isArray(value) ? value : [value];
}

/** `/a/:id/b/:other` → `/a/{id}/b/{other}`, the way @fastify/swagger does it. */
function openapiPathOf(url: string): string {
  const path = url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

export async function introspectRoutes() {
  const { app } = await import("@/http");

  const registered: RouteOptions[] = [];

  // Before ready(): every route plugin is deferred to the boot phase, so a
  // hook added now still sees all of them. The objects are kept by reference
  // and read after ready(), once the limiter has rearranged their hooks.
  app.addHook("onRoute", (route) => {
    registered.push(route as RouteOptions);
  });

  await app.ready();

  const document = app.swagger() as unknown as OpenApiDocument;

  const routes: IntrospectedRoute[] = registered.flatMap((route) =>
    toArray(route.method)
      .map((method) => String(method).toUpperCase())
      .filter((method) => VERBS.includes(method))
      .map((method) => {
        const openapiPath = openapiPathOf(route.url);
        const schema = route.schema as Record<string, unknown> | undefined;

        return {
          id: `${method} ${openapiPath}`,
          method,
          url: route.url,
          openapiPath,
          hidden: Boolean(schema?.hide),
          onRequest: toArray(route.onRequest),
          preHandler: toArray(route.preHandler),
          handler: route.handler,
          config: (route.config ?? {}) as Record<string, unknown>,
          schema,
          operation: document.paths[openapiPath]?.[method.toLowerCase()],
        };
      }),
  );

  return {
    app,
    document,
    routes,
    close: () => app.close(),
  };
}
