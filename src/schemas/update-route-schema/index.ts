import { z } from "zod";

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
});

const updateRouteSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  origin: coordinateSchema.optional(),
  destination: coordinateSchema.optional(),
  waypoints: z.array(coordinateSchema).optional(),
  distance: z.number().min(0).optional(),
  duration: z.number().min(0).optional(),
  geometry: z
    .object({
      type: z.string(),
      coordinates: z.array(z.array(z.number())),
    })
    .optional(),
  estimatedCost: z.number().min(0).optional(),
  status: z.string().optional(),
  vehicleId: z.string().uuid().nullable().optional(),
  driverId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export { updateRouteSchema };
