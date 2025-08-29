import { z } from "zod";

const healthSchemas = {
  // Health routes don't need input schemas as they don't accept parameters
};

const healthResponses = {
  healthCheck: z.object({
    status: z
      .enum(["healthy", "unhealthy"])
      .describe("Overall system health status"),
    timestamp: z.string().describe("ISO timestamp of health check"),
    uptime: z.number().describe("Application uptime in seconds"),
    services: z
      .object({
        database: z.object({
          status: z
            .enum(["healthy", "unhealthy"])
            .describe("Database connection status"),
          latency: z
            .number()
            .optional()
            .describe("Database response latency in milliseconds"),
          error: z.string().optional().describe("Error message if unhealthy"),
        }),
        rabbitmq: z.object({
          status: z
            .enum(["healthy", "unhealthy"])
            .describe("RabbitMQ connection status"),
          error: z.string().optional().describe("Error message if unhealthy"),
        }),
      })
      .describe("Individual service health statuses"),
    message: z
      .string()
      .optional()
      .describe("Additional message if system is unhealthy"),
  }),
  livenessCheck: z.object({
    status: z.literal("alive").describe("Application liveness status"),
  }),
  readinessCheck: z.object({
    status: z
      .enum(["ready", "not ready"])
      .describe("Application readiness status"),
    ready: z.boolean().describe("Boolean indicating if application is ready"),
  }),
};

export { healthSchemas, healthResponses };
