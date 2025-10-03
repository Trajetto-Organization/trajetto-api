import "reflect-metadata";
import "./shared";

import fastify from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";

import fastifyStatic from "@fastify/static";
import multipart from "@fastify/multipart";

import path from "node:path";

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

app.register(fastifyCors, {
  origin: [
    env.HTTP_REQUEST,
    env.EVOLUTION_API_URL,
    env.EVOLUTION_HTTP_REQUEST as string,
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
  credentials: true,
});

app.register(fastifyStatic, {
  root: path.join(__dirname, "..", "tmp"),
  prefix: "/tmp/",
  decorateReply: false,
  setHeaders: (res) => {
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Access-Control-Allow-Origin", "*");
  },
});

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

app.register(fastifyRateLimit, {
  global: true,
  max: 300, // 300 requests per minute (5 requests/second) - Suitable for B2B
  timeWindow: "1 minute",
  skipOnError: false, // Do not skip rate limit if there is an error in the plugin
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
  },
});

app.register(routes);

app.setErrorHandler((error, _, reply) => {
  if (error instanceof ZodError || hasZodFastifySchemaValidationErrors(error)) {
    const issues =
      error instanceof ZodError
        ? error.errors.map(({ message }) => message)
        : error.validation.map(({ message }) => message);

    return reply.status(400).send({
      message: "Validation Error",
      issues,
    });
  }

  if (error instanceof AppError) {
    return reply.status(error.statusCode).send({
      message: error.message,
    });
  }

  if (env.NODE_ENV !== "production") {
    console.error(error);
  } else {
    // for production sentry, datadog, etc.
  }

  return reply.status(500).send({
    status: "error",
    message: "Internal server error",
  });
});

export { app, serverInstance };
