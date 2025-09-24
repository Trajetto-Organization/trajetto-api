import { z } from "zod";

const updateDeleteVehicleChecklistSchema = z.object({
  businessId: z.string().uuid("O ID da empresa deve ser um UUID válido."),
  checklistId: z.string().uuid("O ID do checklist deve ser um UUID válido."),
});

export { updateDeleteVehicleChecklistSchema };
