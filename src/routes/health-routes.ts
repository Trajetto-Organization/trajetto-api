import { FastifyInstance } from "fastify";
import database from "@/../infra/database";

import { RabbitMQConnection } from "@/../infra/messaging/rabbitmq-connection";
import { RedisConnection } from "@/../infra/cache/redis-connection";

import { healthResponses } from "./documentation/health-documentation";

async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "System health check",
        description:
          "Comprehensive health check of all system components including database and message queue connections with latency metrics",
        response: {
          200: healthResponses.healthCheck,
          503: healthResponses.healthCheck,
        },
      },
    },
    async (request, reply) => {
      const services: any = {};

      try {
        // Check database
        const dbStart = Date.now();
        await database.$queryRaw`SELECT 1`;

        services.database = {
          status: "healthy",
          latency: Date.now() - dbStart,
        };
      } catch (error) {
        services.database = {
          status: "unhealthy",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

      try {
        // Check RabbitMQ
        const rabbitmq = RabbitMQConnection.getInstance();
        const connection = await rabbitmq.getConnection();

        services.rabbitmq = {
          status: connection ? "healthy" : "unhealthy",
        };
      } catch (error) {
        services.rabbitmq = {
          status: "unhealthy",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

      try {
        // Check Redis
        const redisStart = Date.now();
        const redis = RedisConnection.getInstance();

        const client = await redis.getClient();
        await client.ping();

        services.redis = {
          status: "healthy",
          latency: Date.now() - redisStart,
        };
      } catch (error) {
        services.redis = {
          status: "unhealthy",
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }

      // Determine overall health
      const isHealthy = Object.values(services).every(
        (service: any) => service.status === "healthy",
      );

      const response = {
        status: isHealthy ? "healthy" : "unhealthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        services,
      };

      if (!isHealthy) {
        return reply.status(503).send({
          ...response,
          message: "One or more services are unhealthy",
        });
      }

      return reply.status(200).send(response);
    },
  );

  // Liveness probe - just checks if the application is responding
  app.get(
    "/health/liveness",
    {
      schema: {
        tags: ["health"],
        summary: "Application liveness probe",
        description:
          "Basic liveness check to verify if the application process is running and responding to requests",
        response: {
          200: healthResponses.livenessCheck,
        },
      },
    },
    async (request, reply) => {
      return reply.status(200).send({ status: "alive" });
    },
  );

  // Readiness probe - checks if the application is ready to receive traffic
  app.get(
    "/health/readiness",
    {
      schema: {
        tags: ["health"],
        summary: "Application readiness probe",
        description:
          "Readiness check to verify if the application is ready to receive and process traffic with database connectivity",
        response: {
          200: healthResponses.readinessCheck,
          503: healthResponses.readinessCheck,
        },
      },
    },
    async (request, reply) => {
      let isReady = true;

      try {
        // Quick database check
        await database.$queryRaw`SELECT 1`;
      } catch {
        isReady = false;
      }

      if (!isReady) {
        return reply.status(503).send({
          status: "not ready",
          ready: false,
        });
      }

      return reply.status(200).send({
        status: "ready",
        ready: true,
      });
    },
  );
}

export { healthRoutes };
