import { z } from "zod";
import {
  shipperNameSchema,
  shipperCnpjSchema,
  shipperEmailSchema,
  shipperTelephoneSchema,
} from "@/schemas/create-shipper-schema";

const updateShipperSchema = z.object({
  name: shipperNameSchema.optional(),
  cnpj: shipperCnpjSchema,
  email: shipperEmailSchema,
  telephone: shipperTelephoneSchema,
  is_active: z.boolean().optional(),
});

export { updateShipperSchema };
