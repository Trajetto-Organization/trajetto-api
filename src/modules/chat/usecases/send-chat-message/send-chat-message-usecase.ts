import { randomUUID } from "node:crypto";
import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import { IChatRepository } from "../../repositories/IChat-repository";

import { UploadService } from "@/shared/services/upload-service";
import { OutboxService } from "@/shared/notifications/outbox-service";

import database from "@/../infra/database";
import { sendChatMessageEvent } from "@/websocket";

import { ChatMessageKind, ChatMessageView } from "../../dtos/chat-dto";
import {
  PresentedChatMessage,
  buildChatBodyPreview,
  presentChatMessage,
} from "../shared/chat-presenter";

import { resolveChatScope } from "../shared/chat-scope";
import { canWriteInChat } from "../shared/chat-access-rules";

import {
  ChatDriverNotBelongBusinessError,
  ChatDriverNotFoundError,
} from "../errors/chat-errors";

import { DeliveryNotFoundError } from "@/modules/delivery/usecases/errors/delivery-errors";
import { AppError } from "@/shared/errors/AppError";

interface SendChatMessageRequest {
  userId: string;
  driverIds: string[];
  kind: ChatMessageKind;
  body?: string;
  attachmentKey?: string;
  durationMs?: number;
  deliveryId?: string;
  clientSubmissionId?: string;
  businessId?: string;
}

interface SentChatMessage extends PresentedChatMessage {
  driver: { id: string; name: string };
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
  ) {}

  async execute({
    userId,
    driverIds,
    kind,
    body,
    attachmentKey,
    durationMs,
    deliveryId,
    clientSubmissionId,
    businessId: requestedBusinessId,
  }: SendChatMessageRequest): Promise<{ data: SentChatMessage[] }> {
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

    // A driver has exactly one conversation: their own. Everything else —
    // choosing targets, mass notices — is the SAC side of the counter.
    if (
      scope.driverId &&
      (driverIds.length !== 1 || driverIds[0] !== scope.driverId)
    ) {
      throw new AppError(
        "Motoristas conversam apenas com a operação da própria empresa.",
        403,
        "DRIVER_CHAT_OWN_THREAD",
      );
    }

    // Outbox-style resend: the send button pressed twice over a dead
    // network returns the message it already created, and rings nobody
    // again.
    if (clientSubmissionId) {
      const existing =
        await this.chat.findMessageBySubmissionId(clientSubmissionId);

      if (existing) {
        const thread = await this.chat.findThreadById(existing.threadId);
        const existingDriver = thread
          ? await this.driver.findDriverById(thread.driverId)
          : null;

        const presented = await presentChatMessage(
          await this.buildView(existing, scope.user.name, userId),
          this.uploadService,
        );

        return {
          data: [
            {
              ...presented,
              driver: existingDriver
                ? { id: existingDriver.id, name: existingDriver.name }
                : { id: thread?.driverId ?? "", name: "" },
            },
          ],
        };
      }
    }

    // The schema already refused these shapes on the wire; asserting them
    // here keeps the rules true for any caller of the use case.
    if (kind === "TEXT" && !body?.trim()) {
      throw new AppError("Uma mensagem de texto precisa de texto.", 400);
    }

    if (kind !== "TEXT" && !attachmentKey) {
      throw new AppError(
        "Mensagens com mídia precisam do anexo enviado antes.",
        400,
      );
    }

    if (kind === "AUDIO" && !durationMs) {
      throw new AppError("Áudio precisa da duração para o player.", 400);
    }

    if (driverIds.length > 1 && (clientSubmissionId || deliveryId)) {
      throw new AppError(
        "Aviso em massa não aceita idempotência por envio nem referência de entrega.",
        400,
      );
    }

    // Fail before anything is written: a mass notice with one bad target
    // sends nothing instead of half.
    const drivers = await Promise.all(
      driverIds.map(async (id) => {
        const findDriver = await this.driver.findDriverById(id);

        if (!findDriver) {
          throw new ChatDriverNotFoundError();
        }

        if (findDriver.businessId !== scope.businessId) {
          throw new ChatDriverNotBelongBusinessError();
        }

        return findDriver;
      }),
    );

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

    if (deliveryId) {
      const findDelivery = await this.delivery.findDeliveryById(deliveryId);

      if (
        !findDelivery ||
        findDelivery.businessId !== scope.businessId ||
        (scope.driverId && findDelivery.driverId !== scope.driverId)
      ) {
        throw new DeliveryNotFoundError();
      }

      deliveryChip = {
        id: findDelivery.id!,
        recipient_name: findDelivery.recipient_name,
        status: findDelivery.status ?? "PENDING",
      };
    }

    const broadcastId = driverIds.length > 1 ? randomUUID() : null;
    const staffSender = !scope.driverId;

    const results: SentChatMessage[] = [];

    try {
      // One small transaction per driver, not one giant one: each message
      // commits with its own push event, and a mid-broadcast crash leaves
      // whole messages, never half of one.
      for (const targetDriver of drivers) {
        const thread = await this.chat.getOrCreateThread(
          scope.businessId,
          targetDriver.id,
        );

        const driverUser = await this.user.findUserByDriverId(targetDriver.id);

        const message = await database.$transaction(async (tx) => {
          const created = await this.chat.createMessage(
            {
              threadId: thread.id,
              senderId: userId,
              kind,
              body: body?.trim() || null,
              attachment_key: attachmentPath,
              duration_ms: durationMs ?? null,
              deliveryId: deliveryId ?? null,
              broadcast_id: broadcastId,
              client_submission_id: clientSubmissionId ?? null,
            },
            tx,
          );

          // Only the SAC rings the driver's phone. The other direction is
          // the Chat tab badge plus the socket — the manager's bell stays
          // exclusive to blocking occurrences.
          if (staffSender && driverUser) {
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
                recipientUserId: driverUser.id,
                senderName: scope.user.name,
                kind,
                bodyPreview: buildChatBodyPreview(body ?? null),
              },
            });
          }

          return created;
        });

        const presented = await presentChatMessage(
          {
            ...message,
            sender: { id: userId, name: scope.user.name },
            delivery: deliveryChip,
          },
          this.uploadService,
        );

        const sent: SentChatMessage = {
          ...presented,
          driver: { id: targetDriver.id, name: targetDriver.name },
        };

        // After the commit: an emit about a rolled-back message would be a
        // ghost, and a crashed emit must not undo a saved one.
        sendChatMessageEvent(scope.businessId, driverUser?.id ?? null, sent);

        results.push(sent);
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

    return { data: results };
  }

  private async buildView(
    message: Awaited<ReturnType<IChatRepository["createMessage"]>>,
    senderName: string,
    senderId: string,
  ): Promise<ChatMessageView> {
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

    return {
      ...message,
      sender: { id: senderId, name: senderName },
      delivery: deliveryChip,
    };
  }
}

export { SendChatMessageUseCase };
export type { SentChatMessage };
