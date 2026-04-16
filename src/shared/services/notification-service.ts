import { inject, injectable } from "tsyringe";
import { container } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { WhatsAppService } from "./whatsapp-service";

interface CreateActivityProps {
  type: string;
  action: string;
  entityId: string;
  description: string;
  status: string;
  performedBy: string;
  businessId: string | null;
  tenantName?: string | null;
  visibilityLevel?: string;
  performingUserRole?: string;
}

interface CreateNotificationProps {
  userId: string;
  type: string;
  title: string;
  message: string;
  entityId: string;
  link: string;
  businessId: string | null;
  shouldSendEmail?: boolean;
  shouldSendWhatsApp?: boolean;
  whatsAppMessage?: string;
  instanceName?: string;
}

@injectable()
class NotificationService {
  private whatsAppService: WhatsAppService;

  constructor(
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {
    this.whatsAppService = WhatsAppService.getInstance();
  }

  async createActivityIfEnabled(
    activityData: CreateActivityProps,
  ): Promise<void> {
    try {
      const user = await this.userRepository.findUserById(
        activityData.performedBy,
      );

      if (!user) {
        return;
      }

      // Always create activity record - no configuration checks needed
      // Hierarchical visibility is handled at query time in ActivityRepository
      const { CreateActivityUseCase } = await import(
        "@/modules/activity/usecases/create-activity/create-activity-usecase"
      );

      const createActivityUseCase = container.resolve(CreateActivityUseCase);
      await createActivityUseCase.execute(activityData);
    } catch (error) {
      console.warn("Erro ao criar activity:", error);
    }
  }

  async createNotificationIfEnabled(
    notificationData: CreateNotificationProps,
  ): Promise<void> {
    try {
      const user = await this.userRepository.findUserById(
        notificationData.userId,
      );

      if (!user) {
        return;
      }

      // All users follow the same notification rules based on their settings
      const shouldCreateNotification = user.activity_notifications_enabled;
      const shouldSendEmail =
        user.email_notifications_enabled && notificationData.shouldSendEmail;

      // WhatsApp for BUSINESS_ADMIN and BUSINESS_USER
      const shouldSendWhatsApp =
        user.whatsapp_notifications_enabled &&
        notificationData.shouldSendWhatsApp &&
        notificationData.whatsAppMessage;

      // Create notification if activity_notifications_enabled OR if email should be sent
      // But separate the controls: notification creation vs email sending
      if (shouldCreateNotification || shouldSendEmail) {
        const { CreateNotificationUseCase } = await import(
          "@/modules/notification/usecases/create-notification/create-notification-usecase"
        );
        const createNotificationUseCase = container.resolve(
          CreateNotificationUseCase,
        );

        await createNotificationUseCase.execute({
          ...notificationData,
          shouldSendEmail,
          shouldCreateInAppNotification: shouldCreateNotification, // New flag to control in-app notification
        });
      }

      // Send WhatsApp notification (background processing)
      if (
        shouldSendWhatsApp &&
        user.whatsapp_phone &&
        notificationData.instanceName
      ) {
        await this.whatsAppService.enqueueWhatsAppMessage(
          `whatsapp-${notificationData.businessId}`,
          {
            instanceName: notificationData.instanceName,
            phoneNumber: user.whatsapp_phone,
            message: notificationData.whatsAppMessage!,
            userId: user.id,
          },
        );
      }
    } catch (error) {
      console.warn("Erro ao criar notificação:", error);
    }
  }

  async processUserNotifications(params: {
    activity?: CreateActivityProps;
    notification?: CreateNotificationProps;
  }): Promise<void> {
    const promises: Promise<void>[] = [];

    if (params.activity) {
      promises.push(this.createActivityIfEnabled(params.activity));
    }

    if (params.notification) {
      promises.push(this.createNotificationIfEnabled(params.notification));
    }

    try {
      await Promise.allSettled(promises);
    } catch (error) {
      console.warn("Erro ao processar notificações do usuário:", error);
    }
  }
}

export { NotificationService, CreateActivityProps, CreateNotificationProps };
