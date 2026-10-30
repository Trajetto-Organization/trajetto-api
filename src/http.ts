import "reflect-metadata";
import "./shared";
// Installs zod's pt-BR default sentences before any schema is parsed.
import { validationErrorMessage } from "./shared/validation/zod-pt-br";

import fastify, { type FastifyBaseLogger, type FastifyReply } from "fastify";

import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCompress from "@fastify/compress";

import fastifyStatic from "@fastify/static";

import path from "node:path";
import Redis from "ioredis";

import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";
import { redisClientOptions } from "@/config/redis-client-options";

import { ZodError } from "zod";
import { env } from "./env";

import helmet from "@fastify/helmet";
import { fastifyCors } from "@fastify/cors";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import {
  DOCS_PASSWORD_MIN_LENGTH,
  basicAuthMatches,
  docsAccessFor,
} from "@/shared/integration/docs-access";
import {
  PUBLIC_DOCS_CSP_DIRECTIVES,
  buildPublicApiDocument,
  renderApiRobotsTxt,
  renderApiSitemapXml,
  renderPublicDocsPage,
  type OpenApiDocument,
} from "@/shared/integration/public-docs";

import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";

import { routes } from "./routes/routes";
import { openapiTransform } from "./routes/documentation/openapi-transform";
import {
  API_INFO_DESCRIPTION,
  API_TAG_GROUPS,
  API_TAGS,
  apiVersion,
} from "./routes/documentation/api-tags";
import { AppError } from "./shared/errors/AppError";
import { ServiceBusyError } from "./shared/errors/service-busy-error";
import {
  completeErrorBody,
  errorAwareSerializerCompiler,
} from "./shared/errors/error-body";
import {
  DATABASE_RETRY_AFTER_SECONDS,
  isDatabaseUnavailable,
} from "./shared/errors/database-unavailable";

import {
  endRequestContext,
  enterRequestContext,
} from "@/shared/http/request-context";
import { tolerateEmptyJsonBody } from "@/shared/http/json-body-parser";
import { rejectUnstorableText } from "@/shared/http/unstorable-text";
import { buildPublicBaseUrl } from "@/shared/utils/public-base-url";
import { clientRateLimitKey, rateLimitExceeded } from "@/config/rate-limit";
import {
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_REQUEST_TIMEOUT_MS,
} from "@/config/http-server";
import {
  configureIntegrationRateGuard,
  createIntegrationRateGuard,
} from "@/shared/integration/integration-rate-guard";
import {
  configureMailCooldown,
  createRedisMailCooldown,
} from "@/shared/security/mail-cooldown";

import { enforceRequestedTenant } from "./modules/middlewares/tenant-authorization";
import { UPLOAD_TYPES, uploadConfig } from "./config/upload";

import { isOriginAllowed } from "./config/cors-origin";
import { requestLogSerializer } from "./shared/logging/request-log-serializer";
import { urlForLog } from "./shared/logging/redact-url";
import { logger } from "./shared/logging/logger";
import { generateRequestId } from "./shared/logging/request-id";
import {
  clientUpgradeGate,
  clientVersionForLog,
} from "./shared/http/client-version";

const app = fastify({
  // The process's one logger (LOG_LEVEL, same format as the workers'). The
  // request lines carry the client's address as the rate limiter resolves
  // it, not the proxy's (OBS-13), and the route pattern instead of the raw
  // URL (OBS-05).
  loggerInstance: logger.child(
    {},
    { serializers: { req: requestLogSerializer } },
  ) as FastifyBaseLogger,
  // A uuid v7 instead of the per-process `req-N`, echoed as x-request-id
  // below and carried into the outbox as the correlation id (OBS-06).
  genReqId: generateRequestId,
  // Fastify's 0 left the body phase with no time limit (config/http-server.ts).
  requestTimeout: HTTP_REQUEST_TIMEOUT_MS,
  // Above Traefik's 90 s idle, so the proxy closes first (config/http-server.ts).
  keepAliveTimeout: HTTP_KEEP_ALIVE_TIMEOUT_MS,
}).withTypeProvider<ZodTypeProvider>();

