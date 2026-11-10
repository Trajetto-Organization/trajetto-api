import type {
  ChecklistPhase,
  FuelAlert,
  OccurrenceAuthorizationStatus,
  OccurrenceCategory,
  ProofSignatureStatus,
  RecordOrigin,
} from "@prisma/client";

import { DEFAULT_BUSINESS_TIMEZONE } from "@/shared/time/business-day";

/**
 * What Postgres stores for a column an INSERT leaves out, for the columns the
 * in-memory repositories must mirror: the NOT NULL defaults, and NULL for the
 * nullable columns the final-phase migrations added (20260928120200) and the
 * meeting's (20261005120100..0500, docs/desenho/esquema-reuniao.md).
 *
 * A Prisma repository returns the whole row, so these come back even while
 * the DTO does not name them yet. A fake that builds its row from the DTO
 * alone returns undefined instead: `authorization_status === "NOT_REQUIRED"`
 * false, a business with no zone, `authorizedById === null` false.
 * Decision 13.2: the fake and the database must agree. Apply them with
 * `withColumnDefaults`, or spread them first where the fake lists every key.
 *
 * tests/E2E/schema-expand-contract.test.ts pins every entry to the real
 * column (its default, or nullable with none); changing one side alone fails
 * there.
 */
const BUSINESS_COLUMN_DEFAULTS = {
  timezone: DEFAULT_BUSINESS_TIMEZONE,
} as const;

const OCCURRENCE_TYPE_COLUMN_DEFAULTS = {
  requires_photo: false,
  blocks_delivery: false,
  form_fields: null,
  form_version: 1,
  requires_authorization: false,
  is_system: false,
  // Decisions 14.3 and 14.4.
  category: "NOT_DELIVERED",
  requires_receipt_photo: false,
  requires_signature: false,
  pause_kind: null,
  system_key: null,
  deactivated_at: null,
  // Plan of 02/11/2026: the ERP code (L8) and the requirements' clock (K2).
  code: null,
  requirements_changed_at: null,
} as const satisfies Record<string, unknown> & { category: OccurrenceCategory };

const DELIVERY_COLUMN_DEFAULTS = {
  apiKeyId: null,
  // The meeting of 14/10/2026: a delivery created without a type is an
  // "Entrega".
  kind: "DELIVERY",
  // Decision 14.7: the address point for the route map.
  latitude: null,
  longitude: null,
  geo_source: null,
  geo_updated_at: null,
  // Plan of 02/11/2026 (E1): the geocoder's level and its bookkeeping.
  geo_precision: null,
  geocode_status: null,
  geocode_attempted_at: null,
  geocode_attempts: 0,
} as const;

const DELIVERY_EVENT_COLUMN_DEFAULTS = {
  occurrenceId: null,
  // L9: the API key behind an INTEGRATION event.
  apiKeyId: null,
  // Decision 14.8: the proof document's phone, stamp and address.
  device_id: null,
  photo_taken_at: null,
  gps_address: null,
  gps_address_source: null,
  gps_geocoded_at: null,
  // Plan of 02/11/2026 (E4): the geofence record of the action.
  distance_m: null,
  accuracy_m: null,
  geofence_outcome: null,
} as const;

const DELIVERY_OCCURRENCE_COLUMN_DEFAULTS = {
  authorization_status: "NOT_REQUIRED",
  form_answers: null,
  form_version: null,
  authorizedById: null,
  authorized_at: null,
  authorization_note: null,
  escalated_at: null,
  // Decision 14.3.
  category: "NOT_DELIVERED",
  receipt_photo: null,
  signature: null,
  received_by: null,
  // Plan of 02/11/2026 (E3/E4): the geofence record of the report.
  distance_m: null,
  accuracy_m: null,
  geofence_outcome: null,
} as const satisfies Record<string, unknown> & {
  authorization_status: OccurrenceAuthorizationStatus;
  category: OccurrenceCategory;
};

const ROUTE_COLUMN_DEFAULTS = {
  destination: null,
  // Decisions 14.4 and 14.7.
  released_at: null,
  plan_version: 0,
  client_submission_id: null,
  // Plan of 02/11/2026, K11 (D26).
  closure_reason: null,
  left_open_alerted_at: null,
} as const;

const ROUTE_STOP_COLUMN_DEFAULTS = {
  on_the_way_at: null,
  // Plan of 02/11/2026 (B6): a stop of its own until the key is written.
  stop_group_key: null,
} as const;

const CHAT_MESSAGE_COLUMN_DEFAULTS = {
  routeId: null,
  // Decision 14.5: null until the ticket code writes it.
  ticketId: null,
} as const;

// ── The meeting of 01/10/2026 (decisions 14.2, 14.6, 14.8) ──

const SHIPPER_COLUMN_DEFAULTS = {
  corporate_reason: null,
} as const;

const USER_COLUMN_DEFAULTS = {
  ops_alert_sound_enabled: true,
  // 20261106120000: nobody must change a password they set themselves.
  must_change_password: false,
} as const;

const DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS = {
  layout_version: 1,
  signature_status: "UNSIGNED",
  unsigned_reason: null,
  signature_profile: null,
  signer_name: null,
  signer_cnpj: null,
  cert_serial: null,
  cert_issuer: null,
  cert_not_after: null,
  signed_at: null,
  cert_icp_brasil: null,
} as const satisfies Record<string, unknown> & {
  signature_status: ProofSignatureStatus;
};

const DELIVERY_PROOF_AUDIT_COLUMN_DEFAULTS = {
  device_precheck: null,
  device_agreement: null,
} as const;

