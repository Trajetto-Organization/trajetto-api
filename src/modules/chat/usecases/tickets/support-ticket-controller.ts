import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";
import { z } from "zod";

import {
  assignSupportTicketSchema,
  closeSupportTicketSchema,
  listSupportTicketsSchema,
  listTicketAssigneesSchema,
  markTicketReadSchema,
  openSupportTicketSchema,
  reopenSupportTicketSchema,
  ticketMessageBodySchema,
  ticketParamsSchema,
  ticketsSummarySchema,
} from "@/schemas/support-ticket-schema";
import { listChatMessagesSchema } from "@/schemas/list-chat-messages-schema";
import { idempotencyKeyOf } from "@/shared/http/idempotency-key";

import { OccurrenceAlreadyDecidedError } from "@/modules/delivery/usecases/authorize-occurrence/occurrence-authorization-errors";

import { SupportTicketDetailedError } from "../errors/support-ticket-errors";

import { ListSupportTicketsUseCase } from "./list-support-tickets/list-support-tickets-usecase";
import { GetSupportTicketsSummaryUseCase } from "./get-support-tickets-summary/get-support-tickets-summary-usecase";
import { GetSupportTicketUseCase } from "./get-support-ticket/get-support-ticket-usecase";
import { OpenSupportTicketUseCase } from "./open-support-ticket/open-support-ticket-usecase";
import { CloseSupportTicketUseCase } from "./close-support-ticket/close-support-ticket-usecase";
import { AssignSupportTicketUseCase } from "./assign-support-ticket/assign-support-ticket-usecase";
import { ReopenSupportTicketUseCase } from "./reopen-support-ticket/reopen-support-ticket-usecase";
import { ListSupportTicketEventsUseCase } from "./list-support-ticket-events/list-support-ticket-events-usecase";
import { MarkSupportTicketReadUseCase } from "./mark-support-ticket-read/mark-support-ticket-read-usecase";
import { ListTicketAssigneesUseCase } from "./list-ticket-assignees/list-ticket-assignees-usecase";

import { ListChatMessagesUseCase } from "../list-chat-messages/list-chat-messages-usecase";
import { SendChatMessageUseCase } from "../send-chat-message/send-chat-message-usecase";

/** Business id of a MASTER, from the query or the body. */
const masterBusinessId = z
  .object({ businessId: z.string().uuid().optional() })
  .partial();

/**
 * The refusals whose body carries more than code and message: who closed
 * the ticket, who holds it now, who decided the occurrence. The global
 * handler would strip those fields.
 */
function sendDetailedError(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof SupportTicketDetailedError) {
    reply.status(error.statusCode).send({
      code: error.code,
      message: error.message,
      ...error.details,
    });

    return true;
  }

  if (error instanceof OccurrenceAlreadyDecidedError) {
    reply.status(409).send({
      code: error.code,
      message: error.message,
      decision: error.decision,
    });

    return true;
  }

  return false;
}

const CLOSE_MESSAGES = {
  RESOLVED: "Atendimento encerrado.",
  APPROVED: "Ocorrência autorizada. O motorista já foi avisado.",
  DENIED: "Pedido negado. O motorista já foi avisado do motivo.",
} as const;

class SupportTicketController {
  async list(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = request.query as z.infer<typeof listSupportTicketsSchema>;

    const result = await container.resolve(ListSupportTicketsUseCase).execute({
      userId: request.user.id,
      ...query,
    });

    return reply.status(200).send(result);
  }

  async summary(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId } = request.query as z.infer<
      typeof ticketsSummarySchema
    >;

    const counts = await container
      .resolve(GetSupportTicketsSummaryUseCase)
      .execute({ userId: request.user.id, businessId });

