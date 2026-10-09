import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import {
  decidePermission,
  type PermissionPrincipal,
} from "@/modules/middlewares/verify-permission";

import type { ISupportTicketRepository } from "../../repositories/ISupport-ticket-repository";
import type { SupportTicket } from "../../dtos/support-ticket-dto";

import { resolveChatScope, type ChatScope } from "../shared/chat-scope";
import { canWriteInChat } from "../shared/chat-access-rules";

import {
  MasterChatReadOnlyError,
  SupportTicketNotFoundError,
} from "../errors/support-ticket-errors";
import { permissionDenied } from "@/shared/errors/access-errors";

/**
 * Who may do what with a ticket (design §10). The routes already ran the
 * module and permission guards; these restate the rules for any caller of
 * the use cases, and add the ones a route cannot see (MASTER writes nothing,
 * a driver only touches his own tickets).
 */

/** The tower side: writes delivery_manage, is not a driver, is not the vendor. */
function isTicketOperator(scope: ChatScope): boolean {
  return (
    !scope.driverId &&
    canWriteInChat(scope.user.role) &&
    decidePermission(
      scope.user as unknown as PermissionPrincipal,
      "delivery_manage",
      "write",
      { allowDriver: false },
    ) === null
  );
}

/** Speaking in a ticket: the operator, or the driver in his own. */
function canSpeak(scope: ChatScope): boolean {
  if (!canWriteInChat(scope.user.role)) return false;

  return (
    decidePermission(scope.user as unknown as PermissionPrincipal, "delivery_manage", "write") ===
    null
  );
}

function assertNotMaster(scope: ChatScope): void {
  if (!canWriteInChat(scope.user.role)) throw new MasterChatReadOnlyError();
}

function assertOperator(scope: ChatScope): void {
  assertNotMaster(scope);

  if (!isTicketOperator(scope)) {
    throw permissionDenied("Somente a central gerencia atendimentos.");
  }
}

/** The ticket inside the scope, or 404 — same body for every reason. */
async function loadScopedTicket(
  tickets: ISupportTicketRepository,
  scope: ChatScope,
  ticketId: string,
): Promise<SupportTicket> {
  const ticket = await tickets.findById(ticketId, scope.businessId);

  if (!ticket || (scope.driverId && ticket.driverId !== scope.driverId)) {
    throw new SupportTicketNotFoundError();
  }

  return ticket;
}

async function resolveTicketScope(
  users: IUserRepository,
  userId: string,
  businessId?: string,
): Promise<ChatScope> {
  return resolveChatScope(users, userId, businessId);
}

export {
  isTicketOperator,
  canSpeak,
  assertNotMaster,
  assertOperator,
  loadScopedTicket,
  resolveTicketScope,
};
