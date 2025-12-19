import { z } from "zod";

import { createFineSchema } from "@/schemas/create-fine-schema";
import { updateFineSchema } from "@/schemas/update-fine-schema";

import { updateDeleteFineSchema } from "@/schemas/update-delete-fine-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";

const fineSchemas = {
  createFine: createFineSchema,
  updateFine: updateFineSchema,
  updateDeleteFine: updateDeleteFineSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  listFines: listPagesSchema,
  exportFinesQuery: z.object({
    search: z.string().optional().describe("Search term to filter fines"),
  }),
};

const fineResponses = {
  fineCreated: z.object({
    message: z.string().default("Multa registrada com sucesso!"),
  }),
  fineUpdated: z.object({
    message: z.string().default("Multa atualizada com sucesso!"),
  }),
  fineDeleted: z.object({
    message: z.string().default("Multa deletada com sucesso!"),
  }),
  finesList: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("Fine ID"),
        violation_date: z.string().describe("Date of the traffic violation"),
        due_date: z.string().describe("Fine payment due date"),
        payment_date: z.string().nullable().describe("Fine payment date"),
        amount: z.number().describe("Fine amount"),
        points: z.number().describe("Points deducted from driver's license"),
        location: z
          .string()
          .nullable()
          .describe("Location where violation occurred"),
        observation: z.string().nullable().describe("Additional observations"),
        created_at: z.string().describe("Fine creation timestamp"),
        updated_at: z.string().describe("Fine last update timestamp"),
        branch: z
          .object({
            id: z.string().describe("Branch ID"),
            name: z.string().describe("Branch name"),
            cnpj: z.string().describe("Branch CNPJ"),
          })
          .describe("Branch information"),
        driver: z
          .object({
            id: z.string().describe("Driver ID"),
            name: z.string().describe("Driver name"),
            cpf: z.string().describe("Driver CPF"),
            cnh: z.string().describe("Driver license number"),
          })
          .describe("Driver information"),
        vehicle: z
          .object({
            id: z.string().describe("Vehicle ID"),
            name: z.string().describe("Vehicle name"),
            license_plate: z.string().describe("Vehicle license plate"),
            renavam: z.string().describe("Vehicle RENAVAM"),
          })
          .describe("Vehicle information"),
        trafficViolationCode: z
          .object({
            id: z.string().describe("Traffic violation code ID"),
            code: z.string().describe("Traffic violation code"),
            description: z.string().describe("Traffic violation description"),
            gravity: z.string().describe("Violation gravity level"),
          })
          .describe("Traffic violation code information"),
      }),
    ),
    total: z.number().describe("Total number of fines"),
  }),
  exportFinesSuccess: z.object({
    buffer: z.any().describe("Excel file buffer"),
    filename: z.string().describe("Generated filename"),
    totalRecords: z.number().describe("Total number of exported records"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  businessNotFound: z.object({
    message: z
      .string()
      .default("Empresa não encontrada! Por favor, tente novamente."),
  }),
  branchNotFound: z.object({
    message: z.string().default("Filial não encontrada!"),
  }),
  driverNotFound: z.object({
    message: z.string().default("Motorista não encontrado!"),
  }),
  vehicleNotFound: z.object({
    message: z.string().default("Veículo não encontrado!"),
  }),
  trafficViolationCodeNotFound: z.object({
    message: z
      .string()
      .default("Código de infração de trânsito não encontrado!"),
  }),
  fineNumberAlreadyExists: z.object({
    message: z.string().default("Este número de multa já existe!"),
  }),
  branchNotBelongBusiness: z.object({
    message: z
      .string()
      .default("A filial informada não pertence à mesma empresa do usuário."),
  }),
  driverNotBelongBusiness: z.object({
    message: z
      .string()
      .default(
        "O motorista informado não pertence à mesma empresa do usuário.",
      ),
  }),
  vehicleNotBelongBusiness: z.object({
    message: z
      .string()
      .default("O veículo informado não pertence à mesma empresa do usuário."),
  }),
  validationError: z.object({
    message: z.string().default("Erro de validação"),
    issues: z.array(z.string()).describe("List of validation errors"),
  }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { fineSchemas, fineResponses };
