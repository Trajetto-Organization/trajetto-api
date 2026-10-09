import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/IOccurrence-type-repository";

import { readFormFields } from "@/modules/occurrence-type/form/occurrence-form-rules";
import { DELIVERED_DEFAULT_TYPE_KEY } from "@/shared/delivery/default-occurrence-types";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { AppError } from "@/shared/errors/AppError";
import type { DevicePrecheck } from "@/shared/ai-precheck/device-precheck";
import type { ProofCapture } from "@/shared/delivery/proof-capture";

import { ReportDeliveryOccurrenceUseCase } from "../report-delivery-occurrence/report-delivery-occurrence-usecase";
import type { ReportOccurrenceResult } from "../report-delivery-occurrence/report-delivery-occurrence-usecase";
import { LegacyProofNeedsAppUpdateError } from "../report-delivery-occurrence/occurrence-report-errors";

interface RegisterDeliveryProofRequest {
  userId: string;
  businessId: string;
  deliveryId: string;
  client_submission_id: string;
  photo: string;
  signature?: string;
  received_by?: string;
  latitude?: number;
  longitude?: number;

  /**
   * When the receipt was signed, for a proof the app sent later
   * (resolveOccurredAt). Absent means now.
   */
  occurredAt?: Date | null;

  /** The phone's offline check of the receipt (decision 14.2). */
  device_precheck?: DevicePrecheck | null;

  /** The photo stamp and the phone (decision 14.8), for the PROOF event. */
  capture?: ProofCapture;
}

/**
 * The installed app's proof route (contract <= 2), adapted onto decision
 * 14.3: proving is reporting a DELIVERED occurrence, and that build has no
 * type picker, so its proof lands on the company's default delivered type
 * ("Entrega normal", found by key whatever it is called now, active or not).
 *
 * The effect is the one every proof has (delivery-proof-effect): DELIVERED,
 * PROOF, stop, customer notice, webhooks, audit card, AI. What this build
 * cannot satisfy — a signature, photos or a form the company now requires on
 * the default — is CLIENT_OUTDATED, which its queue keeps on the phone and
 * sends again after the update. Remove with the route once 14 days pass
 * without a use (legacy_proof_adapter), then MIN_MOBILE_CONTRACT=3.
 */
@injectable()
class RegisterDeliveryProofUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OccurrenceTypeRepository")
    private occurrenceType: IOccurrenceTypeRepository,
    @inject(ReportDeliveryOccurrenceUseCase)
    private report: ReportDeliveryOccurrenceUseCase,
  ) {}

  async execute({
    userId,
    businessId,
    deliveryId,
    client_submission_id,
    photo,
    signature,
    received_by,
    latitude,
    longitude,
    occurredAt,
    device_precheck,
    capture,
  }: RegisterDeliveryProofRequest): Promise<ReportOccurrenceResult> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    if (!findUser.driverId) {
      throw new AppError(
        "Esta rota é do aplicativo do motorista: apenas usuários vinculados a um motorista comprovam entregas.",
        403,
        "DRIVER_ONLY",
      );
    }

    // Seeded with the company (create-business) and by the migration; this
    // is the safety net for a company that slipped between the two.
    let type = await this.occurrenceType.findDefaultType(businessId, DELIVERED_DEFAULT_TYPE_KEY);

    if (!type) {
      await this.occurrenceType.ensureDefaultTypes(businessId);
      type = await this.occurrenceType.findDefaultType(businessId, DELIVERED_DEFAULT_TYPE_KEY);
    }

    if (!type) {
      throw new AppError(
        "Houve um erro ao tentar comprovar a entrega! Por favor, tente novamente.",
        500,
      );
    }

    // What this build's body cannot carry. Checked only for a submission not
    // recorded yet: a resend of a proof that got in is a success whatever the
    // company changed since (the report's replay answers it first).
    const missing: Array<"signature" | "photos" | "form"> = [];

    if (type.requires_signature === true && !signature) missing.push("signature");
    if (type.requires_photo === true) missing.push("photos");
    if ((readFormFields(type.form_fields) ?? []).some((field) => field.required)) {
      missing.push("form");
    }

    const report = () =>
      this.report.execute({
        userId,
        businessId,
        deliveryId,
        occurrenceTypeId: type!.id!,
        client_submission_id,
        receipt_photo: photo,
        signature,
        received_by,
        latitude,
        longitude,
        occurredAt,
        device_precheck,
        capture,
        legacy: true,
      });

    if (missing.length > 0) {
      // A replay of a submission already recorded is not refused.
      const result = await this.report.replayIfRecorded(
        client_submission_id,
        businessId,
        deliveryId,
      );

      if (result) return result;

      throw new LegacyProofNeedsAppUpdateError(missing);
    }

    return report();
  }
}

export { RegisterDeliveryProofUseCase };
export type { RegisterDeliveryProofRequest };
