import { z } from "zod";

const updateDeleteVehicleTypeSchema = z.object({
  vehicleTypeId: z
    .string({ required_error: "ID do tipo de veículo é obrigatório!" })
    .uuid("ID do tipo de veículo é inválido."),
});

export { updateDeleteVehicleTypeSchema };