const serverInstance = app.server;
app.register(helmet, {
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

app.setValidatorCompiler(validatorCompiler);
// A 4xx body is sent as built and always carries a code (error-body.ts).
app.setSerializerCompiler(errorAwareSerializerCompiler(serializerCompiler));
app.addHook("preSerialization", completeErrorBody);

// Enable gzip/deflate/brotli compression for all responses
app.register(fastifyCompress, {
  global: true,
  threshold: 1024, // Only compress responses > 1KB
  encodings: ["gzip", "deflate", "br"], // Support gzip, deflate, and brotli
  zlibOptions: {
    level: 6, // Compression level (1-9, 6 is default and balanced)
  },
  brotliOptions: {
    params: {
      [require("zlib").constants.BROTLI_PARAM_QUALITY]: 4, // Brotli quality (0-11, 4 is fast)
    },
  },
});

app.register(fastifyCors, {
  // The rule lives in config/cors-origin.ts, tested on its own. Refusing by
  // answering without the allow header (rather than throwing) is what a
  // rejection looks like to a browser, and it keeps the log quiet.
  origin: (origin, callback) =>
    callback(
      null,
      isOriginAllowed(origin, {
        allowedOrigin: env.HTTP_REQUEST,
        isProduction: env.NODE_ENV === "production",
      }),
    ),
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
});

// Local files are a development convenience only. Sensitive production
// images live in a private R2 bucket and are exposed through signed URLs.
if (env.NODE_ENV !== "production") {
  app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "tmp"),
    prefix: "/tmp/",
    decorateReply: false,
    setHeaders: (res) => {
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Access-Control-Allow-Origin", "*");
    },
  });
}

app.register(fastifySwagger, {
  openapi: {
    info: {
      title: "Trajetto — API",
      description: API_INFO_DESCRIPTION,
      version: apiVersion(),
    },
    tags: API_TAGS,
    // A vendor extension the plugin copies to the root; its typings only
    // know the standard keys.
    ...({ "x-tagGroups": API_TAG_GROUPS } as object),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },

        /**
         * The public integration API. A different scheme from `bearerAuth`
         * and deliberately so: a JWT is a person's session and an API key is
         * a machine with scopes, and a document that called them the same
         * thing would have integrators sending us the wrong credential.
         *
         * Referencing a scheme that is not declared here does not fail a
         * typecheck — it fails when somebody opens /docs, which is why the
         * contract test builds the document.
         */
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "A chave inteira, como foi entregue no cadastro: `tjk_live_<prefixo>.<segredo>`.",
        },
      },
    },
  },
  // jsonSchemaTransform, plus the refusals every route's hooks can produce
  // (401, 403, 429, 503), the NDJSON and file responses, and the bodies some
  // controllers parse by hand. See routes/documentation/openapi-transform.
  transform: openapiTransform,
});

/**
 * The internal reference, and who may read it.
 *
 * Open outside production. In production it answers 404 unless DOCS_USER and
 * DOCS_PASSWORD are both set, and then only behind HTTP Basic: /docs describes
 * every endpoint of the product, including the ones only a master can call,
 * and publishing that is publishing the map.
 *
 * 404 and not 403, for the same reason a cross-tenant read is a 404: "there is
 * nothing here" ends the conversation, while "you may not" confirms there is
 * something worth coming back for.
 */
const docsAccess = docsAccessFor(env.NODE_ENV, {
  user: env.DOCS_USER,
  password: env.DOCS_PASSWORD,
});

if (docsAccess.kind === "disabled" && docsAccess.reason === "weak-password") {
  app.log.warn(
    `[docs] /docs continua fechado: DOCS_PASSWORD precisa de ao menos ${DOCS_PASSWORD_MIN_LENGTH} caracteres.`,
  );
}

// Dedicated Redis client for rate limiting (separate from the main one).
// Sharing the counter across replicas keeps the global limit correct when
// scaling horizontally (in-memory would multiply the effective limit by N).
// Its options (config/redis-client-options.ts) make a counter fail fast when
// Redis is down AND when it is hung, and `skipOnError: true` below lets the
// request pass instead of returning 500 — the limiter fails open, never the
// request.
const rateLimitRedis = new Redis(
  env.REDIS_URL,
  redisClientOptions("rate-limit"),
);

attachRedisConnectionLog(rateLimitRedis, "rate-limit");

// The public API's failed-key budget per address, on the same counters
// connection (shared/integration/integration-rate-guard.ts).
configureIntegrationRateGuard(createIntegrationRateGuard(rateLimitRedis));

