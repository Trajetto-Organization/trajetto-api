import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, UpdateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { UserAssignedUserNotFoundError } from "@/modules/user/usecases/errors/user-assigned-user-not-found-error";
import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";

import { KanbanNotAllowedUpdateCardBusinessError } from "../errors/kanban-not-allowed-update-card-business-error";
import { KanbanCardColumnNotFoundError } from "../errors/kanban-card-column-not-found-error";

import { KanbanCardNotFoundError } from "../errors/kanban-card-not-found-error";

import { NotificationService } from "@/shared/services/notification-service";
import { redirectPage } from "@/shared/utils/link-redirect-page";

import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";

interface KanbanCardNotificationTextProps {
  title: string;
  description: string;
  priority: string;
  dueDate: string;
  cardId: string;
}

@injectable()
class UpdateKanbanCardUseCase {
  private http_request = env.HTTP_REQUEST;

  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
  ) {}

  private buildKanbanCardNotificationText({
    title,
    description,
    priority,
    dueDate,
    cardId,
  }: KanbanCardNotificationTextProps): string {
    const getPriorityInfo = (priority: string) => {
      switch (priority.toLowerCase()) {
        case "urgent":
          return { emoji: "🆘", text: "Urgente" };
        case "high":
          return { emoji: "🔴", text: "Alta" };
        case "medium":
          return { emoji: "🟡", text: "Média" };
        case "low":
          return { emoji: "🟢", text: "Baixa" };
        default:
          return { emoji: "🟢", text: "Baixa" };
      }
    };

    const priorityInfo = getPriorityInfo(priority);

    return [
      `📝 *Card Atualizado! Você foi designado como responsável por um card atualizado no kanban*`,
      `Título: *${title}*`,
      `Descrição: ${description}`,
      `Prioridade: ${priorityInfo.emoji} *${priorityInfo.text}*`,
      `Data de vencimento: *${dueDate}*`,
      `Identificador do card: *${cardId}*`,
      `Para mais detalhes, acesse o sistema.`,
    ].join("\n");
  }

  private async processNotifications(
    originalCard: KanbanCard,
    updatedCard: KanbanCard,
    cardData: UpdateKanbanCardProps,
    userId: string,
    businessId: string,
  ): Promise<void> {
    try {
      // Always create activity for card update
      const activityData = {
        type: "Card Kanban",
        action: "update",
        entityId: updatedCard.id,
        description: `Card "${updatedCard.title}" atualizado com sucesso no kanban | ID: ${updatedCard.id}`,
        status: updatedCard.completed ? "Completo" : "Pendente",
        performedBy: userId,
        businessId,
      };

      // Check if assignedUserId changed
      const assignedUserChanged =
        cardData.assignedUserId !== undefined &&
        originalCard.assignedUserId !== cardData.assignedUserId;

      if (assignedUserChanged && cardData.assignedUserId) {
        // AssignedUser changed, send notification
        const assignedUser = await this.user.findUserById(
          cardData.assignedUserId,
        );

        if (assignedUser) {
          const linkRedirectPage = redirectPage(
            assignedUser.role,
            assignedUser.driverId,
          );

          const notificationData = {
            userId: cardData.assignedUserId,
            type: "kanban-card",
            title: "Card Atualizado e Atribuído",
            message: `Você foi designado como responsável pelo card "${updatedCard.title}" que foi atualizado no kanban`,
            entityId: updatedCard.id,
            link: `${this.http_request}/${linkRedirectPage}/kanban?search=${updatedCard.id}&page=1`,
            businessId,
            shouldSendEmail: true,
            shouldSendWhatsApp: true,
            whatsAppMessage: this.buildKanbanCardNotificationText({
              title: updatedCard.title,
              description: updatedCard.description,
              priority: updatedCard.priority,
              dueDate: updatedCard.dueDate,
              cardId: updatedCard.id,
            }),
            instanceName: generateWhatsAppInstanceName(
              assignedUser.email,
              businessId,
            ),
          };

          // Process notification to newly assigned user
          await this.notificationService.processUserNotifications({
            notification: notificationData,
            activity: activityData,
          });
        } else {
          // Fallback: Create activity even if assigned user not found
          await this.notificationService.createActivityIfEnabled(activityData);
        }
      } else {
        // No assignedUser change, just create activity
        await this.notificationService.createActivityIfEnabled(activityData);
      }
    } catch (error) {
      console.error(
        "[Kanban Cards Update] Erro ao processar notificações:",
        error,
      );
      // Does not prevent the card update
    }
  }

  async execute(
    cardData: UpdateKanbanCardProps,
    cardId: string,
    userId: string,
  ): Promise<KanbanCard> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findCard = await this.kanban.findCardById(cardId);

    if (!findCard) {
      throw new KanbanCardNotFoundError();
    }

    const findColumn = await this.kanban.findColumnById(findCard.columnId);

    if (!findColumn) {
      throw new KanbanCardColumnNotFoundError();
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findColumn.businessId) {
        throw new KanbanNotAllowedUpdateCardBusinessError();
      }
    }

    // Verify assigned user if changed
    if (
      cardData.assignedUserId !== undefined &&
      cardData.assignedUserId !== null
    ) {
      const assignedUser = await this.user.findUserById(
        cardData.assignedUserId,
      );

      if (!assignedUser) {
        throw new UserAssignedUserNotFoundError();
      }

      if (
        findUser.role !== "MASTER" &&
        assignedUser.businessId !== findColumn.businessId
      ) {
        throw new UserNotBelongBusinessError();
      }
    }

    try {
      const updatedCard = await this.kanban.updateCard({
        cardData,
        cardId,
      });

      // Process notifications (activity + conditionally WhatsApp/Email)
      this.processNotifications(
        findCard,
        updatedCard,
        cardData,
        userId,
        findColumn.businessId,
      );

      return updatedCard;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar atualizar o card! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { UpdateKanbanCardUseCase };
