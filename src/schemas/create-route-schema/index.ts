import { z } from "zod";

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
});

const createRouteSchema = z.object({
  // Route identification
  name: z.string().min(1, "O nome da rota é obrigatório.").optional(),
  description: z.string().optional(),

  // Mandatory data
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  origin: coordinateSchema,
  destination: coordinateSchema,
  waypoints: z.array(coordinateSchema).optional(),

  // Calculated fields - OPTIONAL (UseCase calculates automatically if not submitted)
  distance: z
    .number()
    .min(0, "A distância deve ser maior ou igual a 0.")
    .optional(),
  duration: z
    .number()
    .min(0, "A duração deve ser maior ou igual a 0.")
    .optional(),
  geometry: z
    .object({
      type: z.string(),
      coordinates: z.array(z.array(z.number())),
    })
    .optional(),
  estimatedCost: z
    .number()
    .min(0, "O custo estimado deve ser maior ou igual a 0.")
    .optional(),
  costPerKm: z
    .number()
    .min(0, "O custo por km deve ser maior ou igual a 0.")
    .optional()
    .default(2.5),

  // Assignments and metadata
  status: z.string().optional(),
  vehicleId: z
    .string()
    .uuid("O ID do veículo deve ser um UUID válido.")
    .optional(),
  driverId: z
    .string()
    .uuid("O ID do motorista deve ser um UUID válido.")
    .optional(),
  simulationId: z
    .string()
    .uuid("O ID da simulação deve ser um UUID válido.")
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export { createRouteSchema };
