import { z } from "zod";

const coordinateSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().optional(),
});

const optimizeRouteSchema = z.object({
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  coordinates: z
    .array(coordinateSchema)
    .min(2, "Forneça pelo menos 2 coordenadas!"),
  roundtrip: z.boolean().optional(),
  source: z.enum(["first", "any"]).optional(),
  destination: z.enum(["last", "any"]).optional(),
});

export { optimizeRouteSchema };
