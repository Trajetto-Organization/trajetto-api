import { z } from "zod";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { routeParamsSchema } from "@/schemas/route-params-schema";

import { calculateRouteSchema } from "@/schemas/calculate-route-schema";
import { createRouteSchema } from "@/schemas/create-route-schema";

import { updateRouteSchema } from "@/schemas/update-route-schema";
import { optimizeRouteSchema } from "@/schemas/optimize-route-schema";

import { listRoutesQuerySchema } from "@/schemas/list-routes-query-schema";

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90).describe("Latitude"),
  lng: z.number().min(-180).max(180).describe("Longitude"),
  address: z.string().optional().describe("Optional address"),
});

const routeObjectSchema = z.object({
  id: z.string().uuid(),
  origin: coordinateSchema,
  destination: coordinateSchema,
  waypoints: z.array(coordinateSchema),
  distance: z.number(),
  duration: z.number(),
  geometry: z.object({
    type: z.string(),
    coordinates: z.array(z.array(z.number())),
  }),
  estimatedCost: z.number(),
  status: z.string(),
  businessId: z.string().uuid(),
  vehicleId: z.string().uuid().nullable(),
  driverId: z.string().uuid().nullable(),
  simulationId: z.string().uuid().nullable(),
  metadata: z.record(z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
  vehicle: z
    .object({
      id: z.string(),
      description: z.string(),
      license_plate: z.string(),
      brand: z.string(),
      model: z.string(),
    })
    .optional(),
  driver: z
    .object({
      id: z.string(),
      name: z.string(),
      cpf: z.string(),
    })
    .optional(),
});

const routeResultSchema = z.object({
  distance: z.number().describe("Distance in meters"),
  duration: z.number().describe("Duration in seconds"),
  distanceKm: z.number().describe("Distance in kilometers"),
  durationFormatted: z.string().describe("Formatted duration (e.g., 1h 30min)"),
  estimatedCost: z.number().describe("Estimated cost in BRL"),
  geometry: z.object({
    type: z.string(),
    coordinates: z.array(z.array(z.number())),
  }),
  steps: z
    .array(
      z.object({
        distance: z.number(),
        duration: z.number(),
        instruction: z.string(),
      }),
    )
    .optional(),
});

const optimizedRouteResultSchema = routeResultSchema.extend({
  waypointsOrder: z.array(z.number()).describe("Optimized waypoints order"),
});

export const routingSchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  routeParams: routeParamsSchema,
  calculateRoute: calculateRouteSchema,
  createRoute: createRouteSchema,
  updateRoute: updateRouteSchema,
  optimizeRoute: optimizeRouteSchema,
  listRoutes: listRoutesQuerySchema,
};

export const routingResponses = {
  // Calculate Route
  routeCalculated: z.object({
    message: z.string().default("Rota calculada com sucesso!"),
    route: routeResultSchema,
  }),

  calculateRouteErrors: z.union([
    z.object({ message: z.literal("Usuário não encontrado!") }),
    z.object({ message: z.literal("Empresa não encontrada!") }),
    z.object({ message: z.literal("Veículo não encontrado!") }),
    z.object({
      message: z.literal(
        "Erro ao calcular rota. Verifique as coordenadas e tente novamente.",
      ),
    }),
  ]),

  // Optimize Route
  routeOptimized: z.object({
    message: z.string().default("Rota otimizada com sucesso!"),
    route: optimizedRouteResultSchema,
  }),

  optimizeRouteErrors: z.union([
    z.object({ message: z.literal("Usuário não encontrado!") }),
    z.object({ message: z.literal("Empresa não encontrada!") }),
    z.object({
      message: z.literal(
        "É necessário fornecer pelo menos 2 coordenadas para otimizar a rota!",
      ),
    }),
  ]),

  // Create Route
  routeCreated: z.object({
    message: z.string().default("Rota criada com sucesso!"),
    route: routeObjectSchema,
  }),

  createRouteErrors: z.union([
    z.object({ message: z.literal("Usuário não encontrado!") }),
    z.object({ message: z.literal("Empresa não encontrada!") }),
    z.object({ message: z.literal("Veículo não encontrado!") }),
    z.object({ message: z.literal("Motorista não encontrado!") }),
  ]),

  // List Routes
  routeList: z.object({
    data: z.array(routeObjectSchema),
    total: z.number(),
  }),

  listRoutesErrors: z.union([
    z.object({ message: z.literal("Usuário não encontrado!") }),
    z.object({ message: z.literal("Empresa não encontrada!") }),
  ]),

  // Get Route
  routeDetails: routeObjectSchema,

  getRouteErrors: z.union([
    z.object({ message: z.literal("Usuário não encontrado!") }),
    z.object({ message: z.literal("Empresa não encontrada!") }),
    z.object({ message: z.literal("Rota não encontrada!") }),
  ]),

  routeNotFound: z.object({
    message: z.literal("Rota não encontrada!"),
  }),

  // Update Route
  routeUpdated: z.object({
    message: z.string().default("Rota atualizada com sucesso!"),
    route: routeObjectSchema,
  }),

  updateRouteErrors: z.union([
    z.object({ message: z.literal("Usuário não encontrado!") }),
    z.object({ message: z.literal("Empresa não encontrada!") }),
    z.object({ message: z.literal("Veículo não encontrado!") }),
    z.object({ message: z.literal("Motorista não encontrado!") }),
    z.object({ message: z.literal("Rota não encontrada!") }),
  ]),

  // Delete Route
  routeDeleted: z.object({
    message: z.string().default("Rota deletada com sucesso!"),
    route: routeObjectSchema,
  }),

  deleteRouteErrors: z.union([
    z.object({ message: z.literal("Usuário não encontrado!") }),
    z.object({ message: z.literal("Empresa não encontrada!") }),
    z.object({ message: z.literal("Rota não encontrada!") }),
  ]),

  // Generic
  internalServerError: z.object({
    message: z.string(),
  }),
};
