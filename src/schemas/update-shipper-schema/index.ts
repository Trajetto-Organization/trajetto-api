import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import {
  shipperNameSchema,
  shipperCorporateReasonSchema,
  shipperCnpjSchema,
  shipperEmailSchema,
  shipperTelephoneSchema,
} from "@/schemas/create-shipper-schema";

const updateShipperSchema = z.object({
  ...tenantLockedShape,
  name: shipperNameSchema.optional(),
  corporate_reason: shipperCorporateReasonSchema,
  cnpj: shipperCnpjSchema,
  email: shipperEmailSchema,
  telephone: shipperTelephoneSchema,
  is_active: z.boolean().optional(),
});

export { updateShipperSchema };
