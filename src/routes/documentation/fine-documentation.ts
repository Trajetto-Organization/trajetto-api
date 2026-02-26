import { z } from "zod";

import { createFineSchema } from "@/schemas/create-fine-schema";
import { updateFineSchema } from "@/schemas/update-fine-schema";

import { updateDeleteFineSchema } from "@/schemas/update-delete-fine-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { listPagesSchema } from "@/schemas/list-pages-schema";

const fineBusinessParams = z.object({
  businessId: z.string().uuid("O ID da empresa é obrigatório!"),
  fineId: z.string().uuid("ID da multa deve ser um UUID válido."),
});

const fineSchemas = {
  createFine: createFineSchema,
  updateFine: updateFineSchema,
  updateDeleteFine: updateDeleteFineSchema,
  updateDeleteBusiness: updateDeleteBusinessSchema,
  listFines: listPagesSchema,
  fineBusinessParams: fineBusinessParams,
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
        violation_date: z
          .union([z.string(), z.date()])
          .describe("Date of the traffic violation"),
        due_date: z
          .union([z.string(), z.date()])
          .describe("Fine payment due date"),
        payment_date: z
          .union([z.string(), z.date()])
          .nullable()
          .describe("Fine payment date"),
        amount: z.number().describe("Fine amount"),
        points: z.number().describe("Points deducted from driver's license"),
        location: z
          .string()
          .nullable()
          .describe("Location where violation occurred"),
        observation: z.string().nullable().describe("Additional observations"),
        businessId: z.string().describe("Business ID"),
        branchId: z.string().describe("Branch ID"),
        driverId: z.string().describe("Driver ID"),
        vehicleId: z.string().describe("Vehicle ID"),
        trafficViolationCodeId: z
          .string()
          .describe("Traffic violation code ID"),
        latitude: z
          .number()
          .nullable()
          .optional()
          .describe("Location latitude"),
        longitude: z
          .number()
          .nullable()
          .optional()
          .describe("Location longitude"),
        latitude_original: z
          .number()
          .nullable()
          .optional()
          .describe("Original location latitude"),
        longitude_original: z
          .number()
          .nullable()
          .optional()
          .describe("Original location longitude"),
        location_source: z
          .string()
          .nullable()
          .optional()
          .describe("Source of location data"),
        location_edited_by: z
          .string()
          .nullable()
          .optional()
          .describe("User who edited location"),
        location_edited_at: z
          .union([z.string(), z.date()])
          .nullable()
          .optional()
          .describe("When location was edited"),
        created_from: z.string().describe("Creation source"),
        created_at: z
          .union([z.string(), z.date()])
          .describe("Fine creation timestamp"),
        updated_at: z
          .union([z.string(), z.date()])
          .describe("Fine last update timestamp"),
        business: z
          .object({
            corporate_reason: z.string().describe("Business corporate reason"),
          })
          .optional()
          .describe("Business information"),
        branch: z
          .object({
            corporate_reason: z.string().describe("Branch corporate reason"),
          })
          .describe("Branch information"),
        driver: z
          .object({
            name: z.string().describe("Driver name"),
            cpf: z.string().describe("Driver CPF"),
          })
          .describe("Driver information"),
        vehicle: z
          .object({
            license_plate: z.string().describe("Vehicle license plate"),
            description: z.string().describe("Vehicle description"),
          })
          .describe("Vehicle information"),
        trafficViolationCode: z
          .object({
            code: z.string().describe("Traffic violation code"),
            sub_code: z.string().describe("Traffic violation sub-code"),
            description: z.string().describe("Traffic violation description"),
            gravity: z.string().describe("Violation gravity level"),
            points: z.number().describe("Points deducted"),
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
  fineNotFound: z.object({
    message: z.string().default("Multa não encontrada!"),
  }),
  vehicleNotFound: z.object({
    message: z.string().default("Veículo não encontrado!"),
  }),
  trafficViolationCodeNotFound: z.object({
    message: z
      .string()
      .default("Código de infração de trânsito não encontrado!"),
  }),
  fineDateInfractionCannotBeFuture: z.object({
    message: z.string().default("A data da infração não pode ser futura!"),
  }),
  fineDueDateMustBeAfterInfraction: z.object({
    message: z
      .string()
      .default("A data de vencimento deve ser posterior à data da infração!"),
  }),
  finePaymentDateCannotBeEarlierInfraction: z.object({
    message: z
      .string()
      .default("A data de pagamento não pode ser anterior à data da infração!"),
  }),
  fineLocationNotProvidedAdjustmentValidation: z.object({
    message: z
      .string()
      .default("Localização original não fornecida para validação de ajuste."),
  }),
  fineRegistrationsMobileLocationRequired: z.object({
    message: z
      .string()
      .default(
        "Para registros via aplicativo mobile, a localização é obrigatória.",
      ),
  }),
  fineDueDateInfractionCannotBeLater: z.object({
    message: z
      .string()
      .default(
        "A nova data da infração não pode ser posterior à data de vencimento existente!",
      ),
  }),
  fineDueDateMustBeLaterInfraction: z.object({
    message: z
      .string()
      .default(
        "A nova data de vencimento deve ser posterior à data da infração existente!",
      ),
  }),
  fineNotBelongBusiness: z.object({
    message: z.string().default("Esta multa não pertence a esta empresa!"),
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

  // Grouping errors by route - CREATE (POST) - status 400
  createFineErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Empresa não encontrada! Por favor, tente novamente."),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Código de infração de trânsito não encontrado!"),
    }),
    z.object({
      message: z.string().default("A data da infração não pode ser futura!"),
    }),
    z.object({
      message: z
        .string()
        .default("A data de vencimento deve ser posterior à data da infração!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "A data de pagamento não pode ser anterior à data da infração!",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Localização original não fornecida para validação de ajuste.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "Para registros via aplicativo mobile, a localização é obrigatória.",
        ),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()),
    }),
  ]),

  // Forbidden errors for CREATE (status 403)
  createFineForbiddenErrors: z.union([
    z.object({
      message: z
        .string()
        .default("A filial informada não pertence à mesma empresa do usuário."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O motorista informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O veículo informado não pertence à mesma empresa do usuário.",
        ),
    }),
  ]),

  // UPDATE errors (PATCH) - status 400
  updateFineErrors: z.union([
    z.object({
      message: z.string().default("Recurso não encontrado!"),
    }),
    z.object({
      message: z.string().default("Filial não encontrada!"),
    }),
    z.object({
      message: z.string().default("Motorista não encontrado!"),
    }),
    z.object({
      message: z.string().default("Veículo não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("Código de infração de trânsito não encontrado!"),
    }),
    z.object({
      message: z
        .string()
        .default("A data de vencimento deve ser posterior à data da infração!"),
    }),
    z.object({
      message: z
        .string()
        .default(
          "A data de pagamento não pode ser anterior à data da infração!",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "A nova data da infração não pode ser posterior à data de vencimento existente!",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "A nova data de vencimento deve ser posterior à data da infração existente!",
        ),
    }),
    z.object({
      message: z.string().default("Erro de validação"),
      issues: z.array(z.string()),
    }),
  ]),

  // Forbidden errors for UPDATE (status 403)
  updateFineForbiddenErrors: z.union([
    z.object({
      message: z.string().default("Esta multa não pertence a esta empresa!"),
    }),
    z.object({
      message: z
        .string()
        .default("A filial informada não pertence à mesma empresa do usuário."),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O motorista informado não pertence à mesma empresa do usuário.",
        ),
    }),
    z.object({
      message: z
        .string()
        .default(
          "O veículo informado não pertence à mesma empresa do usuário.",
        ),
    }),
  ]),
};

export { fineSchemas, fineResponses };