// The per-recipient cooldown of the anonymous e-mails ("esqueci minha
// senha"), on the same fail-fast connection (shared/security/mail-cooldown.ts).
configureMailCooldown(createRedisMailCooldown(rateLimitRedis));

/**
 * The limiter goes FIRST in each route's onRequest, not last.
 *
 * @fastify/rate-limit appends its hook after the route's own onRequest — where
 * `ensureAuthenticated` lives — so every request it refused had already paid
 * the session lookup: one valid token in a loop drained the database pool for
 * every tenant while being told 429. The key now comes from the token's
 * signature (see `clientRateLimitKey`), which is all the limiter needs.
 *
 * Two hooks around the plugin, because its handler is anonymous: the first
 * records how many hooks a route declared, the second moves whatever the
 * plugin appended to the front. Routes with a keyGenerator of their own keep
 * the old order — the integration API keys by `request.apiKey`, which only the
 * route's own onRequest resolves.
 */
const declaredOnRequestHooks = new WeakMap<object, number>();

app.addHook("onRoute", (routeOptions) => {
  const hooks = routeOptions.onRequest;

  declaredOnRequestHooks.set(
    routeOptions,
    Array.isArray(hooks) ? hooks.length : hooks ? 1 : 0,
  );
});

app.register(fastifyRateLimit, {
  global: true,
  max: 300, // 300 requests per minute (5 requests/second) - Suitable for B2B
  timeWindow: "1 minute",
  redis: rateLimitRedis,
  skipOnError: true, // if Redis is down, let the request pass (don't crash the app)
  keyGenerator: clientRateLimitKey,
  errorResponseBuilder: () => rateLimitExceeded(),
  addHeaders: {
    "x-ratelimit-limit": true, // Add X-RateLimit-Limit header
    "x-ratelimit-remaining": true, // Add X-RateLimit-Remaining header
    "x-ratelimit-reset": true, // Add X-RateLimit-Reset header
    "retry-after": true, // Adds Retry-After header
  },
});

// Registered after the plugin so its onRoute hook runs after the plugin's.
// `skip-override` keeps the hook on the root instance, where the routes are.
const moveRateLimiterFirst = async (instance: typeof app) => {
  instance.addHook("onRoute", (routeOptions) => {
    const config = routeOptions.config as
      | { rateLimit?: { keyGenerator?: unknown } | false }
      | undefined;

    if (config?.rateLimit && config.rateLimit.keyGenerator) return;

    const declared = declaredOnRequestHooks.get(routeOptions);
    const hooks = routeOptions.onRequest;

    if (declared === undefined || !Array.isArray(hooks)) return;
    if (hooks.length <= declared) return;

    routeOptions.onRequest = [
      ...hooks.slice(declared),
      ...hooks.slice(0, declared),
    ];
  });
};

Object.assign(moveRateLimiterFirst, { [Symbol.for("skip-override")]: true });

app.register(moveRateLimiterFirst);

/*
  Below the limiter, and that is the whole point — see the comment on the
  register right after this one. Registered above it, the /docs routes were
  created before the limiter's onRoute hook existed and had no limit at all:
  a Basic password could be tried as fast as the network allowed, against
  the one page that maps every endpoint of the product.
*/
app.register(fastifySwaggerUi, {
  routePrefix: "/docs",
  uiHooks: {
    onRequest: (request, reply, next) => {
      if (docsAccess.kind === "open") return next();

      if (docsAccess.kind === "disabled") {
        return reply.status(404).send({ message: "Not found" });
      }

      if (basicAuthMatches(request.headers.authorization, docsAccess)) {
        return next();
      }

      return reply
        .header("WWW-Authenticate", 'Basic realm="Trajetto API"')
        .status(401)
        .send({ message: "Credenciais inválidas." });
    },
  },
});

