import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const updateDeleteVehicleTypeSchema = z.object({
  vehicleTypeId: z
    .string(fieldError({ required: "ID do tipo de veículo é obrigatório!" }))
    .uuid("ID do tipo de veículo é inválido."),
});

export { updateDeleteVehicleTypeSchema };
