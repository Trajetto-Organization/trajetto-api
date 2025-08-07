import { z } from "zod";

const updateDeleteVehicleTypeSchema = z.object({
  vehicleTypeId: z.string().min(1, "O ID do tipo de veículo é obrigatório!"),
});

export { updateDeleteVehicleTypeSchema };
