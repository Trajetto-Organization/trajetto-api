import { z } from "zod";

import { listTrafficViolationCodeSchema } from "@/schemas/list-traffic-violation-code-schema";

const trafficViolationCodeSchemas = {
  listTrafficViolationCode: listTrafficViolationCodeSchema,
};

const trafficViolationCodeResponses = {
  trafficViolationCodeList: z.object({
    data: z.array(
      z.object({
        id: z.string().describe("Traffic violation code ID"),
        code: z.string().describe("Traffic violation code number"),
        sub_code: z.number().describe("Traffic violation sub-code number"),
        description: z
          .string()
          .describe("Detailed description of the violation"),
        legal_basis: z.string().describe("Legal basis for the violation"),
        violator_type: z
          .string()
          .describe("Type of violator (driver, owner, etc.)"),
        gravity: z
          .enum(["LIGHT", "MEDIUM", "SERIOUS", "VERY_SERIOUS", "NO_POINTS"])
          .describe("Violation gravity level"),
        gravity_raw: z.string().describe("Raw gravity description"),
        points: z.number().describe("Points deducted from driver's license"),
        competent_agency: z
          .string()
          .describe("Competent agency for the violation"),
        created_at: z.string().describe("Creation timestamp"),
        updated_at: z.string().describe("Last update timestamp"),
        gravityLabel: z
          .string()
          .optional()
          .describe("Human-readable gravity label"),
        fullCode: z
          .string()
          .optional()
          .describe("Complete violation code (e.g., '5010-0')"),
      }),
    ),
    total: z.number().describe("Total number of traffic violation codes"),
  }),
  resourceNotFound: z.object({
    message: z.string().default("Recurso não encontrado!"),
  }),
  internalServerError: z.object({
    message: z.string().default("Erro interno do servidor"),
  }),
};

export { trafficViolationCodeSchemas, trafficViolationCodeResponses };
