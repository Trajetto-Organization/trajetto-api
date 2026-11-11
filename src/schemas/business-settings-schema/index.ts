import { z } from "zod";

import {
  CHECKLIST_REQUIREMENTS,
  GEOFENCE_MODES,
  GEOFENCE_RADIUS_MAX_M,
  GEOFENCE_RADIUS_MIN_M,
  type ChecklistRequirement,
  type GeofenceMode,
} from "@/shared/business/business-settings";
import { tenantLockedShape } from "@/shared/validation/tenant-locked-field";
import { fieldError } from "@/shared/validation/field-error";

/**
 * The company's own settings (plan of 02/11/2026, M1): the request body of
 * PUT /business/:businessId/settings and the shape the session (/user/me)
 * and the driver's payload (my-deliveries) carry.
 */

const checklistRequirementSchema = z
  .enum(
    CHECKLIST_REQUIREMENTS as [ChecklistRequirement, ...ChecklistRequirement[]],
  )
  .describe(
    "Quando a rota exige o checklist do veículo: NONE (não exige), ROUTE_START (no início), ROUTE_END (no fim) ou ROUTE_START_AND_END (nos dois).",
  );

const geofenceModeSchema = z
  .enum(GEOFENCE_MODES as [GeofenceMode, ...GeofenceMode[]])
  .describe(
    "Apontamento fora do raio do cliente — chegada, comprovante e ocorrência: DISABLED (não confere), ALERT (pede confirmação ao motorista e sinaliza o apontamento) ou BLOCK (impede chegada e comprovante fora do raio; a ocorrência nunca é impedida, só sinalizada). Posição sem precisão suficiente ou endereço sem coordenada nunca bloqueiam, e o envio que estava na fila offline nunca é recusado pelo servidor, só sinalizado.",
  );

const geofenceRadiusSchema = z
  .number(fieldError({ invalid: "O raio deve ser um número." }))
  .int("O raio deve ser um número inteiro de metros.")
  .min(
    GEOFENCE_RADIUS_MIN_M,
    `O raio mínimo é de ${GEOFENCE_RADIUS_MIN_M} metros.`,
  )
  .max(
    GEOFENCE_RADIUS_MAX_M,
    `O raio máximo é de ${GEOFENCE_RADIUS_MAX_M.toLocaleString("pt-BR")} metros.`,
  )
  .describe(
    `Raio limite para apontamento de eventos no cliente, em metros (${GEOFENCE_RADIUS_MIN_M} a ${GEOFENCE_RADIUS_MAX_M.toLocaleString("pt-BR")}).`,
  );

/** The values as the session and the driver's payload carry them. */
const businessSettingsValuesSchema = z.object({
  checklist_requirement: checklistRequirementSchema,
  arrival_geofence_mode: geofenceModeSchema,
  arrival_geofence_radius_m: geofenceRadiusSchema,
});

/**
 * The save: any of the three, at least one. The company comes from the path;
 * a `businessId` in the body is refused (decision 16.100), like every edit.
 */
const updateBusinessSettingsSchema = z
  .object({
    ...tenantLockedShape,
    checklist_requirement: checklistRequirementSchema.optional(),
    arrival_geofence_mode: geofenceModeSchema.optional(),
    arrival_geofence_radius_m: geofenceRadiusSchema.optional(),
  })
  .refine(
    (body) =>
      body.checklist_requirement !== undefined ||
      body.arrival_geofence_mode !== undefined ||
      body.arrival_geofence_radius_m !== undefined,
    { message: "Informe ao menos uma configuração para salvar." },
  );

type UpdateBusinessSettingsBody = z.infer<typeof updateBusinessSettingsSchema>;

export {
  businessSettingsValuesSchema,
  checklistRequirementSchema,
  geofenceModeSchema,
  geofenceRadiusSchema,
  updateBusinessSettingsSchema,
};
export type { UpdateBusinessSettingsBody };