/*
  Inside a `register`, and that is the whole point.

  Both of these routes carry `config: { rateLimit: { max: 30 } }`, and neither
  was limited by anything. `app.get()` on the root instance runs immediately;
  `app.register()` is deferred to the boot phase — so every root-level route
  is in the router BEFORE the rate-limit plugin loads, whatever order the
  source is written in, and none of them gets its `onRequest`. Moving the two
  routes below the plugin changed nothing at all, which is how this was found:
  measured, not reasoned about. They answered with no `x-ratelimit-*` headers
  and never refused a 45th request, while `/health` — which lives inside the
  `routes` plugin, itself a deferred register — carried all three headers.

  Wrapping them in a register of their own puts them in the same boot phase as
  everything else that is protected.

  They are the only unauthenticated, cacheable, CI-fetched endpoints the
  product has, which is what makes an unlimited bucket cost most here.
*/
app.register(async (instance) => {
  /**
   * The PUBLIC reference: only what a customer's API key can reach.
   *
   * Built by subtraction from the document the application actually serves, so
   * an endpoint renamed internally cannot leave the portal describing a URL
   * that no longer answers.
   */
  instance.get(
    "/integration/docs/openapi.json",
    {
      schema: { hide: true },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (_request, reply) =>
      reply
        .header("Cache-Control", "public, max-age=300")
        .status(200)
        .send(buildPublicApiDocument(app.swagger() as OpenApiDocument)),
  );

  instance.get(
    "/integration/docs",
    {
      schema: { hide: true },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },

      // helmet's default `script-src 'self'` blocked the CDN renderer and the
      // fallback alike, and the portal rendered blank. Only this route widens
      // it, and only by the pinned CDN and the fallback's hash.
      helmet: {
        contentSecurityPolicy: { directives: PUBLIC_DOCS_CSP_DIRECTIVES },
      },
    },
    async (_request, reply) =>
      reply
        .type("text/html; charset=utf-8")
        .header("Cache-Control", "public, max-age=300")
        .status(200)
        .send(renderPublicDocsPage("/integration/docs/openapi.json")),
  );

  // The host's crawl rules and sitemap: the console above is the one page
  // here meant for search, and only production's (public-docs.ts).
  instance.get(
    "/robots.txt",
    {
      schema: { hide: true },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (_request, reply) =>
      reply
        .type("text/plain; charset=utf-8")
        .header("Cache-Control", "public, max-age=3600")
        .status(200)
        .send(renderApiRobotsTxt()),
  );

  instance.get(
    "/sitemap.xml",
    {
      schema: { hide: true },
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (_request, reply) => {
      const sitemap = renderApiSitemapXml();

      if (!sitemap) return reply.callNotFound();

      return reply
        .type("application/xml; charset=utf-8")
        .header("Cache-Control", "public, max-age=3600")
        .status(200)
        .send(sitemap);
    },
  );
});

/**
 * An empty body that claims to be JSON.
 *
 * Fastify's default JSON parser refuses it — `FST_ERR_CTP_EMPTY_JSON_BODY` —
 * and that refusal is pedantic in the one case it fires most: a DELETE with
 * no body sent by a client that sets `Content-Type` on every request. Our own
 * web actions do exactly that, so revoking an API key answered an error and
 * never revoked anything. An integrator's HTTP library will do the same.
 *
 * An empty body is `undefined`, which is what a route with no body schema
 * expects and what a route WITH one will fail validation on — as it should,
 * with a 400 that names the missing fields, instead of a parser error.
 *
 * Anything that is not empty goes to the real parser, so malformed JSON is
 * still malformed and still refused.
 *
 * "The real parser" is Fastify's own default, not a bare JSON.parse: the
 * default runs secure-json-parse and refuses `__proto__` and
 * `constructor.prototype` keys (prototype poisoning) with a 400.
 */
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  tolerateEmptyJsonBody(app.getDefaultJsonParser("error", "error")),
);

// Development only: the local upload route stands in for the storage bucket
// and receives raw image bytes, which no other route does. The cap matches the
// largest single file any upload type allows, so an oversized body is refused
// before it is buffered rather than after.
if (uploadConfig.storage.type !== "r2") {
  app.addContentTypeParser(
    // Every MIME any upload type accepts — images plus the chat's voice
    // notes. Derived, not listed: a type registered in config/upload.ts
    // can no longer be forgotten here and fail only on local storage.
    [
      ...uploadConfig.allowedMimeTypes.images,
      ...uploadConfig.allowedMimeTypes.audio,
    ],
    {
      parseAs: "buffer",
      bodyLimit: Math.max(
        ...UPLOAD_TYPES.map((type) => uploadConfig.getSizeLimit(type)),
      ),
    },
    (_request, body, done) => done(null, body),
  );
}

/**
 * Opens the request's own scope, and publishes the caller's host into it.
 *
 * The scope itself is entered for EVERY request, in every environment,
 * because the repositories memoise inside it — the session lookup used to
 * happen twice per request, three queries each time, on every authenticated
 * call in the product. A scope that only existed outside production would put
 * that saving exactly where it does not matter.
 *
 * `publicBaseUrl` is the part that stays development-only. Only local-storage
 * mode consumes it, to build URLs back to this API's own files; production
 * signs R2 URLs and never looks at it — which is also why the header is not
 * trusted there: `Host` is client-controlled, and a spoofed one would
 * otherwise hand a user a link to somebody else's server. In development the
 * trade is the right way round: the alternative is every image and voice note
 * being dead on the phone, because the API answers `localhost` and on a phone
 * `localhost` is the phone.
 */
app.addHook("onRequest", async (request, reply) => {
  // The id support can be quoted, on every response — refusals included —
  // and the correlation id of whatever this request publishes (OBS-06).
  reply.header("x-request-id", request.id);

  const context =
    env.NODE_ENV === "production"
      ? { requestId: request.id }
      : { requestId: request.id, publicBaseUrl: buildPublicBaseUrl(request) };

  enterRequestContext(context);

  // `close` fires for a finished response and for an aborted one alike; past
  // it, anything still carrying this store must not read the request's rows.
  reply.raw.once("close", () => endRequestContext(context));
});

// App builds below MIN_MOBILE_CONTRACT, when set and only when they say which
// contract they speak (GAP5-2). Before authentication: a build that is turned
// away does not need its session looked up to be told so. The refusal names
// the store page (MOBILE_STORE_URL) when one is set.
app.addHook(
  "onRequest",
  clientUpgradeGate(env.MIN_MOBILE_CONTRACT, env.MOBILE_STORE_URL),
);

// Registered before the routes so it applies to every one of them. This runs
// after body parsing, which `onRequest` (where `ensureAuthenticated` lives)
// cannot do — without it a `businessId` sent in the body bypasses the check.
app.addHook("preHandler", enforceRequestedTenant);

// NUL and lone surrogates crash the query engine (500 at error level) on
// every route that stores or searches text; refused as a 400 before any
// route reads them (shared/http/unstorable-text.ts).
app.addHook("preValidation", rejectUnstorableText);
app.register(routes);

/**
 * Fastify's own 404 wrote `Route GET:<raw url> not found` to the log, query
 * string included — a mistyped reset or tracking link left its token there
 * (OBS-05). Same status and body keys; the path goes through `urlForLog`.
 */
app.setNotFoundHandler((request, reply) => {
  const message = `Route ${request.method}:${urlForLog(request)} not found`;

  request.log.info({ client: clientVersionForLog(request) }, message);

  // `code` (and the header) tell an app build whose route was renamed or
  // removed apart from a refusal on the merits: its queue keeps the item and
  // sends it again once the app is updated, instead of failing it (GAP5-2).
  return reply.header("x-error-code", "ROUTE_NOT_FOUND").status(404).send({
    message,
    error: "Not Found",
    statusCode: 404,
    code: "ROUTE_NOT_FOUND",
  });
});

/**
 * An error body leaves already serialized, so no route schema touches it.
 *
 * Each route declares a zod response schema per status, and a plain object
 * sent from here went through it like any payload: a 400 schema demanding
 * `issues` turned malformed JSON on the public quote form into a 500
 * ("Response doesn't match the schema"), and every schema listing only
 * `message` stripped `code` and `issues` in silence — the field a client
 * decides on and the list of what it got wrong. These bodies are built from
 * known fields right here, so there is nothing for a schema to guard.
 */
function sendError(
  reply: FastifyReply,
  statusCode: number,
  body: Record<string, unknown>,
) {
  // Every branch, not only the AppError one: the document promises the
  // header wherever the body has a code (validation and parser refusals
  // included), and a client may decide without parsing the JSON.
  if (typeof body.code === "string" && !reply.hasHeader("x-error-code")) {
    reply.header("x-error-code", body.code);
  }

  return reply
    .status(statusCode)
    .type("application/json; charset=utf-8")
    .send(JSON.stringify(body));
}

app.setErrorHandler((error, request, reply) => {
  // Raised by the local upload route when the body exceeds its parser limit.
  // In production the equivalent refusal comes from R2, which rejects a PUT
  // whose length does not match the signed `ContentLength`.
  const isBodyTooLarge = error.code === "FST_ERR_CTP_BODY_TOO_LARGE";

  const isValidationError =
    error instanceof ZodError || hasZodFastifySchemaValidationErrors(error);

  const isAppError = error instanceof AppError;

  /**
   * Somebody already decided this was the caller's fault. Respect it.
   *
   * Fastify attaches a 4xx `statusCode` to the errors it raises before any
   * handler runs: a body that is not the JSON it claims to be, a content type
   * nothing is registered for, a route that does not exist. Every one of them
   * used to fall through to the 500 at the bottom of this function, because
   * the branches above only recognised Zod and AppError — so a request the
   * server merely could not parse was reported as the server breaking, and
   * logged at error level among real failures.
   *
   * That was not theoretical. Every DELETE the web sent carried
   * `Content-Type: application/json` with no body, which Fastify's default
   * parser refuses: revoking an API key answered "Internal server error", the
   * panel showed a red toast, and the key stayed live. (The parser above now
   * accepts an empty body as well, so that particular request no longer
   * arrives here at all — this is the floor under everything like it.)
   *
   * Checked last of the three so the branches with a richer shape win.
   */
  const isClientError =
    !isAppError &&
    !isValidationError &&
    !isBodyTooLarge &&
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode < 500;

  /**
   * The database, not the request, failed: unreachable, closed the
   * connection, or no pool slot within pool_timeout (GAP6-3).
   *
   * That used to fall through to the 500 below, so login, refresh, /track
   * and the public integration API answered "Internal server error" to an
   * outage — which a generic HTTP client does not retry — while the
   * authenticated routes answered 503 for the same outage. A 503 with
   * Retry-After is the honest answer, and its own log line lets an alert
   * tell "database down" from "code broken".
   */
  const isDatabaseDown =
    !isAppError &&
    !isValidationError &&
    !isBodyTooLarge &&
    isDatabaseUnavailable(error);

  const statusCode = isBodyTooLarge
    ? 413
    : isValidationError
      ? 400
      : isAppError
        ? error.statusCode
        : isDatabaseDown
          ? 503
          : isClientError
            ? (error.statusCode as number)
            : 500;

  // This custom handler REPLACES the one Fastify installs by default, and the
  // default is what logs errors out of the box. Without an explicit log here
  // an unhandled exception is completely invisible: the client gets a generic
  // "Internal server error" and the server keeps no trace of the stack, in
  // any environment. So the log happens once, before the response, for every
  // branch below and with the status code already resolved.
  //
  // Level split on purpose: a 4xx is the client being told it is wrong, which
  // is expected traffic and would otherwise bury real failures under
  // validation noise. Anything 5xx is ours and is logged as an error. `err`
  // is pino's reserved key, so the stack is serialized in full.
  const logContext = {
    err: error,
    method: request.method,
    // The route pattern, never the raw URL: it carries one-time tokens.
    url: urlForLog(request),
    requestId: request.id,
    statusCode,
    // Which app build was refused, when it says: the only way to tell a
    // contract an old build still depends on from one nobody calls (GAP5-2).
    client: clientVersionForLog(request),
  };

  // The same outage on an authenticated route: ensure-authenticated answers
  // AUTH_SESSION_UNAVAILABLE only for an error isDatabaseUnavailable
  // recognised, and most of the traffic is authenticated.
  const isSessionCheckOutage =
    isAppError && error.code === "AUTH_SESSION_UNAVAILABLE";

  if (isDatabaseDown || isSessionCheckOutage) {
    // Still error level — it is ours — but a message of its own, so an alert
    // on bugs does not page for an outage the readiness probe already sees.
    request.log.error(
      logContext,
      "Database unavailable while processing request",
    );
  } else if (statusCode >= 500 && !(error instanceof ServiceBusyError)) {
    // A load-shedding 503 is the server working as designed; at error level a
    // credential-stuffing run would bury the real failures under stack traces.
    request.log.error(logContext, "Unhandled error while processing request");
  } else {
    request.log.warn(logContext, "Request rejected");
  }

  if (isBodyTooLarge) {
    return sendError(reply, 413, {
      code: "UPLOAD_FILE_TOO_LARGE",
      message: "O arquivo excede o limite de tamanho permitido.",
    });
  }

  if (error instanceof ZodError || hasZodFastifySchemaValidationErrors(error)) {
    const issues =
      error instanceof ZodError
        ? error.errors.map(({ message }) => message)
        : error.validation.map(({ message }) => message);

    return sendError(reply, 400, {
      code: "VALIDATION_ERROR",
      // pt-BR at the source: clients that show `message` used to print the
      // English "Validation Error".
      message: validationErrorMessage(issues),
      issues,
    });
  }

  if (error instanceof AppError) {
    // Refused for load, not for the request: say when to come back.
    if (error instanceof ServiceBusyError) {
      reply.header("retry-after", String(error.retryAfterSeconds));
    } else if (error.statusCode === 503) {
      // AUTH_SESSION_UNAVAILABLE, STORAGE_UNAVAILABLE: a dependency is down,
      // so the same hint as a database outage below.
      reply.header("retry-after", String(DATABASE_RETRY_AFTER_SECONDS));
    }

    // A curated 500 (an e-mail that did not go, a render that failed) is
    // still our failure: the same shape as the unhandled one below, with
    // the request id to find it. Its default code was BAD_REQUEST — a 500
    // that blamed the caller.
    if (error.statusCode >= 500 && error.statusCode !== 503) {
      const code = error.code === "BAD_REQUEST" ? "INTERNAL_ERROR" : error.code;

      return sendError(reply.header("x-error-code", code), error.statusCode, {
        code,
        status: "error",
        message: error.message,
        requestId: request.id,
      });
    }

    return sendError(
      reply.header("x-error-code", error.code),
      error.statusCode,
      {
        code: error.code,
        message: error.message,
      },
    );
  }

  if (isDatabaseDown) {
    // A fixed sentence: the Prisma message names the database host and port,
    // so the detail stays in the log line above. A 503 does not promise "not
    // executed" — P1017 can land after a COMMIT — so a retried write needs an
    // Idempotency-Key.
    return sendError(
      reply
        .header("retry-after", String(DATABASE_RETRY_AFTER_SECONDS))
        .header("x-error-code", "SERVICE_UNAVAILABLE"),
      503,
      {
        code: "SERVICE_UNAVAILABLE",
        message:
          "Serviço temporariamente indisponível. Tente novamente em instantes.",
        requestId: request.id,
      },
    );
  }

  /**
   * A build of the app from before photo uploads moved to presigned PUTs.
   *
   * That build posts fueling and checklist photos as multipart, which this API
   * no longer parses, and it shows the response `message` in a toast — so the
   * driver read "Unsupported Media Type: multipart/form-data; boundary=…" on
   * every retry. The sentence below is one they can act on, and the warn line
   * (with the user agent) is how anyone can tell when the last such build has
   * gone quiet.
   */
  if (
    error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" &&
    String(request.headers["content-type"] ?? "").startsWith("multipart/")
  ) {
    request.log.warn(
      { url: urlForLog(request), userAgent: request.headers["user-agent"] },
      "Deprecated contract: multipart upload from an outdated client",
    );

    return sendError(reply, 415, {
      code: "CLIENT_OUTDATED",
      message:
        "Esta versão do aplicativo não consegue mais enviar fotos. " +
        "Atualize o aplicativo Trajetto e tente de novo — o seu rascunho continua salvo.",
    });
  }

  if (isClientError) {
    return sendError(reply, statusCode, {
      code: "MALFORMED_REQUEST",

      // Fastify's own sentence, which names the actual problem — "Body cannot
      // be empty when content-type is set to 'application/json'", or the
      // position where the JSON broke. A generic "requisição inválida" would
      // leave whoever is integrating with nothing to act on.
      message: error.message,
    });
  }

  // The stack stays in the log and never in the body: an unhandled exception
  // must not leak internals to the client, in any environment.
  return sendError(reply, 500, {
    code: "INTERNAL_ERROR",
    status: "error",
    message: "Internal server error",
    // What makes "it gave an error" findable in the logs (OBS-06).
    requestId: request.id,
  });
});

export { app, serverInstance };
