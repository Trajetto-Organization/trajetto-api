import { z } from "zod";
import { fieldError } from "@/shared/validation/field-error";

const getVehicleSchema = z.object({
  businessId: z
    .string(fieldError({ required: "ID da empresa é obrigatório!" }))
    .uuid("ID da empresa é inválido."),
  vehicleId: z
    .string(fieldError({ required: "ID do veículo é obrigatório!" }))
    .uuid("ID do veículo é inválido."),
});

export { getVehicleSchema };
