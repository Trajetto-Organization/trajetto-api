import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryMessageTemplateRepository } from "../../repositories/IDelivery-message-template-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { AppError } from "@/shared/errors/AppError";
import type { DeliveryMessageTemplateRecord } from "../../repositories/IDelivery-message-template-repository";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { customerWhatsAppPreview } from "@/shared/delivery/customer-whatsapp-templates";

const TOPICS = ["DISPATCHED", "ON_THE_WAY", "DELIVERED", "FAILED"] as const;

/**
 * The fixed text of each moment's WhatsApp (plan of 02/11/2026, B3/B4): the
 * template approved by Meta, the body with each variable named, and the two
 * buttons. The web shows it on the WhatsApp cards, which are only a switch.
 */
interface WhatsAppPreview {
  topic: (typeof TOPICS)[number];
  template: string;
  body: string;
  buttons: string[];
}

interface ListMessageTemplatesRequest {
  userId: string;
  businessId?: string;
}

@injectable()
class ListMessageTemplatesUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryMessageTemplateRepository")
    private templates: IDeliveryMessageTemplateRepository,
  ) {}

  async execute({ userId, businessId }: ListMessageTemplatesRequest): Promise<{
    data: DeliveryMessageTemplateRecord[];
    total: number;
    whatsappPreviews: WhatsAppPreview[];
  }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    const data = await this.templates.listByBusiness(resolvedBusinessId);

    // Every moment, written or not: a WhatsApp card exists before its row.
    const whatsappPreviews = TOPICS.map((topic) => ({
      topic,
      ...customerWhatsAppPreview(topic),
    }));

    return { data, total: data.length, whatsappPreviews };
  }
}

export { ListMessageTemplatesUseCase };
