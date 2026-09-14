import { NotificationCategory } from "@prisma/client";

import {
  BusinessLimitChangedPayload,
  BusinessModuleChangedPayload,
  NotificationPolicyEntry,
  PolicyDeps,
  RecipientRenderContext,
  RenderContext,
} from "../notification-types";

import { User } from "@/modules/user/dtos/user-dto";

/**
 * Notification policies for changes to what a company has contracted:
 * hired modules, fleet size and AI quota.
 *
 * These are the only actions in the product that change what the customer
 * paid for, and until now they were also the only ones leaving no trace —
 * creating a permission was audited, switching off a whole module was not.
 *
 * Two audiences hear about it, for different reasons:
 *
 *   the other masters — oversight, and the reason this is `mandatory`: if a
 *                       master session is stolen and starts switching modules
 *                       off, this notice is how anyone finds out. Same
 *                       reasoning as "your password was changed".
 *   the company's admins — so "why did the menu disappear?" has an answer on
 *                       screen instead of becoming a support ticket.
 *
 * The actor is deliberately not notified: they confirmed a dialog two seconds
 * ago. Their record is the activity entry, which is searchable and permanent.
 */

/**
 * The tenant is allowed to see this MASTER action. Activities authored by a
 * MASTER are hidden from company users by default; their own plan changing is
 * the exception, and this marker is what carries it through the query.
 */
const TENANT_VISIBLE = "TENANT_VISIBLE";

const MODULE_LABELS: Record<string, string> = {
  FLEET: "Gestão de Frota",
  DELIVERIES: "Entregas",
};

const LIMIT_LABELS: Record<string, string> = {
  vehicle: "Limite de veículos",
  ai: "Limite de análises com IA",
};

function moduleLabel(module: string): string {
  return MODULE_LABELS[module] ?? module;
}

function limitLabel(limit: string): string {
  return LIMIT_LABELS[limit] ?? limit;
}

/**
 * Every master except the one who acted, plus the admins of the affected
 * company. Revoked accounts are already excluded by findOtherMasters; the
 * company side filters them here.
 */
async function resolvePlanAudience(
  businessId: string,
  actorId: string,
  deps: PolicyDeps,
): Promise<User[]> {
  const [masters, companyUsers] = await Promise.all([
    deps.userRepository.findOtherMasters(actorId),
    deps.userRepository.findUsersByBusiness(businessId),
  ]);

  const admins = companyUsers.filter(
    (user) =>
      user.role === "BUSINESS_ADMIN" && !user.access_revoked && user.id !== actorId,
  );

  // A master who also belongs to the company would otherwise be paged twice.
  const seen = new Set<string>();

  return [...masters, ...admins].filter((user) => {
    if (seen.has(user.id)) return false;

    seen.add(user.id);
    return true;
  });
}

/** Masters oversee every company; admins are being told about their own. */
function isMaster(recipient: RecipientRenderContext): boolean {
  return recipient.role === "MASTER";
}

// ============================================================================
// business-module.changed — a module was switched on or off for a company
// ============================================================================

