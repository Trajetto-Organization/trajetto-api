/**
 * The closed catalog of what the activity trail records (decision FLEET-ACT-2,
 * FLEET-ACT-4): every `status` and `type` a writer uses, with the product
 * module it belongs to.
 *
 * `Activity.status` and `Activity.type` are free text in the table, written
 * by some seventy call sites. The screen used to know nine statuses out of
 * roughly thirty, so the filter could not find "Entregue" or "Planejada" and
 * the badges fell back to grey. This list is what the filters accept and
 * what the web badge map mirrors (trajetto-ui src/features/activity/lib/
 * activity-catalog.ts; a web test compares both files).
 *
 * `aliases` are other spellings rows already carry: the vehicle writes
 * "Em Rota" while deliveries write "Em rota", and route activities recorded
 * the raw enum ("PLANNED"…) before FLEET-ACT-1. Filtering by the canonical
 * value finds them too, so the audit trail is searchable without rewriting
 * history.
 *
 * `module` drives which options a company sees (FLEET-ACT-4): the options
 * follow the contracted modules (MASTER sees all), the rows never hide —
 * they are the audit trail.
 */

type ActivityModule = "CORE" | "FLEET" | "DELIVERIES";

interface ActivityStatusEntry {
  value: string;
  module: ActivityModule;
  aliases?: readonly string[];
}

const ACTIVITY_STATUS_CATALOG = [
  // The result of a create / update / delete, any entity.
  { value: "Completo", module: "CORE" },
  { value: "Criado", module: "CORE" },
  { value: "Atualizado", module: "CORE" },
  { value: "Deletado", module: "CORE" },
  { value: "Pendente", module: "CORE", aliases: ["PENDING"] },
  // Entity states (user, branch, company, vehicle, webhook).
  { value: "Ativo", module: "CORE", aliases: ["ACTIVE"] },
  { value: "Inativo", module: "CORE", aliases: ["INACTIVE"] },
  { value: "Bloqueado", module: "CORE", aliases: ["BLOCKED"] },
  // Deliveries and routes.
  { value: "Em rota", module: "DELIVERIES", aliases: ["Em Rota", "IN_TRANSIT", "IN_ROUTE"] },
  { value: "Entregue", module: "DELIVERIES", aliases: ["DELIVERED"] },
  { value: "Insucesso", module: "DELIVERIES", aliases: ["FAILED"] },
  { value: "Cancelada", module: "DELIVERIES", aliases: ["CANCELLED"] },
  { value: "Planejada", module: "DELIVERIES", aliases: ["PLANNED"] },
  { value: "Liberada", module: "DELIVERIES", aliases: ["RELEASED"] },
  { value: "Em andamento", module: "DELIVERIES", aliases: ["IN_PROGRESS"] },
  { value: "Concluída", module: "DELIVERIES", aliases: ["COMPLETED"] },
  { value: "Aprovado", module: "DELIVERIES", aliases: ["APPROVED"] },
  { value: "Rejeitado", module: "DELIVERIES", aliases: ["REJECTED"] },
  { value: "Importada", module: "DELIVERIES" },
  { value: "Estornada", module: "DELIVERIES" },
  // Integrations (API keys and webhooks require Entregas, decision 4.3).
  { value: "Ativa", module: "DELIVERIES" },
  { value: "Revogada", module: "DELIVERIES" },
  { value: "Desativado", module: "DELIVERIES" },
  { value: "Pausado", module: "DELIVERIES" },
  { value: "Segredo trocado", module: "DELIVERIES" },
  { value: "Removido", module: "DELIVERIES" },
] as const satisfies readonly ActivityStatusEntry[];

type ActivityStatusValue = (typeof ACTIVITY_STATUS_CATALOG)[number]["value"];

const ACTIVITY_STATUS_VALUES = ACTIVITY_STATUS_CATALOG.map(
  (entry) => entry.value,
) as unknown as readonly [ActivityStatusValue, ...ActivityStatusValue[]];

interface ActivityTypeEntry {
  value: string;
  module: ActivityModule;
}

const ACTIVITY_TYPE_CATALOG = [
  { value: "Empresa", module: "CORE" },
  { value: "Plano", module: "CORE" },
  { value: "Filial", module: "CORE" },
  { value: "Usuário", module: "CORE" },
  { value: "Perfil de acesso", module: "CORE" },
  { value: "Permissão", module: "CORE" },
  { value: "Card Kanban", module: "CORE" },
  // Drivers and vehicles serve both modules.
  { value: "Veículo", module: "CORE" },
  { value: "Motorista", module: "CORE" },
  { value: "Tipo de veículo", module: "CORE" },
  { value: "Tipo de combustível", module: "CORE" },
  { value: "Abastecimento", module: "FLEET" },
  { value: "Checklist Veicular", module: "FLEET" },
  { value: "Ordem de serviço", module: "FLEET" },
  { value: "Peça", module: "FLEET" },
  { value: "Peça da ordem de serviço", module: "FLEET" },
  { value: "Fornecedor", module: "FLEET" },
  { value: "Conta a pagar", module: "FLEET" },
  { value: "Multa", module: "FLEET" },
  { value: "Entrega", module: "DELIVERIES" },
  { value: "Rota", module: "DELIVERIES" },
  { value: "Integração", module: "DELIVERIES" },
] as const satisfies readonly ActivityTypeEntry[];

type ActivityTypeValue = (typeof ACTIVITY_TYPE_CATALOG)[number]["value"];

const ACTIVITY_TYPE_VALUES = ACTIVITY_TYPE_CATALOG.map(
  (entry) => entry.value,
) as unknown as readonly [ActivityTypeValue, ...ActivityTypeValue[]];

const ACTIVITY_ACTIONS = ["create", "update", "delete"] as const;

type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/**
 * Who acted, as the reader sees it. DRIVER is a BUSINESS_USER linked to a
 * driver (the app's actions); PLATFORM is how a company sees a MASTER.
 */
const ACTIVITY_ACTOR_ROLES = [
  "MASTER",
  "BUSINESS_ADMIN",
  "BUSINESS_USER",
  "DRIVER",
  "PLATFORM",
] as const;

type ActivityActorRole = (typeof ACTIVITY_ACTOR_ROLES)[number];

/** Every stored spelling a canonical status stands for, itself first. */
function storedStatusesFor(values: readonly string[]): string[] {
  const stored = new Set<string>();

  for (const value of values) {
    const entry = ACTIVITY_STATUS_CATALOG.find((item) => item.value === value);

    stored.add(value);

    for (const alias of (entry as ActivityStatusEntry | undefined)?.aliases ?? []) {
      stored.add(alias);
    }
  }

  return Array.from(stored);
}

/** The canonical status of a stored one ("Em Rota" → "Em rota"), or itself. */
function canonicalStatus(stored: string): string {
  const entry = (ACTIVITY_STATUS_CATALOG as readonly ActivityStatusEntry[]).find(
    (item) => item.value === stored || item.aliases?.includes(stored),
  );

  return entry?.value ?? stored;
}

export {
  ACTIVITY_ACTIONS,
  ACTIVITY_ACTOR_ROLES,
  ACTIVITY_STATUS_CATALOG,
  ACTIVITY_STATUS_VALUES,
  ACTIVITY_TYPE_CATALOG,
  ACTIVITY_TYPE_VALUES,
  canonicalStatus,
  storedStatusesFor,
  type ActivityAction,
  type ActivityActorRole,
  type ActivityModule,
  type ActivityStatusValue,
  type ActivityTypeValue,
};
