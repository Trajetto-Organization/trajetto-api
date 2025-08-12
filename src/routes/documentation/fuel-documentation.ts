import { z } from "zod";

import { listPagesSchema } from "@/schemas/list-pages-schema";
import { listPagesByBusinessSchema } from "@/schemas/list-pages-by-business-schema";

const fuelSchemas = {
  listFuel: listPagesSchema,
  listFuelBusiness: listPagesByBusinessSchema,
};

const fuelResponses = {
  fuelList: z.object({
    data: z.array(
      z.object({
        id: z.string(),
        current_mileage: z.number(),
        liters_amount: z.number(),
        price_per_liter: z.number(),
        total_amount: z.number(),
        odometer_photo: z.string(),
        odometer_verified: z.boolean(),
        notes: z.string(),
        refueling_date: z.string(),
        businessId: z.string(),
        branchId: z.string(),
        vehicleId: z.string(),
        driverId: z.string(),
        fuelTypeId: z.string(),
        business_name: z.string().optional(),
        branch_name: z.string(),
        vehicle_description: z.string(),
        vehicle_license_plate: z.string(),
        vehicle_brand: z.string(),
        vehicle_model: z.string(),
        driver_name: z.string(),
        driver_cnh: z.string(),
        fuel_type_description: z.string(),
        created_at: z.string(),
        updated_at: z.string(),
      })
    ),
    total: z.number(),
  }),

  // Common Error Responses
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),

  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),

  validationError: z.object({
    message: z.string().default("Validation Error"),
    issues: z.array(z.string()),
  }),

  // Grouping errors by route
  listFuelErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
  ]),

  listFuelBusinessErrors: z.union([
    z.object({
      message: z.string().default("Validation Error"),
      issues: z.array(z.string()),
    }),
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
  ]),
};

export { fuelSchemas, fuelResponses };