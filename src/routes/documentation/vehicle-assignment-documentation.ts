import { z } from "zod";

import { createVehicleAssignmentSchema } from "@/schemas/create-vehicle-assignment-schema";
import { updateVehicleAssignmentSchema } from "@/schemas/update-vehicle-assignment-schema";

import { listVehicleAssignmentsQuerySchema } from "@/schemas/list-vehicle-assignments-query-schema";
import { vehicleAssignmentParamsSchema } from "@/schemas/vehicle-assignment-params-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

// Shared schema for assignment object with relationships
const assignmentObjectSchema = z.object({
  id: z.string(),
  routeId: z.string(),
  vehicleId: z.string(),
  driverId: z.string().nullable(),
  scheduledDate: z.union([z.string(), z.date()]).transform((val) => {
    if (val instanceof Date) return val.toISOString();
    return val;
  }),
  status: z.string(),
  notes: z.string().nullable(),
  businessId: z.string(),
  created_at: z.union([z.string(), z.date()]).transform((val) => {
    if (val instanceof Date) return val.toISOString();
    return val;
  }),
  updated_at: z.union([z.string(), z.date()]).transform((val) => {
    if (val instanceof Date) return val.toISOString();
    return val;
  }),
  route: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      origin: z.object({
        lat: z.number(),
        lng: z.number(),
        address: z.string().optional(),
      }),
      destination: z.object({
        lat: z.number(),
        lng: z.number(),
        address: z.string().optional(),
      }),
      distance: z.number(),
      duration: z.number(),
      estimatedCost: z.number(),
    })
    .optional(),
  vehicle: z
    .object({
      id: z.string(),
      description: z.string(),
      license_plate: z.string(),
      brand: z.string(),
      model: z.string(),
      status: z.string(),
    })
    .optional(),
  driver: z
    .object({
      id: z.string(),
      name: z.string(),
      cpf: z.string(),
    })
    .nullable()
    .optional(),
});

const vehicleAssignmentSchemas = {
  createAssignment: createVehicleAssignmentSchema,
  updateAssignment: updateVehicleAssignmentSchema,
  listAssignmentsQuery: listVehicleAssignmentsQuerySchema,
  businessIdParam: updateDeleteBusinessSchema,
  assignmentParams: vehicleAssignmentParamsSchema,
};

const vehicleAssignmentResponses = {
  assignmentCreated: z.object({
    message: z.string().default("Atribuição criada com sucesso!"),
    assignment: assignmentObjectSchema,
  }),

  createAssignmentErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Rota não encontrada!"),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z.string().default("Veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("Veículo já está atribuído para esta data e horário!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar criar a atribuição! Por favor, tente novamente.",
        ),
    }),
  ]),

  assignmentsList: z.object({
    data: z.array(assignmentObjectSchema),
    total: z.number(),
  }),

  listAssignmentsErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar listar as atribuições! Por favor, tente novamente.",
        ),
    }),
  ]),

  assignmentDetails: assignmentObjectSchema,

  getAssignmentErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Atribuição não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar buscar a atribuição! Por favor, tente novamente.",
        ),
    }),
  ]),

  assignmentUpdated: z.object({
    message: z.string().default("Atribuição atualizada com sucesso!"),
    assignment: assignmentObjectSchema,
  }),

  updateAssignmentErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Atribuição não encontrada!"),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z.string().default("Veículo não pertence a esta empresa!"),
    }),
    z.object({
      message: z.string().default("Motorista não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar atualizar a atribuição! Por favor, tente novamente.",
        ),
    }),
  ]),

  assignmentDeleted: z.object({
    message: z.string().default("Atribuição removida com sucesso!"),
    assignment: assignmentObjectSchema,
  }),

  deleteAssignmentErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Atribuição não encontrada!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Houve um erro ao tentar remover a atribuição! Por favor, tente novamente.",
        ),
    }),
  ]),
};

export { vehicleAssignmentSchemas, vehicleAssignmentResponses };
