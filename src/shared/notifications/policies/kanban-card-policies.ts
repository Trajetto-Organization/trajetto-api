import { NotificationCategory } from "@prisma/client";

import { formatDate } from "@/shared/utils/format-values";
import { redirectPage } from "@/shared/utils/link-redirect-page";

import {
  KanbanCardCreatedPayload,
  KanbanCardUpdatedPayload,
  NotificationPolicyEntry,
  PolicyDeps,
  RecipientRenderContext,
  RenderContext,
  RenderedActivity,
  RenderedInApp,
} from "../notification-types";

/**
 * Notification policies for kanban cards.
 *
 * Both topics share the recipient rule (the assigned user, when there is
 * one), the link and the WhatsApp body — what changes between them is who is
 * being told what: a fresh assignment versus an update that handed the card
 * over. Kept in one file so the shared pieces stay visibly shared.
 */

interface KanbanCardContent {
  cardId: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: string | null;
  /** The company's zone the due day is read in; absent on older events. */
  timeZone?: string;
}

function priorityInfo(priority: string): { emoji: string; text: string } {
  switch (priority.toLowerCase()) {
    case "urgent":
      return { emoji: "🆘", text: "Urgente" };
    case "high":
      return { emoji: "🔴", text: "Alta" };
    case "medium":
      return { emoji: "🟡", text: "Média" };
    default:
      return { emoji: "🟢", text: "Baixa" };
  }
}

function kanbanCardLink(
  ctx: RenderContext,
  recipient: RecipientRenderContext,
  cardId: string,
): string {
  const basePath = redirectPage(recipient.role, recipient.driverId);
  return `${ctx.baseUrl}/${basePath}/kanban?search=${cardId}&page=1`;
}

function kanbanCardWhatsAppBody(
  header: string,
  card: KanbanCardContent,
): string {
  const priority = priorityInfo(card.priority);

  return [
    header,
    `Título: *${card.title}*`,
    card.description && `Descrição: ${card.description}`,
    `Prioridade: ${priority.emoji} *${priority.text}*`,
    card.dueDate &&
      `Data de vencimento: *${formatDate(card.dueDate, card.timeZone)}*`,
    `Identificador do card: *${card.cardId}*`,
    `Para mais detalhes, acesse o sistema.`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderKanbanCardCreatedWhatsApp(card: KanbanCardContent): string {
  return kanbanCardWhatsAppBody(
    `📋 *Novo Card Atribuído! Você foi designado como responsável por um novo card no kanban*`,
    card,
  );
}

function renderKanbanCardUpdatedWhatsApp(card: KanbanCardContent): string {
  return kanbanCardWhatsAppBody(
    `📝 *Card Atualizado! Você foi designado como responsável por um card atualizado no kanban*`,
    card,
  );
}

async function resolveAssignedRecipient(
  assignedUserId: string | null,
  deps: PolicyDeps,
) {
  if (!assignedUserId) return [];

  const assigned = await deps.userRepository.findUserById(assignedUserId);
  return assigned ? [assigned] : [];
}

// ============================================================================
// kanban-card.created
// ============================================================================

function renderKanbanCardCreatedInApp(
  payload: KanbanCardCreatedPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): RenderedInApp {
  return {
    type: "kanban-card",
    title: "Novo Card Atribuído",
    message: `Você foi designado como responsável pelo card "${payload.title}" no kanban`,
    link: kanbanCardLink(ctx, recipient, payload.cardId),
    entityId: payload.cardId,
  };
}

function renderKanbanCardCreatedActivity(
  payload: KanbanCardCreatedPayload,
): RenderedActivity {
  return {
    type: "Card Kanban",
    action: "create",
    entityId: payload.cardId,
    description: payload.fromServiceOrder
      ? `Card "${payload.title}" criado automaticamente a partir de ordem de serviço | ID: ${payload.cardId}`
      : `Card "${payload.title}" criado com sucesso no kanban | ID: ${payload.cardId}`,
    status: payload.isCompleted ? "Completo" : "Pendente",
  };
}

const kanbanCardCreatedPolicy: NotificationPolicyEntry<KanbanCardCreatedPayload> =
  {
    category: NotificationCategory.TASKS,

    async resolveRecipients(payload, deps) {
      return resolveAssignedRecipient(payload.assignedUserId, deps);
    },

    renderInApp: renderKanbanCardCreatedInApp,
    renderWhatsApp: renderKanbanCardCreatedWhatsApp,
    renderActivity: renderKanbanCardCreatedActivity,
  };

// ============================================================================
// kanban-card.updated
// ============================================================================

function renderKanbanCardUpdatedInApp(
  payload: KanbanCardUpdatedPayload,
  ctx: RenderContext,
  recipient: RecipientRenderContext,
): RenderedInApp {
  return {
    type: "kanban-card",
    title: "Card Atualizado e Atribuído",
    message: `Você foi designado como responsável pelo card "${payload.title}" que foi atualizado no kanban`,
    link: kanbanCardLink(ctx, recipient, payload.cardId),
    entityId: payload.cardId,
  };
}

function renderKanbanCardUpdatedActivity(
  payload: KanbanCardUpdatedPayload,
): RenderedActivity {
  return {
    type: "Card Kanban",
    action: "update",
    entityId: payload.cardId,
    description: `Card "${payload.title}" atualizado com sucesso no kanban | ID: ${payload.cardId}`,
    status: payload.isCompleted ? "Completo" : "Pendente",
  };
}

const kanbanCardUpdatedPolicy: NotificationPolicyEntry<KanbanCardUpdatedPayload> =
  {
    category: NotificationCategory.TASKS,

    async resolveRecipients(payload, deps) {
      return resolveAssignedRecipient(payload.assignedUserId, deps);
    },

    renderInApp: renderKanbanCardUpdatedInApp,
    renderWhatsApp: renderKanbanCardUpdatedWhatsApp,
    renderActivity: renderKanbanCardUpdatedActivity,
  };

export {
  kanbanCardCreatedPolicy,
  kanbanCardUpdatedPolicy,
  renderKanbanCardCreatedWhatsApp,
  renderKanbanCardUpdatedWhatsApp,
  renderKanbanCardCreatedInApp,
  renderKanbanCardCreatedActivity,
  renderKanbanCardUpdatedInApp,
  renderKanbanCardUpdatedActivity,
};
