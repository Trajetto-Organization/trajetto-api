import { z } from "zod";

import {
  createVehicleAssignmentSchema,
  updateVehicleAssignmentSchema,
  listVehicleAssignmentsQuerySchema,
  businessIdParamSchema,
  getAssignmentParamsSchema,
  updateAssignmentParamsSchema,
  deleteAssignmentParamsSchema,
} from "./vehicle-assignment-schemas";

const coordinateSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string().optional(),
});

const vehicleAssignmentObjectSchema = z.object({
  id: z.string().uuid(),
  routeId: z.string().uuid(),
  vehicleId: z.string().uuid(),
  driverId: z.string().uuid().nullable(),
  scheduledDate: z.union([z.string(), z.date()]).transform((val) => {
    if (val instanceof Date) {
      return val.toISOString();
    }
    return val;
  }),
  status: z.string(),
  notes: z.string().nullable(),
  businessId: z.string().uuid(),
  created_at: z.union([z.string(), z.date()]).transform((val) => {
    if (val instanceof Date) {
      return val.toISOString();
    }
    return val;
  }),
  updated_at: z.union([z.string(), z.date()]).transform((val) => {
    if (val instanceof Date) {
      return val.toISOString();
    }
    return val;
  }),
  route: z
    .object({
      id: z.string(),
      name: z.string().nullable().optional(),
      origin: coordinateSchema,
      destination: coordinateSchema,
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

export const vehicleAssignmentSchemas = {
  businessIdParam: businessIdParamSchema,
  getAssignmentParams: getAssignmentParamsSchema,
  updateAssignmentParams: updateAssignmentParamsSchema,
  deleteAssignmentParams: deleteAssignmentParamsSchema,
  createAssignment: createVehicleAssignmentSchema,
  updateAssignment: updateVehicleAssignmentSchema,
  listAssignmentsQuery: listVehicleAssignmentsQuerySchema,
};

export const vehicleAssignmentResponses = {
  // Create Assignment
  assignmentCreated: z.object({
    message: z.string().default("Atribuição criada com sucesso!"),
    assignment: vehicleAssignmentObjectSchema,
  }),

  createAssignmentErrors: z.union([
    z.object({ message: z.string().default("Recurso não encontrado!") }),
    z.object({ message: z.string().default("Empresa não encontrada! Por favor, tente novamente.") }),
    z.object({ message: z.string().default("Sem permissão para acessar esta empresa!") }),
    z.object({ message: z.string().default("Rota não encontrada!") }),
    z.object({ message: z.string().default("Veículo não encontrado!") }),
    z.object({ message: z.string().default("Motorista não encontrado!") }),
    z.object({ message: z.string().default("Veículo não pertence a esta empresa!") }),
    z.object({ message: z.string().default("Motorista não pertence a esta empresa!") }),
    z.object({ message: z.string().default("Veículo já está atribuído para esta data e horário!") }),
  ]),

  // List Assignments
  assignmentsList: z.object({
    data: z.array(vehicleAssignmentObjectSchema),
    total: z.number(),
  }),

  listAssignmentsErrors: z.union([
    z.object({ message: z.string().default("Recurso não encontrado!") }),
    z.object({ message: z.string().default("Empresa não encontrada! Por favor, tente novamente.") }),
    z.object({ message: z.string().default("Sem permissão para acessar esta empresa!") }),
  ]),

  // Get Assignment
  assignmentDetails: vehicleAssignmentObjectSchema,

  getAssignmentErrors: z.union([
    z.object({ message: z.string().default("Recurso não encontrado!") }),
    z.object({ message: z.string().default("Empresa não encontrada! Por favor, tente novamente.") }),
    z.object({ message: z.string().default("Atribuição não encontrada!") }),
    z.object({ message: z.string().default("Sem permissão para acessar esta empresa!") }),
  ]),

  // Update Assignment
  assignmentUpdated: z.object({
    message: z.string().default("Atribuição atualizada com sucesso!"),
    assignment: vehicleAssignmentObjectSchema,
  }),

  updateAssignmentErrors: z.union([
    z.object({ message: z.string().default("Recurso não encontrado!") }),
    z.object({ message: z.string().default("Empresa não encontrada! Por favor, tente novamente.") }),
    z.object({ message: z.string().default("Atribuição não encontrada!") }),
    z.object({ message: z.string().default("Sem permissão para acessar esta empresa!") }),
    z.object({ message: z.string().default("Veículo não encontrado!") }),
    z.object({ message: z.string().default("Motorista não encontrado!") }),
    z.object({ message: z.string().default("Veículo não pertence a esta empresa!") }),
    z.object({ message: z.string().default("Motorista não pertence a esta empresa!") }),
  ]),

  // Delete Assignment
  assignmentDeleted: z.object({
    message: z.string().default("Atribuição removida com sucesso!"),
    assignment: vehicleAssignmentObjectSchema,
  }),

  deleteAssignmentErrors: z.union([
    z.object({ message: z.string().default("Recurso não encontrado!") }),
    z.object({ message: z.string().default("Empresa não encontrada! Por favor, tente novamente.") }),
    z.object({ message: z.string().default("Atribuição não encontrada!") }),
    z.object({ message: z.string().default("Sem permissão para acessar esta empresa!") }),
  ]),
};
