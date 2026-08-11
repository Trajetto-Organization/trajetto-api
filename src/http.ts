import "reflect-metadata";
import "./shared";

import fastify from "fastify";

import fastifyRateLimit from "@fastify/rate-limit";
import fastifyCompress from "@fastify/compress";

import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";

import path from "node:path";
import Redis from "ioredis";

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

import { enforceRequestedTenant } from "./modules/middlewares/tenant-authorization";
import { uploadConfig } from "./config/upload";

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
  origin: [
    env.HTTP_REQUEST,
    env.EVOLUTION_API_URL,
    env.EVOLUTION_HTTP_REQUEST as string,
  ],
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

rateLimitRedis.on("error", (err) => {
  console.error("[Redis · rate-limit] connection error:", err.message);
});

app.register(fastifyRateLimit, {
  global: true,
  max: 300, // 300 requests per minute (5 requests/second) - Suitable for B2B
  timeWindow: "1 minute",
  redis: rateLimitRedis,
  skipOnError: true, // if Redis is down, let the request pass (don't crash the app)
  keyGenerator: (request) => {
    const forwardedFor = request.headers["x-forwarded-for"];
    const clientIP =
      request.headers["cf-connecting-ip"] ||
      request.headers["x-real-ip"] ||
      (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) ||
      request.socket.remoteAddress;

    return (Array.isArray(clientIP) ? clientIP[0] : clientIP) || "";
  },
  errorResponseBuilder: (req, context) => {
    return {
      statusCode: 429,
      error: "Too Many Requests",
      message: `Limite de requisições excedido. Por favor, tente novamente mais tarde.`,
    };
  },
  addHeaders: {
    "x-ratelimit-limit": true, // Add X-RateLimit-Limit header
    "x-ratelimit-remaining": true, // Add X-RateLimit-Remaining header
    "x-ratelimit-reset": true, // Add X-RateLimit-Reset header
    "retry-after": true, // Adds Retry-After header
  },
});

app.register(multipart, {
  limits: {
    fileSize: Math.max(
      uploadConfig.getSizeLimit("odometerPhotos"),
      uploadConfig.getSizeLimit("avatars"),
      uploadConfig.getSizeLimit("checklistPhotos"),
    ),
    files: 20, // Allow up to 20 files per request for checklist photos etc
    fields: 100,
    parts: 120,
  },
});

// Registered before the routes so it applies to every one of them. This runs
// after body parsing, which `onRequest` (where `ensureAuthenticated` lives)
// cannot do — without it a `businessId` sent in the body bypasses the check.
app.addHook("preHandler", enforceRequestedTenant);
app.register(routes);

app.setErrorHandler((error, _, reply) => {
  const multipartErrorCodes: Record<
    string,
    { status: number; code: string; message: string }
  > = {
    FST_REQ_FILE_TOO_LARGE: {
      status: 413,
      code: "UPLOAD_FILE_TOO_LARGE",
      message: "O arquivo excede o limite de tamanho permitido.",
    },
    FST_FILES_LIMIT: {
      status: 413,
      code: "UPLOAD_FILE_LIMIT_EXCEEDED",
      message: "A quantidade de arquivos excede o limite permitido.",
    },
    FST_FIELDS_LIMIT: {
      status: 413,
      code: "UPLOAD_FIELD_LIMIT_EXCEEDED",
      message: "A quantidade de campos excede o limite permitido.",
    },
    FST_PARTS_LIMIT: {
      status: 413,
      code: "UPLOAD_PART_LIMIT_EXCEEDED",
      message:
        "A quantidade de partes do formulario excede o limite permitido.",
    },
    FST_INVALID_MULTIPART_CONTENT_TYPE: {
      status: 415,
      code: "INVALID_MULTIPART_REQUEST",
      message: "A requisicao deve usar multipart/form-data.",
    },
  };

  const multipartError =
    typeof error.code === "string"
      ? multipartErrorCodes[error.code]
      : undefined;

  if (multipartError) {
    return reply.status(multipartError.status).send({
      code: multipartError.code,
      message: multipartError.message,
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

  if (env.NODE_ENV !== "production") {
    console.error(error);
  } else {
    // for production sentry, datadog, etc.
  }

  return reply.status(500).send({
    code: "INTERNAL_ERROR",
    status: "error",
    message: "Internal server error",
  });
});

export { app, serverInstance };
