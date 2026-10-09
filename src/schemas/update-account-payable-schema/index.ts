import { z } from "zod";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";

import {
  ONE_PAYEE_MESSAGE,
  PAYMENT_MESSAGE,
  accountPayableFields,
  paymentConsistent,
} from "@/schemas/create-account-payable-schema";

/**
 * The create's fields, each optional: absent is "unchanged". The required
 * columns (category, dates, amount, branch, responsible) cannot be sent as
 * null — clearing them would break the bill, and the use case used to turn
 * an absent responsible into whoever saved the form.
 */
const updateAccountPayableSchema = z
  .object({
    ...tenantLockedShape,
    category: accountPayableFields.category.optional(),
    category_description: accountPayableFields.category_description,
    due_date: accountPayableFields.due_date.optional(),
    payment_date: accountPayableFields.payment_date,
    amount: accountPayableFields.amount.optional(),
    amount_paid: z.preprocess(
      // An emptied field arrives as "" from some clients: that clears it.
      (value) =>
        typeof value === "string" && value.trim() === "" ? null : value,
      accountPayableFields.amount_paid,
    ),
    branchId: accountPayableFields.branchId.optional(),
    serviceOrderId: accountPayableFields.serviceOrderId,
    registrationUserId: accountPayableFields.registrationUserId.optional(),
    supplierId: accountPayableFields.supplierId,
    payee_name: accountPayableFields.payee_name,
    vehicleId: accountPayableFields.vehicleId,
    description: accountPayableFields.description,
    document_number: accountPayableFields.document_number,
  })
  .refine(paymentConsistent, { message: PAYMENT_MESSAGE, path: ["amount_paid"] })
  .refine(
    (data) =>
      data.category === undefined ||
      data.category !== "OTHER" ||
      Boolean(data.category_description),
    {
      message: 'Descreva a categoria ao selecionar "Outros".',
      path: ["category_description"],
    },
  )
  .refine((data) => !(data.supplierId && data.payee_name), {
    message: ONE_PAYEE_MESSAGE,
    path: ["payee_name"],
  })
  // A description for a named category is stale text waiting to mislead.
  .transform((data) =>
    data.category === undefined || data.category === "OTHER"
      ? data
      : { ...data, category_description: null },
  );

export { updateAccountPayableSchema };