const businessModuleChangedPolicy: NotificationPolicyEntry<BusinessModuleChangedPayload> =
  {
    category: NotificationCategory.SYSTEM,

    // Losing a whole module is not the kind of thing a preference should be
    // able to silence — for the admin it explains a menu that vanished, for
    // the other masters it is the tripwire on a stolen session.
    mandatory: true,

    async resolveRecipients(payload, deps) {
      return resolvePlanAudience(payload.businessId, payload.actor.id, deps);
    },

    renderInApp(
      payload,
      ctx: RenderContext,
      recipient: RecipientRenderContext,
    ) {
      const label = moduleLabel(payload.module);
      const verb = payload.enabled ? "habilitado" : "desabilitado";

      if (isMaster(recipient)) {
        return {
          type: "business-plan",
          title: `Módulo ${verb}: ${payload.businessName}`,
          message: `${payload.actor.name} (${payload.actor.email}) ${verb} o módulo ${label} da empresa ${payload.businessName}.`,
          link: `${ctx.baseUrl}/admin/business?search=${payload.businessId}&page=1`,
          entityId: payload.businessId,
        };
      }

      return {
        type: "business-plan",
        title: payload.enabled
          ? `Módulo ${label} habilitado`
          : `Módulo ${label} desabilitado`,
        message: payload.enabled
          ? `O módulo ${label} foi habilitado para a sua empresa. As telas correspondentes já estão disponíveis no menu.`
          : `O módulo ${label} foi desabilitado para a sua empresa. As telas saíram do menu, mas nenhum dado foi apagado — ao reabilitar, tudo volta como estava.`,
        link: `${ctx.baseUrl}/dashboard`,
        entityId: payload.businessId,
      };
    },

    renderWhatsApp(payload) {
      const label = moduleLabel(payload.module);
      const verb = payload.enabled ? "habilitado" : "desabilitado";

      return [
        `${payload.enabled ? "✅" : "🚫"} *Módulo ${verb}*`,
        `Empresa: *${payload.businessName}*`,
        `Módulo: *${label}*`,
        `Por: *${payload.actor.name}* (${payload.actor.email})`,
        payload.enabled
          ? `As telas do módulo já estão disponíveis.`
          : `Nenhum dado foi apagado — ao reabilitar, tudo volta como estava.`,
      ].join("\n");
    },

    renderActivity(payload) {
      const label = moduleLabel(payload.module);

      return {
        type: "Plano",
        action: "update",
        entityId: payload.businessId,
        description:
          `Módulo ${label}: ${payload.previousEnabled ? "habilitado" : "desabilitado"} → ` +
          `${payload.enabled ? "habilitado" : "desabilitado"} | Empresa: ${payload.businessName}`,
        status: payload.enabled ? "Ativo" : "Inativo",
        tenantName: payload.businessName,
        visibilityLevel: TENANT_VISIBLE,
        performingUserRole: payload.actor.role,
      };
    },
  };

// ============================================================================
// business-limit.changed — contracted fleet size or AI quota moved
// ============================================================================

const businessLimitChangedPolicy: NotificationPolicyEntry<BusinessLimitChangedPayload> =
  {
    category: NotificationCategory.SYSTEM,
    mandatory: true,

    async resolveRecipients(payload, deps) {
      return resolvePlanAudience(payload.businessId, payload.actor.id, deps);
    },

    renderInApp(
      payload,
      ctx: RenderContext,
      recipient: RecipientRenderContext,
    ) {
      const label = limitLabel(payload.limit);
      const movement = `${payload.previousValue} → ${payload.newValue}`;

      if (isMaster(recipient)) {
        return {
          type: "business-plan",
          title: `${label} alterado: ${payload.businessName}`,
          message: `${payload.actor.name} (${payload.actor.email}) alterou o ${label.toLowerCase()} da empresa ${payload.businessName} de ${movement}.`,
          link: `${ctx.baseUrl}/admin/business?search=${payload.businessId}&page=1`,
          entityId: payload.businessId,
        };
      }

      return {
        type: "business-plan",
        title: `${label} atualizado`,
        message: `O ${label.toLowerCase()} da sua empresa foi alterado de ${movement}. Acompanhe o consumo na aba Limites de Uso.`,
        link: `${ctx.baseUrl}/dashboard`,
        entityId: payload.businessId,
      };
    },

    renderWhatsApp(payload) {
      const label = limitLabel(payload.limit);

      return [
        `📈 *${label} alterado*`,
        `Empresa: *${payload.businessName}*`,
        `De *${payload.previousValue}* para *${payload.newValue}*`,
        `Por: *${payload.actor.name}* (${payload.actor.email})`,
      ].join("\n");
    },

    renderActivity(payload) {
      return {
        type: "Plano",
        action: "update",
        entityId: payload.businessId,
        description: `${limitLabel(payload.limit)}: ${payload.previousValue} → ${payload.newValue} | Empresa: ${payload.businessName}`,
        status: "Atualizado",
        tenantName: payload.businessName,
        visibilityLevel: TENANT_VISIBLE,
        performingUserRole: payload.actor.role,
      };
    },
  };

export {
  businessModuleChangedPolicy,
  businessLimitChangedPolicy,
  resolvePlanAudience,
  moduleLabel,
  limitLabel,
  TENANT_VISIBLE,
};
