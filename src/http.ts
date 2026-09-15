import "reflect-metadata";
import "./shared";

import fastify from "fastify";

import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCompress from "@fastify/compress";

import fastifyStatic from "@fastify/static";

import path from "node:path";
import Redis from "ioredis";

import { attachRedisConnectionLog } from "@/shared/services/redis-connection-log";

import { ZodError } from "zod";
import { env } from "./env";

import helmet from "@fastify/helmet";
import { fastifyCors } from "@fastify/cors";

import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";

import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";

import { routes } from "./routes/routes";
import { AppError } from "./shared/errors/AppError";

import { enterRequestContext } from "@/shared/http/request-context";
import { buildPublicBaseUrl } from "@/shared/utils/public-base-url";
import { clientRateLimitKey, rateLimitExceeded } from "@/config/rate-limit";

import { enforceRequestedTenant } from "./modules/middlewares/tenant-authorization";
import { UPLOAD_TYPES, uploadConfig } from "./config/upload";

import { isOriginAllowed } from "./config/cors-origin";

const app = fastify({
  logger: true,
}).withTypeProvider<ZodTypeProvider>();

const serverInstance = app.server;
app.register(helmet, {
  crossOriginResourcePolicy: { policy: "cross-origin" },
});

app.setValidatorCompiler(validatorCompiler);
app.setSerializerCompiler(serializerCompiler);

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
      title: "Trajetto API",
      description: "Trajetto API documentation",
      version: "1.0.0",
    },
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
  transform: jsonSchemaTransform,
});

app.register(fastifySwaggerUi, {
  routePrefix: "/docs",
});

// Dedicated Redis client for rate limiting (separate from the main one).
// Sharing the counter across replicas keeps the global limit correct when
// scaling horizontally (in-memory would multiply the effective limit by N).
// `enableOfflineQueue: false` makes calls fail fast when Redis is down, and
// `skipOnError: true` below lets the request pass instead of returning 500.
const rateLimitRedis = new Redis(env.REDIS_URL, {
  connectionName: "trajetto-rate-limit",
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: false,
});

attachRedisConnectionLog(rateLimitRedis, "rate-limit");

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
 * Publishes the caller's own host to the whole request.
 *
 * Only local-storage mode consumes it, to build URLs back to this API's own
 * files. Production signs R2 URLs and never looks at it — which is also why
 * the header is only trusted outside production: `Host` is client-controlled,
 * and a spoofed one would otherwise hand a user a link to somebody else's
 * server. In development the trade is the right way round: the alternative is
 * every image and voice note being dead on the phone, because the API answers
 * `localhost` and on a phone `localhost` is the phone.
 */
app.addHook("onRequest", async (request) => {
  if (env.NODE_ENV === "production") return;

  enterRequestContext({ publicBaseUrl: buildPublicBaseUrl(request) });
});

// Registered before the routes so it applies to every one of them. This runs
// after body parsing, which `onRequest` (where `ensureAuthenticated` lives)
// cannot do — without it a `businessId` sent in the body bypasses the check.
app.addHook("preHandler", enforceRequestedTenant);
app.register(routes);

app.setErrorHandler((error, request, reply) => {
  // Raised by the local upload route when the body exceeds its parser limit.
  // In production the equivalent refusal comes from R2, which rejects a PUT
  // whose length does not match the signed `ContentLength`.
  const isBodyTooLarge = error.code === "FST_ERR_CTP_BODY_TOO_LARGE";

  const isValidationError =
    error instanceof ZodError || hasZodFastifySchemaValidationErrors(error);

  const isAppError = error instanceof AppError;

  const statusCode = isBodyTooLarge
    ? 413
    : isValidationError
      ? 400
      : isAppError
        ? error.statusCode
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
    url: request.url,
    requestId: request.id,
    statusCode,
  };

  if (statusCode >= 500) {
    request.log.error(logContext, "Unhandled error while processing request");
  } else {
    request.log.warn(logContext, "Request rejected");
  }

  if (isBodyTooLarge) {
    return reply.status(413).send({
      code: "UPLOAD_FILE_TOO_LARGE",
      message: "O arquivo excede o limite de tamanho permitido.",
    });
  }

  if (error instanceof ZodError || hasZodFastifySchemaValidationErrors(error)) {
    const issues =
      error instanceof ZodError
        ? error.errors.map(({ message }) => message)
        : error.validation.map(({ message }) => message);

    return reply.status(400).send({
      code: "VALIDATION_ERROR",
      message: "Validation Error",
      issues,
    });
  }

  if (error instanceof AppError) {
    return reply
      .header("x-error-code", error.code)
      .status(error.statusCode)
      .send({
        code: error.code,
        message: error.message,
      });
  }

  // The stack stays in the log and never in the body: an unhandled exception
  // must not leak internals to the client, in any environment.
  return reply.status(500).send({
    code: "INTERNAL_ERROR",
    status: "error",
    message: "Internal server error",
  });
});

export { app, serverInstance };
