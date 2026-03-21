import { inject, injectable } from "tsyringe";

import { INotificationRepository } from "../../repositories/INotification-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import {
  Notification,
  CreateNotificationProps,
} from "../../dtos/notification-dto";

import { sendNotificationToUser } from "@/websocket";

import { AppError } from "@/shared/errors/AppError";
import { EmailWorkerAdapter } from "@/jobs/email-worker-adapter";

import { env } from "@/env";

interface CreateNotificationRequest extends CreateNotificationProps {
  shouldSendEmail?: boolean;
  shouldCreateInAppNotification?: boolean;
}

@injectable()
class CreateNotificationUseCase {
  private emailQueue: EmailWorkerAdapter;

  private http_request = env.HTTP_REQUEST;
  private cloudinaryLogo = env.CLOUDINARY_LOGO_IMAGE;

  constructor(
    @inject("NotificationRepository")
    private notificationRepository: INotificationRepository,
    @inject("UserRepository")
    private userRepository: IUserRepository,
  ) {
    this.emailQueue = new EmailWorkerAdapter("notificationEmailQueue");
  }

  async execute(data: CreateNotificationRequest): Promise<Notification> {
    const user = await this.userRepository.findUserById(data.userId);

    if (!user) {
      throw new ResourceNotFoundError();
    }

    try {
      let notification;

      // Only create in-app notification if shouldCreateInAppNotification is true (or undefined for backward compatibility)
      if (data.shouldCreateInAppNotification !== false) {
        notification = await this.notificationRepository.createNotification({
          userId: data.userId,
          type: data.type,
          title: data.title,
          message: data.message,
          link: data.link,
          entityId: data.entityId,
          businessId: data.businessId,
        });

        // Send real-time notification via Socket.IO
        sendNotificationToUser(data.userId, {
          id: notification.id,
          type: notification.type,
          title: notification.title,
          message: notification.message,
          link: notification.link || undefined,
          read: notification.read,
          entityId: notification.entityId || undefined,
          businessId: notification.businessId,
          created_at: notification.created_at,
        });
      }

      // Email notification
      if (data.shouldSendEmail !== false && user.email) {
        await this.emailQueue.enqueueEmail({
          email: user.email,
          name: user.name,
          subject: `Trajetto - ${data.title}`,
          templateName: "notification.hbs",
          moduleName: "notification",
          additionalVariablesProperties: {
            title: data.title,
            message: data.message,
            link: data.link || `${this.http_request}/notifications`,
            logo: this.cloudinaryLogo,
          },
        });
      }

      // Return a mock notification object if we didn't create one
      return (
        notification || {
          id: "email-only",
          userId: data.userId,
          type: data.type,
          title: data.title,
          message: data.message,
          link: data.link,
          entityId: data.entityId,
          businessId: data.businessId,
          read: false,
          created_at: new Date(),
          updated_at: new Date(),
        }
      );
    } catch (error) {
      throw new AppError(
        "Houve um erro ao tentar criar a notificação! Por favor, tente novamente.",
        500,
      );
    }
  }
}

export { CreateNotificationUseCase };
