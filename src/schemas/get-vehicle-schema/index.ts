import { z } from "zod";

const getVehicleSchema = z.object({
  businessId: z
    .string({ required_error: "A empresa é obrigatória!" })
    .min(1, "A empresa é obrigatória!"),
  vehicleId: z
    .string({ required_error: "O veículo é obrigatório!" })
    .min(1, "O veículo é obrigatório!"),
});

export { getVehicleSchema };
