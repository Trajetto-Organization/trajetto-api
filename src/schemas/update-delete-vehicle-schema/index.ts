import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteVehicleSchema = z.object({
  vehicleId: z
    .string(fieldError({ required: "ID do veículo é obrigatório!" }))
    .uuid("ID do veículo é inválido."),
});

export { updateDeleteVehicleSchema };
