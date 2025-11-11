import { z } from "zod";

const createVehicleAssignmentSchema = z.object({
  routeId: z
    .string()
    .uuid("O ID da rota deve ser um UUID válido.")
    .min(1, "O ID da rota é obrigatório."),
  vehicleId: z
    .string()
    .uuid("O ID do veículo deve ser um UUID válido.")
    .min(1, "O ID do veículo é obrigatório."),
  driverId: z
    .string()
    .uuid("O ID do motorista deve ser um UUID válido.")
    .optional(),
  scheduledDate: z
    .string()
    .datetime("A data agendada deve estar no formato ISO 8601."),
  status: z
    .enum(["pending", "in_progress", "completed", "cancelled"])
    .optional()
    .default("pending"),
  notes: z.string().optional(),
});

export { createVehicleAssignmentSchema };
