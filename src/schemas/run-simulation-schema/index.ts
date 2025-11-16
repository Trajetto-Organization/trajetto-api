import { z } from "zod";

const coordinateSchema = z.object({
  lat: z.number().min(-90, "Latitude inválida").max(90, "Latitude inválida"),
  lng: z
    .number()
    .min(-180, "Longitude inválida")
    .max(180, "Longitude inválida"),
});

const routeForSimulationSchema = z.object({
  name: z.string().min(1, "O nome da rota é obrigatório").optional(),
  origin: coordinateSchema,
  destination: coordinateSchema,
  waypoints: z.array(coordinateSchema).optional(),
  vehicleId: z.string().uuid("ID do veículo inválido").optional(),
  driverId: z.string().uuid("ID do motorista inválido").optional(),
});

const runSimulationSchema = z.object({
  name: z
    .string()
    .min(3, "O nome deve ter no mínimo 3 caracteres.")
    .max(100, "O nome deve ter no máximo 100 caracteres."),
  description: z
    .string()
    .max(500, "A descrição deve ter no máximo 500 caracteres.")
    .optional()
    .nullable(),
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  routes: z
    .array(routeForSimulationSchema)
    .min(1, "É necessário fornecer pelo menos 1 rota.")
    .max(100, "O máximo de rotas permitidas é 100."),
  metadata: z.record(z.unknown()).optional(),
});

export { runSimulationSchema };