const FUEL_COLUMN_DEFAULTS = {
  odometer_device_precheck: null,
  odometer_device_agreement: null,
  // Plan of 02/11/2026 (C5/F3): made outside a route.
  routeId: null,
  // 20261105130000: no alert, and nothing behind one. A fake copies the
  // array before storing it (one row's alerts are never another's).
  alerts: [],
  recent_refuel_reason: null,
  recent_refuel_previous_at: null,
} as const satisfies Record<string, unknown> & {
  alerts: readonly FuelAlert[];
};

const VEHICLE_CHECKLIST_COLUMN_DEFAULTS = {
  mileage_device_precheck: null,
  mileage_device_agreement: null,
  // Plan of 02/11/2026 (C4/F3): made outside a route.
  routeId: null,
  phase: "STANDALONE",
  // 20261105120000: what the web's form gets, which sends no origin and no
  // key (shared/vehicle/record-origin.ts).
  created_from: "WEB_DASHBOARD",
} as const satisfies Record<string, unknown> & {
  phase: ChecklistPhase;
  created_from: RecordOrigin;
};

// Plan of 02/11/2026 (F1): no responsible = the company's admins.
const VEHICLE_COLUMN_DEFAULTS = {
  responsibleUserId: null,
} as const;

const ACCOUNT_PAYABLE_COLUMN_DEFAULTS = {
  supplierId: null,
  vehicleId: null,
  payee_name: null,
  description: null,
  document_number: null,
  createdById: null,
} as const;

const DRIVER_COLUMN_DEFAULTS = {
  cnh_category: null,
  cnh_expires_at: null,
} as const;

const VEHICLE_TYPE_COLUMN_DEFAULTS = {
  required_cnh_category: null,
} as const;

/** Every constant above by its SQL table, for the E2E pin. */
const COLUMN_DEFAULTS_BY_TABLE = {
  business: BUSINESS_COLUMN_DEFAULTS,
  occurrence_type: OCCURRENCE_TYPE_COLUMN_DEFAULTS,
  delivery: DELIVERY_COLUMN_DEFAULTS,
  delivery_event: DELIVERY_EVENT_COLUMN_DEFAULTS,
  delivery_occurrence: DELIVERY_OCCURRENCE_COLUMN_DEFAULTS,
  route: ROUTE_COLUMN_DEFAULTS,
  route_stop: ROUTE_STOP_COLUMN_DEFAULTS,
  chat_message: CHAT_MESSAGE_COLUMN_DEFAULTS,
  account_payable: ACCOUNT_PAYABLE_COLUMN_DEFAULTS,
  driver: DRIVER_COLUMN_DEFAULTS,
  vehicle_type: VEHICLE_TYPE_COLUMN_DEFAULTS,
  shipper: SHIPPER_COLUMN_DEFAULTS,
  user: USER_COLUMN_DEFAULTS,
  delivery_proof_document: DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS,
  delivery_proof_audit: DELIVERY_PROOF_AUDIT_COLUMN_DEFAULTS,
  fuel: FUEL_COLUMN_DEFAULTS,
  vehicle_checklist: VEHICLE_CHECKLIST_COLUMN_DEFAULTS,
  vehicle: VEHICLE_COLUMN_DEFAULTS,
} as const satisfies Record<string, Record<string, unknown>>;

/** A defaulted key is always present: the caller's value or the default. */
type RowWithDefaults<Defaults, Data> = Omit<Data, keyof Defaults> & {
  [Key in keyof Defaults]: Key extends keyof Data
    ? Exclude<Data[Key], undefined> | Defaults[Key]
    : Defaults[Key];
};

/**
 * A new row as the table stores it: the column defaults, overridden by every
 * value the caller actually gave.
 *
 * Prisma reads an `undefined` key as "not given" and lets the default apply,
 * and use cases build payloads like `{ authorization_status: needsAuth ?
 * "PENDING" : undefined }`. A plain `{ ...defaults, ...data }` would store
 * undefined over the default there.
 */
function withColumnDefaults<Defaults extends object, Data extends object>(
  defaults: Defaults,
  data: Data,
): RowWithDefaults<Defaults, Data> {
  const given = Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );

  return { ...defaults, ...given } as RowWithDefaults<Defaults, Data>;
}

export {
  ACCOUNT_PAYABLE_COLUMN_DEFAULTS,
  BUSINESS_COLUMN_DEFAULTS,
  CHAT_MESSAGE_COLUMN_DEFAULTS,
  COLUMN_DEFAULTS_BY_TABLE,
  DELIVERY_COLUMN_DEFAULTS,
  DELIVERY_EVENT_COLUMN_DEFAULTS,
  DELIVERY_OCCURRENCE_COLUMN_DEFAULTS,
  DELIVERY_PROOF_AUDIT_COLUMN_DEFAULTS,
  DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS,
  DRIVER_COLUMN_DEFAULTS,
  FUEL_COLUMN_DEFAULTS,
  OCCURRENCE_TYPE_COLUMN_DEFAULTS,
  ROUTE_COLUMN_DEFAULTS,
  ROUTE_STOP_COLUMN_DEFAULTS,
  SHIPPER_COLUMN_DEFAULTS,
  USER_COLUMN_DEFAULTS,
  VEHICLE_CHECKLIST_COLUMN_DEFAULTS,
  VEHICLE_COLUMN_DEFAULTS,
  VEHICLE_TYPE_COLUMN_DEFAULTS,
  withColumnDefaults,
};
