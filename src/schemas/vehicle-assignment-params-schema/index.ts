import { z } from "zod";

const vehicleAssignmentParamsSchema = z.object({
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  assignmentId: z.string().uuid("O ID da atribuição deve ser um UUID válido."),
});

export { vehicleAssignmentParamsSchema };
