import { z } from "zod";

const updateDeleteVehicleSchema = z.object({
  vehicleId: z.string().min(1, "O ID do veículo é obrigatório!"),
});

export { updateDeleteVehicleSchema };
