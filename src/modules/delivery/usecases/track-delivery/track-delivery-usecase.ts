import { inject, injectable } from "tsyringe";

import { IExternalRecipientRepository } from "../../repositories/IExternal-recipient-repository";

import { buildTrackingView } from "@/shared/delivery/customer-tracking";
import { AppError } from "@/shared/errors/AppError";

import { env } from "@/env";
import type { PublicTrackingView } from "../../dtos/external-recipient-dto";

interface TrackDeliveryRequest {
  token: string;
}

/**
 * The page the customer's link opens.
 *
 * No login, no session, no tenant — the token is the authorisation. Which is
 * why the answer is built by a pure function written as a subtraction, and why
 * every refusal here is the same 404: a distinct "this link expired" would let
 * somebody tell a real token from a wrong one.
 */
@injectable()
class TrackDeliveryUseCase {
  constructor(
    @inject("ExternalRecipientRepository")
    private recipients: IExternalRecipientRepository,
  ) {}

  async execute({ token }: TrackDeliveryRequest): Promise<PublicTrackingView> {
    const source = await this.recipients.findByToken(token);

    if (!source) {
      throw new AppError(
        "Acompanhamento não encontrado.",
        404,
        "TRACKING_NOT_FOUND",
      );
    }

    const expiresAt = source.recipient.expires_at
      ? new Date(source.recipient.expires_at)
      : null;

    // Same 404 as a token that never existed. A company that chose to let its
    // links go dark gets that, and a probe learns nothing from the difference.
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      throw new AppError(
        "Acompanhamento não encontrado.",
        404,
        "TRACKING_NOT_FOUND",
      );
    }

    return buildTrackingView(source, { publicBaseUrl: env.HTTP_REQUEST });
  }
}

export { TrackDeliveryUseCase };
