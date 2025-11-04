import { z } from "zod";

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90, "Latitude deve estar entre -90 e 90."),
  lng: z.number().min(-180).max(180, "Longitude deve estar entre -180 e 180."),
  address: z.string().optional(),
});

const calculateRouteSchema = z.object({
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  origin: coordinateSchema,
  destination: coordinateSchema,
  waypoints: z.array(coordinateSchema).optional(),
  vehicleId: z
    .string()
    .uuid("O ID do veículo deve ser um UUID válido.")
    .optional(),
  alternatives: z.boolean().optional(),
  steps: z.boolean().optional(),
});

export { calculateRouteSchema };
