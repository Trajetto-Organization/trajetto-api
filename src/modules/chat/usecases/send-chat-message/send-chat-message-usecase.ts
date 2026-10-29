import { randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import {
  ChatRouteRef,
  IChatRepository,
} from "../../repositories/IChat-repository";

import { UploadService } from "@/shared/services/upload-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";
import { sendChatMessageEvent } from "@/websocket";

import {
  ChatMessage,
  ChatMessageKind,
  ChatMessageView,
  ChatRouteTag,
} from "../../dtos/chat-dto";
import {
  PresentedChatMessage,
  buildChatBodyPreview,
  presentChatMessage,
} from "../shared/chat-presenter";

import { resolveChatScope } from "../shared/chat-scope";
import { canWriteInChat } from "../shared/chat-access-rules";

import {
  ChatDeliveryNotFoundError,
  ChatDriverNotFoundError,
  ChatRouteNotFoundError,
} from "../errors/chat-errors";

import { assertSessionEligible } from "@/modules/user/services/session-eligibility";
import { User } from "@/modules/user/dtos/user-dto";
import { Driver } from "@/modules/driver/dtos/driver-dto";

import { AppError } from "@/shared/errors/AppError";
import { isUniqueViolation } from "@/shared/http/idempotency-key";

import { CHAT_BROADCAST_MAX_AUDIENCE } from "@/schemas/send-chat-message-schema";

import type { ISupportTicketRepository } from "../../repositories/ISupport-ticket-repository";
import type { SupportTicket } from "../../dtos/support-ticket-dto";
import {
  SupportTicketClosedError,
  SupportTicketNotFoundError,
} from "../errors/support-ticket-errors";
import { messageSide, routeLegacyMessage } from "../shared/ticket-rules";
import {
  createDriverTicket,
  driverSubject,
  resolveDeliveryTicket,
  resolveRouteTicket,
} from "../shared/ticket-factory";
import { announceTicket } from "../shared/ticket-operations";
import { logger } from "@/shared/logging/logger";

/** "Todos os motoristas ativos com o app", resolved here (decision 6.8). */
type ChatAudience = "ALL_ACTIVE_WITH_APP";

/**
 * What happened to one recipient.
 *
 * SKIPPED_NO_APP exists because a mass notice used to count a driver with no
 * app account as reached: the message sat in a thread nobody reads and the
 * toast said "enviado".
 */
type ChatSendStatus = "SENT" | "ALREADY_SENT" | "SKIPPED_NO_APP";

interface ChatSendOutcome {
  driverId: string;
  driverName: string;
  status: ChatSendStatus;

  /** The message in this driver's thread; null when he was skipped. */
  messageId: string | null;
}

interface ChatSendSummary {
  sent: number;
  alreadySent: number;
  skippedNoApp: number;
}

interface SendChatMessageRequest {
  userId: string;

  /** The chosen recipients. Omitted when `audience` names them. */
  driverIds?: string[];
  audience?: ChatAudience;

  kind: ChatMessageKind;
  body?: string;
  attachmentKey?: string;
  durationMs?: number;
  deliveryId?: string;

  /** Explicit route context; otherwise derived (see resolveRouteTag). */
  routeId?: string;
  clientSubmissionId?: string;
  businessId?: string;

  /**
   * The request's Idempotency-Key header (IDEMP-14).
   *
   * For a mass notice each driver's message is keyed
   * `${broadcastKey}:${driverId}`, and a retry after a failure halfway
   * through writes — and rings — only the drivers that were not reached. For
   * a single recipient without a body key it IS the message's key: the
   * notice dialog with one driver selected used to send no key at all, so a
   * retry duplicated the message.
   */
  broadcastKey?: string;

  /**
   * The support ticket the message belongs to (decision 14.5). Absent on a
   * one-driver send = a client that does not know tickets: the legacy
   * routing picks one (design §4.9).
   */
  ticketId?: string;
}

/** The ticket a message landed in, as the clients draw it. */
interface SentMessageTicket {
  id: string;
  number: number;
  status: "OPEN" | "CLOSED";
  assigneeId: string | null;
  version: number;
}

interface SentChatMessage extends PresentedChatMessage {
  driver: { id: string; name: string };
  ticket: SentMessageTicket | null;

  /**
   * Which side of the counter wrote it. The tower's alert rings for the
   * driver's messages only, and the payload names the driver record, not
   * his user — so the side is said, not guessed.
   */
  senderSide: "DRIVER" | "STAFF";
}

function ticketRef(ticket: SupportTicket | null): SentMessageTicket | null {
  return ticket
    ? {
        id: ticket.id,
        number: ticket.number,
        status: ticket.status,
        assigneeId: ticket.assigneeId,
        version: ticket.version,
      }
    : null;
}

interface SendChatMessageResponse {
  /** The messages now in each reached thread (sent or already there). */
  data: SentChatMessage[];
  outcomes: ChatSendOutcome[];
  summary: ChatSendSummary;
}

/** A recipient resolved once, before anything is written. */
interface ChatTarget {
  id: string;
  name: string;

  /** The app account that can read the thread; null when there is none. */
  appUserId: string | null;
}

function routeTagOf(route: ChatRouteRef | null): ChatRouteTag | null {
  return route ? { id: route.id, code: route.code, name: route.name } : null;
}

function summarize(outcomes: ChatSendOutcome[]): ChatSendSummary {
  return {
    sent: outcomes.filter((outcome) => outcome.status === "SENT").length,
    alreadySent: outcomes.filter((outcome) => outcome.status === "ALREADY_SENT")
      .length,
    skippedNoApp: outcomes.filter(
      (outcome) => outcome.status === "SKIPPED_NO_APP",
    ).length,
  };
}

@injectable()
class SendChatMessageUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("ChatRepository")
    private chat: IChatRepository,
    @inject("UploadService")
    private uploadService: UploadService,
    @inject("OutboxService")
    private outbox: OutboxService,
    // Optional so callers built before the tickets keep working.
    @inject("SupportTicketRepository")
    private tickets?: ISupportTicketRepository,
  ) {}

  async execute({
    userId,
    driverIds: requestedDriverIds = [],
    audience,
    kind,
    body,
    attachmentKey,
    durationMs,
    deliveryId,
    routeId,
    clientSubmissionId,
    businessId: requestedBusinessId,
    broadcastKey,
    ticketId,
  }: SendChatMessageRequest): Promise<SendChatMessageResponse> {
    const scope = await resolveChatScope(
      this.user,
      userId,
      requestedBusinessId,
    );

    // The chat is the company's own voice towards its driver: the app labels
    // everything that is not the driver's own message as "the base". A MASTER
    // is the software vendor, not the customer's operation — a message of
    // theirs would reach the driver disguised as the company's SAC. The
    // master seat is read-only here: support and diagnosis, never
    // impersonation of the customer's counter.
    if (!canWriteInChat(scope.user.role)) {
      throw new AppError(
        "O chat é a voz da operação da empresa. O acesso master é somente de leitura.",
        403,
        "MASTER_CHAT_READ_ONLY",
      );
    }

    // A ticket names its driver. Out of the company, or another driver's
    // for a driver token, it answers exactly like a missing one.
    const namedTicket =
      ticketId && this.tickets
        ? await this.tickets.findById(ticketId, scope.businessId)
        : null;

    if (
      ticketId &&
      (!namedTicket ||
        (scope.driverId && namedTicket.driverId !== scope.driverId) ||
        requestedDriverIds.some((id) => id !== namedTicket.driverId))
    ) {
      throw new SupportTicketNotFoundError();
    }

    // The same driver twice is one recipient. Deduplicated here too, for
    // callers that do not come through the HTTP schema.
    const driverIds = namedTicket
      ? [namedTicket.driverId]
      : [...new Set(requestedDriverIds)];

    // A driver has exactly one conversation: their own. Everything else —
    // choosing targets, mass notices — is the SAC side of the counter.
    if (
      scope.driverId &&
      (audience || driverIds.length !== 1 || driverIds[0] !== scope.driverId)
    ) {
      throw new AppError(
        "Motoristas conversam apenas com a operação da própria empresa.",
        403,
        "DRIVER_CHAT_OWN_THREAD",
      );
    }

    if (!audience && driverIds.length === 0) {
      throw new AppError(
        "Informe ao menos um motorista.",
        400,
        "CHAT_RECIPIENTS_REQUIRED",
      );
    }

    const isBroadcast = Boolean(audience) || driverIds.length > 1;

    if (isBroadcast && ticketId) {
      throw new AppError(
        "Aviso em massa não pertence a um atendimento.",
        400,
        "CHAT_BROADCAST_NOT_TICKET",
      );
    }

    // One conversation's message key: the body's, or the header's when the
    // body has none (a single recipient picked in the notice dialog).
    const submissionKey = isBroadcast
      ? null
      : (clientSubmissionId ?? broadcastKey ?? null);

    // Outbox-style resend: the send button pressed twice over a dead
    // network returns the message it already created, and rings nobody
    // again.
    if (submissionKey) {
      const existing = await this.chat.findMessageBySubmissionId(
        submissionKey,
        scope.businessId,
      );

      if (existing) {
        const thread = await this.chat.findThreadById(existing.threadId);
        const existingDriver = thread
          ? await this.driver.findDriverById(thread.driverId)
          : null;

        const replayed = await this.present(
          existing,
          existingDriver
            ? { id: existingDriver.id, name: existingDriver.name }
            : { id: thread?.driverId ?? "", name: "" },
          scope.user.name,
          userId,
          Boolean(scope.driverId),
        );

        const outcomes: ChatSendOutcome[] = [
          {
            driverId: replayed.driver.id,
            driverName: replayed.driver.name,
            status: "ALREADY_SENT",
            messageId: replayed.id,
          },
        ];

        return { data: [replayed], outcomes, summary: summarize(outcomes) };
      }
    }

    // The schema already refused these shapes on the wire; asserting them
    // here keeps the rules true for any caller of the use case.
    if (kind === "TEXT" && !body?.trim()) {
      throw new AppError(
        "Uma mensagem de texto precisa de texto.",
        400,
        "CHAT_TEXT_REQUIRED",
      );
    }

    if (kind !== "TEXT" && !attachmentKey) {
      throw new AppError(
        "Mensagens com mídia precisam do anexo enviado antes.",
        400,
        "CHAT_ATTACHMENT_REQUIRED",
      );
    }

    if (kind === "AUDIO" && !durationMs) {
      throw new AppError(
        "Áudio precisa da duração para o player.",
        400,
        "CHAT_AUDIO_DURATION_REQUIRED",
      );
    }

    if (isBroadcast && (clientSubmissionId || deliveryId || routeId)) {
      throw new AppError(
        "Aviso em massa não aceita idempotência por envio nem referência de entrega ou rota.",
        400,
        "CHAT_BROADCAST_REFERENCE_NOT_ALLOWED",
      );
    }

    // "Everyone" resolved on the server cannot be retried safely without a
    // key: a second attempt would ring every driver again.
    if (audience && !broadcastKey) {
      throw new AppError(
        "O aviso para todos os motoristas precisa do header Idempotency-Key.",
        400,
        "CHAT_BROADCAST_KEY_REQUIRED",
      );
    }

    // Fail before anything is written: a mass notice with one bad target
    // sends nothing instead of half.
    const targets = audience
      ? await this.resolveAudience(scope.businessId)
      : await this.resolveSelected(driverIds, scope.businessId);

    // Only ownership and existence are left to check before the key
    // becomes a row — the bytes went straight to the bucket.
    let attachmentPath: string | null = null;

    if (attachmentKey) {
      const [resolved] = await this.uploadService.resolvePresignedUploads(
        [{ key: attachmentKey }],
        "chatAttachments",
        scope.businessId,
      );

      attachmentPath = resolved.path;
    }

    // The context chip: the delivery must be of the company — and of the
    // driver, when a driver is talking about it.
    let deliveryChip: ChatMessageView["delivery"] = null;
    // Who holds the chip's delivery now: staff may still name a delivery
    // that moved to another driver, and that must not move tickets.
    let deliveryHolderId: string | null = null;

    if (deliveryId) {
      const findDelivery = await this.delivery.findDeliveryById(deliveryId);

      if (
        !findDelivery ||
        findDelivery.businessId !== scope.businessId ||
        (scope.driverId && findDelivery.driverId !== scope.driverId)
      ) {
        throw new ChatDeliveryNotFoundError();
      }

      deliveryHolderId = findDelivery.driverId ?? null;

      deliveryChip = {
        id: findDelivery.id!,
        recipient_name: findDelivery.recipient_name,
        status: findDelivery.status ?? "PENDING",
      };
    }

    // The route each message is about (decision 6.7), resolved before the
    // first write so a bad explicit route sends nothing.
    const routeByDriver = isBroadcast
      ? await this.chat.findRunningRoutes(
          scope.businessId,
          targets
            .filter((target) => target.appUserId)
            .map((target) => target.id),
        )
      : new Map(
          await Promise.all(
            targets.map(
              async (target) =>
                [
                  target.id,
                  await this.resolveRouteTag(
                    scope.businessId,
                    target.id,
                    routeId,
                    deliveryId,
                    Boolean(scope.driverId),
                  ),
                ] as const,
            ),
          ),
        );

    // A retried notice keeps its broadcast id: the key is a UUID already.
    const broadcastId = isBroadcast ? (broadcastKey ?? randomUUID()) : null;
    const staffSender = !scope.driverId;

    // Decision 14.5: the ticket of a conversation message, resolved before
    // anything of the message is written. A mass notice has none.
    let ticket: SupportTicket | null = null;

    if (!isBroadcast && this.tickets && targets[0]) {
      ticket =
        namedTicket ??
        (await this.routeLegacy({
          businessId: scope.businessId,
          target: targets[0],
          deliveryChip,
          deliveryHolderId,
          explicitRouteId: routeId ?? null,
          derivedRoute: routeByDriver.get(targets[0].id) ?? null,
          sender: { id: userId, name: scope.user.name, isDriver: !staffSender },
        }));

      // Checked again under the row lock below; this answers early.
      if (ticket.status === "CLOSED") {
        throw new SupportTicketClosedError({
          ticketId: ticket.id,
          number: ticket.number,
          closed_at: ticket.closed_at,
        });
      }

      // A message of a ticket is about the ticket's delivery and route.
      if (ticket.deliveryId && deliveryChip?.id !== ticket.deliveryId) {
        const ofTicket = await this.delivery.findDeliveryById(
          ticket.deliveryId,
        );

        deliveryChip = ofTicket
          ? {
              id: ofTicket.id!,
              recipient_name: ofTicket.recipient_name,
              status: ofTicket.status ?? "PENDING",
            }
          : null;
      }

      if (ticket.routeId) {
        const ofTicket = await this.chat.findRoute(ticket.routeId);

        if (ofTicket) routeByDriver.set(targets[0].id, ofTicket);
      }
    }

    const messageDeliveryId = ticket?.deliveryId ?? deliveryId ?? null;
    let autoAssigned = false;

    const results: SentChatMessage[] = [];
    const outcomes: ChatSendOutcome[] = [];

    try {
      // One small transaction per driver, not one giant one: each message
      // commits with its own push event, and a mid-broadcast crash leaves
      // whole messages, never half of one.
      for (const target of targets) {
        const driverRef = { id: target.id, name: target.name };

        // A mass notice goes to people who can read it. A conversation with
        // a driver who has no app yet is still allowed: the thread waits for
        // the account, and the panel says he has no access.
        if (isBroadcast && !target.appUserId) {
          outcomes.push({
            driverId: target.id,
            driverName: target.name,
            status: "SKIPPED_NO_APP",
            messageId: null,
          });

          continue;
        }

        // This driver's share of a keyed mass notice, or the one message of
        // a keyed conversation send.
        const key = isBroadcast
          ? broadcastKey
            ? `${broadcastKey}:${target.id}`
            : null
          : submissionKey;

        // Already written by an attempt that failed further on: answered
        // as it is, with no second push (IDEMP-14).
        if (isBroadcast && key) {
          const existing = await this.chat.findMessageBySubmissionId(
            key,
            scope.businessId,
          );

          if (existing) {
            const replayed = await this.present(
              existing,
              driverRef,
              scope.user.name,
              userId,
              Boolean(scope.driverId),
            );

            results.push(replayed);
            outcomes.push({
              driverId: target.id,
              driverName: target.name,
              status: "ALREADY_SENT",
              messageId: replayed.id,
            });

            continue;
          }
        }

        const thread = await this.chat.getOrCreateThread(
          scope.businessId,
          target.id,
        );

        const route = routeByDriver.get(target.id) ?? null;

        let message: ChatMessage;

        try {
          message = await database.$transaction(async (tx) => {
            // The ticket's row lock serializes this message against a close:
            // a message never lands "after" the ticket closed.
            if (ticket && this.tickets) {
              const locked = await this.tickets.lockForUpdate(
                ticket.id,
                scope.businessId,
                tx,
              );

              if (!locked || locked.status !== "OPEN") {
                throw new SupportTicketClosedError({
                  ticketId: ticket.id,
                  number: ticket.number,
                  closed_at: locked?.closed_at ?? ticket.closed_at,
                });
              }
            }

            const created = await this.chat.createMessage(
              {
                threadId: thread.id,
                senderId: userId,
                kind,
                body: body?.trim() || null,
                attachment_key: attachmentPath,
                duration_ms: durationMs ?? null,
                deliveryId: messageDeliveryId,
                routeId: route?.id ?? null,
                broadcast_id: broadcastId,
                client_submission_id: key,
                ticketId: ticket?.id ?? null,
              },
              tx,
            );

            if (ticket && this.tickets) {
              ticket = await this.tickets.touchOnMessage(
                {
                  id: ticket.id,
                  at: created.created_at,
                  side: messageSide(!staffSender),
                },
                tx,
              );

              // The first reply of the tower takes an unassigned ticket
              // (first wins, design §4.7): "quem atendeu" is never empty.
              if (staffSender && ticket.assigneeId === null) {
                autoAssigned = await this.tickets.autoAssign(
                  ticket.id,
                  userId,
                  created.created_at,
                  tx,
                );

                if (autoAssigned) {
                  await this.tickets.addEvent(
                    {
                      ticketId: ticket.id,
                      businessId: scope.businessId,
                      type: "ASSIGNED",
                      actor_kind: "SYSTEM",
                      target_user_id: userId,
                      target_user_name: scope.user.name,
                    },
                    tx,
                  );

                  ticket =
                    (await this.tickets.findById(
                      ticket.id,
                      scope.businessId,
                      tx,
                    )) ?? ticket;
                }
              }
            }

            // Only the SAC rings the driver's phone. The other direction is
            // the Chat tab badge plus the socket — the manager's bell stays
            // exclusive to blocking occurrences.
            if (staffSender && target.appUserId) {
              await this.outbox.publish(tx, {
                topic: "chat-message.sent",
                aggregateType: "chat-thread",
                aggregateId: thread.id,
                businessId: scope.businessId,
                actorId: userId,
                payload: {
                  messageId: created.id,
                  threadId: thread.id,
                  businessId: scope.businessId,
                  recipientUserId: target.appUserId,
                  senderName: scope.user.name,
                  kind,
                  bodyPreview: buildChatBodyPreview(body ?? null),
                  // Tapping the push opens the chat on this subject (design §8.5).
                  ...(ticket && {
                    ticketId: ticket.id,
                    ticketNumber: ticket.number,
                    ticketSubject: ticket.subject,
                  }),
                },
              });
            }

            return created;
          });
        } catch (error) {
          if (!key || !isUniqueViolation(error)) throw error;

          // The same key committed between the check above and this insert:
          // a double click reaching two replicas. Its twin's transaction
          // rolled back whole, push included, so answering with the message
          // that won is exactly what the client asked for — never a 500.
          const winner = await this.chat.findMessageBySubmissionId(
            key,
            scope.businessId,
          );

          // The column is unique across companies: a key already used by
          // another tenant is a conflict, and says nothing about that row.
          if (!winner) {
            throw new AppError(
              "Este identificador de envio já foi usado. Gere um novo e tente de novo.",
              409,
              "CHAT_SUBMISSION_CONFLICT",
            );
          }

          const replayed = await this.present(
            winner,
            driverRef,
            scope.user.name,
            userId,
            Boolean(scope.driverId),
          );

          results.push(replayed);
          outcomes.push({
            driverId: target.id,
            driverName: target.name,
            status: "ALREADY_SENT",
            messageId: replayed.id,
          });

          continue;
        }

        const presented = await presentChatMessage(
          {
            ...message,
            sender: { id: userId, name: scope.user.name },
            delivery: deliveryChip,
            route: routeTagOf(route),
          },
          this.uploadService,
        );

        const sent: SentChatMessage = {
          ...presented,
          driver: driverRef,
          ticket: ticketRef(ticket),
          senderSide: staffSender ? "STAFF" : "DRIVER",
        };

        // After the commit: an emit about a rolled-back message would be a
        // ghost, and a crashed emit must not undo a saved one.
        sendChatMessageEvent(scope.businessId, target.appUserId, sent);

        if (ticket && autoAssigned && this.tickets) {
          await announceTicket(this.tickets, {
            ticketId: ticket.id,
            businessId: scope.businessId,
            type: "ticket.assigned",
            actor: null,
          });
        }

        results.push(sent);
        outcomes.push({
          driverId: target.id,
          driverName: target.name,
          status: "SENT",
          messageId: sent.id,
        });
      }
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }

      throw new AppError(
        "Houve um erro ao tentar enviar a mensagem! Por favor, tente novamente.",
        500,
      );
    }

    return { data: results, outcomes, summary: summarize(outcomes) };
  }

  /**
   * Hand-picked recipients: every one must exist and be of the company.
   * The app account is read per driver — at most fifty of them.
   */
  private async resolveSelected(
    driverIds: string[],
    businessId: string,
  ): Promise<ChatTarget[]> {
    return Promise.all(
      driverIds.map(async (id) => {
        const findDriver = await this.driver.findDriverById(id);

        // Another company's driver reads exactly like a missing one: a
        // separate 403 "não pertence" told the caller the id was real.
        if (!findDriver || findDriver.businessId !== businessId) {
          throw new ChatDriverNotFoundError();
        }

        const appUser = await this.user.findUserByDriverId(id);

        return {
          id: findDriver.id!,
          name: findDriver.name,
          appUserId: (await this.canUseApp(appUser, findDriver))
            ? appUser!.id
            : null,
        };
      }),
    );
  }

  /**
   * Whether this driver's account could open the app and read the thread.
   *
   * The login's own rule, not a copy of it: `access_revoked` alone counted a
   * driver of an inactive branch — who cannot log in — as reached, rang his
   * phone and reported SENT. The SQL side (`HAS_APP` in the repository)
   * mirrors the same conditions for the lists and the "everyone" audience.
   */
  private async canUseApp(
    appUser: User | null,
    driver: Driver,
  ): Promise<boolean> {
    if (!appUser) return false;

    try {
      // The driver was just loaded, branch included: no second lookup.
      await assertSessionEligible(appUser, {
        findDriverById: async () => driver,
      });

      return true;
    } catch (error) {
      if (error instanceof AppError) return false;

      throw error;
    }
  }

  /**
   * Every active driver of the company with the app, in one read, within the
   * ceiling. The ones without it are not part of this audience at all: the
   * dialog lists them apart before the notice is sent.
   */
  private async resolveAudience(businessId: string): Promise<ChatTarget[]> {
    const audience = await this.chat.listAudience(
      businessId,
      CHAT_BROADCAST_MAX_AUDIENCE + 1,
    );

    if (audience.length > CHAT_BROADCAST_MAX_AUDIENCE) {
      throw new AppError(
        `O aviso para todos alcança no máximo ${CHAT_BROADCAST_MAX_AUDIENCE} motoristas. Escolha os destinatários.`,
        400,
        "CHAT_BROADCAST_TOO_LARGE",
      );
    }

    // Nothing to send to is not a success with an empty list.
    if (audience.length === 0) {
      throw new AppError(
        "Nenhum motorista ativo tem o aplicativo para receber o aviso.",
        400,
        "CHAT_BROADCAST_EMPTY",
      );
    }

    return audience;
  }

  /**
   * Which route a conversation message is about.
   *
   * The one the sender names; else the driver's route that carries the
   * delivery in the chip; else the route he is running now. Server-side, so
   * the app builds already installed — which send neither field — still tag
   * what their drivers say during a route.
   *
   * `driverSender`: a driver naming a colleague's route is answered exactly
   * like a missing route (decision 4.4), as a colleague's delivery is; a
   * distinct refusal would tell him the id exists. Staff keep the 400, which
   * explains a real mistake in the office.
   */
  private async resolveRouteTag(
    businessId: string,
    driverId: string,
    routeId?: string,
    deliveryId?: string,
    driverSender = false,
  ): Promise<ChatRouteRef | null> {
    if (routeId) {
      const route = await this.chat.findRoute(routeId);

      // Another company's route reads exactly like a missing one.
      if (!route || route.businessId !== businessId) {
        throw new ChatRouteNotFoundError();
      }

      if (route.driverId !== driverId) {
        if (driverSender) throw new ChatRouteNotFoundError();

        throw new AppError(
          "Esta rota não é do motorista da conversa.",
          400,
          "CHAT_ROUTE_OTHER_DRIVER",
        );
      }

      return route;
    }

    if (deliveryId) {
      const ofDelivery = await this.chat.findDeliveryRouteOfDriver(
        businessId,
        driverId,
        deliveryId,
      );

      if (ofDelivery) return ofDelivery;
    }

    const running = await this.chat.findRunningRoutes(businessId, [driverId]);

    return running.get(driverId) ?? null;
  }

  /**
   * Where a message from a client that does not know tickets lands
   * (design §4.9). Every use is logged: the branch is removed after 14 days
   * without this line in production.
   */
  private async routeLegacy(input: {
    businessId: string;
    target: ChatTarget;
    deliveryChip: ChatMessageView["delivery"];
    deliveryHolderId: string | null;
    explicitRouteId: string | null;
    derivedRoute: ChatRouteRef | null;
    sender: { id: string; name: string; isDriver: boolean };
  }): Promise<SupportTicket> {
    const tickets = this.tickets!;
    const deps = { tickets, chat: this.chat };

    const thread = await this.chat.findThreadByDriver(
      input.businessId,
      input.target.id,
    );
    const driverUserId = input.sender.isDriver
      ? input.sender.id
      : input.target.appUserId;

    const recent = thread
      ? await tickets.findLastStaffMessageTicket(thread.id, driverUserId)
      : null;

    const latestDriverTicket = await tickets.findLatestOpenDriverTicket(
      input.businessId,
      input.target.id,
    );

    const decision = routeLegacyMessage({
      recentStaffTicket: recent
        ? { id: recent.ticket.id, status: recent.ticket.status, at: recent.at }
        : null,
      now: new Date(),
      deliveryId: input.deliveryChip?.id ?? null,
      explicitRouteId: input.explicitRouteId,
      derivedRouteId: input.derivedRoute?.id ?? null,
      latestOpenDriverTicketId: latestDriverTicket?.id ?? null,
    });

    logger.info({
      event: "chat.legacy_ticket_routing",
      client: input.sender.isDriver ? "driver-app" : "panel",
      target: decision.target,
    });

    const opened = {
      via: "LEGACY_ROUTING" as const,
      userId: input.sender.id,
      actorKind: input.sender.isDriver
        ? ("DRIVER_APP" as const)
        : ("USER" as const),
      actorName: input.sender.name,
    };

    if (decision.target === "TICKET") {
      const found =
        recent?.ticket.id === decision.ticketId
          ? recent.ticket
          : latestDriverTicket?.id === decision.ticketId
            ? latestDriverTicket
            : await tickets.findById(decision.ticketId, input.businessId);

      if (found) return found;
    }

    if (decision.target === "DELIVERY" && input.deliveryChip) {
      const resolved = await resolveDeliveryTicket(deps, {
        businessId: input.businessId,
        driverId: input.target.id,
        holderDriverId: input.deliveryHolderId,
        deliveryId: decision.deliveryId,
        recipientName: input.deliveryChip.recipient_name,
        opened,
      });

      if (resolved) return resolved.ticket;
    }

    const route =
      decision.target === "ROUTE"
        ? input.derivedRoute?.id === decision.routeId
          ? input.derivedRoute
          : await this.chat.findRoute(decision.routeId)
        : null;

    if (route) {
      const resolved = await resolveRouteTicket(deps, {
        businessId: input.businessId,
        driverId: input.target.id,
        route,
        opened,
      });

      if (resolved) return resolved.ticket;
    }

    // A chip about something this driver no longer holds lands in his
    // general ticket, like a message with no context.
    if (latestDriverTicket) return latestDriverTicket;

    return createDriverTicket(deps, {
      businessId: input.businessId,
      driverId: input.target.id,
      subject: driverSubject(input.target.name),
      opened,
    });
  }

  /** A message that already exists, in the shape a fresh send answers. */
  private async present(
    message: ChatMessage,
    driver: { id: string; name: string },
    requesterName: string,
    requesterId: string,
    requesterIsDriver = false,
  ): Promise<SentChatMessage> {
    let deliveryChip: ChatMessageView["delivery"] = null;

    if (message.deliveryId) {
      const findDelivery = await this.delivery.findDeliveryById(
        message.deliveryId,
      );

      if (findDelivery) {
        deliveryChip = {
          id: findDelivery.id!,
          recipient_name: findDelivery.recipient_name,
          status: findDelivery.status ?? "PENDING",
        };
      }
    }

    const route = message.routeId
      ? await this.chat.findRoute(message.routeId)
      : null;

    // The replay is normally the requester's own message; a key reused by
    // someone else still names its real author.
    const author =
      message.senderId === requesterId
        ? null
        : await this.user.findUserById(message.senderId);
    const senderName = author
      ? author.name
      : message.senderId === requesterId
        ? requesterName
        : "";
    const senderSide: "DRIVER" | "STAFF" = author
      ? author.driverId
        ? "DRIVER"
        : "STAFF"
      : requesterIsDriver
        ? "DRIVER"
        : "STAFF";

    const presented = await presentChatMessage(
      {
        ...message,
        sender: { id: message.senderId, name: senderName },
        delivery: deliveryChip,
        route: routeTagOf(route),
      },
      this.uploadService,
    );

    const thread =
      message.ticketId && this.tickets
        ? await this.chat.findThreadById(message.threadId)
        : null;
    const ticket =
      thread && message.ticketId && this.tickets
        ? await this.tickets.findById(message.ticketId, thread.businessId)
        : null;

    return { ...presented, driver, ticket: ticketRef(ticket), senderSide };
  }
}

export { SendChatMessageUseCase };
export type {
  SentChatMessage,
  SentMessageTicket,
  SendChatMessageResponse,
  ChatSendOutcome,
  ChatSendStatus,
  ChatSendSummary,
  ChatAudience,
};
