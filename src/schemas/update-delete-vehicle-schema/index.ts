import { z } from "zod";

const updateDeleteVehicleSchema = z.object({
  vehicleId: z
    .string({ required_error: "ID do veículo é obrigatório!" })
    .uuid("ID do veículo é inválido."),
});

export { updateDeleteVehicleSchema };
