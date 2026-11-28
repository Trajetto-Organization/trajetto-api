import { PLATFORM_ACTOR_NAME } from "@/shared/activity/actor-presentation";
import { formatDate } from "@/shared/utils/format-values";

/**
 * Small, pure formatters the WhatsApp renders share (plan of 02/11/2026,
 * B1). Each returns null for "nothing to say", never a placeholder: the
 * template registry replaces a null with the variable's own fallback, so the
 * wording of "não informado" lives in one place.
 */

/** One line: newlines, tabs and runs of spaces become one space. */
function oneLine(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;

  const flattened = text.replace(/\s+/g, " ").trim();

  return flattened.length > 0 ? flattened : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The short code the web prints as "OS #…": the last 12 characters of a
 * UUID (trajetto-ui src/lib/format-values.ts). Another shape goes whole.
 * Without "#", so a code pasted into the panel's search finds the record.
 */
function shortId(id: string): string {
  return UUID.test(id) ? id.slice(-12) : id;
}

/** The day a timestamp means, in the company's zone; null when absent. */
function dayLabel(
  value: string | Date | null | undefined,
  timeZone: string | null | undefined,
): string | null {
  if (value === null || value === undefined || value === "") return null;

  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) return null;

  return formatDate(date, timeZone);
}

/** "152.340 km": the columns are Float, the reading is whole kilometres. */
function formatMileage(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 }).format(value)} km`;
}

/** Odometer at the opening and, when there is one, after the service. */
function mileageLine(
  current: number | null | undefined,
  after: number | null | undefined,
): string | null {
  const opening = formatMileage(current);
  const closing = formatMileage(after);

  if (opening && closing) {
    return `${opening} na abertura e ${closing} após o serviço`;
  }

  if (opening) return `${opening} na abertura`;
  if (closing) return `${closing} após o serviço`;

  return null;
}

const MAINTENANCE_TYPE_LABELS: Record<string, string> = {
  INTERNAL: "Interna",
  EXTERNAL: "Externa",
};

const ACCOUNT_PAYABLE_CATEGORY_LABELS: Record<string, string> = {
  FUEL: "Combustível",
  MAINTENANCE: "Manutenção",
  INSURANCE: "Seguro",
  TAXES_FEES: "Impostos e taxas",
  FINES: "Multas",
  TOLLS: "Pedágio",
  RENTAL: "Locação",
  PAYROLL: "Folha de pagamento",
  OTHER: "Outros",
};

/** "Outros (descrição)" for OTHER with a description; null when absent. */
function accountPayableCategoryLabel(
  category: string | null | undefined,
  description?: string | null,
): string | null {
  if (!category) return null;

  const label = ACCOUNT_PAYABLE_CATEGORY_LABELS[category];

  if (!label) return null;

  const detail = oneLine(description);

  return category === "OTHER" && detail ? `${label} (${detail})` : label;
}

/**
 * Who acted, as an admin reads it: "Suporte Trajetto" for a MASTER (whose
 * identity the company never sees — actor-presentation.ts), otherwise
 * "Nome (e-mail)", the name or the e-mail alone, or null.
 */
function actorLabel(
  actor: {
    name?: string | null;
    email?: string | null;
    role?: string | null;
  },
  options: { maskMaster?: boolean } = {},
): string | null {
  if (options.maskMaster && actor.role === "MASTER") return PLATFORM_ACTOR_NAME;

  return nameWithEmail(actor.name, actor.email);
}

/** "Nome (e-mail)", either alone, or null. */
function nameWithEmail(
  name: string | null | undefined,
  email: string | null | undefined,
): string | null {
  const who = oneLine(name);
  const mail = oneLine(email);

  if (who && mail) return `${who} (${mail})`;

  return who ?? mail ?? null;
}

/**
 * Who asked the tower, with the role: " (motorista)" when a driver did — a
 * row without the field was written before panel requests existed, so it
 * was a driver — and the name alone for a request filed from the panel.
 * `waiting` adds that the driver stands at the address (the escalation).
 */
function requesterLabel(
  payload: { reporterName: string; fromDriver?: boolean },
  options: { waiting?: boolean } = {},
): string | null {
  const name = oneLine(payload.reporterName);

  if (!name) return null;

  if (payload.fromDriver === false) return name;

  return options.waiting
    ? `${name} (motorista, aguardando no endereço)`
    : `${name} (motorista)`;
}

/** "Rótulo: valor; Rótulo: valor", capped: a notice is not the report. */
function answersLine(
  answers: ReadonlyArray<{ label: string; value: string }> | null | undefined,
  max: number,
): string | null {
  if (!answers || answers.length === 0) return null;

  const line = answers
    .map(
      ({ label, value }) => `${oneLine(label) ?? ""}: ${oneLine(value) ?? ""}`,
    )
    .join("; ");

  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

const LIMIT_KIND_LABELS: Record<string, string> = {
  vehicle: "Veículos contratados",
  ai: "Fotos da Verificação IA",
};

/** Which contracted limit moved; null for one this build does not know. */
function limitKindLabel(limit: string): string | null {
  return LIMIT_KIND_LABELS[limit] ?? null;
}

/**
 * A limit with its unit and what zero means — the same sentences the panel
 * uses (vehicle-slots-copy.ts, ai-usage-copy.ts): 0 vehicles is "no limit
 * configured", 0 photos is "AI verification not enabled".
 */
function formatLimitValue(limit: string, value: number): string | null {
  if (!Number.isFinite(value)) return null;

  const count = value.toLocaleString("pt-BR");

  if (limit === "vehicle") {
    if (value === 0) return "Sem limite configurado";
    return value === 1 ? "1 veículo" : `${count} veículos`;
  }

  if (limit === "ai") {
    if (value === 0) return "Verificação IA não habilitada";
    return value === 1 ? "1 foto por mês" : `${count} fotos por mês`;
  }

  return count;
}

/**
 * The fields of a bill its WhatsApp template prints (B1), read off the row
 * the repository returned — with the supplier and the linked order's vehicle
 * when its include brought them (the DTO does not type the relations).
 */
function accountPayableNoticeFields(
  bill: {
    payee_name?: string | null;
    due_date?: Date | string | null;
    category?: string | null;
    category_description?: string | null;
    description?: string | null;
  },
  timeZone: string | null | undefined,
): {
  payeeName: string | null;
  dueDate: string | null;
  timeZone?: string;
  category: string | null;
  categoryDescription: string | null;
  description: string | null;
  serviceOrderVehiclePlate: string | null;
} {
  const related = bill as {
    supplier?: { name?: string | null } | null;
    serviceOrder?: {
      vehicle?: { license_plate?: string | null } | null;
    } | null;
  };

  const due = bill.due_date ? new Date(bill.due_date) : null;

  return {
    payeeName: related.supplier?.name || bill.payee_name || null,
    dueDate: due && !Number.isNaN(due.getTime()) ? due.toISOString() : null,
    ...(timeZone ? { timeZone } : {}),
    category: bill.category ?? null,
    categoryDescription: bill.category_description ?? null,
    description: bill.description ?? null,
    serviceOrderVehiclePlate:
      related.serviceOrder?.vehicle?.license_plate ?? null,
  };
}

export {
  ACCOUNT_PAYABLE_CATEGORY_LABELS,
  accountPayableNoticeFields,
  MAINTENANCE_TYPE_LABELS,
  accountPayableCategoryLabel,
  actorLabel,
  answersLine,
  dayLabel,
  formatLimitValue,
  formatMileage,
  limitKindLabel,
  mileageLine,
  nameWithEmail,
  oneLine,
  requesterLabel,
  shortId,
};
