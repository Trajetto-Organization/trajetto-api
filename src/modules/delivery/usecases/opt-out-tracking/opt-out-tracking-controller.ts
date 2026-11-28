import { FastifyReply, FastifyRequest } from "fastify";
import { container } from "tsyringe";

import { IExternalRecipientRepository } from "@/modules/delivery/repositories/IExternal-recipient-repository";
import { publicTokenParamsSchema } from "@/schemas/proof-document-schema";

/**
 * "Pare de me mandar mensagens."
 *
 * One click from the message itself, with no login — asking somebody to
 * authenticate in order to be left alone is how a company earns a spam
 * complaint. The answer is the same whether the token was real: a different
 * one would turn this into an oracle for which links exist.
 *
 * It stops this delivery and, for the same carrier, every message to the
 * recipient's phone (WhatsApp) and e-mail (plan of 02/11/2026, D38): the
 * repository records both in the same transaction.
 */
class OptOutTrackingController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const { token } = publicTokenParamsSchema.parse(request.params);

    const recipients = container.resolve<IExternalRecipientRepository>(
      "ExternalRecipientRepository",
    );

    await recipients.optOut(token);

    return reply.status(200).send({
      message:
        "Pronto. Esta transportadora não enviará mais mensagens sobre entregas para este telefone e este e-mail.",
    });
  }
}

export { OptOutTrackingController };
