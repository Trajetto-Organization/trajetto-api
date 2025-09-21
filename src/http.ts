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
app.register(helmet);

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

app.register(fastifyRateLimit);
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
