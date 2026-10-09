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
import {
  WHATSAPP_BODY_MAX,
  minimumWhatsAppLength,
} from "@/shared/delivery/whatsapp-body";

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

    if (!findUser) throw callerNotFound();

    assertDispatcher(findUser);
    assertTenantAccess(findUser, businessId);

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

    // A message with no way out is a message that earns a spam complaint, and
    // the company that wrote it will not be the one Meta suspends first.
    // Read from the parsed template: a substring check was satisfied by the
    // link inside a comment, which the customer never receives.
    if (
      channel === "WHATSAPP" &&
      !bodyInspection.used.includes("link_descadastro")
    ) {
      throw new AppError(
        "A mensagem de WhatsApp precisa incluir {{link_descadastro}}, para que o destinatário possa parar de receber.",
        400,
        "MISSING_OPT_OUT_LINK",
      );
    }

    // The form counts the TEMPLATE's characters; each link then grows by
    // about a hundred. Past the cap the company's text would be cut on every
    // single send — the send keeps the opt-out link, but not their words.
    if (
      channel === "WHATSAPP" &&
      minimumWhatsAppLength(body) > WHATSAPP_BODY_MAX
    ) {
      throw new AppError(
        `Com os links, a mensagem de WhatsApp passa de ${WHATSAPP_BODY_MAX} caracteres e seria cortada. Encurte o texto.`,
        400,
        "WHATSAPP_TEMPLATE_TOO_LONG",
      );
    }

    const saved = await this.templates.save({
      businessId,
      topic,
      channel,
      // WhatsApp carries no subject, and storing one would show a field in the
      // editor that never reaches anybody.
      subject: channel === "WHATSAPP" ? null : subject,
      body,
      is_active,
    });

    // Another dispatcher with the editor open sees the saved text.
    sendCatalogChangedEvent(businessId, "message_template");

    return saved;
  }
}

export { SaveMessageTemplateUseCase };
