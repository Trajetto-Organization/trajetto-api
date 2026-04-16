import { z } from "zod";

const getVehicleSchema = z.object({
  businessId: z
    .string({ required_error: "ID da empresa é obrigatório!" })
    .uuid("ID da empresa é inválido."),
  vehicleId: z
    .string({ required_error: "ID do veículo é obrigatório!" })
    .uuid("ID do veículo é inválido."),
});

export { getVehicleSchema };
