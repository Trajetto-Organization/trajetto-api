import { inject, injectable } from "tsyringe";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";
import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import type { IOccurrenceAuthorizationRepository } from "@/modules/delivery/repositories/IOccurrence-authorization-repository";
import type { IChatRepository } from "../../../repositories/IChat-repository";
import type { ISupportTicketRepository } from "../../../repositories/ISupport-ticket-repository";
import type { SupportTicket } from "../../../dtos/support-ticket-dto";
import type { ChatMessageKind } from "../../../dtos/chat-dto";

import { AppError } from "@/shared/errors/AppError";
import { permissionDenied } from "@/shared/errors/access-errors";
import { isUniqueViolation } from "@/shared/http/idempotency-key";

import {
  ChatDeliveryNotFoundError,
  ChatDriverNotFoundError,
  ChatRouteNotFoundError,
} from "../../errors/chat-errors";
import {
  DriverChatOwnThreadError,
  IdempotencyKeyRequiredError,
  SupportTicketContextConflictError,
  SupportTicketSubjectRequiredError,
} from "../../errors/support-ticket-errors";

import {
  createDriverTicket,
  driverSubject,
  resolveDeliveryTicket,
  resolveRouteTicket,
  type OpenedBy,
} from "../../shared/ticket-factory";
import { occurrenceTicketSubject } from "../../shared/ticket-rules";
import {
  driverTicketView,
  presentTicket,
  type TicketSummary,
} from "../../shared/ticket-presenter";
import { announceTicket } from "../../shared/ticket-operations";

import {
  SendChatMessageUseCase,
  type SentChatMessage,
} from "../../send-chat-message/send-chat-message-usecase";

import {
  assertNotMaster,
  isTicketOperator,
  resolveTicketScope,
} from "../ticket-access";

interface OpenSupportTicketRequest {
  userId: string;
  businessId?: string;
  idempotencyKey?: string;
  driverId?: string;
  deliveryId?: string;
  routeId?: string;
  occurrenceId?: string;
  subject?: string;
  message?: {
    kind: ChatMessageKind;
    body?: string;
    attachmentKey?: string;
    durationMs?: number;
    clientSubmissionId?: string;
  };
}

/**
 * The holder was checked above, so the factory never declines here; if the
 * delivery or route moved in between, the request reads like a missing one.
 */
function held<T>(resolution: T | null, notFound: () => Error): T {
  if (!resolution) throw notFound();

  return resolution;
}

interface OpenSupportTicketResponse {
  data: TicketSummary;
  created: boolean;
  message: SentChatMessage | null;
}

/**
 * Opens a ticket (design §4.5): the tower's "+ Novo atendimento" or "Abrir
 * atendimento", the driver's "Novo assunto". About a delivery or a route it
 * is a get-or-create — one open ticket per delivery and per route, settled
 * by the partial unique indexes between replicas. The Idempotency-Key makes
 * a retried create answer the same ticket.
 */
@injectable()
class OpenSupportTicketUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
    @inject("SupportTicketRepository")
    private tickets: ISupportTicketRepository,
    @inject("OccurrenceAuthorizationRepository")
    private authorizations: IOccurrenceAuthorizationRepository,
    @inject(SendChatMessageUseCase)
    private sendMessage: SendChatMessageUseCase,
  ) {}

  async execute(
    request: OpenSupportTicketRequest,
  ): Promise<OpenSupportTicketResponse> {
    const scope = await resolveTicketScope(
      this.user,
      request.userId,
      request.businessId,
    );

    assertNotMaster(scope);

    // Creating a ticket allocates a number and rings a phone: never twice.
    if (!request.idempotencyKey) throw new IdempotencyKeyRequiredError();

    if (request.deliveryId && request.routeId)
      throw new SupportTicketContextConflictError();

    const byDriver = Boolean(scope.driverId);

    if (byDriver) {
      if (request.driverId && request.driverId !== scope.driverId) {
        throw new DriverChatOwnThreadError();
      }

      if (request.occurrenceId) {
        throw permissionDenied(
          "Somente a central abre o atendimento de uma ocorrência.",
        );
      }
    } else if (!isTicketOperator(scope)) {
      throw permissionDenied(
        "Seu perfil de acesso permite apenas a leitura desta seção.",
      );
    }

    let driverId = scope.driverId ?? request.driverId;

    // "Abrir atendimento" from a delivery or an occurrence: the ticket lives
    // in the conversation of the delivery's driver, so the panel need not
    // know him. A delivery of another company reads as missing.
    if (!driverId && request.deliveryId) {
      const ofDelivery = await this.delivery.findDeliveryById(
        request.deliveryId,
      );

      if (!ofDelivery || ofDelivery.businessId !== scope.businessId) {
        throw new ChatDeliveryNotFoundError();
      }

      if (!ofDelivery.driverId) {
        throw new AppError(
          "Esta entrega ainda não tem motorista: não há com quem abrir o atendimento.",
          400,
          "SUPPORT_TICKET_NO_DRIVER",
        );
      }

      driverId = ofDelivery.driverId;
    }

    if (!driverId) {
      throw new AppError(
        "Informe o motorista do atendimento.",
        400,
        "SUPPORT_TICKET_DRIVER_REQUIRED",
      );
    }

    // A retried create answers the ticket the first attempt opened.
    const replay = await this.tickets.findBySubmissionId(
      request.idempotencyKey,
      scope.businessId,
    );

    if (replay) {
      // A key is not a credential: someone else's ticket is a conflict.
      if (replay.driverId !== driverId) {
        throw new AppError(
          "Este identificador de envio já foi usado. Gere um novo e tente de novo.",
          409,
          "CHAT_SUBMISSION_CONFLICT",
        );
      }

      return this.answer(replay, false, request, scope.user.id, byDriver);
    }

    const findDriver = await this.driver.findDriverById(driverId);

    // Another company's driver reads exactly like a missing one.
    if (!findDriver || findDriver.businessId !== scope.businessId) {
      throw new ChatDriverNotFoundError();
    }

    const opened: OpenedBy = {
      via: byDriver ? "DRIVER_APP" : "PANEL",
      userId: scope.user.id,
      actorKind: byDriver ? "DRIVER_APP" : "USER",
      actorName: scope.user.name,
    };

    const deps = { tickets: this.tickets, chat: this.chat };

    let resolution: { ticket: SupportTicket; created: boolean };

    try {
      if (request.deliveryId) {
        const findDelivery = await this.delivery.findDeliveryById(
          request.deliveryId,
        );

        // The delivery must be of the company and held by this driver: the
        // ticket lives in the driver's conversation.
        if (
          !findDelivery ||
          findDelivery.businessId !== scope.businessId ||
          findDelivery.driverId !== driverId
        ) {
          throw new ChatDeliveryNotFoundError();
        }

        if (request.occurrenceId) {
          resolution = await this.resolveOccurrenceTicket({
            occurrenceId: request.occurrenceId,
            deliveryId: request.deliveryId,
            recipientName: findDelivery.recipient_name,
            businessId: scope.businessId,
            driverId,
            opened,
            key: request.idempotencyKey,
          });
        } else {
          resolution = held(
            await resolveDeliveryTicket(deps, {
              businessId: scope.businessId,
              driverId,
              holderDriverId: findDelivery.driverId ?? null,
              deliveryId: request.deliveryId,
              recipientName: findDelivery.recipient_name,
              opened,
              clientSubmissionId: request.idempotencyKey,
            }),
            () => new ChatDeliveryNotFoundError(),
          );
        }
      } else if (request.occurrenceId) {
        throw new AppError(
          "Informe a entrega da ocorrência.",
          400,
          "SUPPORT_TICKET_CONTEXT_REQUIRED",
        );
      } else if (request.routeId) {
        const route = await this.chat.findRoute(request.routeId);

        if (
          !route ||
          route.businessId !== scope.businessId ||
          route.driverId !== driverId
        ) {
          throw new ChatRouteNotFoundError();
        }

        resolution = held(
          await resolveRouteTicket(deps, {
            businessId: scope.businessId,
            driverId,
            route,
            opened,
            clientSubmissionId: request.idempotencyKey,
          }),
          () => new ChatRouteNotFoundError(),
        );
      } else if (byDriver) {
        // "Novo assunto" during a route is about that route (design §3.2).
        const running = (
          await this.chat.findRunningRoutes(scope.businessId, [driverId])
        ).get(driverId);

        resolution = running
          ? held(
              await resolveRouteTicket(deps, {
                businessId: scope.businessId,
                driverId,
                route: running,
                opened,
                clientSubmissionId: request.idempotencyKey,
              }),
              () => new ChatRouteNotFoundError(),
            )
          : {
              ticket: await createDriverTicket(deps, {
                businessId: scope.businessId,
                driverId,
                subject: request.subject ?? driverSubject(findDriver.name),
                opened,
                clientSubmissionId: request.idempotencyKey,
              }),
              created: true,
            };
      } else {
        if (!request.subject?.trim())
          throw new SupportTicketSubjectRequiredError();

        resolution = {
          ticket: await createDriverTicket(deps, {
            businessId: scope.businessId,
            driverId,
            subject: request.subject,
            opened,
            clientSubmissionId: request.idempotencyKey,
          }),
          created: true,
        };
      }
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // The same key committed by a twin request between the check above
      // and this insert: answer the twin's ticket.
      const twin = await this.tickets.findBySubmissionId(
        request.idempotencyKey,
        scope.businessId,
      );

      if (!twin) {
        throw new AppError(
          "Este identificador de envio já foi usado. Gere um novo e tente de novo.",
          409,
          "CHAT_SUBMISSION_CONFLICT",
        );
      }

      if (twin.driverId !== driverId) {
        throw new AppError(
          "Este identificador de envio já foi usado. Gere um novo e tente de novo.",
          409,
          "CHAT_SUBMISSION_CONFLICT",
        );
      }

      resolution = { ticket: twin, created: false };
    }

    if (resolution.created) {
      await announceTicket(this.tickets, {
        ticketId: resolution.ticket.id,
        businessId: scope.businessId,
        type: "ticket.opened",
        actor: { id: scope.user.id, name: scope.user.name },
        ...(byDriver && { alert: { reason: "DRIVER_OPENED" as const } }),
      });
    }

    return this.answer(
      resolution.ticket,
      resolution.created,
      request,
      scope.user.id,
      byDriver,
    );
  }

  /** "Abrir atendimento" on an occurrence without one (design §6.3). */
  private async resolveOccurrenceTicket(input: {
    occurrenceId: string;
    deliveryId: string;
    recipientName: string;
    businessId: string;
    driverId: string;
    opened: OpenedBy;
    key: string;
  }): Promise<{ ticket: SupportTicket; created: boolean }> {
    const existing = await this.tickets.findByOccurrence(
      input.occurrenceId,
      input.businessId,
    );

    if (existing) return { ticket: existing, created: false };

    const occurrence = await this.authorizations.findForDecision(
      input.occurrenceId,
      input.businessId,
    );

    if (!occurrence || occurrence.deliveryId !== input.deliveryId) {
      throw new ChatDeliveryNotFoundError();
    }

    try {
      const ticket = await createDriverTicket(
        { tickets: this.tickets, chat: this.chat },
        {
          businessId: input.businessId,
          driverId: input.driverId,
          subject: occurrenceTicketSubject(
            occurrence.occurrenceType.name,
            input.recipientName,
          ),
          opened: input.opened,
          clientSubmissionId: input.key,
          occurrence: { id: input.occurrenceId, deliveryId: input.deliveryId },
        },
      );

      return { ticket, created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      const winner = await this.tickets.findByOccurrence(
        input.occurrenceId,
        input.businessId,
      );

      if (!winner) throw error;

      return { ticket: winner, created: false };
    }
  }

  private async answer(
    ticket: SupportTicket,
    created: boolean,
    request: OpenSupportTicketRequest,
    userId: string,
    forDriver: boolean,
  ): Promise<OpenSupportTicketResponse> {
    let message: SentChatMessage | null = null;

    if (request.message) {
      // The message rides its own key; without one the request's key is
      // reused (different table, no collision), so a retried create never
      // writes the first message twice.
      const sent = await this.sendMessage.execute({
        userId,
        businessId: request.businessId,
        ticketId: ticket.id,
        kind: request.message.kind,
        body: request.message.body,
        attachmentKey: request.message.attachmentKey,
        durationMs: request.message.durationMs,
        clientSubmissionId:
          request.message.clientSubmissionId ?? request.idempotencyKey,
      });

      message = sent.data[0] ?? null;
    }

    const row = await this.tickets.findRowById(ticket.id, ticket.businessId);

    const summary = presentTicket(row!);

    return {
      // The driver never sees who handles his ticket inside the company.
      data: forDriver
        ? (driverTicketView(summary) as unknown as TicketSummary)
        : summary,
      created,
      message,
    };
  }
}

export { OpenSupportTicketUseCase };
export type { OpenSupportTicketRequest, OpenSupportTicketResponse };
