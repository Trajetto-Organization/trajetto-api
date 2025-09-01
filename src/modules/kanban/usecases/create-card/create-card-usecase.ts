import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { KanbanCard, CreateKanbanCardProps } from "../../dtos/kanban-dto";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

import { KanbanColumnNotFoundError } from "../errors/kanban-column-not-found-error";
import { AppError } from "@/shared/errors/AppError";

import { NotificationService } from "@/shared/services/notification-service";
import { redirectPage } from "@/shared/utils/link-redirect-page";

import { generateWhatsAppInstanceName } from "@/shared/utils/whatsapp-instance-name";
import { env } from "@/env";

interface KanbanCardNotificationTextProps {
  title: string;
  description: string;
  priority: string;
  dueDate: string;
  cardId: string;
}

@injectable()
class CreateKanbanCardUseCase {
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
      `📋 *Novo Card Atribuído! Você foi designado como responsável por um novo card no kanban*`,
      `Título: *${title}*`,
      `Descrição: ${description}`,
      `Prioridade: ${priorityInfo.emoji} *${priorityInfo.text}*`,
      `Data de vencimento: *${dueDate}*`,
      `Identificador do card: *${cardId}*`,
      `Para mais detalhes, acesse o sistema.`,
    ].join("\n");
  }

  private async processNotifications(
    cardCreated: KanbanCard,
    cardData: CreateKanbanCardProps,
    userId: string,
    businessId: string,
  ): Promise<void> {
    try {
      // Create activity for the user who created the card
      const activityData = {
        type: "Card Kanban",
        action: "create",
        entityId: cardCreated.id,
        description: `Card "${cardCreated.title}" criado com sucesso no kanban | ID: ${cardCreated.id}`,
        status: cardCreated.completed ? "Completo" : "Pendente",
        performedBy: userId,
        businessId,
      };

      // Check if there's an assigned user
      if (cardData.assignedUserId) {
        const assignedUser = await this.user.findUserById(
          cardData.assignedUserId,
        );

        if (assignedUser) {
          const linkRedirectPage = redirectPage(assignedUser.role);
          const notificationData = {
            userId: cardData.assignedUserId,
            type: "kanban-card",
            title: "Novo Card Atribuído",
            message: `Você foi designado como responsável pelo card "${cardCreated.title}" no kanban`,
            entityId: cardCreated.id,
            link: `${this.http_request}/${linkRedirectPage}/kanban?search=${cardCreated.id}&page=1`,
            businessId,
            shouldSendEmail: true,
            shouldSendWhatsApp: true,
            whatsAppMessage: this.buildKanbanCardNotificationText({
              title: cardCreated.title,
              description: cardCreated.description,
              priority: cardCreated.priority,
              dueDate: cardCreated.dueDate,
              cardId: cardCreated.id,
            }),
            instanceName: generateWhatsAppInstanceName(
              assignedUser.email,
              businessId,
            ),
          };

          // Process notification to assigned user
          await this.notificationService.processUserNotifications({
            notification: notificationData,
            activity: activityData,
          });
        }
      } else {
        // No assignedUser or assignedUser is the creator, just create activity
        await this.notificationService.createActivityIfEnabled(activityData);
      }
    } catch (error) {
      console.error("[Kanban Cards] Erro ao processar notificações:", error);
      // Does not prevent the creation of the card
    }
  }

  async execute(
    cardData: CreateKanbanCardProps,
    userId: string,
  ): Promise<KanbanCard> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw new ResourceNotFoundError();
    }

    const findColumn = await this.kanban.findColumnById(cardData.columnId);

    if (!findColumn) {
      throw new KanbanColumnNotFoundError();
    }

    // Verify user permissions
    if (findUser.role !== "MASTER") {
      if (findUser.businessId !== findColumn.businessId) {
        throw new AppError(
          "Você não tem permissão para criar cards nesta empresa.",
          403,
        );
      }
    }

    // Verify assigned user exists and belongs to the same business
    if (cardData.assignedUserId) {
      const assignedUser = await this.user.findUserById(
        cardData.assignedUserId,
      );

      if (!assignedUser) {
        throw new AppError("Usuário atribuído não encontrado.", 400);
      }

      if (
        findUser.role !== "MASTER" &&
        assignedUser.businessId !== findColumn.businessId
      ) {
        throw new AppError(
          "O usuário atribuído não pertence a esta empresa.",
          400,
        );
      }
    }

    try {
      const card = await this.kanban.createCard(cardData);

      // Process notifications if there's an assigned user
      this.processNotifications(card, cardData, userId, findColumn.businessId);
      return card;
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar o card! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateKanbanCardUseCase };
