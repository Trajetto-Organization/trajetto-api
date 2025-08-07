// src/modules/middlewares/notification-context.ts
import { AppError } from "@/shared/errors/AppError";
import { FastifyRequest, FastifyReply } from "fastify";
import { container } from "tsyringe";
import { IUserRepository } from "../user/repositories/IUser-repository";

declare module "fastify" {
  interface FastifyRequest {
    notificationContext: {
      userId: string;
      businessId?: string;
      preferences: {
        emailEnabled: boolean;
        activityEnabled: boolean;
        whatsappEnabled: boolean;
      };
    };
  }
}

export async function notificationContext(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  // Este middleware é executado APÓS ensureAuthenticated
  // então request.user já está disponível

  const { id: userId } = request.user;

  // Buscar preferências do usuário (pode ser cacheado)
  const userRepository = container.resolve<IUserRepository>("UserRepository");
  const user = await userRepository.findUserById(userId);

  if (!user) {
    throw new AppError("Usuário não encontrado", 404);
  }

  request.notificationContext = {
    userId,
    businessId: user.businessId || undefined,
    preferences: {
      emailEnabled: user.email_notifications_enabled as boolean,
      activityEnabled: user.activity_notifications_enabled as boolean,
      whatsappEnabled: user.whatsapp_notifications_enabled as boolean,
    },
  };
}
