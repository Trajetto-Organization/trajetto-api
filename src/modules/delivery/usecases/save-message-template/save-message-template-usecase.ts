import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryMessageTemplateRepository } from "../../repositories/IDelivery-message-template-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import {
  InvalidMessageTemplateError,
  inspectTemplate,
  TemplateInspection,
} from "@/shared/delivery/message-template";

import { AppError } from "@/shared/errors/AppError";
import type {
  DeliveryMessageTemplateRecord,
  DeliveryMessageTopic,
} from "../../repositories/IDelivery-message-template-repository";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { sendCatalogChangedEvent } from "@/websocket";

/**
 * Parses a template for the save, turning a syntax error into the 400 the
 * editor shows next to the field.
 */
function inspectOrRefuse(template: string): TemplateInspection {
  try {
    return inspectTemplate(template);
  } catch (error) {
    if (!(error instanceof InvalidMessageTemplateError)) throw error;

    throw new AppError(
      `A mensagem tem um erro de formatação${
        error.line ? ` na linha ${error.line}` : ""
      }. Confira se cada variável abre com {{ e fecha com }}, como {{destinatario}}.`,
      400,
      "INVALID_TEMPLATE_SYNTAX",
    );
  }
}

interface SaveMessageTemplateRequest {
  userId: string;
  businessId: string;

  topic: DeliveryMessageTopic;
  channel: "EMAIL" | "WHATSAPP";

  subject: string | null;

  /**
   * The e-mail's text. Ignored on WhatsApp (plan of 02/11/2026, B3), which
   * goes out as Meta's fixed template: the web before this release still
   * sends one there, and it is neither refused nor stored.
   */
  body?: string | null;

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
 *
 * WhatsApp is only the moment's switch (plan of 02/11/2026, B3, decision
 * D34): the text is the fixed template approved by Meta, with the "Parar de
 * receber" button built in, so there is nothing of the company's to check.
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

    if (!findUser) throw callerNotFound();

    assertDispatcher(findUser);
    assertTenantAccess(findUser, businessId);

    const saved =
      channel === "WHATSAPP"
        ? await this.saveWhatsAppSwitch(businessId, topic, is_active)
        : await this.saveEmail(businessId, topic, subject, body, is_active);

    // Another dispatcher with the editor open sees the saved state.
    sendCatalogChangedEvent(businessId, "message_template");

    return saved;
  }

  /**
   * The WhatsApp row is the switch of the moment and nothing else. Its body
   * column was loosened in 20261102120800 (nullable-expand), and in THIS
   * release it is still never written NULL: the image before this one reads
   * a WhatsApp row's body as a string, and a rollback must find one. So the
   * row keeps whatever text it had, or '' when it is new; the next release
   * writes NULL and clears the old texts (contract phase).
   */
  private async saveWhatsAppSwitch(
    businessId: string,
    topic: DeliveryMessageTopic,
    is_active: boolean,
  ): Promise<DeliveryMessageTemplateRecord> {
    const rows = await this.templates.listByBusiness(businessId);

    const existing = rows.find(
      (row) => row.topic === topic && row.channel === "WHATSAPP",
    );

    return this.templates.save({
      businessId,
      topic,
      channel: "WHATSAPP",
      // WhatsApp carries no subject, and storing one would show a field in
      // the editor that never reaches anybody.
      subject: null,
      body: existing?.body ?? "",
      is_active,
    });
  }

  private async saveEmail(
    businessId: string,
    topic: DeliveryMessageTopic,
    subject: string | null,
    body: string | null | undefined,
    is_active: boolean,
  ): Promise<DeliveryMessageTemplateRecord> {
    // The schema already demands it; repeated here as the authority for any
    // other caller. The database's CHECK would refuse it anyway.
    if (!body || body.trim().length === 0) {
      throw new AppError(
        "O texto da mensagem é obrigatório.",
        400,
        "TEMPLATE_BODY_REQUIRED",
      );
    }

    // Parsed, not pattern-matched. A regex for `{{name}}` let every other
    // Handlebars form through — partials, blocks, helpers with arguments —
    // and those either could not render at send time or, like `{{log}}`,
    // rendered by writing the tenant's text into the platform's log.
    const bodyInspection = inspectOrRefuse(body);
    const subjectInspection = subject ? inspectOrRefuse(subject) : null;

    const unsupported = [
      ...new Set([
        ...bodyInspection.unsupported,
        ...(subjectInspection?.unsupported ?? []),
      ]),
    ];

    if (unsupported.length > 0) {
      throw new AppError(
        `A mensagem usa recursos que não são permitidos: ${unsupported.join(
          ", ",
        )}. Use apenas as variáveis disponíveis, como {{destinatario}}.`,
        400,
        "UNSUPPORTED_TEMPLATE_SYNTAX",
      );
    }

    const unknown = [
      ...new Set([
        ...bodyInspection.unknown,
        ...(subjectInspection?.unknown ?? []),
      ]),
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

    return this.templates.save({
      businessId,
      topic,
      channel: "EMAIL",
      subject,
      body,
      is_active,
    });
  }
}

export { SaveMessageTemplateUseCase };
