import { NotificationCategory } from "@prisma/client";

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
import type { RenderedWhatsApp } from "../whatsapp-templates";
import { dayLabel, oneLine } from "../whatsapp-parameters";

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

/**
 * The four parameters both kanban templates share (B1): the title instead of
 * the card's UUID, the priority with its emoji, the due day and the
 * description on one line — its lines joined with " · " first, so the
 * automatic card of a service order (four lines) still reads as a list.
 */
function kanbanCardParameters(
  card: KanbanCardContent,
): RenderedWhatsApp["parameters"] {
  const priority = priorityInfo(card.priority ?? "");
  const description = card.description
    ? oneLine(
        card.description
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .join(" · "),
      )
    : null;

  return [
    oneLine(card.title),
    `${priority.emoji} ${priority.text}`,
    dayLabel(card.dueDate, card.timeZone),
    description,
  ];
}

/**
 * trajetto_kanban_card_criado. Null for the card a service order created on
 * its own: the responsible already got the order's WhatsApp, and a second
 * one about the same work is noise (the in-app and the e-mail stay).
 */
function renderKanbanCardCreatedWhatsApp(
  card: KanbanCardContent & { fromServiceOrder?: boolean },
): RenderedWhatsApp | null {
  if (card.fromServiceOrder) return null;

  return {
    template: "trajetto_kanban_card_criado",
    parameters: kanbanCardParameters(card),
  };
}

/** trajetto_kanban_card_atualizado: sent only when the card changed hands. */
function renderKanbanCardUpdatedWhatsApp(
  card: KanbanCardContent,
): RenderedWhatsApp {
  return {
    template: "trajetto_kanban_card_atualizado",
    parameters: kanbanCardParameters(card),
  };
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
