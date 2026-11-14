import { NotificationCategory } from "@prisma/client";

import {
  MasterUserAccountUpdatedPayload,
  MasterUserCreatedPayload,
  MasterUserUpdatedPayload,
  MasterUserWelcomedPayload,
  NotificationPolicyEntry,
  PolicyDeps,
  RenderContext,
} from "../notification-types";
import type { RenderedWhatsApp } from "../whatsapp-templates";
import { nameWithEmail } from "../whatsapp-parameters";

/**
 * Notification policies for MASTER account management.
 *
 * Each operation tells two different people two different things — the
 * performing MASTER hears "you did X", the affected MASTER hears "X happened
 * to your account" — so each operation publishes two topics rather than one
 * render trying to serve both. Activities carry SYSTEM visibility: they exist
 * outside any tenant.
 */

async function resolveSingleUser(userId: string, deps: PolicyDeps) {
  const user = await deps.userRepository.findUserById(userId);
  return user ? [user] : [];
}

// ============================================================================
// master-user.created — for the performing MASTER
// ============================================================================

const masterUserCreatedPolicy: NotificationPolicyEntry<MasterUserCreatedPayload> =
  {
    category: NotificationCategory.ACCOUNT,

    async resolveRecipients(payload, deps) {
      return resolveSingleUser(payload.actorUserId, deps);
    },

    renderInApp(payload, ctx: RenderContext) {
      return {
        type: "master-user",
        title: "Novo Usuário Master Criado",
        message: `Você criou o usuário Master ${payload.masterName} (${payload.masterEmail}).`,
        link: `${ctx.baseUrl}/admin/master-users?search=${payload.masterUserId}&page=1`,
        entityId: payload.masterUserId,
      };
    },

    // trajetto_master_criado (B1): the confirmation of what the reader did.
    renderWhatsApp(payload): RenderedWhatsApp {
      return {
        template: "trajetto_master_criado",
        parameters: [payload.masterName, payload.masterEmail],
      };
    },

    renderActivity(payload) {
      return {
        type: "Usuário",
        action: "create",
        entityId: payload.masterUserId,
        description: `Usuário Master ${payload.masterName} criado | E-mail não verificado: ${payload.masterEmail}`,
        status: "Pendente",
        visibilityLevel: "SYSTEM",
      };
    },
  };

// ============================================================================
// master-user.welcomed — for the freshly created MASTER
// ============================================================================

const masterUserWelcomedPolicy: NotificationPolicyEntry<MasterUserWelcomedPayload> =
  {
    category: NotificationCategory.ACCOUNT,

    // A brand-new account must see its welcome regardless of preferences the
    // user has never even set.
    mandatory: true,

    // The credentials already went out as a dedicated e-mail; doubling the
    // welcome into the inbox would just bury them.
    suppressEmail: true,

    async resolveRecipients(payload, deps) {
      return resolveSingleUser(payload.masterUserId, deps);
    },

    renderInApp(payload, ctx: RenderContext) {
      return {
        type: "master-user",
        title: "Bem-vindo ao Trajetto",
        message: `Sua conta Master foi criada por ${payload.performingUserName} (${payload.performingUserEmail}). Suas credenciais foram enviadas por e-mail.`,
        link: `${ctx.baseUrl}/admin`,
        entityId: payload.masterUserId,
      };
    },
  };

// ============================================================================
// master-user.updated — for the performing MASTER
// ============================================================================

/**
 * Two templates where one render used to serve both (B1): the master who
 * made the change reads "você alterou", the master whose account changed
 * reads the security notice with who did it.
 */
function renderMasterUserUpdatedWhatsApp(
  payload: MasterUserUpdatedPayload,
): RenderedWhatsApp {
  return {
    template: "trajetto_master_atualizado",
    parameters: [payload.beforeName, payload.changesNotificationText],
  };
}

function renderMasterAccountUpdatedWhatsApp(
  payload: MasterUserAccountUpdatedPayload,
): RenderedWhatsApp {
  return {
    template: "trajetto_conta_master_atualizada",
    parameters: [
      payload.changesNotificationText,
      nameWithEmail(payload.performingUserName, payload.performingUserEmail),
    ],
  };
}

const masterUserUpdatedPolicy: NotificationPolicyEntry<MasterUserUpdatedPayload> =
  {
    category: NotificationCategory.ACCOUNT,

    async resolveRecipients(payload, deps) {
      return resolveSingleUser(payload.actorUserId, deps);
    },

    renderInApp(payload, ctx: RenderContext) {
      return {
        type: "master-user",
        title: "Usuário Master Atualizado",
        message: `Você atualizou o usuário Master ${payload.beforeName}. Campos alterados: ${payload.changesNotificationText}.`,
        link: `${ctx.baseUrl}/admin/master-users?search=${payload.masterUserId}&page=1`,
        entityId: payload.masterUserId,
      };
    },

    renderWhatsApp: renderMasterUserUpdatedWhatsApp,

    renderActivity(payload) {
      return {
        type: "Usuário",
        action: "update",
        entityId: payload.masterUserId,
        description: `Usuário Master ${payload.masterName} atualizado | Campos: ${payload.changesActivityText}`,
        status: "Atualizado",
        visibilityLevel: "SYSTEM",
      };
    },
  };

// ============================================================================
// master-user.account-updated — for the MASTER whose account changed
// ============================================================================

const masterUserAccountUpdatedPolicy: NotificationPolicyEntry<MasterUserAccountUpdatedPayload> =
  {
    category: NotificationCategory.ACCOUNT,

    // "Someone changed your account" is a security notice, not noise.
    mandatory: true,

    // The use case already mails this master directly, with the fuller
    // template (old and new name or e-mail; update-master-user-usecase.ts),
    // and a link-only change mails the link itself. This e-mail landed in
    // the same inbox as a second copy of the event (14/11/2026, decision
    // D-52). The bell, the phone and the WhatsApp stay.
    suppressEmail: true,

    async resolveRecipients(payload, deps) {
      return resolveSingleUser(payload.masterUserId, deps);
    },

    renderInApp(payload, ctx: RenderContext) {
      return {
        type: "master-user",
        title: "Sua Conta Foi Atualizada",
        message: `${payload.performingUserName} (${payload.performingUserEmail}) atualizou sua conta. Campos alterados: ${payload.changesNotificationText}.`,
        link: `${ctx.baseUrl}/profile`,
        entityId: payload.masterUserId,
      };
    },

    renderWhatsApp: renderMasterAccountUpdatedWhatsApp,
  };

export {
  masterUserCreatedPolicy,
  masterUserWelcomedPolicy,
  masterUserUpdatedPolicy,
  masterUserAccountUpdatedPolicy,
  renderMasterAccountUpdatedWhatsApp,
  renderMasterUserUpdatedWhatsApp,
};