    return reply.status(200).send(counts);
  }

  async get(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const { businessId } = masterBusinessId.parse(request.query ?? {});

    const data = await container
      .resolve(GetSupportTicketUseCase)
      .execute({ userId: request.user.id, businessId, ticketId });

    return reply.status(200).send({ data });
  }

  async open(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const body = openSupportTicketSchema.parse(request.body);

    try {
      const result = await container.resolve(OpenSupportTicketUseCase).execute({
        userId: request.user.id,
        idempotencyKey: idempotencyKeyOf(request.headers),
        ...body,
      });

      // Design §4.5: `message` is the first message sent (or null).
      return reply.status(result.created ? 201 : 200).send(result);
    } catch (error) {
      if (sendDetailedError(reply, error)) return;

      throw error;
    }
  }

  async close(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const { outcome, note } = closeSupportTicketSchema.parse(request.body);
    const { businessId } = masterBusinessId.parse(request.query ?? {});

    try {
      const result = await container
        .resolve(CloseSupportTicketUseCase)
        .execute({
          userId: request.user.id,
          businessId,
          ticketId,
          outcome,
          note,
        });

      return reply
        .status(200)
        .send({ message: CLOSE_MESSAGES[outcome], ...result });
    } catch (error) {
      if (sendDetailedError(reply, error)) return;

      throw error;
    }
  }

  async assign(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const { assigneeId, expectedAssigneeId } = assignSupportTicketSchema.parse(
      request.body,
    );
    const { businessId } = masterBusinessId.parse(request.query ?? {});

    try {
      const result = await container
        .resolve(AssignSupportTicketUseCase)
        .execute({
          userId: request.user.id,
          businessId,
          ticketId,
          assigneeId,
          expectedAssigneeId,
        });

      return reply.status(200).send({
        message: assigneeId ? "Atendente definido." : "Atendimento liberado.",
        ...result,
      });
    } catch (error) {
      if (sendDetailedError(reply, error)) return;

      throw error;
    }
  }

  async reopen(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const { note } = reopenSupportTicketSchema.parse(request.body ?? {});
    const { businessId } = masterBusinessId.parse(request.query ?? {});

    const result = await container
      .resolve(ReopenSupportTicketUseCase)
      .execute({ userId: request.user.id, businessId, ticketId, note });

    return reply
      .status(200)
      .send({ message: "Atendimento reaberto.", ...result });
  }

  async events(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const { businessId } = masterBusinessId.parse(request.query ?? {});

    const result = await container
      .resolve(ListSupportTicketEventsUseCase)
      .execute({ userId: request.user.id, businessId, ticketId });

    return reply.status(200).send(result);
  }

  async listMessages(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const query = request.query as z.infer<typeof listChatMessagesSchema>;

    const result = await container.resolve(ListChatMessagesUseCase).execute({
      userId: request.user.id,
      ticketId,
      before:
        query.beforeAt && query.beforeId
          ? { created_at: new Date(query.beforeAt), id: query.beforeId }
          : undefined,
      after:
        query.afterAt && query.afterId
          ? { created_at: new Date(query.afterAt), id: query.afterId }
          : undefined,
      aroundMessageId: query.aroundMessageId,
      limit: query.limit,
      search: query.search,
      businessId: query.businessId,
    });

    return reply.status(200).send(result);
  }

  async sendMessage(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const body = ticketMessageBodySchema.parse(request.body);
    const { businessId } = masterBusinessId.parse(request.query ?? {});

    try {
      const { data } = await container.resolve(SendChatMessageUseCase).execute({
        userId: request.user.id,
        businessId,
        ticketId,
        kind: body.kind,
        body: body.body,
        attachmentKey: body.attachmentKey,
        durationMs: body.durationMs,
        clientSubmissionId: body.clientSubmissionId,
        broadcastKey: idempotencyKeyOf(request.headers),
      });

      return reply
        .status(201)
        .send({ message: "Mensagem enviada!", data: data[0] });
    } catch (error) {
      if (sendDetailedError(reply, error)) return;

      throw error;
    }
  }

  async markRead(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { ticketId } = ticketParamsSchema.parse(request.params);
    const { readAt } = markTicketReadSchema.parse(request.body ?? {});
    const { businessId } = masterBusinessId.parse(request.query ?? {});

    const data = await container.resolve(MarkSupportTicketReadUseCase).execute({
      userId: request.user.id,
      businessId,
      ticketId,
      readAt: readAt ? new Date(readAt) : undefined,
    });

    return reply
      .status(200)
      .send({ message: "Atendimento marcado como lido.", data });
  }

  async assignees(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { businessId, search } = request.query as z.infer<
      typeof listTicketAssigneesSchema
    >;

    const result = await container
      .resolve(ListTicketAssigneesUseCase)
      .execute({ userId: request.user.id, businessId, search });

    return reply.status(200).send(result);
  }
}

export { SupportTicketController, sendDetailedError };
