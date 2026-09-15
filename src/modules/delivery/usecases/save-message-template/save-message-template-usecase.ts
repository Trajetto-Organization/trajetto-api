import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryMessageTemplateRepository } from "../../repositories/IDelivery-message-template-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { unknownTemplateVariables } from "@/shared/delivery/message-template";

import { AppError } from "@/shared/errors/AppError";
import type { DeliveryMessageTemplateRecord } from "../../repositories/IDelivery-message-template-repository";

interface SaveMessageTemplateRequest {
  userId: string;
  businessId: string;

  topic: "DISPATCHED" | "DELIVERED" | "FAILED";
  channel: "EMAIL" | "WHATSAPP";

  subject: string | null;
  body: string;

  is_active: boolean;
}

/**
 * What a company says to the person waiting for their delivery.
 *
 * One template per company × moment × channel, which is why this is a single
 * save rather than a create and an update: a second template for the same
 * moment would make which sentence goes out a matter of row order.
 *
 * The variables are checked HERE, at save time, and that is the whole point of
 * validating them at all. A dispatcher who typed `{{motorista}}` has to find
 * out in the form — the alternative is a customer receiving a message with a
 * blank where a word should be, days later, with nobody able to say why.
 */
@injectable()
class SaveMessageTemplateUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryMessageTemplateRepository")
    private templates: IDeliveryMessageTemplateRepository,
  ) {}

  async execute({
    userId,
    businessId,
    topic,
    channel,
    subject,
    body,
    is_active,
  }: SaveMessageTemplateRequest): Promise<DeliveryMessageTemplateRecord> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    assertDispatcher(findUser);
    assertTenantAccess(findUser, businessId);

    const unknown = [
      ...unknownTemplateVariables(body),
      ...(subject ? unknownTemplateVariables(subject) : []),
    ];

    if (unknown.length > 0) {
      throw new AppError(
        `A mensagem usa variáveis que não existem: ${unknown
          .map((name) => `{{${name}}}`)
          .join(", ")}.`,
        400,
        "UNKNOWN_TEMPLATE_VARIABLE",
      );
    }

    // A message with no way out is a message that earns a spam complaint, and
    // the company that wrote it will not be the one Meta suspends first.
    if (channel === "WHATSAPP" && !body.includes("{{link_descadastro}}")) {
      throw new AppError(
        "A mensagem de WhatsApp precisa incluir {{link_descadastro}}, para que o destinatário possa parar de receber.",
        400,
        "MISSING_OPT_OUT_LINK",
      );
    }

    return this.templates.save({
      businessId,
      topic,
      channel,
      // WhatsApp carries no subject, and storing one would show a field in the
      // editor that never reaches anybody.
      subject: channel === "WHATSAPP" ? null : subject,
      body,
      is_active,
    });
  }
}

export { SaveMessageTemplateUseCase };
