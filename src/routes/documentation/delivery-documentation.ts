import { z } from "zod";

import { createDeliverySchema } from "@/schemas/create-delivery-schema";
import { updateDeliverySchema } from "@/schemas/update-delivery-schema";

import { updateDeliveryStatusSchema } from "@/schemas/update-delivery-status-schema";
import { assignDeliveriesSchema } from "@/schemas/assign-deliveries-schema";

import { deliveryArrivalSchema } from "@/schemas/delivery-arrival-schema";
import { deliveryProofSchema } from "@/schemas/delivery-proof-schema";
import { reportDeliveryOccurrenceSchema } from "@/schemas/report-delivery-occurrence-schema";

import { importDeliveryXmlSchema } from "@/schemas/import-delivery-xml-schema";
import { listDeliverySchema } from "@/schemas/list-delivery-schema";

import { listOccurrencesSchema } from "@/schemas/list-occurrences-schema";
import { operationSummarySchema } from "@/schemas/operation-summary-schema";

import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";
import { updateDeleteDeliverySchema } from "@/schemas/update-delete-delivery-schema";

const deliveryStatusEnum = z.enum([
  "PENDING",
  "IN_TRANSIT",
  "DELIVERED",
  "FAILED",
  "CANCELLED",
]);

const deliveryListEntity = z.object({
  id: z.string(),
  code: z.string().nullable(),
  invoice_key: z.string().nullable(),
  invoice_number: z.string().nullable(),
  recipient_name: z.string(),
  city: z.string(),
  uf: z.string(),
  status: deliveryStatusEnum,
  scheduled_date: z.string().nullable(),
  delivered_at: z.string().nullable(),
  shipper: z.object({ id: z.string(), name: z.string() }).nullable(),
  driver: z
    .object({ id: z.string(), name: z.string(), cnh: z.string() })
    .nullable(),
  vehicle: z.object({ id: z.string(), license_plate: z.string() }).nullable(),
  created_at: z.string(),
});

const deliverySchemas = {
  businessIdParam: updateDeleteBusinessSchema,
  deliveryBusinessParams: updateDeleteBusinessSchema.merge(
    updateDeleteDeliverySchema,
  ),
  createDelivery: createDeliverySchema,
  updateDelivery: updateDeliverySchema,
  updateDeliveryStatus: updateDeliveryStatusSchema,
  assignDeliveries: assignDeliveriesSchema,
  deliveryArrival: deliveryArrivalSchema,
  deliveryProof: deliveryProofSchema,
  reportOccurrence: reportDeliveryOccurrenceSchema,
  importDeliveryXml: importDeliveryXmlSchema,
  listDeliveries: listDeliverySchema,
  listOccurrences: listOccurrencesSchema,
  operationSummary: operationSummarySchema,
};

const deliveryResponses = {
  deliveryCreated: z.object({
    message: z.string().default("Entrega criada com sucesso!"),
    data: z.object({ id: z.string() }),
  }),
  deliveryUpdated: z.object({
    message: z.string().default("Entrega atualizada com sucesso!"),
  }),
  deliveryStatusUpdated: z.object({
    message: z.string().default("Status da entrega atualizado com sucesso!"),
  }),
  deliveriesAssigned: z.object({
    message: z.string().default("Entregas atribuídas com sucesso!"),
    data: z.object({ assigned: z.number() }),
  }),
  // Deliveries carry nested items whose shape evolves with the module —
  // validated by zod at write time, passed through on read (same rule as
  // deliveryDetail).
  myDeliveries: z.object({
    data: z.array(z.unknown()),
    occurrence_types: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        requires_photo: z.boolean(),
        blocks_delivery: z.boolean(),
      }),
    ),
  }),
  routeStarted: z.object({
    message: z.string(),
    data: z.object({ started: z.number() }),
  }),
  arrivalRegistered: z.object({
    message: z.string().default("Chegada registrada com sucesso!"),
  }),
  proofRegistered: z.object({
    message: z.string().default("Entrega comprovada com sucesso!"),
  }),
  occurrenceReported: z.object({
    message: z.string().default("Ocorrência registrada com sucesso!"),
  }),
  deliveriesImported: z.object({
    message: z.string(),
    data: z.object({
      imported: z.number(),
      duplicated: z.number(),
      invalid: z.number(),
      created_shippers: z
        .array(z.string())
        .describe("Embarcadores criados a partir do emitente das notas."),
      results: z.array(
        z.object({
          filename: z.string(),
          outcome: z.enum(["imported", "duplicated", "invalid"]),
          invoice_key: z.string().nullable(),
          recipient_name: z.string().nullable(),
          message: z
            .string()
            .nullable()
            .describe("Motivo acionável quando o arquivo não virou entrega."),
        }),
      ),
    }),
  }),
  deliveryList: z.object({
    data: z.array(deliveryListEntity),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
  // Detail carries nested items/occurrences whose shape evolves with the
  // module — validated by zod at write time, passed through on read.
  deliveryDetail: z.object({ data: z.unknown() }),
  // Feed rows nest type/delivery/reporter — same pass-through rule.
  occurrenceList: z.object({
    data: z.array(z.unknown()),
    total: z.number(),
    currentPage: z.number(),
    pageSize: z.number(),
    totalPages: z.number(),
  }),
  operationSummaryResult: z.object({
    data: z.object({
      totals: z.object({
        unassigned: z
          .number()
          .describe("Pendentes sem motorista — o que ainda deve rota."),
        designated: z.number(),
        inRoute: z.number(),
        deliveredToday: z.number(),
        failedToday: z.number(),
        occurrencesToday: z.number(),
      }),
      drivers: z.array(
        z.object({
          driverId: z.string(),
          driverName: z.string(),
          cnh: z.string(),
          designated: z.number(),
          inRoute: z.number(),
          deliveredToday: z.number(),
          failedToday: z.number(),
        }),
      ),
    }),
  }),
  genericError: z.object({ message: z.string() }),
  internalServerError: z.object({
    message: z.string().default("Internal server error"),
  }),
};

export { deliverySchemas, deliveryResponses };
