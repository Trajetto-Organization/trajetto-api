import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import { nameField } from "@/schemas/create-status-change-reason-schema";

const updateStatusChangeReasonSchema = z
  .object({
    ...tenantLockedShape,
    name: nameField.optional(),
    description: z.preprocess(
      (value) => (value === "" ? null : value),
      z
        .string()
        .max(255, "A descrição deve ter no máximo 255 caracteres.")
        .nullable()
        .optional(),
    ),

    /**
     * How a reason is retired. It keeps explaining the events that already
     * cite it and stops being offered for new ones — which is why deleting one
     * that has been used is refused outright.
     */
    is_active: z.boolean().optional(),
  })
  .refine(
    (body) => Object.values(body).some((value) => value !== undefined),
    "Envie ao menos um campo para alterar.",
  );

export { updateStatusChangeReasonSchema };
